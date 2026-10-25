const test = require('node:test');
const assert = require('node:assert/strict');

const { ElevenLabsBridge } = require('../src/elevenlabs-bridge');

test('does not print transcript content to process logs', () => {
  const logged = [];
  const originalLog = console.log;
  const seen = [];
  console.log = (...args) => logged.push(args.join(' '));
  try {
    const bridge = new ElevenLabsBridge({
      onTranscript: (text) => seen.push(text),
      onAgentResponse: (text) => seen.push(text)
    });
    bridge._handleMessage({
      type: 'user_transcript',
      user_transcription_event: { user_transcript: 'private caller secret' }
    });
    bridge._handleMessage({
      type: 'agent_response',
      agent_response_event: { agent_response: 'private agent secret' }
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(seen, ['private caller secret', 'private agent secret']);
  assert.doesNotMatch(logged.join('\n'), /private|secret/);
});
