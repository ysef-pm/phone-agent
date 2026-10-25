const test = require('node:test');
const assert = require('node:assert/strict');

const { createVoiceBridge } = require('../src/voice-bridge-factory');
const { ElevenLabsBridge } = require('../src/elevenlabs-bridge');
const { GPTLiveBridge } = require('../src/gpt-live-bridge');

const common = {
  taskPrompt: 'Collect a menu URL',
  callSid: 'CAtest',
  onEnd: () => {}
};

test('creates the unchanged ElevenLabs bridge for rollback calls', () => {
  const bridge = createVoiceBridge('elevenlabs', {
    ...common,
    env: { ELEVENLABS_AGENT_ID: 'agent', ELEVENLABS_API_KEY: 'key' }
  });
  assert.ok(bridge instanceof ElevenLabsBridge);
});

test('creates GPT-Live with independently configurable voice and backend', () => {
  const bridge = createVoiceBridge('gpt-live', {
    ...common,
    env: {
      OPENAI_API_KEY: 'openai-key',
      GPT_LIVE_PILOT_ENABLED: 'true',
      GPT_LIVE_MODEL: 'gpt-live-1',
      GPT_LIVE_BACKEND_MODEL: 'gpt-5.6-luna',
      GPT_LIVE_VOICE: 'willow'
    }
  });
  assert.ok(bridge instanceof GPTLiveBridge);
  assert.equal(bridge.backendModel, 'gpt-5.6-luna');
  assert.equal(bridge.voice, 'willow');
});

test('rechecks the GPT-Live kill switch when the queued stream actually starts', () => {
  assert.throws(
    () => createVoiceBridge('gpt-live', {
      ...common,
      env: { OPENAI_API_KEY: 'configured', GPT_LIVE_PILOT_ENABLED: 'false' }
    }),
    /disabled/i
  );
});

test('fails closed when a required provider credential is missing', () => {
  assert.throws(
    () => createVoiceBridge('elevenlabs', { ...common, env: {} }),
    /Missing ElevenLabs credentials/
  );
  assert.throws(
    () => createVoiceBridge('gpt-live', { ...common, env: {} }),
    /Missing OpenAI credential/
  );
});
