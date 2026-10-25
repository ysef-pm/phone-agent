const { promptLogMeta, transcriptLogEvent } = require('./logging-policy');

function isValidStart(data) {
  return data?.event === 'start' &&
    /^CA[0-9a-f]{32}$/i.test(data.start?.callSid || '') &&
    /^MZ[0-9a-f]{32}$/i.test(data.start?.streamSid || '') &&
    /^[A-Za-z0-9_-]{16,128}$/.test(data.start?.customParameters?.callToken || '');
}

function attachMediaStreamSession(ws, {
  pendingCalls,
  createBridge,
  env = process.env,
  appendCallEvent = () => {},
  sendTelegramSummary = async () => ({ sent: 0 }),
  saveTranscript = () => {},
  hangUpCall = async () => {},
  pressDigit = async () => {}
} = {}) {
  let bridge = null;
  let bridgeClosed = false;
  let started = false;
  let boundStreamSid = null;
  let transcriptFinalized = false;
  let humanHandoffObserved = false;

  function closeBridge() {
    if (!bridge || bridgeClosed) return;
    bridgeClosed = true;
    try {
      bridge.close();
    } catch (e) {
      appendCallEvent('unknown', {
        type: 'bridge_close_error',
        text: 'Bridge close failed',
        meta: { error: e.message }
      });
    }
  }

  function closeSocket(code, reason) {
    try {
      ws.close(code, reason);
    } catch {}
  }

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch {
      closeBridge();
      closeSocket(1003, 'Invalid JSON');
      return;
    }

    if (data.event === 'start') {
      if (started) {
        closeBridge();
        closeSocket(1008, 'Duplicate start event');
        return;
      }
      if (!isValidStart(data)) {
        closeSocket(1008, 'Invalid start event');
        return;
      }
      started = true;
      boundStreamSid = data.start.streamSid;
      const metadata = pendingCalls?.takeForCall(
        data.start.customParameters.callToken,
        data.start.callSid
      );
      if (!metadata) {
        closeSocket(1008, 'Unknown or expired call');
        return;
      }
      try {
        const { provider, taskPrompt, to = 'unknown', smartIvr = false, ivrHistory = [] } = metadata;
        appendCallEvent(data.start.callSid, {
          type: 'voice_stream_start',
          text: `Media stream connected, starting ${provider} bridge`,
          meta: promptLogMeta(taskPrompt, { streamSid: data.start.streamSid, provider })
        });
        bridge = createBridge(provider, {
          env,
          taskPrompt,
          callSid: data.start.callSid,
          smartIvr,
          ivrHistory,
          onPressDigit: (request) => pressDigit({
            ...request,
            callSid: data.start.callSid,
            metadata
          }),
          onConversationStart: () => {
            humanHandoffObserved = true;
            appendCallEvent(data.start.callSid, {
              type: 'ivr_human_handoff',
              text: 'Verified a live human and enabled conversational audio'
            });
          },
          onTranscript: (text) => appendCallEvent(
            data.start.callSid,
            transcriptLogEvent('caller', text, provider)
          ),
          onAgentResponse: (text) => appendCallEvent(
            data.start.callSid,
            transcriptLogEvent('agent', text, provider)
          ),
          onWarning: (warning) => appendCallEvent(data.start.callSid, {
            type: 'voice_provider_warning',
            text: 'Voice provider rejected an unsafe or unverified model action and kept listening',
            meta: { provider, warning: warning.message }
          }),
          onError: (err) => {
            appendCallEvent(data.start.callSid, {
              type: 'voice_provider_error',
              text: 'Voice provider error',
              meta: { provider, error: err.message }
            });
            closeBridge();
            closeSocket(1011, 'Voice provider error');
          },
          onEnd: (transcript, providerMeta = {}) => {
            if (transcriptFinalized) return;
            transcriptFinalized = true;
            try {
              saveTranscript(data.start.callSid, {
                streamSid: data.start.streamSid, provider, transcript,
                endReason: providerMeta.endReason || null,
                mode: smartIvr ? 'smart-ivr' : 'direct', humanHandoffObserved
              });
              appendCallEvent(data.start.callSid, {
                type: 'transcript_archived', text: 'Stored transcript in the private encrypted archive',
                meta: { provider, turns: transcript.length }
              });
            } catch {
              appendCallEvent(data.start.callSid, {
                type: 'transcript_archive_error', text: 'Private transcript archive write failed', meta: { provider }
              });
            }
            appendCallEvent(data.start.callSid, {
              type: 'voice_conversation_end',
              text: `${provider} conversation ended`,
              meta: { provider, turns: transcript.length, ...providerMeta }
            });
            if (providerMeta.endReason === 'ivr_dtmf') {
              appendCallEvent(data.start.callSid, {
                type: 'ivr_handoff',
                text: 'Voice stream ended for model-selected DTMF handoff'
              });
              return;
            }
            // Hang up the Twilio call so the line does not sit open with dead
            // air after the conversation ends. Closing the media socket alone
            // does not terminate the phone call.
            Promise.resolve(hangUpCall(data.start.callSid)).then(() => {
              appendCallEvent(data.start.callSid, {
                type: 'call_hangup',
                text: 'Twilio call ended after conversation completed'
              });
            }).catch((err) => {
              appendCallEvent(data.start.callSid, {
                type: 'call_hangup_error',
                text: 'Twilio hangup failed',
                meta: { error: err.message }
              });
            });
            sendTelegramSummary(data.start.callSid, to, transcript).catch(() => {
              appendCallEvent(data.start.callSid, {
                type: 'telegram_summary_error',
                text: 'Telegram summary delivery failed'
              });
            });
          }
        });
        bridge.setTwilioStream(ws, data.start.streamSid);
        Promise.resolve(bridge.connect()).catch((err) => {
          appendCallEvent(data.start.callSid, {
            type: 'voice_provider_connect_error',
            text: 'Voice provider connection failed',
            meta: { provider, error: err.message }
          });
          closeBridge();
          closeSocket(1011, 'Voice provider connection failed');
        });
      } catch (err) {
        bridge = null;
        appendCallEvent(data.start?.callSid || 'unknown', {
          type: 'bridge_construction_error',
          text: 'Voice bridge unavailable',
          meta: { error: err.message }
        });
        closeSocket(1011, 'Voice bridge unavailable');
      }
      return;
    }

    if (data.event === 'media') {
      const payload = data.media?.payload;
      if (!bridge || data.streamSid !== boundStreamSid ||
          typeof payload !== 'string' || !payload ||
          payload.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
        closeBridge();
        closeSocket(1008, 'Invalid media event');
        return;
      }
      try {
        bridge.sendAudio(payload);
      } catch (err) {
        closeBridge();
        closeSocket(1011, 'Audio relay failed');
      }
      return;
    }

    if (data.event === 'stop') closeBridge();
  });

  ws.on('error', closeBridge);
  ws.on('close', closeBridge);
}

module.exports = { attachMediaStreamSession, isValidStart };
