import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { waitForChildExit } from './child-process.mjs';

function runningChild() {
  return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, pid: 123 });
}

test('waiting for a child clears its watchdog and listeners when it exits', async () => {
  const child = runningChild();
  const timerCount = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const waiting = waitForChildExit(child, { timeoutMs: 5000 });
  child.emit('exit', 0, null);
  assert.deepEqual(await waiting, { code: 0, signal: null });
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length, timerCount);
});

test('waiting for an already exited child resolves without another event', async () => {
  const child = Object.assign(runningChild(), { exitCode: 1 });
  assert.deepEqual(await waitForChildExit(child), { code: 1, signal: null });
  assert.equal(child.listenerCount('exit'), 0);
});

test('waiting for a child reports spawn errors and removes listeners', async () => {
  const child = runningChild();
  const error = new Error('spawn failed');
  const waiting = waitForChildExit(child);
  child.emit('error', error);
  await assert.rejects(waiting, (received) => received === error);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

test('waiting for a child times out with current diagnostics and removes listeners', async () => {
  const child = runningChild();
  await assert.rejects(waitForChildExit(child, { timeoutMs: 5, message: () => 'current output' }), /current output/);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});
