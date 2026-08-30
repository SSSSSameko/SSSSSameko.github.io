import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactCookieEntriesByAccount,
  cookieCandidatesWithFallback,
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

test('cookieCandidatesWithFallback always tries stored accounts first', () => {
  const candidates = cookieCandidatesWithFallback(
    [{ id: 'server-one', cookie: 'server=1' }, { id: 'server-two', cookie: 'server=2' }],
    { id: 'user-fallback', cookie: 'user=1' },
  );

  assert.deepEqual(candidates.map((entry) => entry.id), [
    'server-one',
    'server-two',
    'user-fallback',
  ]);
  assert.equal(candidates[2].transient, true);
});

test('cookieCandidatesWithFallback does not retry the same stored cookie', () => {
  const candidates = cookieCandidatesWithFallback(
    [{ id: 'same', cookie: 'server=1' }],
    { id: 'same', cookie: 'server=1' },
  );

  assert.equal(candidates.length, 1);
});
