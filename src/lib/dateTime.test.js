import assert from 'node:assert/strict';
import test from 'node:test';

import { formatDateTime } from './dateTime.js';

test('formatDateTime keeps the shared announcement and poster format', () => {
  assert.equal(
    formatDateTime('2026-09-12T08:30:00'),
    '2026.09.12 08:30',
  );
  assert.equal(
    formatDateTime('', { fallback: '时间未记录' }),
    '时间未记录',
  );
  assert.equal(formatDateTime('invalid'), '');
});

test('formatDateTime can use the current time for poster fallback', () => {
  const value = formatDateTime('', { useCurrentTime: true });
  assert.match(value, /^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}$/);
});
