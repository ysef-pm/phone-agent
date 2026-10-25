const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { attachMediaStreamSession } = require('../src/media-stream-session');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.closeCalls = [];
  }
  close(code, reason) { this.closeCalls.push([code, reason]); }
}

test('closes the media socket safely when a message is malformed JSON', () => {
  const ws = new FakeSocket();
  attachMediaStreamSession(ws, {});

  ws.emit('message', Buffer.from('{not json'));

  assert.deepEqual(ws.closeCalls, [[1003, 'Invalid JSON']]);
});

test('rejects malformed start data before constructing a provider bridge', () => {
  const ws = new FakeSocket();
  let created = 0;
  attachMediaStreamSession(ws, { createBridge: () => { created += 1; } });

  ws.emit('message', JSON.stringify({ event: 'start', start: { callSid: '../../escape' } }));

  assert.equal(created, 0);
  assert.deepEqual(ws.closeCalls, [[1008, 'Invalid start event']]);
});

test('uses the opaque per-call token rather than CallSid for pending metadata', () => {
  const ws = new FakeSocket();
  const taken = [];
  let created = 0;
  attachMediaStreamSession(ws, {
    pendingCalls: {
      takeForCall: (key) => {
        taken.push(key);
        return key === 'pilot-token-123456' ? { taskPrompt: 'task', provider: 'elevenlabs' } : undefined;
      }
    },
    createBridge: () => {
      created += 1;
      return { setTwilioStream() {}, connect() {}, close() {} };
    }
  });

  ws.emit('message', JSON.stringify({
    event: 'start',
    start: {
      callSid: `CA${'a'.repeat(32)}`,
      streamSid: `MZ${'b'.repeat(32)}`,
      customParameters: { callToken: 'pilot-token-123456' }
    }
  }));

  assert.deepEqual(taken, ['pilot-token-123456']);
  assert.equal(created, 1);
});

test('rejects valid-looking starts that have no pending call token metadata', () => {
  const ws = new FakeSocket();
  let created = 0;
  attachMediaStreamSession(ws, {
    pendingCalls: { takeForCall: () => undefined },
    createBridge: () => { created += 1; }
  });

  ws.emit('message', JSON.stringify({
    event: 'start',
    start: {
      callSid: `CA${'a'.repeat(32)}`,
      streamSid: `MZ${'b'.repeat(32)}`,
      customParameters: { callToken: 'unknown-token-123456' }
    }
  }));

  assert.equal(created, 0);
  assert.deepEqual(ws.closeCalls, [[1008, 'Unknown or expired call']]);
});

test('fails closed when bridge construction throws', () => {
  const ws = new FakeSocket();
  attachMediaStreamSession(ws, {
    pendingCalls: { takeForCall: () => ({ taskPrompt: 'task', to: '+31000', provider: 'elevenlabs' }) },
    createBridge: () => { throw new Error('constructor failed'); }
  });

  ws.emit('message', JSON.stringify({
    event: 'start',
    start: { callSid: `CA${'a'.repeat(32)}`, streamSid: `MZ${'b'.repeat(32)}`, customParameters: { callToken: 'pilot-token-123456456' } }
  }));

  assert.deepEqual(ws.closeCalls, [[1011, 'Voice bridge unavailable']]);
});

