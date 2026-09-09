import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadTelegramFile } from '../src/telegram/mediaDownload.js';

test('Telegram downloader commits all asynchronously written chunks before returning', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-download-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const chunks = [Buffer.alloc(131072, 17), Buffer.alloc(200000, 29), Buffer.from('final chunk')];
  const filePath = path.join(directory, 'original');
  const client = { async downloadMedia(_message, args) {
    assert.equal(typeof args.outputFile.write, 'function');
    for (const chunk of chunks) await args.outputFile.write(chunk);
  } };
  const result = await downloadTelegramFile({ client, message: {}, filePath, maxFileBytes: 1000000 });
  assert.equal(result.size, Buffer.concat(chunks).length);
  assert.deepEqual(await fs.readFile(filePath), Buffer.concat(chunks));
  await assert.rejects(downloadTelegramFile({ client, message: {}, filePath: path.join(directory, 'limited'), maxFileBytes: 100 }), /exceeds/);
});
