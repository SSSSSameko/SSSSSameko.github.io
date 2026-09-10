import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptyPageGuard,
  createRepeatedPageGuard,
  repostIdentity,
  uniqueReposts,
} from './repostCandidates.js';

test('repost identity keeps separate reposts from the same account', () => {
  const first = { uid: '1001', repostId: 'repost-a', text: '第一次转发' };
  const second = { uid: '1001', repostId: 'repost-b', text: '第二次转发' };

  assert.notEqual(repostIdentity(first), repostIdentity(second));
  assert.deepEqual(uniqueReposts([first, second]), [first, second]);
});

test('unique reposts remove repeated provider copies of one repost', () => {
  const desktop = { uid: '1001', repostId: 'same-repost', source: 'desktop-cookie' };
  const mobile = { uid: '1001', repostId: 'same-repost', source: 'mobile' };

  assert.deepEqual(uniqueReposts([desktop, mobile]), [desktop]);
});

test('repeated page guard stops only after consecutive non-empty duplicate pages', () => {
  const guard = createRepeatedPageGuard(3);
  assert.equal(guard.observe(20, 0), false);
  assert.equal(guard.observe(20, 0), false);
  assert.equal(guard.observe(20, 2), false);
  assert.equal(guard.observe(20, 0), false);
  assert.equal(guard.observe(20, 0), false);
  assert.equal(guard.observe(20, 0), true);
  assert.equal(guard.count, 3);
});

test('empty page guard resets after data resumes', () => {
  const guard = createEmptyPageGuard(3);
  assert.equal(guard.observe(0), false);
  assert.equal(guard.observe(0), false);
  assert.equal(guard.observe(1), false);
  assert.equal(guard.observe(0), false);
  assert.equal(guard.observe(0), false);
  assert.equal(guard.observe(0), true);
  assert.equal(guard.count, 3);
});
