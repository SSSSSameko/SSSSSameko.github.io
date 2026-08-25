import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeRepostHead, repostIdentity, uniqueReposts } from './repostCandidates.js';

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

test('head reconciliation prepends new reposts and respects the candidate cap', () => {
  const existing = [
    { uid: '1001', repostId: 'old-a' },
    { uid: '1002', repostId: 'old-b' },
  ];
  const latest = [
    { uid: '1003', repostId: 'new-a' },
    { uid: '1001', repostId: 'old-a' },
  ];

  const merged = mergeRepostHead(existing, latest, 3);
  assert.equal(merged.addedCount, 1);
  assert.equal(merged.truncatedCount, 0);
  assert.deepEqual(merged.candidates.map((item) => item.repostId), ['new-a', 'old-a', 'old-b']);
});

test('head reconciliation never drops older candidates when the cap is full', () => {
  const existing = [{ repostId: 'old-a' }, { repostId: 'old-b' }];
  const merged = mergeRepostHead(existing, [{ repostId: 'new-a' }], 2);

  assert.equal(merged.addedCount, 0);
  assert.equal(merged.truncatedCount, 1);
  assert.deepEqual(merged.candidates, existing);
});
