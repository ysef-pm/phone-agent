const WebSocket = require("ws");
const https = require("https");

// Mulaw encoding/decoding tables
const MULAW_BIAS = 33;
const MULAW_MAX = 0x1FFF;

function encodeMulaw(sample) {
  const sign = (sample < 0) ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample += MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0; exponent--, mask >>= 1) {
    if (sample >= mask) break;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

// Precomputed mulaw-to-linear decode table
const MULAW_DECODE = new Int16Array(256);
(function buildDecodeTable() {
  for (let i = 0; i < 256; i++) {
    const v = ~i & 0xFF;
    const sign = (v & 0x80) ? -1 : 1;
    const exponent = (v >> 4) & 0x07;
    const mantissa = v & 0x0F;
    const magnitude = ((mantissa << 1) | 0x21) << (exponent + 2);
    MULAW_DECODE[i] = sign * (magnitude - MULAW_BIAS);
  }
})();

class ElevenLabsBridge {
  constructor({ agentId, apiKey, taskPrompt, callSid, onTranscript, onAgentResponse, onError, onEnd }) {
    this.agentId = agentId;
    this.apiKey = apiKey;
    this.taskPrompt = taskPrompt;
    this.callSid = callSid;
    this.onTranscript = onTranscript || (() => {});
    this.onAgentResponse = onAgentResponse || (() => {});
    this.onError = onError || (() => {});
    this.onEnd = onEnd || (() => {});
    this.elWs = null;
    this.twilioWs = null;
    this.streamSid = null;
    this.conversationId = null;
    this.transcript = [];
  }

  async connect() {
    const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${this.agentId}`;
    console.log(`[EL] Connecting...`);
    this.elWs = new WebSocket(wsUrl);

    this.elWs.on("open", () => {
      console.log(`[EL] Connected, sending init`);
      this.elWs.send(JSON.stringify({
        type: "conversation_initiation_client_data"
      }));
    });

    this.elWs.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      this._handleMessage(msg);
    });

    this.elWs.on("close", (code, reason) => {
      console.log(`[EL] Closed: ${code} ${reason}`);
      this.onEnd(this.transcript);
    });

    this.elWs.on("error", (err) => {
      console.error(`[EL] Error: ${err.message}`);
      this.onError(err);
    });
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case "conversation_initiation_metadata": {
        this.conversationId = msg.conversation_initiation_metadata_event?.conversation_id;
        const fmt = msg.conversation_initiation_metadata_event?.agent_output_audio_format;
        console.log(`[EL] Conv: ${this.conversationId}, format: ${fmt}`);
        if (this.taskPrompt && this.elWs?.readyState === WebSocket.OPEN) {
          this.elWs.send(JSON.stringify({ type: "contextual_update", text: this.taskPrompt }));
        }
        break;
      }

      case "audio": {
        if (this.streamSid && this.twilioWs?.readyState === WebSocket.OPEN) {
          const b64 = msg.audio_event?.audio_base_64 || "";
          if (b64) {
            const mulawB64 = this._pcm16kToMulaw8k(b64);
            this.twilioWs.send(JSON.stringify({
              event: "media",
              streamSid: this.streamSid,
              media: { payload: mulawB64 }
            }));
          }
        }
        break;
      }

      case "user_transcript": {
        const t = msg.user_transcription_event?.user_transcript || "";
        if (t) {
          this.transcript.push({ role: "user", text: t });
          this.onTranscript(t);
        }
        break;
      }

      case "agent_response": {
        const t = msg.agent_response_event?.agent_response || "";
        if (t) {
          this.transcript.push({ role: "agent", text: t });
          this.onAgentResponse(t);
        }
        break;
      }

      case "ping": {
        const evt = msg.ping_event || {};
        setTimeout(() => {
          if (this.elWs?.readyState === WebSocket.OPEN) {
            this.elWs.send(JSON.stringify({ type: "pong", event_id: evt.event_id }));
          }
        }, evt.ping_ms || 0);
        break;
      }

      case "interruption":
        break;

      default:
        console.log(`[EL] ${msg.type}`);
        break;
    }
  }

  // Convert PCM 16-bit 16kHz -> mulaw 8-bit 8kHz
  // Downsample by taking every other sample, then encode to mulaw
  _pcm16kToMulaw8k(base64Audio) {
    const pcm = Buffer.from(base64Audio, "base64");
    const numSamples = pcm.length / 2;
    // Downsample 16kHz -> 8kHz: take every 2nd sample
    const outLen = Math.floor(numSamples / 2);
    const mulaw = Buffer.alloc(outLen);
    for (let i = 0; i < outLen; i++) {
      const sample = pcm.readInt16LE(i * 4); // skip every other sample
      mulaw[i] = encodeMulaw(sample);
    }
    return mulaw.toString("base64");
  }

  // Convert mulaw 8-bit 8kHz -> PCM 16-bit 16kHz
  // Decode mulaw, then upsample by duplicating each sample
  _mulaw8kToPcm16k(base64Audio) {
    const mulaw = Buffer.from(base64Audio, "base64");
    // Each mulaw byte -> 2 PCM samples (upsample 8k->16k) -> 4 bytes each = 4 bytes per input byte
    const pcm = Buffer.alloc(mulaw.length * 4);
    for (let i = 0; i < mulaw.length; i++) {
      const sample = MULAW_DECODE[mulaw[i]];
      // Write same sample twice (upsample)
      pcm.writeInt16LE(sample, i * 4);
      pcm.writeInt16LE(sample, i * 4 + 2);
    }
    return pcm.toString("base64");
  }

  setTwilioStream(twilioWs, streamSid) {
    this.twilioWs = twilioWs;
    this.streamSid = streamSid;
  }

  // Convert Twilio mulaw to PCM before sending to ElevenLabs
  sendAudio(base64MulawAudio) {
    if (this.elWs?.readyState === WebSocket.OPEN) {
      const pcmB64 = this._mulaw8kToPcm16k(base64MulawAudio);
      this.elWs.send(JSON.stringify({ user_audio_chunk: pcmB64 }));
    }
  }

  close() {
    if (this.elWs) {
      this.elWs.close();
      this.elWs = null;
    }
  }
}

module.exports = { ElevenLabsBridge };
