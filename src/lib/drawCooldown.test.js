import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquireDrawGuard,
  acquireDrawTabLock,
  clearDrawCooldownStorage,
  completeDrawGuard,
  drawCooldownScope,
  drawCooldownStatus,
  DRAW_COOLDOWN_KEY,
  DRAW_COOLDOWN_MS,
  releaseDrawGuard,
} from './drawCooldown.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function memoryLocks() {
  const held = new Set();
  return {
    request(name, options, callback) {
      const lock = options?.ifAvailable && held.has(name) ? null : { name };
      if (lock) held.add(name);
      return Promise.resolve(callback(lock)).finally(() => {
        if (lock) held.delete(name);
      });
    },
  };
}

test('draw cooldown uses the loaded Weibo id and skips manual lists', () => {
  assert.equal(drawCooldownScope({ source: 'manual', statusId: '123' }), '');
  assert.equal(drawCooldownScope({ source: 'mobile', statusId: '123' }), 'weibo:123');
  assert.equal(
    drawCooldownScope({ source: 'mobile', statusUrl: 'http://m.weibo.cn/detail/123' }),
    'weibo-url:https://m.weibo.cn/detail/123',
  );
});

test('only a completed draw starts the one-minute cooldown', () => {
  const storage = memoryStorage();
  const scope = 'weibo:123';
  const first = acquireDrawGuard(storage, scope, 1_000);
  assert.equal(first.ok, true);
  assert.equal(first.persistent, true);
  assert.equal(drawCooldownStatus(storage, scope, 1_100).reason, 'running');

  releaseDrawGuard(storage, scope, first.token, 1_200);
  assert.equal(drawCooldownStatus(storage, scope, 1_300).blocked, false);

  const second = acquireDrawGuard(storage, scope, 2_000);
  const completed = completeDrawGuard(storage, scope, second.token, 3_000);
  assert.equal(completed.persistent, true);
  const blocked = drawCooldownStatus(storage, scope, 3_500);
  assert.equal(blocked.reason, 'cooldown');
  assert.equal(blocked.persistent, true);
  assert.equal(blocked.remainingMs, DRAW_COOLDOWN_MS - 500);
  assert.equal(drawCooldownStatus(storage, scope, 3_000 + DRAW_COOLDOWN_MS).blocked, false);
});

test('a different link can draw while another link is cooling down', () => {
  const storage = memoryStorage();
  const first = acquireDrawGuard(storage, 'weibo:123', 1_000);
  completeDrawGuard(storage, 'weibo:123', first.token, 2_000);
  assert.equal(acquireDrawGuard(storage, 'weibo:456', 2_100).ok, true);
});

test('cooldown cleanup removes persistent and in-page draw guards', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const scope = 'weibo:clear-guard';
  assert.equal(acquireDrawGuard(storage, scope, 10_000).ok, true);

  assert.deepEqual(clearDrawCooldownStorage(storage), { ok: true, reason: '' });
  assert.equal(values.has(DRAW_COOLDOWN_KEY), false);
  assert.equal(drawCooldownStatus(storage, scope, 10_100).blocked, false);
  assert.equal(acquireDrawGuard(storage, scope, 10_100).ok, true);
});

test('suppression-only records cannot evict an active running guard', () => {
  const now = 200_000;
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const records = Object.fromEntries([
    ['weibo:active-old', {
      state: 'running',
      token: 'active-token',
      startedAt: now - 120_000,
      expiresAt: now + 60_000,
    }],
    ...Array.from({ length: 50 }, (_, index) => [`weibo:suppressed-${index}`, {
      state: 'completed',
      token: `suppressed-token-${index}`,
      completedAt: now - DRAW_COOLDOWN_MS - 1_000 + index,
      suppressUntil: now + 120_000 + index,
    }]),
  ]);
  values.set('weibo-draw-cooldowns-v1', JSON.stringify(records));

  const newest = acquireDrawGuard(storage, 'weibo:new-active', now);
  const persisted = JSON.parse(values.get('weibo-draw-cooldowns-v1'));

  assert.equal(newest.ok, true);
  assert.equal(drawCooldownStatus(storage, 'weibo:active-old', now + 1_000).reason, 'running');
  assert.equal(persisted['weibo:active-old'].token, 'active-token');
  assert.equal(Object.keys(persisted).length, 50);
});

test('the browser lock closes the simultaneous-tab race for one link', async () => {
  const locks = memoryLocks();
  const first = await acquireDrawTabLock('weibo:123', locks);
  assert.equal(first.ok, true);
  assert.equal(first.supported, true);

  const competing = await acquireDrawTabLock('weibo:123', locks);
  assert.equal(competing.ok, false);
  assert.equal(competing.reason, 'running');

  const otherLink = await acquireDrawTabLock('weibo:456', locks);
  assert.equal(otherLink.ok, true);
  await otherLink.release();
  await first.release();

  const next = await acquireDrawTabLock('weibo:123', locks);
  assert.equal(next.ok, true);
  await next.release();
});

