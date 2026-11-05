import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { replaceFileAtomically } from './atomic-replace.mjs';

test('transient Windows file contention preserves the old file until replacement succeeds', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sameko-atomic-replace-'));
  const source = path.join(directory, 'record.tmp');
  const destination = path.join(directory, 'record.json');
  try {
    await writeFile(source, 'new record');
    await writeFile(destination, 'old record');
    let attempts = 0;
    const waits = [];
    await replaceFileAtomically(source, destination, {
      platform: 'win32',
      renameFile: async (from, to) => {
        attempts += 1;
        assert.equal(await readFile(to, 'utf8'), 'old record');
        if (attempts < 3) throw Object.assign(new Error('file is busy'), { code: 'EPERM' });
        await rename(from, to);
      },
      wait: async (ms) => { waits.push(ms); },
    });
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [25, 50]);
    assert.equal(await readFile(destination, 'utf8'), 'new record');
    await assert.rejects(readFile(source), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('permanent Windows permission errors stop after a bounded retry budget', async () => {
  const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  let attempts = 0;
  const waits = [];
  await assert.rejects(replaceFileAtomically('temporary', 'destination', {
    platform: 'win32',
    renameFile: async () => { attempts += 1; throw failure; },
    wait: async (ms) => { waits.push(ms); },
  }), (error) => error === failure);
  assert.equal(attempts, 6);
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 775);
});

test('unrelated errors and other platforms are reported immediately', async () => {
  for (const [platform, code] of [['win32', 'ENOENT'], ['win32', 'ENOSPC'], ['linux', 'EPERM']]) {
    let attempts = 0;
    const failure = Object.assign(new Error(code), { code });
    await assert.rejects(replaceFileAtomically('temporary', 'destination', {
      platform,
      renameFile: async () => { attempts += 1; throw failure; },
      wait: async () => assert.fail('non-transient errors must not be retried'),
    }), (error) => error === failure);
    assert.equal(attempts, 1);
  }
});
