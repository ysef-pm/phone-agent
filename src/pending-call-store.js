class PendingCallStore {
  constructor({ ttlMs = 15 * 60 * 1000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  set(callSid, metadata) {
    this.sweep();
    this.entries.set(callSid, { metadata, expiresAt: this.now() + this.ttlMs });
  }

  take(callSid) {
    const entry = this.entries.get(callSid);
    if (!entry) return undefined;
    this.entries.delete(callSid);
    if (entry.expiresAt <= this.now()) return undefined;
    return entry.metadata;
  }

  bindExpectedCallSid(key, callSid) {
    if (!/^CA[0-9a-f]{32}$/i.test(callSid || '')) return false;
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.entries.delete(key);
      return false;
    }
    if (entry.metadata.expectedCallSid && entry.metadata.expectedCallSid !== callSid) return false;
    entry.metadata = { ...entry.metadata, expectedCallSid: callSid };
    return true;
  }

  takeForCall(key, callSid) {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.entries.delete(key);
      return undefined;
    }
    if (entry.metadata.expectedCallSid !== callSid) return undefined;
    this.entries.delete(key);
    return entry.metadata;
  }

  delete(callSid) {
    return this.entries.delete(callSid);
  }

  sweep() {
    const now = this.now();
    for (const [callSid, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(callSid);
    }
  }

  get size() {
    this.sweep();
    return this.entries.size;
  }
}

module.exports = { PendingCallStore };
