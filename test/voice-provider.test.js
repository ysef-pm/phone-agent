const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveVoiceProvider } = require('../src/voice-provider');

test('defaults to ElevenLabs so rollback is fail-safe', () => {
  assert.equal(resolveVoiceProvider(undefined, {}), 'elevenlabs');
  assert.equal(resolveVoiceProvider(undefined, {
    VOICE_PROVIDER: 'gpt-live',
    GPT_LIVE_PILOT_ENABLED: 'true',
    OPENAI_API_KEY: 'configured'
  }), 'elevenlabs');
});

test('allows an explicitly enabled GPT-Live pilot call', () => {
  assert.equal(resolveVoiceProvider('gpt-live', {
    GPT_LIVE_PILOT_ENABLED: 'true',
    OPENAI_API_KEY: 'configured'
  }), 'gpt-live');
});

test('rejects GPT-Live when the pilot kill switch is off', () => {
  assert.throws(
    () => resolveVoiceProvider('gpt-live', {
      GPT_LIVE_PILOT_ENABLED: 'false',
      OPENAI_API_KEY: 'configured'
    }),
    (error) => error.code === 'GPT_LIVE_DISABLED' && error.statusCode === 503
  );
});

test('rejects GPT-Live when its credential is missing', () => {
  assert.throws(
    () => resolveVoiceProvider('gpt-live', { GPT_LIVE_PILOT_ENABLED: 'true' }),
    (error) => error.code === 'GPT_LIVE_NOT_CONFIGURED' && error.statusCode === 503
  );
});

test('rejects unknown providers instead of silently changing behavior', () => {
  assert.throws(
    () => resolveVoiceProvider('other', {}),
    (error) => error.code === 'INVALID_VOICE_PROVIDER' && error.statusCode === 400
  );
});
