import fs from 'node:fs/promises';
import path from 'node:path';

// GramJS's path writer does not await WriteStream.close() before returning.
// Supply an asynchronous writer and own its lifetime, so callers cannot hash,
// copy or delete a file whose final chunks are still queued in a stream.
export async function downloadTelegramFile({ client, message, filePath, maxFileBytes, thumb }) {
  const handle = await fs.open(filePath, 'wx', 0o600);
  let written = 0;
  const writer = {
    async write(value) {
      const chunk = Buffer.from(value);
      if (maxFileBytes && written + chunk.length > maxFileBytes) {
        throw Object.assign(new Error('Telegram download exceeds file limit'), { code: 'blocked_by_limit' });
      }
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
        if (!bytesWritten) throw new Error('Telegram file write made no progress');
        offset += bytesWritten;
      }
      written += chunk.length;
    }
  };
  try {
    const args = { outputFile: writer, ...(thumb ? { thumb } : {}) };
    const result = typeof message.downloadMedia === 'function' ? await message.downloadMedia(args) : await client.downloadMedia(message, args);
    if (typeof result === 'string' && path.resolve(result) !== path.resolve(filePath)) throw new Error('Unexpected Telegram download path');
    if ((Buffer.isBuffer(result) || result instanceof Uint8Array) && !written) await writer.write(result);
    if (!written) throw new Error('Telegram media download produced an empty file');
    await handle.sync();
    return { filePath, size: written };
  } finally { await handle.close(); }
}
