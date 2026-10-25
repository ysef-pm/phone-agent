class VoiceProviderError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = 'VoiceProviderError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function enabled(value) {
  return String(value || '').toLowerCase() === 'true';
}

function resolveVoiceProvider(requestedProvider, env = process.env) {
  const provider = requestedProvider || 'elevenlabs';

  if (!['elevenlabs', 'gpt-live'].includes(provider)) {
    throw new VoiceProviderError(
      'Unsupported voice provider',
      'INVALID_VOICE_PROVIDER',
      400
    );
  }

  if (provider === 'gpt-live') {
    if (!enabled(env.GPT_LIVE_PILOT_ENABLED)) {
      throw new VoiceProviderError(
        'GPT-Live pilot is disabled',
        'GPT_LIVE_DISABLED',
        503
      );
    }
    if (!env.OPENAI_API_KEY) {
      throw new VoiceProviderError(
        'GPT-Live is not configured',
        'GPT_LIVE_NOT_CONFIGURED',
        503
      );
    }
  }

  return provider;
}

module.exports = { resolveVoiceProvider, VoiceProviderError };
