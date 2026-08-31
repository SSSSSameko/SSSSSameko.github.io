import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactCookieEntriesByAccount,
  cookieCandidatesWithFallback,
  cookiePoolCounts,
  cookiePoolStatusCounts,
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

test('cookiePoolStatusCounts does not describe every stored cookie as verified', () => {
  const counts = cookiePoolStatusCounts([
    {
      id: 'verified',
      user: { id: '1001' },
      lastCheckedAt: '2026-08-31T08:00:00.000Z',
      lastValidAt: '2026-08-31T08:00:00.000Z',
      lastError: '',
    },
    { id: 'pending' },
    {
      id: 'network-error',
      lastCheckedAt: '2026-08-31T08:05:00.000Z',
      lastError: 'request timed out',
    },
    {
      id: 'quarantined',
      lastCheckedAt: '2026-08-31T08:10:00.000Z',
      lastValidAt: '2026-08-31T08:10:00.000Z',
      lastError: '',
    },
  ], { quarantinedIds: ['quarantined'] });

  assert.deepEqual(counts, {
    tryableCookieCount: 3,
    tryableAccountCount: 3,
    verifiedCookieCount: 1,
    verifiedAccountCount: 1,
    pendingCookieCount: 1,
    pendingAccountCount: 1,
    checkFailedCookieCount: 1,
    checkFailedAccountCount: 1,
    quarantinedCookieCount: 1,
    quarantinedAccountCount: 1,
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
