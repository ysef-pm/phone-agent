const crypto = require('crypto');
const twilio = require('twilio');

const MIN_MEDIA_TOKEN_LENGTH = 32;

function publicWebhookUrl(baseUrl, originalUrl) {
  const base = new URL(baseUrl);
  return new URL(originalUrl, base.origin).toString();
}

function createTwilioSignatureMiddleware({ authToken, baseUrl }) {
  return (req, res, next) => {
    if (!authToken || !baseUrl) {
      return res.status(500).json({ error: 'Twilio webhook validation is not configured' });
    }

    const signature = req.get('x-twilio-signature') || '';
    const url = publicWebhookUrl(baseUrl, req.originalUrl);
    if (!signature || !twilio.validateRequest(authToken, signature, url, req.body || {})) {
      return res.status(403).json({ error: 'Invalid Twilio signature' });
    }
    return next();
  };
}

function isAuthorizedMediaStreamRequest(req, expectedToken) {
  if (typeof expectedToken !== 'string' || expectedToken.length < MIN_MEDIA_TOKEN_LENGTH) return false;
  // Twilio <Stream> cannot send custom headers, but DOES preserve query params
  // on the wss URL. This is a coarse upgrade-level gate; the real per-call secret
  // is the opaque one-time callToken validated at the start event.
  let provided;
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/media-stream') return false;
    provided = url.searchParams.get('token');
  } catch {
    return false;
  }
  if (typeof provided !== 'string') return false;
  const expectedBuffer = Buffer.from(expectedToken);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function buildMediaStreamUrl(baseUrl, token) {
  const base = new URL(baseUrl);
  const url = new URL('/media-stream', `wss://${base.host}`);
  url.searchParams.set('token', token);
  return url.toString();
}

module.exports = {
  MIN_MEDIA_TOKEN_LENGTH,
  createTwilioSignatureMiddleware,
  isAuthorizedMediaStreamRequest,
  buildMediaStreamUrl,
  publicWebhookUrl
};
