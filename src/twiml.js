// Pure TwiML builders for the media-stream call flow. Kept dependency-free and
// side-effect-free so they are easy to unit test.

const MAX_DIAL_DIGITS = 32;

// Allowed <Play digits="..."> characters per Twilio: 0-9, A-D, *, #, and
// w/W pause markers. Everything else (including quotes/angle brackets) is
// stripped so a caller-supplied value cannot inject TwiML.
function sanitizeDialDigits(digits) {
  if (typeof digits !== 'string') return '';
  return digits.replace(/[^0-9A-Dabcd*#wW]/g, '').slice(0, MAX_DIAL_DIGITS);
}

function renderStreamTwiml(wsUrl, callToken, digits, digitLeadIn) {
  const playStep = digits ? `  <Play digits="${digitLeadIn}${digits}"></Play>\n` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${playStep}  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callToken" value="${callToken}" />
    </Stream>
  </Connect>
</Response>`;
}

function buildStreamTwiml(wsUrl, callToken, preDialDigits) {
  const digits = sanitizeDialDigits(preDialDigits);
  // Initial pre-dial digits need a short pause so the remote IVR is ready.
  return renderStreamTwiml(wsUrl, callToken, digits, digits ? 'ww' : '');
}

function buildImmediateDtmfStreamTwiml(wsUrl, callToken, digit) {
  const digits = sanitizeDialDigits(digit);
  // A smart-IVR handoff happens after the option was already spoken. Send the
  // selected key immediately so short IVR response windows do not expire.
  return renderStreamTwiml(wsUrl, callToken, digits, '');
}

module.exports = {
  buildStreamTwiml,
  buildImmediateDtmfStreamTwiml,
  sanitizeDialDigits,
  MAX_DIAL_DIGITS
};
