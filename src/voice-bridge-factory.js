const { ElevenLabsBridge } = require('./elevenlabs-bridge');
const { GPTLiveBridge } = require('./gpt-live-bridge');

function createVoiceBridge(provider, options) {
  const { env = process.env, ...callbacks } = options;

  if (provider === 'elevenlabs') {
    if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_AGENT_ID) {
      throw new Error('Missing ElevenLabs credentials');
    }
    return new ElevenLabsBridge({
      ...callbacks,
      agentId: env.ELEVENLABS_AGENT_ID,
      apiKey: env.ELEVENLABS_API_KEY
    });
  }

  if (provider === 'gpt-live') {
    if (!env.OPENAI_API_KEY) {
      throw new Error('Missing OpenAI credential');
    }
    if (String(env.GPT_LIVE_PILOT_ENABLED || '').toLowerCase() !== 'true') {
      throw new Error('GPT-Live pilot is disabled');
    }
    return new GPTLiveBridge({
      ...callbacks,
      apiKey: env.OPENAI_API_KEY,
      model: env.GPT_LIVE_MODEL || 'gpt-live-1',
      backendModel: env.GPT_LIVE_BACKEND_MODEL || 'gpt-5.6-luna',
      voice: env.GPT_LIVE_VOICE || 'willow',
      opening: env.GPT_LIVE_OPENING || undefined,
      inactivityTimeoutMs: Number(env.GPT_LIVE_INACTIVITY_MS) || 15000,
      maxCallMs: Number(env.GPT_LIVE_MAX_CALL_MS) || 10 * 60 * 1000
    });
  }

  throw new Error(`Unsupported voice provider: ${provider}`);
}

module.exports = { createVoiceBridge };
