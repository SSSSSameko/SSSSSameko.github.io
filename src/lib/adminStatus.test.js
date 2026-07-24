import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendKeepaliveEvent,
  formatDurationMs,
} from './adminStatus.js';

test('formatDurationMs renders the 12 hour keepalive interval clearly', () => {
  assert.equal(formatDurationMs(12 * 60 * 60_000), '12 小时');
});

test('appendKeepaliveEvent stores newest events first and caps history', () => {
  const base = {
    history: Array.from({ length: 12 }, (_, index) => ({
      at: `2026-06-22T00:${String(index).padStart(2, '0')}:00.000Z`,
      status: 'ok',
      message: `old-${index}`,
    })),
  };

  const next = appendKeepaliveEvent(base, {
    at: '2026-06-23T01:00:00.000Z',
    status: 'error',
    reason: 'scheduled-refresh',
    message: 'profile missing',
  });

  assert.equal(next.history.length, 12);
  assert.deepEqual(next.history[0], {
    at: '2026-06-23T01:00:00.000Z',
    status: 'error',
    reason: 'scheduled-refresh',
    message: 'profile missing',
  });
  assert.equal(next.history.at(-1).message, 'old-10');
});
