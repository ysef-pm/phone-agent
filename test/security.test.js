const test = require('node:test');
const assert = require('node:assert/strict');
const twilio = require('twilio');

const {
  createTwilioSignatureMiddleware,
  isAuthorizedMediaStreamRequest,
  buildMediaStreamUrl
} = require('../src/security');

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('validates Twilio webhook signatures against configured public BASE_URL', () => {
  const authToken = 'twilio-test-token';
  const baseUrl = 'https://voice.example.test/base';
  const req = {
    originalUrl: '/twilio/voice/status?source=twilio',
    headers: {},
    body: { CallSid: 'CA123', CallStatus: 'completed' },
    get(name) { return this.headers[name.toLowerCase()]; }
  };
  const publicUrl = 'https://voice.example.test/twilio/voice/status?source=twilio';
  req.headers['x-twilio-signature'] = twilio.getExpectedTwilioSignature(authToken, publicUrl, req.body);
  const res = fakeResponse();
  let called = false;

  createTwilioSignatureMiddleware({ authToken, baseUrl })(req, res, () => { called = true; });

  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
});

test('rejects missing or invalid Twilio webhook signatures', () => {
  const middleware = createTwilioSignatureMiddleware({
    authToken: 'twilio-test-token',
    baseUrl: 'https://voice.example.test'
  });
  const req = {
    originalUrl: '/twilio/voice/status',
    headers: { 'x-twilio-signature': 'invalid' },
    body: { CallSid: 'CA123' },
    get(name) { return this.headers[name.toLowerCase()]; }
  };
  const res = fakeResponse();

  middleware(req, res, () => assert.fail('invalid request reached handler'));

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Invalid Twilio signature' });
});

test('requires a configured strong media-stream token in the upgrade query', () => {
  const token = 'a'.repeat(32);
  const validReq = { url: '/media-stream?token=' + token };
  const wrongReq = { url: '/media-stream?token=wrong' };
  const missingReq = { url: '/media-stream' };
  assert.equal(isAuthorizedMediaStreamRequest(validReq, token), true);
  assert.equal(isAuthorizedMediaStreamRequest(wrongReq, token), false);
  assert.equal(isAuthorizedMediaStreamRequest(missingReq, token), false);
  assert.equal(isAuthorizedMediaStreamRequest(validReq, 'short'), false);
});

test('builds the Twilio stream URL carrying the upgrade token', () => {
  assert.equal(
    buildMediaStreamUrl('https://voice.example.test/some/path', 'a b+c'),
    'wss://voice.example.test/media-stream?token=a+b%2Bc'
  );
});
