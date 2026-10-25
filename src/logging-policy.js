function promptLogMeta(prompt, metadata = {}) {
  return { ...metadata, promptChars: String(prompt || '').length };
}

function transcriptLogEvent(role, text, provider) {
  const label = role === 'caller' ? 'Caller' : 'Agent';
  return {
    type: `${role}_transcript_activity`,
    text: `${label} transcript activity`,
    meta: { provider, chars: String(text || '').length }
  };
}

module.exports = { promptLogMeta, transcriptLogEvent };
