const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CALL = `CA${'a'.repeat(32)}`;
const STREAM = `MZ${'b'.repeat(32)}`;
function archiveClass() {
  let mod;
  try { mod = require('../src/call-transcript-store'); }
  catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  assert.equal(typeof mod?.CallTranscriptStore, 'function', 'private transcript archive is not implemented');
  return mod.CallTranscriptStore;
}
function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/home/clawd/.hermes/cache/scratch', 'phone-transcript-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function segment(overrides = {}) {
  return { streamSid: STREAM, provider: 'gpt-live', endReason: null,
    transcript: [{ role: 'user', text: 'TEST ONLY: please confirm the reservation.' },
      { role: 'agent', text: 'TEST ONLY: I will check it.' }], ...overrides };
}

test('archives a readable transcript privately and encrypted across process restarts', (t) => {
  const Store = archiveClass();
  const dir = temporaryDirectory(t);
  const store = new Store({ dir });
  store.saveSegment(CALL, segment());
  const reloaded = new Store({ dir }).get(CALL);
  assert.deepEqual(reloaded.transcript, segment().transcript);
  assert.equal(reloaded.callSid, CALL);
  assert.equal(reloaded.status, 'complete');
  const raw = fs.readFileSync(path.join(dir, `${CALL}.json.enc`), 'utf8');
  assert.ok(!raw.includes('TEST ONLY') && !raw.includes('reservation'));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, '.key')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, `${CALL}.json.enc`)).mode & 0o777, 0o600);
});

test('retains IVR legs and replaces duplicate segment callbacks without duplicating speech', (t) => {
  const Store = archiveClass();
  const store = new Store({ dir: temporaryDirectory(t) });
  const menu = segment({ endReason: 'ivr_dtmf', transcript: [{ role: 'user', text: 'TEST ONLY: press one for reception.' }] });
  const conversation = segment({ streamSid: `MZ${'c'.repeat(32)}` });
  store.saveSegment(CALL, menu);
  assert.equal(store.get(CALL).status, 'partial');
  store.saveSegment(CALL, conversation);
  store.saveSegment(CALL, conversation);
  store.saveSegment(CALL, menu);
  const result = store.get(CALL);
  assert.equal(result.segments.length, 2);
  assert.deepEqual(result.transcript, [...menu.transcript, ...conversation.transcript]);
  assert.equal(result.status, 'complete');
});

test('expires archives after the retention window without exposing or retaining their contents', (t) => {
  const Store = archiveClass();
  const dir = temporaryDirectory(t);
  let now = Date.parse('2026-10-25T00:00:00Z');
  const store = new Store({ dir, now: () => now, retentionMs: 1000 });
  store.saveSegment(CALL, segment());
  assert.equal(store.get(CALL).expiresAt, '2026-10-25T00:00:01.000Z');
  now += 1001;
  store.cleanup();
  assert.equal(store.get(CALL), null);
  assert.equal(fs.existsSync(path.join(dir, `${CALL}.json.enc`)), false);
  assert.equal(fs.existsSync(path.join(dir, '.key')), true);
});

test('rejects malformed or oversized transcript segments before writing', (t) => {
  const Store = archiveClass();
  const dir = temporaryDirectory(t);
  const store = new Store({ dir });
  assert.throws(() => store.saveSegment(CALL, segment({ streamSid: '../escape' })), /Invalid/);
  assert.throws(() => store.saveSegment(CALL, segment({ provider: 'unknown' })), /Invalid/);
  assert.throws(() => store.saveSegment(CALL, segment({ transcript: [{ role: 'system', text: 'bad role' }] })), /Invalid/);
  assert.throws(() => store.saveSegment(CALL, segment({ transcript: [{ role: 'user', text: 'x'.repeat(200001) }] })), /limit/);
  assert.throws(() => store.get('../../outside'), /Invalid CallSid/);
  assert.deepEqual(fs.readdirSync(dir), ['.key']);
});

test('binds encrypted archives to the call ID so records cannot be swapped', (t) => {
  const Store = archiveClass();
  const dir = temporaryDirectory(t);
  const store = new Store({ dir });
  store.saveSegment(CALL, segment());
  const other = `CA${'d'.repeat(32)}`;
  fs.copyFileSync(path.join(dir, `${CALL}.json.enc`), path.join(dir, `${other}.json.enc`));
  assert.throws(() => store.get(other));
});

test('preserves suppression and verified-handoff metadata in the protected archive', (t) => {
  const Store = archiveClass();
  const store = new Store({ dir: temporaryDirectory(t) });
  store.saveSegment(CALL, segment({ mode: 'smart-ivr', humanHandoffObserved: true,
    transcript: [{ role: 'agent', text: 'TEST ONLY: not played aloud', audioSuppressed: true }] }));
  const record = store.get(CALL);
  assert.equal(record.transcript[0].audioSuppressed, true);
  assert.equal(record.segments[0].mode, 'smart-ivr');
  assert.equal(record.segments[0].humanHandoffObserved, true);
});

module.exports = { CALL, STREAM, archiveClass, temporaryDirectory, segment };
