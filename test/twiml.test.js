const test = require('node:test');
const assert = require('node:assert/strict');

const { buildStreamTwiml, sanitizeDialDigits } = require('../src/twiml');

test('builds a plain Connect/Stream TwiML with the call token parameter', () => {
  const xml = buildStreamTwiml('wss://x/media-stream', 'tok123');
  assert.match(xml, /<Connect>/);
  assert.match(xml, /<Stream url="wss:\/\/x\/media-stream">/);
  assert.match(xml, /<Parameter name="callToken" value="tok123" \/>/);
  assert.doesNotMatch(xml, /<Play/);
});

test('prepends a Play digits step when pre-dial digits are provided', () => {
  const xml = buildStreamTwiml('wss://x/media-stream', 'tok123', '1');
  // Play must come before Connect so the IVR menu is cleared first
  assert.ok(xml.indexOf('<Play') < xml.indexOf('<Connect>'), 'Play precedes Connect');
  assert.match(xml, /<Play digits="w{2}1"><\/Play>/);
});

test('sanitizeDialDigits keeps only valid DTMF characters and strips injection', () => {
  assert.equal(sanitizeDialDigits('1'), '1');
  assert.equal(sanitizeDialDigits('9w2W#*0'), '9w2W#*0');
  // TwiML-injection characters (<>"/ space) are removed; leftover DTMF-valid
  // letters may remain but cannot form markup.
  const cleaned = sanitizeDialDigits('1"><Hangup/>');
  assert.doesNotMatch(cleaned, /[<>"/ ]/);
  assert.match(cleaned, /^[0-9A-Dabcd*#wW]*$/);
  assert.equal(sanitizeDialDigits('!!!'), '');
  assert.equal(sanitizeDialDigits(''), '');
  assert.equal(sanitizeDialDigits(undefined), '');
  assert.equal(sanitizeDialDigits('1'.repeat(50)).length, 32); // capped
});

test('does not emit a Play step when digits sanitize to empty', () => {
  const xml = buildStreamTwiml('wss://x/media-stream', 'tok123', '!@$');
  assert.doesNotMatch(xml, /<Play/);
});
