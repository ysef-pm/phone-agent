require('dotenv').config();
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');
const { createVoiceBridge } = require('./voice-bridge-factory');
const { resolveVoiceProvider } = require('./voice-provider');
const { appendCallEvent } = require('./logger');
const { PendingCallStore } = require('./pending-call-store');
const { sendTelegramSummary } = require('./telegram');
const { promptLogMeta } = require('./logging-policy');
const { buildStreamTwiml, sanitizeDialDigits } = require('./twiml');
const { attachMediaStreamSession } = require('./media-stream-session');
const { createSmartIvrDigitHandler } = require('./smart-ivr-dtmf');
const { CallTranscriptStore } = require('./call-transcript-store');
const { createTranscriptRouter } = require('./transcript-routes');
const {
  MIN_MEDIA_TOKEN_LENGTH,
  createTwilioSignatureMiddleware,
  isAuthorizedMediaStreamRequest,
  buildMediaStreamUrl
} = require('./security');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Startup validation
if (!/^https:\/\//i.test(BASE_URL) && !/^http:\/\/(127\.0\.0\.1|localhost)/i.test(BASE_URL)) {
  console.error(`BASE_URL must use HTTPS for production: ${BASE_URL}`);
  process.exit(1);
}
if (!process.env.MEDIA_STREAM_TOKEN || process.env.MEDIA_STREAM_TOKEN.length < MIN_MEDIA_TOKEN_LENGTH) {
  console.error(`MEDIA_STREAM_TOKEN must be at least ${MIN_MEDIA_TOKEN_LENGTH} characters`);
  process.exit(1);
}
if (process.env.MEDIA_STREAM_TOKEN.includes('change-me') || process.env.MEDIA_STREAM_TOKEN.includes('example')) {
  console.error('MEDIA_STREAM_TOKEN must not contain placeholder values');
  process.exit(1);
}
if (!process.env.OUTBOUND_API_TOKEN || process.env.OUTBOUND_API_TOKEN.length < 16) {
  console.error('OUTBOUND_API_TOKEN must be at least 16 characters');
  process.exit(1);
}
if (process.env.OUTBOUND_API_TOKEN.includes('change-me')) {
  console.error('OUTBOUND_API_TOKEN must not contain placeholder values');
  process.exit(1);
}
if (!process.env.TRANSCRIPT_API_TOKEN || process.env.TRANSCRIPT_API_TOKEN.length < 32) {
  console.error('TRANSCRIPT_API_TOKEN must be at least 32 characters');
  process.exit(1);
}
if (process.env.TRANSCRIPT_API_TOKEN.includes('change-me') || process.env.TRANSCRIPT_API_TOKEN === process.env.OUTBOUND_API_TOKEN) {
  console.error('TRANSCRIPT_API_TOKEN must be unique and not contain placeholder values');
  process.exit(1);
}

const OUTBOUND_ALLOWLIST = (process.env.OUTBOUND_ALLOWLIST || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

// Store pending call prompts and metadata with bounded lifetime.
const pendingCallTtlMs = Number(process.env.PENDING_CALL_TTL_MS || 15 * 60 * 1000);
if (!Number.isFinite(pendingCallTtlMs) || pendingCallTtlMs <= 0) {
  console.error(`PENDING_CALL_TTL_MS must be finite positive number, got: ${process.env.PENDING_CALL_TTL_MS}`);
  process.exit(1);
}
const callPrompts = new PendingCallStore({
  ttlMs: pendingCallTtlMs
});
const transcriptRetentionMs = Number(process.env.TRANSCRIPT_RETENTION_MS || 7 * 24 * 60 * 60 * 1000);
const transcriptStore = new CallTranscriptStore({
  dir: process.env.TRANSCRIPT_DIR || './data/call-transcripts',
  retentionMs: transcriptRetentionMs
});
const callTokensBySid = new Map();
const pendingCallSids = new Map();
const validateTwilioWebhook = createTwilioSignatureMiddleware({
  authToken: process.env.TWILIO_AUTH_TOKEN,
  baseUrl: BASE_URL
});

function requireOutboundToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const headerToken = req.headers['x-api-token'];
  const provided = bearer || headerToken;

  if (!process.env.OUTBOUND_API_TOKEN) {
    return res.status(500).json({ error: 'OUTBOUND_API_TOKEN is not configured' });
  }

  if (provided !== process.env.OUTBOUND_API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function isAllowedOutboundNumber(to) {
  if (OUTBOUND_ALLOWLIST.includes('*')) return true;
  return OUTBOUND_ALLOWLIST.includes(to);
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'min-phone-agent-v1',
    voiceProviderDefault: process.env.VOICE_PROVIDER || 'elevenlabs',
    gptLivePilotEnabled: String(process.env.GPT_LIVE_PILOT_ENABLED).toLowerCase() === 'true',
    ts: new Date().toISOString()
  });
});

