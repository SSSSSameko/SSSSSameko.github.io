import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquirePersistentProfileOwner,
  closePersistentBrowserContext,
  ensureBrowserRuntimeDirs,
  findProfileBrowserPids,
  preparePersistentProfile,
  prunePersistentProfileCaches,
  releasePersistentProfileOwner,
  stopProfileBrowsers,
} from './weiboBrowserLifecycle.js';

const OWNER_FILE = '.sameko-profile-owner.json';

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

test('findProfileBrowserPids matches quoted Windows arguments without prefix collisions', async () => {
  const profileDir = 'C:\\Users\\Sameko\\Profile With Space';
  const pids = await findProfileBrowserPids(profileDir, {
    platform: 'win32',
    ownPid: 999,
    processes: [
      {
        ProcessId: 101,
        CommandLine: 'chrome.exe "--user-data-dir=C:\\Users\\Sameko\\Profile With Space"',
      },
      {
        ProcessId: 202,
        CommandLine: 'chrome.exe --user-data-dir="C:/Users/Sameko/Profile With Space-other"',
      },
      { ProcessId: 303, CommandLine: 'chrome.exe --user-data-dir=C:\\Other' },
    ],
  });

  assert.deepEqual(pids, [101]);
});

test('stopProfileBrowsers terminates only matching processes', async (t) => {
  const root = await tempDir(t);
  const procDir = path.join(root, 'proc');
  const profileDir = path.join(root, 'profile');
  await fs.mkdir(procDir, { recursive: true });
  const owner = await acquirePersistentProfileOwner(profileDir, {
    procDir,
  });
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
  assert.equal(
    await releasePersistentProfileOwner(profileDir, owner.token),
    true,
  );
});

test('preparePersistentProfile removes stale Chromium locks', async (t) => {
  const root = await tempDir(t);
  const profileDir = path.join(root, 'profile');
  const procDir = path.join(root, 'proc');
  await fs.mkdir(profileDir, { recursive: true });
  await fs.mkdir(procDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(profileDir, 'SingletonLock'), 'lock'),
    fs.writeFile(path.join(profileDir, 'SingletonCookie'), 'cookie'),
    fs.writeFile(path.join(profileDir, 'SingletonSocket'), 'socket'),
  ]);

  const prepared = await preparePersistentProfile(profileDir, {
    procDir,
    stopProcesses: false,
  });
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    await assert.rejects(fs.stat(path.join(profileDir, name)), { code: 'ENOENT' });
  }
  assert.equal(
    await releasePersistentProfileOwner(profileDir, prepared.ownerToken),
    true,
  );
});

test('an active profile owner is never replaced', async (t) => {
  const root = await tempDir(t);
  const profileDir = path.join(root, 'profile');
  const procDir = path.join(root, 'proc');
  const now = Date.now();
  await Promise.all([
    fs.mkdir(profileDir, { recursive: true }),
    fs.mkdir(procDir, { recursive: true }),
  ]);
  await fs.writeFile(path.join(profileDir, OWNER_FILE), JSON.stringify({
    version: 1,
    pid: 700,
    token: 'active-owner-token',
    createdAt: new Date(now - 60_000).toISOString(),
  }));

  await assert.rejects(
    acquirePersistentProfileOwner(profileDir, {
      procDir,
      nowMs: now,
      ownerStaleMs: 0,
      kill(pid, signal) {
        assert.equal(pid, 700);
        assert.equal(signal, 0);
      },
    }),
    { code: 'ERR_PROFILE_OWNER_ACTIVE', status: 409 },
  );
  const stored = JSON.parse(await fs.readFile(path.join(profileDir, OWNER_FILE), 'utf8'));
  assert.equal(stored.token, 'active-owner-token');
});

test('a stale dead owner is recovered and only its new token can release it', async (t) => {
  const root = await tempDir(t);
  const profileDir = path.join(root, 'profile');
  const procDir = path.join(root, 'proc');
  const now = Date.now();
  await Promise.all([
    fs.mkdir(profileDir, { recursive: true }),
    fs.mkdir(procDir, { recursive: true }),
  ]);
  await fs.writeFile(path.join(profileDir, OWNER_FILE), JSON.stringify({
    version: 1,
    pid: 701,
    token: 'stale-owner-token',
    createdAt: new Date(now - 60_000).toISOString(),
  }));

  const owner = await acquirePersistentProfileOwner(profileDir, {
    procDir,
    nowMs: now,
    ownerStaleMs: 1000,
    kill() {
      const error = new Error('not found');
      error.code = 'ESRCH';
      throw error;
    },
  });
  assert.notEqual(owner.token, 'stale-owner-token');
  assert.equal(
    await releasePersistentProfileOwner(profileDir, 'wrong-owner-token'),
    false,
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(profileDir, OWNER_FILE), 'utf8')).token,
    owner.token,
  );
  assert.equal(await releasePersistentProfileOwner(profileDir, owner.token), true);
  await assert.rejects(fs.stat(path.join(profileDir, OWNER_FILE)), { code: 'ENOENT' });
});

