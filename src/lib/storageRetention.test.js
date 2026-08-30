import assert from 'node:assert/strict';
import test from 'node:test';
import {
  removeFilesBestEffort,
  retainLatestLines,
  retainRecentEntries,
  selectNewestFiles,
  selectFilesToPrune,
} from './storageRetention.js';

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

test('selectNewestFiles keeps a bounded newest set without changing the input', () => {
  const input = [
    { file: 'old.json', mtimeMs: 10 },
    { file: 'new.json', mtimeMs: 30 },
    { file: 'middle.json', mtimeMs: 20 },
  ];

  assert.deepEqual(selectNewestFiles(input, 2).map((item) => item.file), ['new.json', 'middle.json']);
  assert.deepEqual(input.map((item) => item.file), ['old.json', 'new.json', 'middle.json']);
});

test('selectNewestFiles uses a stable filename tie-breaker', () => {
  assert.deepEqual(
    selectNewestFiles([
      { file: 'draw-a.json', mtimeMs: 10 },
      { file: 'draw-c.json', mtimeMs: 10 },
      { file: 'draw-b.json', mtimeMs: 10 },
    ], 2).map((item) => item.file),
    ['draw-c.json', 'draw-b.json'],
  );
});

test('selectFilesToPrune removes oldest files until the byte budget is met', () => {
  const result = selectFilesToPrune(files, { maxFiles: 10, maxBytes: 70 });
  assert.deepEqual(result.removals.map((item) => item.file), ['oldest.json', 'middle.json']);
  assert.equal(result.retainedBytes, 40);
});

test('selectFilesToPrune removes files beyond the retention period', () => {
  const now = Date.parse('2026-08-25T00:00:00.000Z');
  const result = selectFilesToPrune([
    { file: 'recent.json', size: 40, mtimeMs: now - 10 * 24 * 60 * 60_000 },
    { file: 'expired.json', size: 30, mtimeMs: now - 181 * 24 * 60 * 60_000 },
  ], { maxFiles: 10, maxBytes: 1000, maxAgeMs: 180 * 24 * 60 * 60_000, now });

  assert.deepEqual(result.removals.map((item) => item.file), ['expired.json']);
  assert.equal(result.retainedBytes, 40);
});

test('retainRecentEntries drops expired feedback and applies its count limit', () => {
  const now = Date.parse('2026-08-25T00:00:00.000Z');
  const items = [
    { id: 'expired', createdAt: '2026-05-01T00:00:00.000Z' },
    { id: 'one', createdAt: '2026-08-20T00:00:00.000Z' },
    { id: 'two', createdAt: '2026-08-21T00:00:00.000Z' },
  ];

  assert.deepEqual(
    retainRecentEntries(items, {
      maxEntries: 1,
      maxAgeMs: 90 * 24 * 60 * 60_000,
      now,
    }).map((item) => item.id),
    ['two'],
  );
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

test('removeFilesBestEffort only counts successful removals and keeps failed bytes', async () => {
  const result = await removeFilesBestEffort([
    { file: 'removed.json', size: 40 },
    { file: 'missing.json', size: 30 },
    { file: 'locked.json', size: 20 },
  ], async (item) => {
    if (item.file === 'missing.json') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    if (item.file === 'locked.json') throw Object.assign(new Error('locked'), { code: 'EPERM' });
  });

  assert.equal(result.removedCount, 1);
  assert.equal(result.missingCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(result.freedBytes, 70);
  assert.equal(result.failures[0].item.file, 'locked.json');
});

test('removeFilesBestEffort keeps file operations within the concurrency limit', async () => {
  let active = 0;
  let peak = 0;
  const processed = [];
  const items = Array.from({ length: 24 }, (_, index) => ({
    file: `file-${index}.json`,
    size: 1,
  }));

  const result = await removeFilesBestEffort(items, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    processed.push(item.file);
    active -= 1;
  }, { concurrency: 3 });

  assert.equal(peak, 3);
  assert.equal(processed.length, items.length);
  assert.equal(result.removedCount, items.length);
  assert.equal(result.freedBytes, items.length);
});

test('removeFilesBestEffort bounds retained failure details', async () => {
  const result = await removeFilesBestEffort(
    Array.from({ length: 12 }, (_, index) => ({ file: `locked-${index}.json` })),
    async () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); },
    { concurrency: 2, maxFailures: 4 },
  );

  assert.equal(result.failedCount, 12);
  assert.equal(result.failures.length, 4);
});
