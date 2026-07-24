import assert from 'node:assert/strict';
import test from 'node:test';
import { selectFilesToPrune } from './storageRetention.js';

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