test('stale recovery leaves a newly replaced owner untouched', async (t) => {
  const root = await tempDir(t);
  const profileDir = path.join(root, 'profile');
  const procDir = path.join(root, 'proc');
  const ownerPath = path.join(profileDir, OWNER_FILE);
  await Promise.all([
    fs.mkdir(profileDir, { recursive: true }),
    fs.mkdir(procDir, { recursive: true }),
  ]);
  await fs.writeFile(ownerPath, JSON.stringify({
    version: 1,
    pid: 701,
    token: 'stale-owner-token',
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
  let replaced = false;

  await assert.rejects(acquirePersistentProfileOwner(profileDir, {
    procDir,
    ownerStaleMs: 0,
    nowMs: Date.parse('2026-08-27T00:00:00.000Z'),
    kill(pid) {
      if (pid === 702) return;
      const error = new Error('not found');
      error.code = 'ESRCH';
      throw error;
    },
    async beforeRetireOwner() {
      if (replaced) return;
      replaced = true;
      await fs.writeFile(ownerPath, JSON.stringify({
        version: 1,
        pid: 702,
        token: 'replacement-owner-token',
        createdAt: '2026-08-27T00:00:00.000Z',
      }));
    },
  }), { code: 'ERR_PROFILE_OWNER_ACTIVE', status: 409 });

  assert.equal(JSON.parse(await fs.readFile(ownerPath, 'utf8')).token, 'replacement-owner-token');
});

test('prepare refuses an unowned active Chromium without sending signals', async (t) => {
  const root = await tempDir(t);
  const procDir = path.join(root, 'proc');
  const profileDir = path.join(root, 'profile');
  await fs.mkdir(path.join(procDir, '505'), { recursive: true });
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(
    path.join(procDir, '505', 'cmdline'),
    `headless_shell\0--user-data-dir=${path.resolve(profileDir)}\0`,
  );
  await fs.writeFile(path.join(profileDir, 'SingletonLock'), 'lock');
  const signals = [];

  await assert.rejects(
    preparePersistentProfile(profileDir, {
      procDir,
      ownPid: 999,
      kill(pid, signal) {
        signals.push([pid, signal]);
      },
    }),
    { code: 'ERR_PROFILE_IN_USE', status: 409 },
  );
  assert.deepEqual(signals, []);
  assert.equal(await fs.readFile(path.join(profileDir, 'SingletonLock'), 'utf8'), 'lock');
  await assert.rejects(fs.stat(path.join(profileDir, OWNER_FILE)), { code: 'ENOENT' });
});

test('profile cleanup removes caches without touching login state', async (t) => {
  const root = await tempDir(t);
  const profileDir = path.join(root, 'profile');
  const procDir = path.join(root, 'proc');
  const cacheDir = path.join(profileDir, 'Default', 'Cache');
  const codeCacheDir = path.join(profileDir, 'Default', 'Code Cache');
  const cookiesFile = path.join(profileDir, 'Default', 'Cookies');
  const localStorageFile = path.join(profileDir, 'Default', 'Local Storage', 'leveldb', '000001.log');
  await Promise.all([
    fs.mkdir(procDir, { recursive: true }),
    fs.mkdir(cacheDir, { recursive: true }),
    fs.mkdir(codeCacheDir, { recursive: true }),
    fs.mkdir(path.dirname(localStorageFile), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(cacheDir, 'cache.data'), 'cache'),
    fs.writeFile(path.join(codeCacheDir, 'code.data'), 'code'),
    fs.writeFile(cookiesFile, 'login-cookie'),
    fs.writeFile(localStorageFile, 'login-storage'),
  ]);

  const removed = await prunePersistentProfileCaches(profileDir, { procDir });

  assert.deepEqual(removed.sort(), ['Default/Cache', 'Default/Code Cache']);
  await assert.rejects(fs.stat(cacheDir), { code: 'ENOENT' });
  await assert.rejects(fs.stat(codeCacheDir), { code: 'ENOENT' });
  assert.equal(await fs.readFile(cookiesFile, 'utf8'), 'login-cookie');
  assert.equal(await fs.readFile(localStorageFile, 'utf8'), 'login-storage');
  await assert.rejects(fs.stat(path.join(profileDir, OWNER_FILE)), { code: 'ENOENT' });
});

test('profile cleanup skips caches owned by another process', async (t) => {
  const root = await tempDir(t);
  const profileDir = path.join(root, 'profile');
  const cacheDir = path.join(profileDir, 'Default', 'Cache');
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(path.join(cacheDir, 'cache.data'), 'cache');
  await fs.writeFile(path.join(profileDir, OWNER_FILE), JSON.stringify({
    version: 1,
    pid: 702,
    token: 'foreign-owner-token',
    createdAt: new Date().toISOString(),
  }));

  assert.deepEqual(await prunePersistentProfileCaches(profileDir), []);
  assert.equal(await fs.readFile(path.join(cacheDir, 'cache.data'), 'utf8'), 'cache');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(profileDir, OWNER_FILE), 'utf8')).token,
    'foreign-owner-token',
  );
});

