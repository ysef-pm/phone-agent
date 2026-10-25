const test = require('node:test');
const assert = require('node:assert/strict');

const { promptLogMeta, transcriptLogEvent } = require('../src/logging-policy');

test('does not include task prompt content in log metadata', () => {
  const secret = 'account password is hunter2';
  const serialized = JSON.stringify(promptLogMeta(secret, { provider: 'elevenlabs' }));

  assert.doesNotMatch(serialized, /hunter2|account password/);
  assert.deepEqual(promptLogMeta(secret, { provider: 'elevenlabs' }), {
    provider: 'elevenlabs',
    promptChars: secret.length
  });
});

test('does not include transcript content in log events', () => {
  const secret = 'my card number is 4111111111111111';
  const event = transcriptLogEvent('caller', secret, 'gpt-live');

  assert.doesNotMatch(JSON.stringify(event), /4111111111111111/);
  assert.deepEqual(event, {
    type: 'caller_transcript_activity',
    text: 'Caller transcript activity',
    meta: { provider: 'gpt-live', chars: secret.length }
  });
});