// Authenticated transcript retrieval
app.use('/api/calls', createTranscriptRouter({
  store: transcriptStore,
  token: process.env.TRANSCRIPT_API_TOKEN
}));

// TwiML endpoint that returns <Connect><Stream> for the selected voice bridge.
app.post('/twilio/voice/stream', validateTwilioWebhook, (req, res) => {
  if (!process.env.MEDIA_STREAM_TOKEN || process.env.MEDIA_STREAM_TOKEN.length < MIN_MEDIA_TOKEN_LENGTH) {
    return res.status(500).json({ error: 'MEDIA_STREAM_TOKEN is not securely configured' });
  }

  const callSid = req.body.CallSid || 'unknown';
  const callToken = String(req.query.call_token || '');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(callToken)) {
    return res.status(400).json({ error: 'Missing or invalid call token' });
  }
  if (!callPrompts.bindExpectedCallSid(callToken, callSid)) {
    return res.status(403).json({ error: 'Call token does not match this CallSid' });
  }

  appendCallEvent(callSid, {
    type: 'stream_twiml',
    text: 'Returning authenticated media-stream TwiML',
    meta: { from: req.body.From, to: req.body.To }
  });

  const preDialDigits = sanitizeDialDigits(String(req.query.pre_dial_digits || ''));
  if (preDialDigits) {
    appendCallEvent(callSid, {
      type: 'pre_dial_digits',
      text: 'Sending IVR pre-dial digits before connecting the stream',
      meta: { digits: preDialDigits }
    });
  }

  const wsUrl = buildMediaStreamUrl(BASE_URL, process.env.MEDIA_STREAM_TOKEN);
  const twiml = buildStreamTwiml(wsUrl, callToken, preDialDigits);

  res.type('text/xml').send(twiml);
});

