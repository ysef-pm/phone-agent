const SENSITIVE_PATTERNS = [
  /transfer/i,
  /payment/i,
  /bank/i,
  /password/i,
  /passcode/i,
  /otp/i,
  /security code/i,
  /unlock/i,
  /buy/i,
  /order/i,
  /send money/i
];

function isSensitive(text) {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text || ''));
}

function normalize(text) {
  return (text || '').trim().toLowerCase();
}

async function generateAssistantReply({ userText, awaitingConfirmation, provider = 'rule-based' }) {
  const clean = normalize(userText);

  if (!clean) {
    return {
      reply: "Sorry, I didn't catch that. Could you say that again?",
      requiresConfirmation: false,
      confirmationState: false,
      meta: { provider, reason: 'empty_input' }
    };
  }

  if (awaitingConfirmation) {
    if (/(yes|confirm|approved|proceed)/i.test(clean)) {
      return {
        reply: 'Confirmed. I have logged your request and will ask Youssef to verify before any real-world action.',
        requiresConfirmation: false,
        confirmationState: false,
        meta: { provider, reason: 'confirmed' }
      };
    }

    if (/(no|cancel|stop|deny)/i.test(clean)) {
      return {
        reply: 'Understood. I cancelled that request.',
        requiresConfirmation: false,
        confirmationState: false,
        meta: { provider, reason: 'cancelled' }
      };
    }

    return {
      reply: 'Please say yes to confirm, or no to cancel.',
      requiresConfirmation: true,
      confirmationState: true,
      meta: { provider, reason: 'awaiting_confirmation' }
    };
  }

  if (isSensitive(clean)) {
    return {
      reply: 'This sounds sensitive. For safety, please say yes to confirm this request, or no to cancel.',
      requiresConfirmation: true,
      confirmationState: true,
      meta: { provider, reason: 'sensitive_gate' }
    };
  }

  // TODO: Swap in LLM provider here (OpenAI/Anthropic/etc.)
  // Keep this fallback deterministic for reliability.
  let reply = "I heard you. I can take a note and pass it to Youssef. Could you share one more detail?";

  if (/voicemail|message/i.test(clean)) {
    reply = 'Sure, leave your message after the tone and I will store it for Youssef.';
  } else if (/meeting|calendar|schedule/i.test(clean)) {
    reply = 'I can help schedule that. Please tell me preferred day and time.';
  } else if (/who are you|your name|what is your name/i.test(clean)) {
    reply = "I'm Min, Youssef's assistant.";
  }

  return {
    reply,
    requiresConfirmation: false,
    confirmationState: false,
    meta: { provider, reason: 'rule_based' }
  };
}

module.exports = {
  generateAssistantReply,
  isSensitive
};
