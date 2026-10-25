const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCallSid, callJsonPath, callMdPath } = require('../src/logger');

test('accepts only Twilio call SIDs for logger filenames', () => {
  const valid = `CA${'a'.repeat(32)}`;
  assert.equal(normalizeCallSid(valid), valid);
  assert.equal(normalizeCallSid('../../tmp/owned'), 'invalid-call-sid');
  assert.equal(normalizeCallSid('unknown'), 'invalid-call-sid');
});

test('keeps all logger paths inside the call log directory', () => {
  for (const value of ['../../tmp/owned', '/tmp/owned', `CA${'b'.repeat(32)}`]) {
    assert.match(callJsonPath(value), /\/logs\/calls\/[^/]+\.json$/);
    assert.match(callMdPath(value), /\/logs\/calls\/[^/]+\.md$/);
  }
});
