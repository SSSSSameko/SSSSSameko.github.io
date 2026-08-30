import assert from 'node:assert/strict';
import test from 'node:test';

import { createAsyncGate } from './asyncGate.js';

test('async gate keeps work within its concurrency limit', async () => {
  const gate = createAsyncGate({ concurrency: 2, maxQueue: 4 });
  let running = 0;
  let peak = 0;
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const jobs = Array.from({ length: 4 }, () => gate.run(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await hold;
    running -= 1;
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.active, 2);
  assert.equal(gate.queued, 2);
  release();
  await Promise.all(jobs);
  assert.equal(peak, 2);
  assert.equal(gate.active, 0);
});

test('feedback-style async gate rejects a full queue without retaining the rejected work', async () => {
  const gate = createAsyncGate({
    concurrency: 1,
    maxQueue: 1,
    busyError: () => Object.assign(new Error('反馈提交较多，请稍后再试'), { status: 429 }),
  });
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const active = gate.run(() => hold);
  const queued = gate.run(() => Promise.resolve());
  let rejectedTaskRan = false;

  const rejected = gate.run(() => {
    rejectedTaskRan = true;
    return Promise.resolve();
  });
  assert.equal(gate.active, 1);
  assert.equal(gate.queued, 1);
  await assert.rejects(rejected, {
    message: '反馈提交较多，请稍后再试',
    status: 429,
  });
  assert.equal(gate.queued, 1);
  release();
  await Promise.all([active, queued]);
  assert.equal(rejectedTaskRan, false);
  assert.equal(gate.active, 0);
  assert.equal(gate.queued, 0);
});

test('queued work can be cancelled without occupying a later slot', async () => {
  const gate = createAsyncGate({ concurrency: 1, maxQueue: 2 });
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const active = gate.run(() => hold);
  const controller = new AbortController();
  const queued = gate.run(() => Promise.resolve('should not run'), { signal: controller.signal });

  assert.equal(gate.active, 1);
  assert.equal(gate.queued, 1);
  controller.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(gate.queued, 0);

  release();
  await active;
  assert.equal(gate.active, 0);
});
