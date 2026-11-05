import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptyPageGuard,
  createRepeatedPageGuard,
  hasStableRepostId,
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

test('legacy BID and decimal MID identify one repost without merging different reposts by the same user', () => {
  const desktop = { uid: '1001', repostId: '5000000123456789', source: 'desktop-cookie' };
  const legacy = { ...desktop, repostId: 'O000cevgF', source: 'weibo-cn' };
  const another = { ...desktop, repostId: '5000000123456790' };
  assert.equal(repostIdentity(desktop), repostIdentity(legacy));
  assert.deepEqual(uniqueReposts([desktop, legacy, another]), [desktop, another]);
  assert.deepEqual(uniqueReposts([legacy, desktop, another]), [legacy, another]);
});

test('opaque and ambiguous numeric IDs are not guessed into unrelated identities', () => {
  assert.equal(repostIdentity({ repostId: '987654321', source: 'weibo-cn' }), 'repost:987654321');
  assert.equal(repostIdentity({ repostId: 'OZZZZZZZZ', source: 'weibo-cn' }), 'repost:OZZZZZZZZ');
  assert.equal(repostIdentity({ repostId: 'O000cevgF', source: 'manual' }), 'repost:O000cevgF');
  assert.equal(hasStableRepostId({ repostId: '987654321', source: 'weibo-cn' }), false);
  assert.equal(hasStableRepostId({ repostId: 'O000cevgF', source: 'weibo-cn' }), true);
  assert.equal(hasStableRepostId({ repostId: 'weibo-cn-1-0-900001', source: 'weibo-cn' }), false);
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
