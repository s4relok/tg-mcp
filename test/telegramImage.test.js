import assert from 'node:assert/strict';
import test from 'node:test';

import { downloadTelegramImageMessage } from '../src/images/telegramImage.js';

test('Telegram photo download selects the largest size below the configured byte limit', async () => {
  let selectedThumb = null;
  const small = { type: 'm', w: 640, h: 360, size: 200000 };
  const large = { type: 'y', w: 1920, h: 1080, size: 2000000 };
  const result = await downloadTelegramImageMessage({
    client: {},
    message: {
      photo: { sizes: [small, large] },
      downloadMedia: async ({ thumb }) => {
        selectedThumb = thumb;
        return Buffer.from('photo');
      }
    },
    metadata: {
      media: { kind: 'photo', mimeType: 'image/jpeg', size: 2000000 }
    },
    maxFileBytes: 500000
  });

  assert.equal(selectedThumb, 'm');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.buffer.toString(), 'photo');
});

test('Telegram image document is rejected before download when declared size is too large', async () => {
  let downloads = 0;
  await assert.rejects(
    () => downloadTelegramImageMessage({
      client: {},
      message: {
        document: { mimeType: 'image/png' },
        downloadMedia: async () => {
          downloads += 1;
          return Buffer.from('image');
        }
      },
      metadata: {
        media: { kind: 'image', mimeType: 'image/png', size: 2000000 }
      },
      maxFileBytes: 500000
    }),
    /exceeds/
  );
  assert.equal(downloads, 0);
});
