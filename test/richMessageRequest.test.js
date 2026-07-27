import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import {
  createSendRichMessageRequest,
  INPUT_RICH_MESSAGE_MARKDOWN_CONSTRUCTOR_ID,
  INVOKE_WITH_LAYER_CONSTRUCTOR_ID,
  RICH_MESSAGE_FLAG,
  SEND_MESSAGE_CONSTRUCTOR_ID,
  TELEGRAM_API_LAYER,
  UPDATE_MESSAGE_ID_CONSTRUCTOR_ID,
  UPDATE_SHORT_SENT_MESSAGE_CONSTRUCTOR_ID
} from '../src/telegram/richMessageRequest.js';

const require = createRequire(import.meta.url);
const { serializeBytes } = require('telegram/tl');

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function int32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value);
  return buffer;
}

test('Rich Text request serializes layer 228 messages.sendMessage with Rich Markdown', () => {
  const markdown = '- [ ] Open\n- [x] Done';
  const peerBytes = uint32(0x7da07ec9);
  const randomIdBytes = Buffer.from('0102030405060708', 'hex');
  const request = createSendRichMessageRequest({
    peer: { getBytes: () => peerBytes },
    markdown,
    randomIdBytes
  });

  assert.equal(request.classType, 'request');
  assert.deepEqual(request.getBytes(), Buffer.concat([
    uint32(INVOKE_WITH_LAYER_CONSTRUCTOR_ID),
    int32(TELEGRAM_API_LAYER),
    uint32(SEND_MESSAGE_CONSTRUCTOR_ID),
    uint32(RICH_MESSAGE_FLAG),
    peerBytes,
    serializeBytes(''),
    randomIdBytes,
    uint32(INPUT_RICH_MESSAGE_MARKDOWN_CONSTRUCTOR_ID),
    uint32(0),
    serializeBytes(markdown)
  ]));
});

test('Rich Text request reads the server message ID matching its random ID', () => {
  const randomIdBytes = Buffer.from('1122334455667788', 'hex');
  const request = createSendRichMessageRequest({
    peer: { getBytes: () => Buffer.alloc(4) },
    markdown: '- [ ] Open',
    randomIdBytes
  });
  const response = Buffer.concat([
    uint32(0x74ae4240),
    Buffer.from('aabbccdd', 'hex'),
    uint32(UPDATE_MESSAGE_ID_CONSTRUCTOR_ID),
    int32(9876),
    randomIdBytes,
    Buffer.from('01020304', 'hex')
  ]);

  const result = request.readResult({
    getBuffer: () => response
  });

  assert.equal(result.messageId, 9876);
  assert.equal(result.date, null);
  assert.deepEqual(result.updates, []);
  assert.deepEqual(result.users, []);
  assert.deepEqual(result.chats, []);
});

test('Rich Text request reads updateShortSentMessage metadata', () => {
  const request = createSendRichMessageRequest({
    peer: { getBytes: () => Buffer.alloc(4) },
    markdown: '- [x] Done',
    randomIdBytes: Buffer.from('0102030405060708', 'hex')
  });
  const response = Buffer.concat([
    uint32(UPDATE_SHORT_SENT_MESSAGE_CONSTRUCTOR_ID),
    uint32(0),
    int32(1234),
    int32(10),
    int32(1),
    int32(1785144248)
  ]);

  const result = request.readResult({
    getBuffer: () => response
  });

  assert.equal(result.messageId, 1234);
  assert.equal(result.date, 1785144248);
});

test('Rich Text request rejects invalid construction inputs', () => {
  assert.throws(
    () => createSendRichMessageRequest({ peer: null, markdown: '- [ ] Task' }),
    /resolved Telegram input peer/
  );
  assert.throws(
    () => createSendRichMessageRequest({
      peer: { getBytes() {} },
      markdown: ' ',
      randomIdBytes: Buffer.alloc(8)
    }),
    /non-empty string/
  );
  assert.throws(
    () => createSendRichMessageRequest({
      peer: { getBytes() {} },
      markdown: '- [ ] Task',
      randomIdBytes: Buffer.alloc(7)
    }),
    /exactly 8 bytes/
  );
});
