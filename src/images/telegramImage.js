import { getTelegramMessageById } from '../audio/telegramAudio.js';

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function estimatedPhotoSize(size) {
  const direct = numeric(size?.size);
  if (direct !== null) {
    return direct;
  }
  const progressive = Array.isArray(size?.sizes)
    ? size.sizes.map(numeric).filter((value) => value !== null)
    : [];
  return progressive.length ? Math.max(...progressive) : null;
}

function selectPhotoSize(photo, maxFileBytes) {
  const sizes = (photo?.sizes || [])
    .filter((size) => numeric(size?.w) && numeric(size?.h))
    .map((size) => ({
      size,
      area: Number(size.w) * Number(size.h),
      bytes: estimatedPhotoSize(size)
    }))
    .filter((candidate) => candidate.bytes === null || candidate.bytes <= maxFileBytes)
    .sort((left, right) => right.area - left.area);
  return sizes[0]?.size || null;
}

export async function downloadTelegramImageMessage({
  client,
  message,
  metadata,
  maxFileBytes
}) {
  const photo = message.photo || message.media?.photo || null;
  const mimeType = photo
    ? 'image/jpeg'
    : String(
      message.document?.mimeType
      || message.document?.mime_type
      || metadata.media?.mimeType
      || ''
    ).toLowerCase();

  let thumb;
  if (photo) {
    const selectedSize = selectPhotoSize(photo, maxFileBytes);
    if (!selectedSize) {
      throw new Error('No Telegram photo size fits the configured image limit');
    }
    // GramJS does not accept a PhotoSizeProgressive object as `thumb`, even
    // though it returns one from Message.photo.sizes. Its string type works
    // for every supported Telegram photo size and avoids an empty buffer.
    thumb = selectedSize.type;
    if (!thumb) {
      throw new Error('Selected Telegram photo size has no downloadable type');
    }
  } else if ((metadata.media?.size || 0) > maxFileBytes) {
    throw new Error(`Image document exceeds the ${maxFileBytes} byte limit`);
  }

  const params = thumb ? { thumb } : {};
  const downloaded = typeof message.downloadMedia === 'function'
    ? await message.downloadMedia(params)
    : await client.downloadMedia(message, params);
  const buffer = Buffer.isBuffer(downloaded)
    ? downloaded
    : downloaded instanceof Uint8Array
      ? Buffer.from(downloaded)
      : null;
  if (!buffer || buffer.length === 0) {
    throw new Error('Telegram image download produced an empty buffer');
  }
  if (buffer.length > maxFileBytes) {
    throw new Error(`Downloaded image exceeds the ${maxFileBytes} byte limit`);
  }

  return {
    buffer,
    mimeType
  };
}

export { getTelegramMessageById };
