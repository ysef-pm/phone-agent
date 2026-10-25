const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { buildTelegramMessages, sendTelegramSummary } = require('../src/telegram');

test('escapes Telegram HTML and splits summaries at the API size limit', () => {
  const transcript = [
    { role: 'user', text: '<b>secret & unsafe</b> ' + 'x'.repeat(5000) }
  ];
  const messages = buildTelegramMessages('CA123', '<recipient>', transcript);

  assert.ok(messages.length > 1);
  assert.ok(messages.every((message) => message.length <= 4096));
  assert.doesNotMatch(messages.join(''), /<b>|<recipient>/);
  assert.match(messages.join(''), /&lt;b&gt;secret &amp; unsafe&lt;\/b&gt;/);
});

test('rejects Telegram API non-success statuses', async () => {
  const httpsImpl = {
    request(options, callback) {
      const request = new EventEmitter();
      request.write = () => {};
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 429;
        response.resume = () => {};
        callback(response);
        response.emit('end');
      };
      return request;
    }
  };

  await assert.rejects(
    sendTelegramSummary('CA123', '+31000', [], {
      botToken: 'bot-token', chatId: 'chat-id', httpsImpl
    }),
    /Telegram API returned 429/
  );
});