test('closePersistentBrowserContext kills profile processes when close stalls', async (t) => {
  const root = await tempDir(t);
  const profileDir = path.join(root, 'profile');
  await fs.mkdir(profileDir, { recursive: true });
  let alive = false;
  const processOptions = {
    platform: 'win32',
    ownPid: 999,
    async listProcesses() {
      return alive
        ? [{
          ProcessId: 404,
          CommandLine: `headless_shell --user-data-dir="${path.win32.resolve(profileDir)}"`,
        }]
        : [];
    },
  };
  const owner = await acquirePersistentProfileOwner(profileDir, processOptions);
  alive = true;
  await fs.writeFile(path.join(profileDir, 'SingletonLock'), 'lock');
  const signals = [];
  const result = await closePersistentBrowserContext(
    { close: () => new Promise(() => {}) },
    profileDir,
    {
      ...processOptions,
      ownerToken: owner.token,
      closeTimeoutMs: 1,
      graceMs: 0,
      wait: async () => {},
      kill(pid, signal) {
        signals.push([pid, signal]);
        if (signal === 'SIGTERM' || signal === 'SIGKILL') alive = false;
        else if (!alive) {
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
  assert.equal(result.ownerReleased, true);
  await assert.rejects(fs.stat(path.join(profileDir, 'SingletonLock')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(profileDir, OWNER_FILE)), { code: 'ENOENT' });
});

test('close without ownership never kills Chromium or removes its locks', async (t) => {
  const root = await tempDir(t);
  const procDir = path.join(root, 'proc');
  const profileDir = path.join(root, 'profile');
  await fs.mkdir(path.join(procDir, '606'), { recursive: true });
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(
    path.join(procDir, '606', 'cmdline'),
    `headless_shell\0--user-data-dir=${path.resolve(profileDir)}\0`,
  );
  await fs.writeFile(path.join(profileDir, 'SingletonLock'), 'lock');
  await fs.writeFile(path.join(profileDir, OWNER_FILE), JSON.stringify({
    version: 1,
    pid: 703,
    token: 'foreign-close-token',
    createdAt: new Date().toISOString(),
  }));
  const signals = [];

  const result = await closePersistentBrowserContext(
    { close: async () => {} },
    profileDir,
    {
      procDir,
      ownPid: 999,
      kill(pid, signal) {
        signals.push([pid, signal]);
      },
    },
  );

  assert.deepEqual(signals, []);
  assert.deepEqual(result.stoppedPids, []);
  assert.equal(result.ownerReleased, false);
  assert.equal(await fs.readFile(path.join(profileDir, 'SingletonLock'), 'utf8'), 'lock');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(profileDir, OWNER_FILE), 'utf8')).token,
    'foreign-close-token',
  );
});

test('close keeps profile ownership while a matching browser process remains', async (t) => {
  const root = await tempDir(t);
  const profileDir = path.join(root, 'profile');
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, 'SingletonLock'), 'lock');
  const processOptions = {
    platform: 'win32',
    ownPid: 999,
    async listProcesses() {
      return [{
        ProcessId: 505,
        CommandLine: `headless_shell --user-data-dir="${path.win32.resolve(profileDir)}"`,
      }];
    },
    kill() {},
    graceMs: 0,
    wait: async () => {},
  };
  const owner = await acquirePersistentProfileOwner(profileDir, processOptions);

  const result = await closePersistentBrowserContext(null, profileDir, {
    ...processOptions,
    ownerToken: owner.token,
  });

  assert.equal(result.ownerReleased, false);
  assert.equal(result.profileLocksRemoved, false);
  assert.equal(await fs.readFile(path.join(profileDir, 'SingletonLock'), 'utf8'), 'lock');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(profileDir, OWNER_FILE), 'utf8')).token,
    owner.token,
  );
});

test('ensureBrowserRuntimeDirs creates writable home and font cache locations', async (t) => {
  const root = await tempDir(t);
  const result = await ensureBrowserRuntimeDirs(root);
  assert.equal((await fs.stat(result.runtimeHome)).isDirectory(), true);
  assert.equal((await fs.stat(result.runtimeCache)).isDirectory(), true);
  assert.equal((await fs.stat(path.join(result.runtimeCache, 'fontconfig'))).isDirectory(), true);
  assert.equal((await fs.stat(result.chromiumCache)).isDirectory(), true);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(result.runtimeHome)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(result.runtimeCache)).mode & 0o777, 0o700);
  }
});
