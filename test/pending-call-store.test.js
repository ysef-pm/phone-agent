const test = require('node:test');
const assert = require('node:assert/strict');

const { PendingCallStore } = require('../src/pending-call-store');

test('expires pending call metadata after the configured TTL', () => {
  let now = 1000;
  const store = new PendingCallStore({ ttlMs: 5000, now: () => now });
  store.set('CA123', { taskPrompt: 'private task' });
  now = 6001;

  assert.equal(store.take('CA123'), undefined);
  assert.equal(store.size, 0);
});

test('binds a token to one CallSid and atomically rejects mismatched stream starts', () => {
  const store = new PendingCallStore({ ttlMs: 5000, now: () => 1000 });
  const callA = `CA${'a'.repeat(32)}`;
  const callB = `CA${'b'.repeat(32)}`;
  store.set('token-123456789012', { provider: 'gpt-live' });

  assert.equal(store.bindExpectedCallSid('token-123456789012', callA), true);
  assert.equal(store.bindExpectedCallSid('token-123456789012', callB), false);
  assert.equal(store.takeForCall('token-123456789012', callB), undefined);
  assert.equal(store.size, 1);
  assert.deepEqual(store.takeForCall('token-123456789012', callA), { provider: 'gpt-live', expectedCallSid: callA });
  assert.equal(store.size, 0);
});

test('taking or deleting pending call metadata cleans it up', () => {
  const store = new PendingCallStore({ ttlMs: 5000, now: () => 1000 });
  store.set('CA1', { provider: 'elevenlabs' });
  store.set('CA2', { provider: 'gpt-live' });

  assert.deepEqual(store.take('CA1'), { provider: 'elevenlabs' });
  assert.equal(store.take('CA1'), undefined);
  assert.equal(store.delete('CA2'), true);
  assert.equal(store.size, 0);
});