// Outbound call endpoint
app.post('/api/calls/outbound', requireOutboundToken, async (req, res) => {
  const { to, prompt, provider: requestedProvider, preDialDigits: rawDigits, smartIvr: rawSmartIvr } = req.body;

  if (!to) {
    return res.status(400).json({ error: 'Missing required field: to' });
  }

  if (!isAllowedOutboundNumber(to)) {
    return res.status(403).json({
      error: 'Number not in allowlist',
      to,
      hint: 'Add this number to OUTBOUND_ALLOWLIST in .env'
    });
  }

  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
    return res.status(500).json({ error: 'Missing Twilio credentials in env' });
  }

  let provider;
  try {
    provider = resolveVoiceProvider(requestedProvider, process.env);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message, code: error.code });
  }

  const smartIvr = rawSmartIvr === undefined ? false : rawSmartIvr;
  if (typeof smartIvr !== 'boolean') {
    return res.status(400).json({ error: 'smartIvr must be a boolean' });
  }
  if (smartIvr && provider !== 'gpt-live') {
    return res.status(400).json({ error: 'smartIvr requires provider="gpt-live"' });
  }

  if (provider === 'elevenlabs' && (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_AGENT_ID)) {
    return res.status(500).json({ error: 'Missing ElevenLabs credentials in env' });
  }

  const taskPrompt = prompt || 'You are Min, a friendly assistant for Youssef. Have a natural conversation.';
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const callToken = crypto.randomBytes(32).toString('base64url');
  const voiceUrl = new URL('/twilio/voice/stream', BASE_URL);
  voiceUrl.searchParams.set('call_token', callToken);
  const preDialDigits = sanitizeDialDigits(String(rawDigits || ''));
  if (preDialDigits) voiceUrl.searchParams.set('pre_dial_digits', preDialDigits);
  callPrompts.set(callToken, {
    taskPrompt,
    to,
    provider,
    smartIvr,
    ivrHops: 0,
    ivrDigits: [],
    ivrHistory: []
  });

  try {
    const call = await client.calls.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: voiceUrl.toString(),
      statusCallback: `${BASE_URL}/twilio/voice/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });

    pendingCallSids.set(call.sid, Date.now());
    callTokensBySid.set(call.sid, callToken);

    appendCallEvent(call.sid, {
      type: 'outbound_triggered',
      text: `Outbound call created with ${provider}`,
      meta: promptLogMeta(taskPrompt, { to, provider })
    });

    return res.json({ ok: true, callSid: call.sid, status: call.status, provider, smartIvr });
  } catch (error) {
    callPrompts.delete(callToken);
    return res.status(500).json({ error: 'Failed to create call', detail: error.message });
  }
});

// Call status webhook
app.post('/twilio/voice/status', validateTwilioWebhook, (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  if (!callSid) return res.status(204).send();

  if (['completed', 'canceled', 'failed', 'busy', 'no-answer'].includes(callStatus)) {
    const pending = pendingCallSids.get(callSid);
    if (pending && Date.now() - pending < 60000) {
      setTimeout(() => {
        const token = callTokensBySid.get(callSid);
        if (token) callPrompts.delete(token);
        callTokensBySid.delete(callSid);
        pendingCallSids.delete(callSid);
      }, 2000).unref();
      appendCallEvent(callSid, {
        type: 'call_status',
        text: `Call status: ${callStatus} (cleanup delayed)`,
        meta: {
          from: req.body.From,
          to: req.body.To,
          direction: req.body.Direction,
          duration: req.body.CallDuration || null
        }
      });
      return res.status(204).send();
    }
    const token = callTokensBySid.get(callSid);
    if (token) callPrompts.delete(token);
    callTokensBySid.delete(callSid);
    pendingCallSids.delete(callSid);
  }
  appendCallEvent(callSid, {
    type: 'call_status',
    text: `Call status: ${callStatus}`,
    meta: {
      from: req.body.From,
      to: req.body.To,
      direction: req.body.Direction,
      duration: req.body.CallDuration || null
    }
  });
  res.status(204).send();
});

// Create HTTP server and WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  path: '/media-stream',
  maxPayload: 32 * 1024
  // NOTE: Twilio <Stream> cannot send custom headers OR preserve query-string
  // params on the WSS upgrade, so no secret can be validated at the handshake.
  // The real per-call security boundary is the opaque single-use callToken
  // delivered via <Parameter> and validated against pending calls at the
  // start event (see media-stream-session.js). Unauthorized upgrades reach the
  // socket but are rejected at 'start' unless they present a valid live token.
});

// Hang up an in-progress Twilio call by CallSid. Used to end the phone line
// once the voice conversation completes, preventing dead-air / silence loops.
async function hangUpCall(callSid) {
  if (!/^CA[0-9a-f]{32}$/i.test(callSid || '')) return;
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.calls(callSid).update({ status: 'completed' });
}

const configuredSmartIvrMaxHops = Number(process.env.SMART_IVR_MAX_HOPS || 12);
const smartIvrMaxHops = Number.isInteger(configuredSmartIvrMaxHops) && configuredSmartIvrMaxHops > 0
  ? configuredSmartIvrMaxHops
  : 12;
const smartIvrDigitHandler = createSmartIvrDigitHandler({
  pendingCalls: callPrompts,
  createToken: () => crypto.randomBytes(32).toString('base64url'),
  buildWsUrl: () => buildMediaStreamUrl(BASE_URL, process.env.MEDIA_STREAM_TOKEN),
  updateCall: async (callSid, twiml) => {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.calls(callSid).update({ twiml });
  },
  appendCallEvent,
  maxHops: smartIvrMaxHops
});

wss.on('connection', (ws) => {
  attachMediaStreamSession(ws, {
    pendingCalls: callPrompts,
    createBridge: createVoiceBridge,
    env: process.env,
    appendCallEvent,
    sendTelegramSummary,
    saveTranscript: (callSid, segment) => transcriptStore.saveSegment(callSid, segment),
    hangUpCall,
    pressDigit: async (request) => {
      const result = await smartIvrDigitHandler(request);
      callTokensBySid.set(request.callSid, result.token);
      return result;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Min phone agent listening on http://localhost:${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`WebSocket: wss://${new URL(BASE_URL).host}/media-stream`);
});
