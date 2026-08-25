import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isWeiboThrottleStatus,
  pageWaitPlan,
  parseRetryAfterMs,
  shouldReconcileRepostHead,
  throttleRetryDelayMs,
} from './weiboPacing.js';

test('recognizes Weibo responses that should back off', () => {
  assert.equal(isWeiboThrottleStatus(418), true);
  assert.equal(isWeiboThrottleStatus(429), true);
  assert.equal(isWeiboThrottleStatus(503), true);
  assert.equal(isWeiboThrottleStatus(401), false);
});

test('parses retry-after seconds and dates', () => {
  assert.equal(parseRetryAfterMs('12'), 12_000);
  assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:20 GMT', Date.parse('2026-01-01T00:00:00Z')), 20_000);
  assert.equal(parseRetryAfterMs('invalid'), 0);
});

test('uses exponential backoff without exceeding the ceiling', () => {
  assert.equal(throttleRetryDelayMs({ attempt: 0, baseMs: 15_000, maxMs: 60_000 }), 15_000);
  assert.equal(throttleRetryDelayMs({ attempt: 2, baseMs: 15_000, maxMs: 60_000 }), 60_000);
  assert.equal(throttleRetryDelayMs({ retryAfter: '90', baseMs: 15_000, maxMs: 60_000 }), 60_000);
});

test('adds jitter to every page and cooldowns at the configured interval', () => {
  assert.deepEqual(pageWaitPlan({
    page: 7,
    baseMs: 2_000,
    jitterMs: 1_000,
    cooldownEvery: 8,
    cooldownMs: 5_000,
    random: () => 0.5,
  }), { delayMs: 2_500, jitterMs: 500, cooldownMs: 0 });

  assert.deepEqual(pageWaitPlan({
    page: 8,
    baseMs: 2_000,
    jitterMs: 1_000,
    cooldownEvery: 8,
    cooldownMs: 5_000,
    random: () => 0.5,
  }), { delayMs: 7_500, jitterMs: 500, cooldownMs: 5_000 });
});

test('rechecks the newest repost page only after a meaningful paginated crawl', () => {
  assert.equal(shouldReconcileRepostHead({ pageCount: 1, elapsedMs: 20_000 }), false);
  assert.equal(shouldReconcileRepostHead({ pageCount: 3, elapsedMs: 4_999 }), false);
  assert.equal(shouldReconcileRepostHead({ pageCount: 3, elapsedMs: 5_000 }), true);
  assert.equal(shouldReconcileRepostHead({ pageCount: 3, elapsedMs: 20_000, hitCandidateCap: true }), false);
});
