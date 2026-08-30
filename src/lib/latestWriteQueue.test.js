import assert from 'node:assert/strict';
import test from 'node:test';

import { createLatestWriteQueue } from './latestWriteQueue.js';

test('latest write queue keeps one active write and the newest pending value', async () => {
  const writes = [];
  let release;
  const firstWrite = new Promise((resolve) => { release = resolve; });
  const queue = createLatestWriteQueue(async (value) => {
    writes.push(value);
    if (value === 'first') await firstWrite;
  });

  const first = queue.enqueue('first');
  const second = queue.enqueue('second');
  const third = queue.enqueue('latest');

  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(queue.active, true);
  assert.equal(queue.pending, true);
  release();
  await first;

  assert.deepEqual(writes, ['first', 'latest']);
  assert.equal(queue.active, false);
  assert.equal(queue.pending, false);
  assert.equal(queue.writeCount, 2);
  assert.equal(queue.coalescedCount, 2);
});

test('latest write queue recovers after a write failure', async () => {
  let attempts = 0;
  const queue = createLatestWriteQueue(async (value) => {
    attempts += 1;
    if (value === 'bad') throw new Error('disk busy');
  });

  await assert.rejects(queue.enqueue('bad'), { message: 'disk busy' });
  await queue.enqueue('good');

  assert.equal(attempts, 2);
  assert.equal(queue.active, false);
  assert.equal(queue.pending, false);
  assert.equal(queue.failureCount, 1);
  assert.ok(queue.lastFailureAt);
  assert.ok(queue.lastSuccessAt);
});

test('latest successful snapshot clears an earlier failure in the same drain', async () => {
  const writes = [];
  let release;
  const firstWrite = new Promise((resolve) => { release = resolve; });
  const queue = createLatestWriteQueue(async (value) => {
    writes.push(value);
    if (value === 'bad') {
      await firstWrite;
      throw new Error('disk busy');
    }
  });

  const first = queue.enqueue('bad');
  const latest = queue.enqueue('good');
  release();

  await Promise.all([first, latest]);
  assert.deepEqual(writes, ['bad', 'good']);
  assert.equal(queue.writeCount, 1);
  assert.equal(queue.active, false);
  assert.equal(queue.pending, false);
});