test('the browser lock fails open when Web Locks is unavailable', async () => {
  const lease = await acquireDrawTabLock('weibo:123', null);
  assert.equal(lease.ok, true);
  assert.equal(lease.supported, false);
  await lease.release();
});

test('a storage write failure keeps the guard active in this tab', () => {
  const storage = {
    getItem: () => null,
    setItem() {
      const error = new Error('Quota exceeded');
      error.name = 'QuotaExceededError';
      throw error;
    },
  };
  const scope = 'weibo:fallback-running';
  const first = acquireDrawGuard(storage, scope, 10_000);

  assert.equal(first.ok, true);
  assert.equal(first.persistent, false);
  assert.equal(drawCooldownStatus(storage, scope, 10_100).persistent, false);
  assert.equal(acquireDrawGuard(storage, scope, 10_200).reason, 'running');

  const completed = completeDrawGuard(storage, scope, first.token, 11_000);
  assert.equal(completed.persistent, false);
  const cooldown = drawCooldownStatus(storage, scope, 11_500);
  assert.equal(cooldown.reason, 'cooldown');
  assert.equal(cooldown.persistent, false);
});

test('a non-persistent running guard can still be released', () => {
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error('storage disabled'); },
  };
  const scope = 'weibo:fallback-release';
  const first = acquireDrawGuard(storage, scope, 20_000);

  assert.equal(first.persistent, false);
  assert.equal(releaseDrawGuard(storage, scope, first.token, 20_100).persistent, false);
  assert.equal(drawCooldownStatus(storage, scope, 20_200).blocked, false);
  assert.equal(acquireDrawGuard(storage, scope, 20_300).ok, true);
});

test('a write that cannot be verified falls back to the page guard', () => {
  const storage = {
    getItem: () => null,
    setItem: () => {},
  };
  const scope = 'weibo:verify-fallback';
  const guard = acquireDrawGuard(storage, scope, 30_000);

  assert.equal(guard.ok, true);
  assert.equal(guard.persistent, false);
  assert.equal(drawCooldownStatus(storage, scope, 30_100).reason, 'running');
});

test('a persisted guard survives storage becoming unavailable in this tab', () => {
  const values = new Map();
  let available = true;
  const storage = {
    getItem(key) {
      if (!available) throw new Error('storage disabled');
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      if (!available) throw new Error('storage disabled');
      values.set(key, String(value));
    },
  };
  const scope = 'weibo:storage-lost';
  const guard = acquireDrawGuard(storage, scope, 40_000);
  assert.equal(guard.persistent, true);

  available = false;
  const completed = completeDrawGuard(storage, scope, guard.token, 41_000);
  assert.equal(completed.persistent, false);
  assert.deepEqual(drawCooldownStatus(storage, scope, 41_500), {
    blocked: true,
    reason: 'cooldown',
    remainingMs: DRAW_COOLDOWN_MS - 500,
    persistent: false,
  });
  assert.equal(drawCooldownStatus(storage, scope, 41_000 + DRAW_COOLDOWN_MS).blocked, false);
});

test('a failed completion write does not extend the cooldown with a stale running record', () => {
  const values = new Map();
  let rejectWrites = false;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (rejectWrites) throw new Error('storage disabled');
      values.set(key, String(value));
    },
  };
  const scope = 'weibo:stale-running';
  const guard = acquireDrawGuard(storage, scope, 50_000);
  rejectWrites = true;

  assert.equal(completeDrawGuard(storage, scope, guard.token, 51_000).persistent, false);
  assert.equal(drawCooldownStatus(storage, scope, 51_500).reason, 'cooldown');
  assert.equal(drawCooldownStatus(storage, scope, 51_000 + DRAW_COOLDOWN_MS).blocked, false);

  const next = acquireDrawGuard(storage, scope, 51_000 + DRAW_COOLDOWN_MS);
  assert.equal(next.ok, true);
  assert.equal(next.persistent, false);
});

test('a failed release write does not leave this tab stuck on the old guard', () => {
  const values = new Map();
  let rejectWrites = false;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (rejectWrites) throw new Error('storage disabled');
      values.set(key, String(value));
    },
  };
  const scope = 'weibo:stale-release';
  const guard = acquireDrawGuard(storage, scope, 60_000);
  rejectWrites = true;

  assert.equal(releaseDrawGuard(storage, scope, guard.token, 60_100).persistent, false);
  assert.equal(drawCooldownStatus(storage, scope, 60_200).blocked, false);
  const next = acquireDrawGuard(storage, scope, 60_300);
  assert.equal(next.ok, true);
  assert.equal(next.persistent, false);
});

test('the browser lock fails open when the lock request rejects', async () => {
  const lease = await acquireDrawTabLock('weibo:lock-error', {
    request: () => Promise.reject(new Error('lock service unavailable')),
  });

  assert.equal(lease.ok, true);
  assert.equal(lease.supported, false);
  await lease.release();
});
