import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countEligibleUsers, uniqueWinnerPool } from './drawPool.js';

test('multiple reposts affect entry order but cannot award one user twice', () => {
  const entries = [
    { uid: '1', repostId: 'later' },
    { uid: '1', repostId: 'earlier' },
    { uid: '2' },
    { screenName: 'Sameko' },
    { screenName: 'sameko' },
  ];
  assert.equal(countEligibleUsers(entries), 3);
  assert.deepEqual(uniqueWinnerPool(entries), [entries[0], entries[2], entries[3]]);
  assert.deepEqual(uniqueWinnerPool([entries[1], entries[2], entries[0]]), [
    entries[1],
    entries[2],
  ]);
  assert.equal(entries.length, 5, 'the original candidate evidence must remain intact');
});

test('the default unique-user draw keeps the original shuffled order', () => {
  const entries = [{ uid: '3' }, { uid: '1' }, { uid: '2' }];
  assert.deepEqual(uniqueWinnerPool(entries), entries);
  assert.equal(countEligibleUsers([]), 0);
});
