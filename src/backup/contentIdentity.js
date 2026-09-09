// File references are short-lived Telegram download credentials, not content.
// Keep the observed raw payload, but ignore reference refreshes when comparing it.
export function stableTelegramContent(value) {
  if (Array.isArray(value)) return value.map(stableTelegramContent);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'fileReference')
    .map(([key, item]) => [key, stableTelegramContent(item)]));
}

export function stableIndexedContent(value) {
  const result = stableTelegramContent(value);
  for (const key of ['_id', 'createdAt', 'updatedAt']) delete result[key];
  if (result.transcription) {
    for (const key of ['lockUntil', 'updatedAt', 'nextAttemptAt']) delete result.transcription[key];
  }
  return result;
}
