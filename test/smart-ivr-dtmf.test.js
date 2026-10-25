const test = require('node:test');
const assert = require('node:assert/strict');

const { createSmartIvrDigitHandler } = require('../src/smart-ivr-dtmf');

test('replaces the active TwiML with one verified digit and a fresh authenticated stream', async () => {
  const stored = [];
  const updates = [];
  const handler = createSmartIvrDigitHandler({
    pendingCalls: {
      set: (token, metadata) => stored.push([token, metadata]),
      delete: () => {}
    },
    createToken: () => 'fresh-token-123456789',
    buildWsUrl: () => 'wss://example.test/media-stream',
    updateCall: async (callSid, twiml) => updates.push([callSid, twiml]),
    appendCallEvent: () => {}
  });

  await handler({
    callSid: `CA${'a'.repeat(32)}`,
    digit: '1',
    heardOption: 'To continue in English, press 1.',
    transcript: [{ role: 'user', text: 'To continue in English, press 1.' }],
    metadata: { provider: 'gpt-live', taskPrompt: 'map menu', to: '+31880000000', smartIvr: true, ivrHops: 0, ivrHistory: [] }
  });

  assert.equal(stored.length, 1);
  assert.equal(stored[0][0], 'fresh-token-123456789');
  assert.equal(stored[0][1].ivrHops, 1);
  assert.equal(stored[0][1].expectedCallSid, `CA${'a'.repeat(32)}`);
  assert.deepEqual(stored[0][1].ivrDigits, ['1']);
  assert.match(stored[0][1].ivrHistory.at(-1).heardOption, /English/);
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0], `CA${'a'.repeat(32)}`);
  assert.ok(updates[0][1].indexOf('<Play digits="1">') < updates[0][1].indexOf('<Connect>'));
  assert.doesNotMatch(updates[0][1], /<Play digits="[wW]+1">/);
  assert.match(updates[0][1], /fresh-token-123456789/);
});

test('rejects invalid digits and excessive IVR handoffs before updating Twilio', async () => {
  let updates = 0;
  const handler = createSmartIvrDigitHandler({
    pendingCalls: { set() {}, delete() {} },
    createToken: () => 'fresh-token-123456789',
    buildWsUrl: () => 'wss://example.test/media-stream',
    updateCall: async () => { updates += 1; },
    appendCallEvent: () => {},
    maxHops: 2
  });
  const base = {
    callSid: `CA${'a'.repeat(32)}`,
    heardOption: 'option', transcript: [],
    metadata: { provider: 'gpt-live', taskPrompt: 'map', smartIvr: true, ivrHops: 0 }
  };

  await assert.rejects(handler({ ...base, digit: '12' }), /Invalid IVR digit/);
  await assert.rejects(handler({ ...base, digit: '1', metadata: { ...base.metadata, ivrHops: 2 } }), /hop limit/);
  assert.equal(updates, 0);
});

test('deletes the fresh pending token if Twilio rejects the handoff', async () => {
  const deleted = [];
  const handler = createSmartIvrDigitHandler({
    pendingCalls: { set() {}, delete: (token) => deleted.push(token) },
    createToken: () => 'fresh-token-123456789',
    buildWsUrl: () => 'wss://example.test/media-stream',
    updateCall: async () => { throw new Error('Twilio failed'); },
    appendCallEvent: () => {}
  });

  await assert.rejects(handler({
    callSid: `CA${'a'.repeat(32)}`,
    digit: '1', heardOption: 'English', transcript: [],
    metadata: { provider: 'gpt-live', taskPrompt: 'map', smartIvr: true, ivrHops: 0 }
  }), /Twilio failed/);
  assert.deepEqual(deleted, ['fresh-token-123456789']);
});
