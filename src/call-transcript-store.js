const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CALL_SID = /^CA[0-9a-f]{32}$/;
const DEFAULT_DIR = path.join(__dirname, '..', 'data', 'call-transcripts');
const MAX_TEXT_CHARS = 200000;

class CallTranscriptStore {
  constructor({ dir = DEFAULT_DIR, now = Date.now, retentionMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    this.dir = path.resolve(dir);
    this.now = now;
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) throw new Error('Invalid transcript retention');
    this.retentionMs = retentionMs;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    const keyPath = path.join(this.dir, '.key');
    try { fs.writeFileSync(keyPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    fs.chmodSync(keyPath, 0o600);
    this.key = fs.readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('Invalid transcript encryption key');
  }

  _file(callSid) {
    if (typeof callSid !== 'string' || !CALL_SID.test(callSid)) throw new Error('Invalid CallSid');
    return path.join(this.dir, `${callSid}.json.enc`);
  }

  _read(callSid) {
    let raw;
    try {
      const file = this._file(callSid);
      if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('Invalid transcript file');
      raw = fs.readFileSync(file, 'utf8');
    }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    const envelope = JSON.parse(raw);
    if (envelope.version !== 1) throw new Error('Invalid transcript version');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(callSid));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const clear = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    const record = JSON.parse(clear.toString('utf8'));
    if (record.callSid !== callSid) throw new Error('Transcript identity mismatch');
    return record;
  }

  _write(callSid, record) {
    const file = this._file(callSid);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(callSid));
    const data = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
    const encoded = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
    const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, encoded, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }

  saveSegment(callSid, segment) {
    this._file(callSid);
    if (!segment || !/^MZ[0-9a-f]{32}$/.test(segment.streamSid || '') ||
        !['gpt-live', 'elevenlabs'].includes(segment.provider) ||
        !Array.isArray(segment.transcript) || segment.transcript.length > 2000 ||
        (segment.endReason != null && (typeof segment.endReason !== 'string' || segment.endReason.length > 80))) {
      throw new Error('Invalid transcript segment');
    }
    for (const turn of segment.transcript) {
      if (!turn || !['user', 'agent'].includes(turn.role) || typeof turn.text !== 'string') throw new Error('Invalid transcript turn');
    }
    if (segment.transcript.reduce((n, turn) => n + turn.text.length, 0) > MAX_TEXT_CHARS) throw new Error('Transcript size limit exceeded');
    const timestamp = new Date(this.now()).toISOString();
    const transcript = segment.transcript.map((turn) => ({ role: turn.role, text: turn.text,
      ...(turn.role === 'agent' && turn.audioSuppressed === true ? { audioSuppressed: true } : {}) }));
    const record = this._read(callSid) || { version: 1, callSid, provider: segment.provider, createdAt: timestamp, segments: [] };
    record.expiresAt ||= new Date(Date.parse(record.createdAt) + this.retentionMs).toISOString();
    const entry = { streamSid: segment.streamSid, provider: segment.provider, endedAt: timestamp,
      endReason: segment.endReason || null, mode: segment.mode === 'smart-ivr' ? 'smart-ivr' : 'direct',
      humanHandoffObserved: segment.humanHandoffObserved === true, transcript };
    const index = record.segments.findIndex((s) => s.streamSid === segment.streamSid);
    if (index < 0) record.segments.push(entry);
    else record.segments[index] = entry;
    const turns = record.segments.flatMap((s) => s.transcript);
    if (record.segments.length > 32 || turns.length > 2000 || turns.reduce((n, turn) => n + turn.text.length, 0) > MAX_TEXT_CHARS) {
      throw new Error('Transcript size limit exceeded');
    }
    record.updatedAt = timestamp;
    record.status = record.segments.some((s) => s.endReason !== 'ivr_dtmf') ? 'complete' : 'partial';
    this._write(callSid, record);
  }

  get(callSid) {
    const record = this._read(callSid);
    if (!record) return null;
    if (!Number.isFinite(Date.parse(record.expiresAt)) || this.now() >= Date.parse(record.expiresAt)) {
      fs.unlinkSync(this._file(callSid));
      return null;
    }
    return { ...record, transcript: record.segments.flatMap((s) => s.transcript) };
  }

  cleanup() {
    for (const name of fs.readdirSync(this.dir)) {
      const match = /^(CA[0-9a-f]{32})\.json\.enc$/.exec(name);
      if (!match) continue;
      try { this.get(match[1]); } catch { /* A corrupt record is never returned as a transcript. */ }
    }
  }
}

module.exports = { CallTranscriptStore, CALL_SID };
