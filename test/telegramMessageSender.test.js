import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTelegramMessageSender,
  MAX_TELEGRAM_MESSAGE_LENGTH,
  MAX_TELEGRAM_RICH_MESSAGE_LENGTH
} from '../src/telegram/messageSender.js';

test('Telegram message sender sends exact plain text to Saved Messages', async () => {
  const calls = [];
  let disconnectCount = 0;
  const config = { telegramSessionFile: 'session-file' };
  const sender = createTelegramMessageSender({
    config,
    createClient: async (receivedConfig) => {
      assert.equal(receivedConfig, config);
      return {
        async sendMessage(entity, options) {
          calls.push({ entity, options });
          return {
            id: 321,
            date: 1785144248
          };
        },
        async disconnect() {
          disconnectCount += 1;
        }
      };
    }
  });

  const text = 'Literal **markdown** and _underscores_';
  const result = await sender.sendMessage({ text });

  assert.deepEqual(calls, [{
    entity: 'me',
    options: {
      message: text,
      parseMode: false
    }
  }]);
  assert.deepEqual(result, {
    status: 'sent',
    destination: { type: 'saved' },
    format: 'plain_text',
    messageId: 321,
    date: new Date(1785144248 * 1000).toISOString()
  });
  assert.equal(disconnectCount, 1);
});

test('Telegram message sender validates requests before connecting', async () => {
  let connectionCount = 0;
  const sender = createTelegramMessageSender({
    config: {},
    createClient: async () => {
      connectionCount += 1;
      return {};
    }
  });

  await assert.rejects(
    sender.sendMessage({ text: '   ' }),
    /text must be a non-empty string/
  );
  await assert.rejects(
    sender.sendMessage({ text: 'x'.repeat(MAX_TELEGRAM_MESSAGE_LENGTH + 1) }),
    /text must be at most 4096 characters for plain_text/
  );
  await assert.rejects(
    sender.sendMessage({
      text: 'x'.repeat(MAX_TELEGRAM_RICH_MESSAGE_LENGTH + 1),
      format: 'rich_text'
    }),
    /text must be at most 32768 characters for rich_text/
  );
  await assert.rejects(
    sender.sendMessage({ text: 'Invalid format', format: 'markdown' }),
    /format must be plain_text or rich_text/
  );
  await assert.rejects(
    sender.sendMessage({
      text: 'Do not send this',
      destination: { type: 'source', sourceId: '123' }
    }),
    /Only the saved Telegram destination is supported/
  );

  assert.equal(connectionCount, 0);
});

test('Telegram message sender disconnects after a send failure and does not retry', async () => {
  const expected = new Error('Telegram send failed');
  let sendCount = 0;
  let disconnectCount = 0;
  const sender = createTelegramMessageSender({
    config: {},
    createClient: async () => ({
      async sendMessage() {
        sendCount += 1;
        throw expected;
      },
      async disconnect() {
        disconnectCount += 1;
      }
    })
  });

  await assert.rejects(
    sender.sendMessage({ text: 'One attempt only' }),
    (error) => error === expected
  );
  assert.equal(sendCount, 1);
  assert.equal(disconnectCount, 1);
});

test('Telegram message sender accepts an explicit Saved Messages destination', async () => {
  const sender = createTelegramMessageSender({
    config: {},
    createClient: async () => ({
      async sendMessage() {
        return {
          id: 7,
          date: new Date('2026-07-27T10:00:00.000Z')
        };
      },
      async disconnect() {}
    })
  });

  const result = await sender.sendMessage({
    text: 'Explicit destination',
    destination: { type: 'saved' }
  });

  assert.equal(result.destination.type, 'saved');
  assert.equal(result.format, 'plain_text');
  assert.equal(result.date, '2026-07-27T10:00:00.000Z');
});

test('Telegram message sender sends Rich Text Markdown through the user MTProto session', async () => {
  const markdown = '- [ ] Open task\n- [x] Completed task';
  const peer = { getBytes: () => Buffer.from('c91ea07d', 'hex') };
  const request = { classType: 'request', marker: 'rich-request' };
  const calls = [];
  let disconnectCount = 0;
  const sender = createTelegramMessageSender({
    config: {},
    createClient: async () => ({
      async getInputEntity(entity) {
        calls.push({ method: 'getInputEntity', entity });
        return peer;
      },
      async invoke(receivedRequest) {
        calls.push({ method: 'invoke', request: receivedRequest });
        return {
          messageId: 456,
          date: null
        };
      },
      async sendMessage() {
        throw new Error('Rich Text must not use the legacy sendMessage helper');
      },
      async disconnect() {
        disconnectCount += 1;
      }
    }),
    createRichMessageRequest: (args) => {
      assert.deepEqual(args, { peer, markdown });
      return request;
    }
  });

  const result = await sender.sendMessage({
    text: markdown,
    format: 'rich_text'
  });

  assert.deepEqual(calls, [
    { method: 'getInputEntity', entity: 'me' },
    { method: 'invoke', request }
  ]);
  assert.deepEqual(result, {
    status: 'sent',
    destination: { type: 'saved' },
    format: 'rich_text',
    messageId: 456,
    date: null
  });
  assert.equal(disconnectCount, 1);
});
