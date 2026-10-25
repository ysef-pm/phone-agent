'use strict';

const { buildImmediateDtmfStreamTwiml } = require('./twiml');

function createSmartIvrDigitHandler({
  pendingCalls,
  createToken,
  buildWsUrl,
  updateCall,
  appendCallEvent = () => {},
  maxHops = 12
}) {
  if (!pendingCalls || typeof pendingCalls.set !== 'function' || typeof pendingCalls.delete !== 'function') {
    throw new Error('pendingCalls store is required');
  }

  return async function pressDigitAndReconnect({
    callSid,
    digit,
    heardOption,
    transcript = [],
    metadata = {}
  }) {
    if (!/^CA[0-9a-f]{32}$/i.test(callSid || '')) throw new Error('Invalid CallSid for IVR handoff');
    if (!/^[0-9*#]$/.test(digit || '')) throw new Error('Invalid IVR digit');
    if (metadata.provider !== 'gpt-live' || metadata.smartIvr !== true) throw new Error('Smart IVR handoff is not enabled');

    const hops = Number(metadata.ivrHops || 0);
    if (!Number.isInteger(hops) || hops < 0 || hops >= maxHops) throw new Error('Smart IVR hop limit reached');
    if (typeof heardOption !== 'string' || !heardOption.trim()) throw new Error('IVR option text is required');

    const token = createToken();
    const previousHistory = Array.isArray(metadata.ivrHistory) ? metadata.ivrHistory : [];
    const previousDigits = Array.isArray(metadata.ivrDigits) ? metadata.ivrDigits : [];
    const safeTranscript = Array.isArray(transcript)
      ? transcript.slice(-6).map(({ role, text }) => ({ role, text: String(text || '').slice(0, 300) }))
      : [];
    const nextMetadata = {
      ...metadata,
      expectedCallSid: callSid,
      ivrHops: hops + 1,
      ivrDigits: [...previousDigits, digit].slice(-maxHops),
      ivrHistory: [...previousHistory, {
        digit,
        heardOption: heardOption.trim().slice(0, 500),
        transcript: safeTranscript
      }].slice(-6)
    };

    pendingCalls.set(token, nextMetadata);
    const twiml = buildImmediateDtmfStreamTwiml(buildWsUrl(), token, digit);
    try {
      await updateCall(callSid, twiml);
    } catch (error) {
      pendingCalls.delete(token);
      throw error;
    }

    appendCallEvent(callSid, {
      type: 'ivr_digit_selected',
      text: 'Model selected a verified IVR option and reconnected the voice stream',
      meta: { digit, hop: hops + 1 }
    });
    return { token, metadata: nextMetadata };
  };
}

module.exports = { createSmartIvrDigitHandler };
