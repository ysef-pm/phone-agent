const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { CallTranscriptStore } = require('../src/call-transcript-store');
const CALL = `CA${'a'.repeat(32)}`;
const TOKEN = 'unit-test-token-never-a-live-secret';

async function serve(t, store) {
  let mod;
  try { mod = require('../src/transcript-routes'); }
  catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  assert.equal(typeof mod?.createTranscriptRouter, 'function', 'authenticated transcript retrieval is not implemented');
  const app = express();
  app.use('/api/calls', mod.createTranscriptRouter({ store, token: TOKEN }));
  app.post('/api/calls/outbound', (_req, res) => res.json({ existingRoute: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/api/calls`;
}
function archive(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/home/clawd/.hermes/cache/scratch', 'phone-transcript-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CallTranscriptStore({ dir });
  store.saveSegment(CALL, { streamSid: `MZ${'b'.repeat(32)}`, provider: 'gpt-live', endReason: null,
    transcript: [{ role: 'user', text: 'TEST ONLY: confirmation has been sent.' }] });
  return store;
}

test('only authenticated clients can retrieve persisted call speech in JSON and text', async (t) => {
  const base = await serve(t, archive(t));
  const denied = await fetch(`${base}/${CALL}/transcript`);
  assert.equal(denied.status, 401);
  assert.ok(!(await denied.text()).includes('confirmation has been sent'));
  const headers = { Authorization: `Bearer ${TOKEN}` };
  const response = await fetch(`${base}/${CALL}/transcript`, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const record = await response.json();
  assert.equal(record.callSid, CALL);
  assert.equal(record.transcript[0].text, 'TEST ONLY: confirmation has been sent.');
  const plain = await fetch(`${base}/${CALL}/transcript?format=text`, { headers });
  assert.match(plain.headers.get('content-type'), /^text\/plain/);
  const text = await plain.text();
  assert.match(text, /UNTRUSTED CALL TRANSCRIPT/);
  assert.match(text, /Caller: TEST ONLY: confirmation has been sent/);
});

test('transcript authorization does not intercept unrelated existing call routes', async (t) => {
  const base = await serve(t, archive(t));
  const response = await fetch(`${base}/outbound`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { existingRoute: true });
});

test('rejects query credentials and malformed identifiers without leaking record existence', async (t) => {
  const base = await serve(t, archive(t));
  for (const suffix of [`${CALL}/transcript?token=${TOKEN}`, 'invalid/transcript']) {
    const response = await fetch(`${base}/${suffix}`);
    assert.equal(response.status, 401);
  }
  const headers = { Authorization: `Bearer ${TOKEN}` };
  assert.equal((await fetch(`${base}/invalid/transcript`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/${CALL}/transcript?format=html`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/CA${'f'.repeat(32)}/transcript`, { headers })).status, 404);
});

test('storage errors return a sanitized failure instead of an invented transcript', async (t) => {
  const base = await serve(t, { get() { throw new Error('PRIVATE TEST TEXT MUST NOT LEAK'); } });
  const response = await fetch(`${base}/${CALL}/transcript`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(!(await response.text()).includes('PRIVATE TEST TEXT'));
});
