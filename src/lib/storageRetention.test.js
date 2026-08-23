import assert from 'node:assert/strict';
import test from 'node:test';
import { retainLatestLines, selectFilesToPrune } from './storageRetention.js';

const files = [
  { file: 'newest.json', size: 40 },
  { file: 'middle.json', size: 35 },
  { file: 'oldest.json', size: 30 },
];

test('selectFilesToPrune removes oldest files beyond the count limit', () => {
  const result = selectFilesToPrune(files, { maxFiles: 2, maxBytes: 1000 });
  assert.deepEqual(result.removals.map((item) => item.file), ['oldest.json']);
  assert.equal(result.retainedBytes, 75);
});

test('selectFilesToPrune removes oldest files until the byte budget is met', () => {
  const result = selectFilesToPrune(files, { maxFiles: 10, maxBytes: 70 });
  assert.deepEqual(result.removals.map((item) => item.file), ['oldest.json', 'middle.json']);
  assert.equal(result.retainedBytes, 40);
});

test('retainLatestLines applies the entry limit even below the byte limit', () => {
  assert.deepEqual(
    retainLatestLines(['one', 'two', 'three'], { maxLines: 2, maxBytes: 1000 }),
    ['two', 'three'],
  );
});

test('retainLatestLines removes the oldest lines until the byte budget is met', () => {
  assert.deepEqual(
    retainLatestLines(['aaaa', 'bbbb', 'cccc'], { maxLines: 10, maxBytes: 10 }),
    ['bbbb', 'cccc'],
  );
});
