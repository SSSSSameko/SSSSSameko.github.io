import fs from 'node:fs/promises';
import path from 'node:path';

const PROFILE_LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function profileArgument(profileDir) {
  return `--user-data-dir=${path.resolve(profileDir)}`;
}

export async function findProfileBrowserPids(profileDir, options = {}) {
  const procDir = options.procDir || '/proc';
  const ownPid = Number(options.ownPid ?? process.pid);
  const expectedArgument = profileArgument(profileDir);
  let entries;
  try {
    entries = await fs.readdir(procDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const pids = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (!pid || pid === ownPid) continue;
    try {
      const raw = await fs.readFile(path.join(procDir, entry.name, 'cmdline'));
      const args = raw.toString('utf8').split('\0').filter(Boolean);
      if (args.includes(expectedArgument)) pids.push(pid);
    } catch {
    }
  }
  return pids;
}

function processIsAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function stopProfileBrowsers(profileDir, options = {}) {
  const kill = options.kill || process.kill;
  const wait = options.wait || sleep;
  const graceMs = Math.max(0, Number(options.graceMs ?? 2000));
  const pids = await findProfileBrowserPids(profileDir, options);
  if (!pids.length) return [];

  for (const pid of pids) {
    try {
      kill(pid, 'SIGTERM');
    } catch {
    }
  }

  const deadline = Date.now() + graceMs;
  let alive = pids.filter((pid) => processIsAlive(pid, kill));
  while (alive.length && Date.now() < deadline) {
    await wait(Math.min(100, Math.max(1, deadline - Date.now())));
    alive = alive.filter((pid) => processIsAlive(pid, kill));
  }

  for (const pid of alive) {
    try {
      kill(pid, 'SIGKILL');
    } catch {
    }
  }
  return pids;
}

export async function removeProfileLocks(profileDir) {
  await Promise.all(PROFILE_LOCK_FILES.map((name) => (
    fs.rm(path.join(profileDir, name), { force: true }).catch(() => {})
  )));
}

export async function preparePersistentProfile(profileDir, options = {}) {
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  await fs.chmod(profileDir, 0o700).catch(() => {});
  const stoppedPids = options.stopProcesses === false
    ? []
    : await stopProfileBrowsers(profileDir, options);
  await removeProfileLocks(profileDir);
  return { stoppedPids };
}

export async function closePersistentBrowserContext(context, profileDir, options = {}) {
  const wait = options.wait || sleep;
  const closeTimeoutMs = Math.max(0, Number(options.closeTimeoutMs ?? 5000));
  let closeTimedOut = false;

  if (context?.close) {
    const closePromise = Promise.resolve()
      .then(() => context.close())
      .catch(() => {});
    if (closeTimeoutMs) {
      await Promise.race([
        closePromise,
        wait(closeTimeoutMs).then(() => {
          closeTimedOut = true;
        }),
      ]);
    } else {
      await closePromise;
    }
  }

  const stoppedPids = await stopProfileBrowsers(profileDir, options);
  await removeProfileLocks(profileDir);
  return { closeTimedOut, stoppedPids };
}

export async function ensureBrowserRuntimeDirs(outputDir) {
  const runtimeHome = path.join(outputDir, 'runtime-home');
  const runtimeCache = path.join(outputDir, 'runtime-cache');
  const fontCache = path.join(runtimeCache, 'fontconfig');
  await Promise.all([
    fs.mkdir(runtimeHome, { recursive: true, mode: 0o700 }),
    fs.mkdir(runtimeCache, { recursive: true, mode: 0o700 }),
  ]);
  await fs.mkdir(fontCache, { recursive: true, mode: 0o700 });
  await Promise.all([
    fs.chmod(runtimeHome, 0o700).catch(() => {}),
    fs.chmod(runtimeCache, 0o700).catch(() => {}),
    fs.chmod(fontCache, 0o700).catch(() => {}),
  ]);
  return { runtimeHome, runtimeCache };
}
