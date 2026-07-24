import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactCookieEntriesByAccount,
  cookiePoolCounts,
} from './cookiePool.js';

test('compactCookieEntriesByAccount keeps one cookie per validated account', () => {
  const entries = [
    { id: 'fresh', user: { id: '1001' }, lastValidAt: '2026-07-02T09:02:00.000Z' },
    { id: 'old', user: { id: '1001' }, lastValidAt: '2026-06-27T09:02:00.000Z' },
    { id: 'other', user: { id: '2002' }, lastValidAt: '2026-07-01T09:02:00.000Z' },
  ];

  const compacted = compactCookieEntriesByAccount(entries);

  assert.deepEqual(compacted.map((entry) => entry.id), ['fresh', 'other']);
});

test('cookiePoolCounts separates stored cookies from unique accounts', () => {
  const counts = cookiePoolCounts([
    { id: 'fresh', user: { id: '1001' } },
    { id: 'old', user: { id: '1001' } },
    { id: 'manual-without-user' },
  ]);

  assert.deepEqual(counts, {
    cookieCount: 3,
    accountCount: 2,
  });
});