test('closes the bridge and socket when provider connection fails', async () => {
  const ws = new FakeSocket();
  let closed = 0;
  const bridge = {
    setTwilioStream() {},
    connect: async () => { throw new Error('connect failed'); },
    close: () => { closed += 1; }
  };
  attachMediaStreamSession(ws, {
    pendingCalls: { takeForCall: () => ({ taskPrompt: 'task', to: '+31000', provider: 'elevenlabs' }) },
    createBridge: () => bridge
  });

  ws.emit('message', JSON.stringify({
    event: 'start',
    start: { callSid: `CA${'a'.repeat(32)}`, streamSid: `MZ${'b'.repeat(32)}`, customParameters: { callToken: 'pilot-token-123456456' } }
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closed, 1);
  assert.deepEqual(ws.closeCalls, [[1011, 'Voice provider connection failed']]);
});

test('relays a valid media frame bound to the started streamSid', () => {
  const ws = new FakeSocket();
  const audio = [];
  const bridge = {
    setTwilioStream() {}, connect() {}, sendAudio: (p) => audio.push(p), close() {}
  };
  attachMediaStreamSession(ws, {
    pendingCalls: { takeForCall: () => ({ taskPrompt: 'task', provider: 'elevenlabs' }) },
    createBridge: () => bridge
  });
  ws.emit('message', JSON.stringify({
    event: 'start',
    start: { callSid: `CA${'a'.repeat(32)}`, streamSid: `MZ${'b'.repeat(32)}`, customParameters: { callToken: 'pilot-token-123456' } }
  }));

  ws.emit('message', JSON.stringify({ event: 'media', streamSid: `MZ${'b'.repeat(32)}`, media: { payload: 'AAAA' } }));

  assert.deepEqual(audio, ['AAAA']);
  assert.deepEqual(ws.closeCalls, []);
});

test('rejects a media frame whose streamSid does not match the start', () => {
  const ws = new FakeSocket();
  let closed = 0;
  const bridge = {
    setTwilioStream() {}, connect() {}, sendAudio() {}, close: () => { closed += 1; }
  };
  attachMediaStreamSession(ws, {
    pendingCalls: { takeForCall: () => ({ taskPrompt: 'task', provider: 'elevenlabs' }) },
    createBridge: () => bridge
  });
  ws.emit('message', JSON.stringify({
    event: 'start',
    start: { callSid: `CA${'a'.repeat(32)}`, streamSid: `MZ${'b'.repeat(32)}`, customParameters: { callToken: 'pilot-token-123456' } }
  }));

  ws.emit('message', JSON.stringify({ event: 'media', streamSid: `MZ${'c'.repeat(32)}`, media: { payload: 'AAAA' } }));

  assert.equal(closed, 1);
  assert.deepEqual(ws.closeCalls, [[1008, 'Invalid media event']]);
});

test('rejects malformed media payloads and closes the active bridge', () => {
  const ws = new FakeSocket();
  let closed = 0;
  const bridge = {
    setTwilioStream() {}, connect() {}, sendAudio() {}, close: () => { closed += 1; }
  };
  attachMediaStreamSession(ws, {
    pendingCalls: { takeForCall: () => ({ taskPrompt: 'task', provider: 'elevenlabs' }) },
    createBridge: () => bridge
  });
  ws.emit('message', JSON.stringify({
    event: 'start',
    start: { callSid: `CA${'a'.repeat(32)}`, streamSid: `MZ${'b'.repeat(32)}`, customParameters: { callToken: 'pilot-token-123456456' } }
  }));

  ws.emit('message', JSON.stringify({ event: 'media', media: {} }));

  assert.equal(closed, 1);
  assert.deepEqual(ws.closeCalls, [[1008, 'Invalid media event']]);
});

test('rejects duplicate starts and closes one bridge exactly once', () => {
  const ws = new FakeSocket();
  let created = 0;
  let closed = 0;
  attachMediaStreamSession(ws, {
    pendingCalls: { takeForCall: () => ({ taskPrompt: 'task', provider: 'elevenlabs' }) },
    createBridge: () => {
      created += 1;
      return { setTwilioStream() {}, connect() {}, close: () => { closed += 1; } };
    }
  });
  const start = JSON.stringify({
    event: 'start',
    start: { callSid: `CA${'a'.repeat(32)}`, streamSid: `MZ${'b'.repeat(32)}`, customParameters: { callToken: 'pilot-token-123456456' } }
  });

  ws.emit('message', start);
  ws.emit('message', start);

  assert.equal(created, 1);
  assert.equal(closed, 1);
  assert.deepEqual(ws.closeCalls, [[1008, 'Duplicate start event']]);
});

test('handles duplicate stops, socket errors, and premature closes idempotently', () => {
  const ws = new FakeSocket();
  let closed = 0;
  attachMediaStreamSession(ws, {
    pendingCalls: { takeForCall: () => ({ taskPrompt: 'task', provider: 'elevenlabs' }) },
    createBridge: () => ({
      setTwilioStream() {}, connect() {}, close: () => { closed += 1; }
    })
  });
  ws.emit('message', JSON.stringify({
    event: 'start',
    start: { callSid: `CA${'a'.repeat(32)}`, streamSid: `MZ${'b'.repeat(32)}`, customParameters: { callToken: 'pilot-token-123456456' } }
  }));

  ws.emit('message', JSON.stringify({ event: 'stop' }));
  ws.emit('message', JSON.stringify({ event: 'stop' }));
  ws.emit('error', new Error('socket failed'));
  ws.emit('close');

  assert.equal(closed, 1);
});

test('hangs up the Twilio call when the conversation ends', async () => {
  const ws = new FakeSocket();
  const hangUpCalls = [];
  let endCallback;
  const bridge = {
    setTwilioStream() {}, connect() {}, close() {},
  };
  attachMediaStreamSession(ws, {
    pendingCalls: { takeForCall: () => ({ taskPrompt: 'task', to: '+31000', provider: 'gpt-live' }) },
    createBridge: (provider, opts) => { endCallback = opts.onEnd; return bridge; },
    hangUpCall: (callSid) => { hangUpCalls.push(callSid); return Promise.resolve(); }
  });
  ws.emit('message', JSON.stringify({
    event: 'start',
    start: { callSid: `CA${'a'.repeat(32)}`, streamSid: `MZ${'b'.repeat(32)}`, customParameters: { callToken: 'pilot-token-123456456' } }
  }));

  endCallback([{ role: 'user', text: 'I am at home' }], { provider: 'gpt-live' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(hangUpCalls, [`CA${'a'.repeat(32)}`]);
});

test('hands a model-selected IVR digit to the application without hanging up the call', async () => {
  const ws = new FakeSocket();
  const presses = [];
  const hangUps = [];
  let pressCallback;
  let endCallback;
  attachMediaStreamSession(ws, {
    pendingCalls: { takeForCall: () => ({ taskPrompt: 'map menu', to: '+31000', provider: 'gpt-live', smartIvr: true, ivrHops: 0 }) },
    createBridge: (provider, opts) => {
      pressCallback = opts.onPressDigit;
      endCallback = opts.onEnd;
      return { setTwilioStream() {}, connect() {}, close() {} };
    },
    pressDigit: async (request) => { presses.push(request); },
    hangUpCall: async (callSid) => { hangUps.push(callSid); }
  });
  ws.emit('message', JSON.stringify({
    event: 'start',
    start: { callSid: `CA${'a'.repeat(32)}`, streamSid: `MZ${'b'.repeat(32)}`, customParameters: { callToken: 'pilot-token-123456456' } }
  }));

  await pressCallback({ digit: '1', heardOption: 'English', transcript: [{ role: 'user', text: 'Press 1 for English' }] });
  endCallback([], { provider: 'gpt-live', endReason: 'ivr_dtmf' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(presses.length, 1);
  assert.equal(presses[0].callSid, `CA${'a'.repeat(32)}`);
  assert.equal(presses[0].digit, '1');
  assert.equal(presses[0].metadata.smartIvr, true);
  assert.deepEqual(hangUps, []);
});

for (const provider of ['gpt-live', 'elevenlabs']) {
  test(`archives ${provider} speech once before sending Telegram, even when delivery fails`, async () => {
    const ws = new FakeSocket();
    const saved = [];
    let options;
    let summaries = 0;
    attachMediaStreamSession(ws, {
      pendingCalls: { takeForCall: () => ({ taskPrompt: 'PRIVATE TASK PROMPT', provider }) },
      createBridge: (_provider, opts) => { options = opts; return { setTwilioStream() {}, connect() {}, close() {} }; },
      saveTranscript: (sid, entry) => { saved.push({ sid, entry }); },
      sendTelegramSummary: async () => { assert.equal(saved.length, 1); summaries += 1; throw new Error('Telegram unavailable'); }
    });
    ws.emit('message', JSON.stringify({ event: 'start', start: { callSid: `CA${'a'.repeat(32)}`, streamSid: `MZ${'b'.repeat(32)}`, customParameters: { callToken: 'pilot-token-123456' } } }));
    const transcript = [{ role: 'user', text: 'TEST ONLY: please resend the confirmation.' }];
    options.onEnd(transcript, { endReason: null });
    options.onEnd(transcript, { endReason: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].sid, `CA${'a'.repeat(32)}`);
    assert.deepEqual(saved[0].entry.transcript, transcript);
    assert.equal(saved[0].entry.provider, provider);
    assert.equal(saved[0].entry.streamSid, `MZ${'b'.repeat(32)}`);
    assert.ok(!JSON.stringify(saved).includes('PRIVATE TASK PROMPT'));
    assert.equal(summaries, 1);
  });
}

test('archives the partial transcript before an IVR stream handoff returns', () => {
  const ws = new FakeSocket();
  const saved = [];
  let options;
  attachMediaStreamSession(ws, {
    pendingCalls: { takeForCall: () => ({ provider: 'gpt-live', smartIvr: true }) },
    createBridge: (_provider, opts) => { options = opts; return { setTwilioStream() {}, connect() {}, close() {} }; },
    saveTranscript: (sid, entry) => saved.push({ sid, entry })
  });
  ws.emit('message', JSON.stringify({ event: 'start', start: { callSid: `CA${'a'.repeat(32)}`, streamSid: `MZ${'b'.repeat(32)}`, customParameters: { callToken: 'pilot-token-123456' } } }));
  options.onEnd([{ role: 'user', text: 'TEST ONLY: press 1 for reception' }], { endReason: 'ivr_dtmf' });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].entry.endReason, 'ivr_dtmf');
  assert.equal(saved[0].entry.mode, 'smart-ivr');
  assert.equal(saved[0].entry.humanHandoffObserved, false);
});

test('archive failure cannot prevent hangup or leak speech into metadata logs', async () => {
  const ws = new FakeSocket();
  const events = [];
  let options;
  let hangups = 0;
  attachMediaStreamSession(ws, {
    pendingCalls: { takeForCall: () => ({ provider: 'gpt-live' }) },
    createBridge: (_provider, opts) => { options = opts; return { setTwilioStream() {}, connect() {}, close() {} }; },
    saveTranscript: () => { throw new Error('PRIVATE TRANSCRIPT BODY'); },
    appendCallEvent: (_sid, event) => events.push(event),
    hangUpCall: async () => { hangups += 1; }
  });
  ws.emit('message', JSON.stringify({ event: 'start', start: { callSid: `CA${'a'.repeat(32)}`, streamSid: `MZ${'b'.repeat(32)}`, customParameters: { callToken: 'pilot-token-123456' } } }));
  options.onEnd([{ role: 'agent', text: 'PRIVATE TRANSCRIPT BODY' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hangups, 1);
  assert.ok(events.some((e) => e.type === 'transcript_archive_error'));
  assert.ok(!JSON.stringify(events).includes('PRIVATE TRANSCRIPT BODY'));
});

module.exports = { FakeSocket };
