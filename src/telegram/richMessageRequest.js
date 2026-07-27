import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { serializeBytes } = require('telegram/tl');

const TELEGRAM_API_LAYER = 228;
const INVOKE_WITH_LAYER_CONSTRUCTOR_ID = 0xda9b0d0d;
const SEND_MESSAGE_CONSTRUCTOR_ID = 0xfef48f62;
const INPUT_RICH_MESSAGE_MARKDOWN_CONSTRUCTOR_ID = 0x004b572c;
const UPDATE_MESSAGE_ID_CONSTRUCTOR_ID = 0x4e90bfd6;
const UPDATE_SHORT_SENT_MESSAGE_CONSTRUCTOR_ID = 0x9015e101;
const RICH_MESSAGE_FLAG = 1 << 23;

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

function createRandomIdBytes() {
  const value = randomBytes(8);
  if (value.every((byte) => byte === 0)) {
    value[0] = 1;
  }
  return value;
}

function readMessageIdFromUpdates(buffer, randomIdBytes) {
  for (let offset = 0; offset <= buffer.length - 16; offset += 1) {
    if (buffer.readUInt32LE(offset) !== UPDATE_MESSAGE_ID_CONSTRUCTOR_ID) {
      continue;
    }
    if (buffer.subarray(offset + 8, offset + 16).equals(randomIdBytes)) {
      return buffer.readInt32LE(offset + 4);
    }
  }
  return null;
}

function readSendResult(reader, randomIdBytes) {
  const buffer = reader.getBuffer();
  if (buffer.length >= 24 && buffer.readUInt32LE(0) === UPDATE_SHORT_SENT_MESSAGE_CONSTRUCTOR_ID) {
    return {
      messageId: buffer.readInt32LE(8),
      date: buffer.readInt32LE(20)
    };
  }
  return {
    messageId: readMessageIdFromUpdates(buffer, randomIdBytes),
    date: null
  };
}

export function createSendRichMessageRequest({
  peer,
  markdown,
  randomIdBytes = createRandomIdBytes()
}) {
  if (!peer || typeof peer.getBytes !== 'function') {
    throw new Error('A resolved Telegram input peer is required');
  }
  if (typeof markdown !== 'string' || !markdown.trim()) {
    throw new Error('Rich message markdown must be a non-empty string');
  }
  if (!Buffer.isBuffer(randomIdBytes) || randomIdBytes.length !== 8) {
    throw new Error('Telegram random ID must contain exactly 8 bytes');
  }

  const stableRandomId = Buffer.from(randomIdBytes);

  return {
    CONSTRUCTOR_ID: INVOKE_WITH_LAYER_CONSTRUCTOR_ID,
    className: 'messages.SendRichTextMessage',
    classType: 'request',

    async resolve() {},

    getBytes() {
      return Buffer.concat([
        uint32(INVOKE_WITH_LAYER_CONSTRUCTOR_ID),
        int32(TELEGRAM_API_LAYER),
        uint32(SEND_MESSAGE_CONSTRUCTOR_ID),
        uint32(RICH_MESSAGE_FLAG),
        peer.getBytes(),
        serializeBytes(''),
        stableRandomId,
        uint32(INPUT_RICH_MESSAGE_MARKDOWN_CONSTRUCTOR_ID),
        uint32(0),
        serializeBytes(markdown)
      ]);
    },

    readResult(reader) {
      const result = readSendResult(reader, stableRandomId);
      return {
        className: 'updates.RichTextMessageSent',
        classType: 'constructor',
        updates: [],
        users: [],
        chats: [],
        ...result
      };
    }
  };
}

export {
  INPUT_RICH_MESSAGE_MARKDOWN_CONSTRUCTOR_ID,
  INVOKE_WITH_LAYER_CONSTRUCTOR_ID,
  RICH_MESSAGE_FLAG,
  SEND_MESSAGE_CONSTRUCTOR_ID,
  TELEGRAM_API_LAYER,
  UPDATE_MESSAGE_ID_CONSTRUCTOR_ID,
  UPDATE_SHORT_SENT_MESSAGE_CONSTRUCTOR_ID
};
