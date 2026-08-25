import assert from 'node:assert/strict';
import test from 'node:test';

import { createSnapshotCache, repostTaskKey } from './repostTaskCache.js';

test('repost task keys separate auth modes without retaining credentials', () => {
  const serverKey = repostTaskKey('12345', { source: 'mobile' });
  const userKey = repostTaskKey('12345', { source: 'mobile', authScope: 'scope-a' });
  const otherUserKey = repostTaskKey('12345', { source: 'mobile', authScope: 'scope-b' });
  const tokenKey = repostTaskKey('12345', { source: 'official', authScope: 'scope-c' });

  assert.equal(serverKey, 'mobile:server-session:12345');
  assert.equal(userKey, 'mobile:user-cookie:scope-a:12345');
  assert.equal(tokenKey, 'official:access-token:scope-c:12345');
  assert.notEqual(userKey, otherUserKey);
  assert.ok(!userKey.includes('secret'));
  assert.ok(!tokenKey.includes('also-secret'));
});

test('snapshot cache expires results and keeps a bounded LRU set', () => {
  let clock = 1000;
  const cache = createSnapshotCache({ ttlMs: 50, maxEntries: 2, now: () => clock });

  cache.set('first', { candidates: [1] });
  clock += 10;
  cache.set('second', { candidates: [2] });
  assert.deepEqual(cache.get('first').result.candidates, [1]);

  clock += 10;
  cache.set('third', { candidates: [3] });
  assert.equal(cache.get('second'), null);
  assert.equal(cache.size, 2);

  clock += 50;
  assert.equal(cache.get('first'), null);
  assert.equal(cache.get('third'), null);
  assert.equal(cache.size, 0);
});

test('snapshot cache releases an expired result without another cache request', async () => {
  const cache = createSnapshotCache({ ttlMs: 15, maxEntries: 2 });
  cache.set('large-result', { candidates: Array.from({ length: 100 }, (_, index) => index) });
  assert.equal(cache.size, 1);

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(cache.size, 0);
});
