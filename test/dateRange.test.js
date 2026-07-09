import assert from 'node:assert/strict';
import test from 'node:test';

import { dayRange } from '../src/services/dateRange.js';

test('dayRange returns one UTC day for UTC timezone', () => {
  const range = dayRange('2026-07-09', 'UTC');

  assert.equal(range.from.toISOString(), '2026-07-09T00:00:00.000Z');
  assert.equal(range.to.toISOString(), '2026-07-10T00:00:00.000Z');
});

test('dayRange respects positive timezone offsets', () => {
  const range = dayRange('2026-07-09', 'Europe/Chisinau');

  assert.equal(range.from.toISOString(), '2026-07-08T21:00:00.000Z');
  assert.equal(range.to.toISOString(), '2026-07-09T21:00:00.000Z');
});
