const test = require('node:test');
const assert = require('node:assert/strict');
const { GPTLiveBridge } = require('../src/gpt-live-bridge');

test('marks generated IVR-mode agent text as suppressed instead of claiming it was spoken', () => {
  const bridge = new GPTLiveBridge({ apiKey: 'unit-test-only-no-network', smartIvr: true });
  bridge._addFragment('agent', { delta: 'TEST ONLY: muted text', start_ms: 0, end_ms: 100 });
  bridge.smartIvr = false;
  bridge._addFragment('agent', { delta: 'TEST ONLY: unmuted text', start_ms: 200, end_ms: 300 });
  assert.deepEqual(bridge._buildTranscript(), [
    { role: 'agent', text: 'TEST ONLY: muted text', audioSuppressed: true },
    { role: 'agent', text: 'TEST ONLY: unmuted text' }
  ]);
});
