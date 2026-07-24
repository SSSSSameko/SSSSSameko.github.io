import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  closePersistentBrowserContext,
  ensureBrowserRuntimeDirs,
  findProfileBrowserPids,
  preparePersistentProfile,
  stopProfileBrowsers,
} from './weiboBrowserLifecycle.js';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weibo-browser-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('findProfileBrowserPids only matches the exact persistent profile argument', async (t) => {
  const root = await tempDir(t);
  const procDir = path.join(root, 'proc');
  const profileDir = path.join(root, 'profile');
  await fs.mkdir(path.join(procDir, '101'), { recursive: true });
  await fs.mkdir(path.join(procDir, '202'), { recursive: true });
  await fs.writeFile(
    path.join(procDir, '101', 'cmdline'),
    `chrome\0--user-data-dir=${path.resolve(profileDir)}\0about:blank\0`,
  );
  await fs.writeFile(
    path.join(procDir, '202', 'cmdline'),
    `chrome\0--user-data-dir=${path.resolve(`${profileDir}-other`)}\0`,
  );

  assert.deepEqual(
    await findProfileBrowserPids(profileDir, { procDir, ownPid: 999 }),
    [101],
  );
});

test('stopProfileBrowsers terminates only matching processes', async (t) => {
  const root = await tempDir(t);
  const procDir = path.join(root, 'proc');
  const profileDir = path.join(root, 'profile');
  await fs.mkdir(path.join(procDir, '303'), { recursive: true });
  await fs.writeFile(
    path.join(procDir, '303', 'cmdline'),
    `headless_shell\0--user-data-dir=${path.resolve(profileDir)}\0`,
  );

  const alive = new Set([303]);
  const signals = [];
  const kill = (pid, signal) => {
    if (!alive.has(pid)) {
      const error = new Error('not found');
      error.code = 'ESRCH';
      throw error;
    }
    signals.push([pid, signal]);
    if (signal === 'SIGTERM' || signal === 'SIGKILL') alive.delete(pid);
  };

  const stopped = await stopProfileBrowsers(profileDir, {
    procDir,
    ownPid: 999,
    kill,
    wait: async () => {},
    graceMs: 0,
  });
  assert.deepEqual(stopped, [303]);
  assert.deepEqual(signals, [[303, 'SIGTERM']]);
});

test('preparePersistentProfile removes stale Chromium locks', async (t) => {
  const root = await tempDir(t);
  const profileDir = path.join(root, 'profile');
  await fs.mkdir(profileDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(profileDir, 'SingletonLock'), 'lock'),
    fs.writeFile(path.join(profileDir, 'SingletonCookie'), 'cookie'),
    fs.writeFile(path.join(profileDir, 'SingletonSocket'), 'socket'),
  ]);

  await preparePersistentProfile(profileDir, { stopProcesses: false });
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    await assert.rejects(fs.stat(path.join(profileDir, name)), { code: 'ENOENT' });
  }
});

test('closePersistentBrowserContext kills profile processes when close stalls', async (t) => {
  const root = await tempDir(t);
  const procDir = path.join(root, 'proc');
  const profileDir = path.join(root, 'profile');
  await fs.mkdir(path.join(procDir, '404'), { recursive: true });
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(
    path.join(procDir, '404', 'cmdline'),
    `headless_shell\0--user-data-dir=${path.resolve(profileDir)}\0`,
  );
  await fs.writeFile(path.join(profileDir, 'SingletonLock'), 'lock');

  const alive = new Set([404]);
  const signals = [];
  const result = await closePersistentBrowserContext(
    { close: () => new Promise(() => {}) },
    profileDir,
    {
      procDir,
      ownPid: 999,
      closeTimeoutMs: 1,
      graceMs: 0,
      wait: async () => {},
      kill(pid, signal) {
        signals.push([pid, signal]);
        if (signal === 'SIGTERM' || signal === 'SIGKILL') alive.delete(pid);
        else if (!alive.has(pid)) {
          const error = new Error('not found');
          error.code = 'ESRCH';
          throw error;
        }
      },
    },
  );

  assert.equal(result.closeTimedOut, true);
  assert.deepEqual(result.stoppedPids, [404]);
  assert.deepEqual(
    signals.filter(([, signal]) => signal),
    [[404, 'SIGTERM']],
  );
  await assert.rejects(fs.stat(path.join(profileDir, 'SingletonLock')), { code: 'ENOENT' });
});

test('ensureBrowserRuntimeDirs creates writable home and font cache locations', async (t) => {
  const root = await tempDir(t);
  const result = await ensureBrowserRuntimeDirs(root);
  assert.equal((await fs.stat(result.runtimeHome)).isDirectory(), true);
  assert.equal((await fs.stat(result.runtimeCache)).isDirectory(), true);
  assert.equal((await fs.stat(path.join(result.runtimeCache, 'fontconfig'))).isDirectory(), true);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(result.runtimeHome)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(result.runtimeCache)).mode & 0o777, 0o700);
  }
});
