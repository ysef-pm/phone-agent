const https = require('https');

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function splitEscapedText(text, maxLength = TELEGRAM_MAX_MESSAGE_LENGTH) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let end = maxLength;
    const amp = remaining.lastIndexOf('&', end - 1);
    const semicolon = remaining.lastIndexOf(';', end - 1);
    if (amp > semicolon) end = amp;
    if (end === 0) end = maxLength;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function buildTelegramMessages(callSid, to, transcript) {
  const lines = transcript.map((turn) =>
    `${turn.role === 'user' ? '👤' : '🤖'} ${escapeHtml(turn.text)}`
  ).join('\n');
  const message = `📞 Call completed\nTo: ${escapeHtml(to)}\nTurns: ${transcript.length}\n\n${lines}`;
  return splitEscapedText(message);
}

function sendTelegramSummary(callSid, to, transcript, options = {}) {
  const botToken = options.botToken || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = options.chatId || process.env.TELEGRAM_CHAT_ID;
  const httpsImpl = options.httpsImpl || https;
  const timeoutMs = options.timeoutMs || 10000;
  if (!botToken || !chatId) return Promise.resolve({ sent: 0 });

  const messages = buildTelegramMessages(callSid, to, transcript);
  return Promise.all(messages.map(message =>
    postTelegramMessage(message, { botToken, chatId, httpsImpl, timeoutMs })
  )).then(() => ({ sent: messages.length }));
}

function postTelegramMessage(text, { botToken, chatId, httpsImpl, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const request = httpsImpl.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (response) => {
      response.resume();
      response.on('end', () => {
        const status = response.statusCode || 0;
        if (status < 200 || status >= 300) {
          reject(new Error(`Telegram API returned ${status}`));
          return;
        }
        resolve();
      });
    });
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Telegram request timeout'));
    });
    request.on('error', reject);
    request.write(postData);
    request.end();
  });
}

module.exports = {
  TELEGRAM_MAX_MESSAGE_LENGTH,
  escapeHtml,
  buildTelegramMessages,
  sendTelegramSummary
};
