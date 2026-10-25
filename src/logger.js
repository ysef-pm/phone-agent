const fs = require('fs');
const path = require('path');

const BASE_DIR = path.join(process.cwd(), 'logs', 'calls');

function ensureBaseDir() {
  fs.mkdirSync(BASE_DIR, { recursive: true });
}

function normalizeCallSid(callSid) {
  return /^CA[0-9a-f]{32}$/i.test(String(callSid || ''))
    ? String(callSid)
    : 'invalid-call-sid';
}

function callJsonPath(callSid) {
  return path.join(BASE_DIR, `${normalizeCallSid(callSid)}.json`);
}

function callMdPath(callSid) {
  return path.join(BASE_DIR, `${normalizeCallSid(callSid)}.md`);
}

function appendCallEvent(callSid, event) {
  ensureBaseDir();
  const jsonPath = callJsonPath(callSid);
  const mdPath = callMdPath(callSid);

  let current = {
    callSid,
    createdAt: new Date().toISOString(),
    events: []
  };

  if (fs.existsSync(jsonPath)) {
    current = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  }

  current.events.push({
    ts: new Date().toISOString(),
    ...event
  });

  fs.writeFileSync(jsonPath, JSON.stringify(current, null, 2));

  const mdLine = `- ${new Date().toISOString()} | ${event.type || 'event'} | ${event.text || ''} ${event.meta ? `| ${JSON.stringify(event.meta)}` : ''}\n`;
  fs.appendFileSync(mdPath, mdLine);
}

module.exports = {
  appendCallEvent,
  normalizeCallSid,
  callJsonPath,
  callMdPath
};
