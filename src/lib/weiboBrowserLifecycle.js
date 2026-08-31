import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const PROFILE_LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
const PROFILE_OWNER_FILE = '.sameko-profile-owner.json';
const OWNER_VERSION = 1;
const OWNER_MAX_BYTES = 4096;
const OWNER_STALE_MS = 30_000;
const OWNER_ACQUIRE_ATTEMPTS = 6;
const PROFILE_CACHE_DIRS = [
  ['Default', 'Cache'],
  ['Default', 'Code Cache'],
  ['Default', 'GPUCache'],
  ['Default', 'DawnCache'],
  ['Default', 'GrShaderCache'],
  ['Default', 'ShaderCache'],
  ['GPUCache'],
  ['DawnCache'],
  ['GrShaderCache'],
  ['ShaderCache'],
];

const WINDOWS_PROCESS_QUERY = [
  '$ErrorActionPreference = "Stop";',
  'Get-CimInstance Win32_Process |',
  'Select-Object ProcessId,CommandLine |',
  'ConvertTo-Json -Compress',
].join(' ');

const owners = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function settlePromiseWithin(promise, timeoutMs) {
  const timeout = Math.max(0, Number(timeoutMs) || 0);
  const guarded = Promise.resolve(promise);
  guarded.catch(() => {});
  let timer;
  const timeoutResult = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeout);
  });
  try {
    return await Promise.race([
      guarded.then(
        (value) => ({ timedOut: false, fulfilled: true, value }),
        (error) => ({ timedOut: false, fulfilled: false, error }),
      ),
      timeoutResult,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function currentPlatform(options = {}) {
  return options.platform || process.platform;
}

function resolveProfileDir(profileDir, platform = process.platform) {
  return platform === 'win32'
    ? path.win32.resolve(String(profileDir))
    : path.resolve(String(profileDir));
}

function profileKey(profileDir, platform = process.platform) {
  const resolved = resolveProfileDir(profileDir, platform);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function stripQuotes(value) {
  const text = String(value || '').trim();
  if (text.length < 2) return text;
  const quoted = (text[0] === '"' && text.at(-1) === '"')
    || (text[0] === "'" && text.at(-1) === "'");
  return quoted ? text.slice(1, -1) : text;
}

function normalizeProfilePath(value, platform) {
  const text = stripQuotes(value);
  if (!text) return '';
  if (platform === 'win32') {
    const normalized = path.win32.normalize(text.replaceAll('/', '\\'));
    return normalized.replace(/\\+$/, '').toLowerCase();
  }
  const normalized = path.posix.normalize(text);
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

function argsUseProfile(args, profileDir, platform) {
  const expected = normalizeProfilePath(resolveProfileDir(profileDir, platform), platform);
  for (let index = 0; index < args.length; index += 1) {
    const argument = stripQuotes(args[index]);
    const comparable = platform === 'win32' ? argument.toLowerCase() : argument;
    if (comparable === '--user-data-dir') {
      if (normalizeProfilePath(args[index + 1], platform) === expected) return true;
      continue;
    }
    if (comparable.startsWith('--user-data-dir=')) {
      const value = argument.slice(argument.indexOf('=') + 1);
      if (normalizeProfilePath(value, platform) === expected) return true;
    }
  }
  return false;
}

function commandLineUsesProfile(commandLine, profileDir) {
  const expected = normalizeProfilePath(resolveProfileDir(profileDir, 'win32'), 'win32');
  const expression = /(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir='([^']+)'|--user-data-dir=([^\s]+)|--user-data-dir\s+"([^"]+)"|--user-data-dir\s+'([^']+)'|--user-data-dir\s+([^\s]+))/gi;
  let match;
  while ((match = expression.exec(String(commandLine || '')))) {
    const value = match.slice(1).find((part) => part !== undefined) || '';
    if (normalizeProfilePath(value, 'win32') === expected) return true;
  }
  return false;
}

function validPid(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
}

async function inspectProcProcesses(profileDir, options) {
  const procDir = options.procDir || '/proc';
  let entries;
  try {
    entries = await fs.readdir(procDir, { withFileTypes: true });
  } catch {
    return { available: false, pids: [] };
  }

  const ownPid = validPid(options.ownPid ?? process.pid);
  const platform = currentPlatform(options);
  const pids = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = validPid(entry.name);
    if (!pid || pid === ownPid) continue;
    try {
      const raw = await fs.readFile(path.join(procDir, entry.name, 'cmdline'));
      const args = raw.toString('utf8').split('\0').filter(Boolean);
      if (argsUseProfile(args, profileDir, platform)) pids.push(pid);
    } catch {
      // A process can exit after readdir and before cmdline is read.
    }
  }
  return { available: true, pids: [...new Set(pids)].sort((a, b) => a - b) };
}

function powershellPath() {
  if (!process.env.SystemRoot) return 'powershell.exe';
  return path.join(
    process.env.SystemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

async function windowsProcesses(options) {
  if (Array.isArray(options.processes)) return { available: true, items: options.processes };
  if (typeof options.listProcesses === 'function') {
    try {
      const items = await options.listProcesses();
      return { available: true, items: Array.isArray(items) ? items : [] };
    } catch {
      return { available: false, items: [] };
    }
  }
  try {
    const { stdout } = await execFile(
      powershellPath(),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_QUERY],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    const output = String(stdout || '').trim();
    if (!output) return { available: true, items: [] };
    const parsed = JSON.parse(output);
    return { available: true, items: Array.isArray(parsed) ? parsed : [parsed] };
  } catch {
    return { available: false, items: [] };
  }
}

async function inspectWindowsProcesses(profileDir, options) {
  const snapshot = await windowsProcesses(options);
  if (!snapshot.available) return { available: false, pids: [] };
  const ownPid = validPid(options.ownPid ?? process.pid);
  const pids = [];
  for (const item of snapshot.items) {
    const pid = validPid(item?.ProcessId ?? item?.pid);
    if (!pid || pid === ownPid) continue;
    const matches = Array.isArray(item?.args)
      ? argsUseProfile(item.args, profileDir, 'win32')
      : commandLineUsesProfile(item?.CommandLine ?? item?.commandLine, profileDir);
    if (matches) pids.push(pid);
  }
  return { available: true, pids: [...new Set(pids)].sort((a, b) => a - b) };
}

async function inspectProfileProcesses(profileDir, options = {}) {
  const platform = currentPlatform(options);
  if (options.procDir || platform === 'linux') {
    return await inspectProcProcesses(profileDir, options);
  }
  if (platform === 'win32') return await inspectWindowsProcesses(profileDir, options);
  return { available: false, pids: [] };
}

export async function findProfileBrowserPids(profileDir, options = {}) {
  return (await inspectProfileProcesses(profileDir, options)).pids;
}

function processIsAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function ownerFile(profileDir) {
  return path.join(profileDir, PROFILE_OWNER_FILE);
}

function ownerPid(options = {}) {
  return validPid(options.ownerPid ?? process.pid) || process.pid;
}

function nowMs(options = {}) {
  const value = typeof options.now === 'function' ? options.now() : options.nowMs;
  if (value instanceof Date) return value.getTime();
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

function validOwner(owner) {
  return owner?.version === OWNER_VERSION
    && validPid(owner.pid) > 0
    && typeof owner.token === 'string'
    && /^[A-Za-z0-9._:-]{8,128}$/.test(owner.token)
    && Number.isFinite(Date.parse(owner.createdAt));
}

async function readOwner(profileDir) {
  const filePath = ownerFile(profileDir);
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, filePath };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > OWNER_MAX_BYTES) {
    return { exists: true, valid: false, filePath, mtimeMs: stat.mtimeMs };
  }
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return {
      exists: true,
      valid: validOwner(value),
      filePath,
      mtimeMs: stat.mtimeMs,
      value,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, filePath };
    if (error instanceof SyntaxError) {
      return { exists: true, valid: false, filePath, mtimeMs: stat.mtimeMs };
    }
    throw error;
  }
}

function profileBusyError(code = 'ERR_PROFILE_OWNER_ACTIVE') {
  const error = new Error(code === 'ERR_PROFILE_IN_USE'
    ? 'The Weibo browser profile is already in use by another Chromium process.'
    : 'The Weibo browser profile is already owned by another process.');
  error.code = code;
  error.status = 409;
  return error;
}

async function hasChromiumLocks(profileDir) {
  for (const name of PROFILE_LOCK_FILES) {
    try {
      await fs.lstat(path.join(profileDir, name));
      return true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return false;
}

async function staleOwnerCanBeRecovered(profileDir, owner, options) {
  const timestamp = owner.valid ? Date.parse(owner.value.createdAt) : owner.mtimeMs;
  const staleMs = Math.max(0, Number(options.ownerStaleMs ?? OWNER_STALE_MS));
  if (!Number.isFinite(timestamp) || nowMs(options) - timestamp < staleMs) return false;
  if (owner.valid && processIsAlive(owner.value.pid, options.kill || process.kill)) return false;
  const inspection = await inspectProfileProcesses(profileDir, options);
  return inspection.available && inspection.pids.length === 0;
}

function sameOwnerSnapshot(expected, current) {
  if (!expected?.exists || !current?.exists || expected.valid !== current.valid) return false;
  if (expected.valid) {
    return expected.value.pid === current.value.pid
      && expected.value.token === current.value.token
      && expected.value.createdAt === current.value.createdAt;
  }
  return expected.mtimeMs === current.mtimeMs;
}

async function retireOwnerFile(profileDir, owner, options = {}) {
  if (typeof options.beforeRetireOwner === 'function') {
    await options.beforeRetireOwner(owner);
  }
  const current = await readOwner(profileDir);
  if (!sameOwnerSnapshot(owner, current)) return false;
  const retired = `${owner.filePath}.stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.rename(owner.filePath, retired);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  await fs.rm(retired, { force: true }).catch(() => {});
  return true;
}

async function ownerMatches(profileDir, token, options = {}) {
  if (!token) return false;
  const owner = await readOwner(profileDir);
  return owner.valid
    && owner.value.pid === ownerPid(options)
    && owner.value.token === token;
}

export async function acquirePersistentProfileOwner(profileDir, options = {}) {
  const platform = currentPlatform(options);
  const resolved = resolveProfileDir(profileDir, platform);
  const key = profileKey(resolved, platform);
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  await fs.chmod(resolved, 0o700).catch(() => {});

  const local = owners.get(key);
  if (local && await ownerMatches(resolved, local.token, options)) {
    return { ...local, reused: true };
  }
  if (local) owners.delete(key);

  const createdAt = new Date(nowMs(options)).toISOString();
  const value = {
    version: OWNER_VERSION,
    pid: ownerPid(options),
    token: options.ownerToken || crypto.randomUUID(),
    createdAt,
  };
  const filePath = ownerFile(resolved);

  for (let attempt = 0; attempt < OWNER_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      const handle = await fs.open(filePath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync().catch(() => {});
      } catch (error) {
        await handle.close().catch(() => {});
        await fs.rm(filePath, { force: true }).catch(() => {});
        throw error;
      }
      await handle.close();
      const acquired = { profileDir: resolved, token: value.token, pid: value.pid, createdAt };
      owners.set(key, acquired);
      return { ...acquired, reused: false };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readOwner(resolved);
      if (!existing.exists) continue;
      if (!(await staleOwnerCanBeRecovered(resolved, existing, options))) {
        throw profileBusyError();
      }
      if (!(await retireOwnerFile(resolved, existing, options))) continue;
    }
  }
  throw profileBusyError();
}

export async function releasePersistentProfileOwner(profileDir, token, options = {}) {
  const platform = currentPlatform(options);
  const resolved = resolveProfileDir(profileDir, platform);
  const key = profileKey(resolved, platform);
  const local = owners.get(key);
  const expectedToken = token || local?.token;
  if (!expectedToken || !(await ownerMatches(resolved, expectedToken, options))) return false;
  try {
    await fs.rm(ownerFile(resolved), { force: true });
  } catch {
    return false;
  }
  if (local?.token === expectedToken) owners.delete(key);
  return true;
}

async function requireOwner(profileDir, options = {}) {
  const platform = currentPlatform(options);
  const local = owners.get(profileKey(profileDir, platform));
  const token = options.ownerToken || local?.token;
  if (!(await ownerMatches(resolveProfileDir(profileDir, platform), token, options))) {
    throw profileBusyError();
  }
  return token;
}

export async function stopProfileBrowsers(profileDir, options = {}) {
  await requireOwner(profileDir, options);
  const first = await inspectProfileProcesses(profileDir, options);
  if (!first.available || !first.pids.length) return [];
  const second = await inspectProfileProcesses(profileDir, options);
  if (!second.available) return [];
  const pids = first.pids.filter((pid) => second.pids.includes(pid));
  const kill = options.kill || process.kill;
  const wait = options.wait || sleep;
  const graceMs = Math.max(0, Number(options.graceMs ?? 2000));

  for (const pid of pids) {
    await requireOwner(profileDir, options);
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

  if (alive.length && await ownerMatches(
    resolveProfileDir(profileDir, currentPlatform(options)),
    options.ownerToken || owners.get(profileKey(profileDir, currentPlatform(options)))?.token,
    options,
  )) {
    const finalInspection = await inspectProfileProcesses(profileDir, options);
    if (finalInspection.available) {
      for (const pid of alive) {
        if (!finalInspection.pids.includes(pid)) continue;
        try {
          kill(pid, 'SIGKILL');
        } catch {
        }
      }
    }
  }
  return pids;
}

async function removeProfileLocks(profileDir) {
  await Promise.all(PROFILE_LOCK_FILES.map(async (name) => {
    try {
      await fs.rm(path.join(profileDir, name), { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }));
}

async function profileIsIdle(profileDir, options) {
  const inspection = await inspectProfileProcesses(profileDir, options);
  if (inspection.available) return inspection.pids.length === 0;
  return !(await hasChromiumLocks(profileDir));
}

export async function prunePersistentProfileCaches(profileDir, options = {}) {
  const platform = currentPlatform(options);
  const resolved = resolveProfileDir(profileDir, platform);
  const key = profileKey(resolved, platform);
  const existingOwner = owners.get(key);
  let temporaryOwner = null;
  if (!existingOwner) {
    try {
      temporaryOwner = await acquirePersistentProfileOwner(resolved, options);
    } catch (error) {
      if (error?.code === 'ERR_PROFILE_OWNER_ACTIVE') return [];
      throw error;
    }
  }

  try {
    const token = existingOwner?.token || temporaryOwner.token;
    await requireOwner(resolved, { ...options, ownerToken: token });
    if (!(await profileIsIdle(resolved, options))) return [];
    const removed = await Promise.all(PROFILE_CACHE_DIRS.map(async (segments) => {
      const target = path.join(resolved, ...segments);
      try {
        await fs.lstat(target);
        await fs.rm(target, { recursive: true, force: true });
        return segments.join('/');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        return '';
      }
    }));
    return removed.filter(Boolean);
  } finally {
    if (temporaryOwner && !temporaryOwner.reused) {
      await releasePersistentProfileOwner(resolved, temporaryOwner.token, options);
    }
  }
}

export async function preparePersistentProfile(profileDir, options = {}) {
  const platform = currentPlatform(options);
  const resolved = resolveProfileDir(profileDir, platform);
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  await fs.chmod(resolved, 0o700).catch(() => {});
  const owner = await acquirePersistentProfileOwner(resolved, options);

  try {
    const inspection = await inspectProfileProcesses(resolved, options);
    if (!inspection.available && await hasChromiumLocks(resolved)) {
      throw profileBusyError('ERR_PROFILE_IN_USE');
    }
    if (inspection.pids.length) {
      if (!owner.reused || options.stopProcesses === false) {
        throw profileBusyError('ERR_PROFILE_IN_USE');
      }
      await stopProfileBrowsers(resolved, { ...options, ownerToken: owner.token });
      const remaining = await inspectProfileProcesses(resolved, options);
      if (!remaining.available || remaining.pids.length) throw profileBusyError('ERR_PROFILE_IN_USE');
    }

    await requireOwner(resolved, { ...options, ownerToken: owner.token });
    await removeProfileLocks(resolved);
    const removedCaches = options.pruneCaches === false
      ? []
      : await prunePersistentProfileCaches(resolved, options);
    return { stoppedPids: inspection.pids, removedCaches, ownerToken: owner.token };
  } catch (error) {
    if (!owner.reused) await releasePersistentProfileOwner(resolved, owner.token, options);
    throw error;
  }
}

export async function closePersistentBrowserContext(context, profileDir, options = {}) {
  const closeTimeoutMs = Math.max(0, Number(options.closeTimeoutMs ?? 5000));
  const releaseOwner = options.releaseOwner !== false;
  const removeLocks = options.removeLocks !== false && releaseOwner;
  const platform = currentPlatform(options);
  const resolved = resolveProfileDir(profileDir, platform);
  const local = owners.get(profileKey(resolved, platform));
  const token = options.ownerToken || local?.token;
  let closeTimedOut = false;
  let stoppedPids = [];
  let profileLocksRemoved = false;
  let ownerCanBeReleased = false;

  if (context?.close) {
    let closeResult = null;
    try {
      closeResult = context.close();
    } catch {
      closeResult = null;
    }
    if (closeTimeoutMs) {
      const closeOutcome = await settlePromiseWithin(closeResult, closeTimeoutMs);
      closeTimedOut = closeOutcome.timedOut;
    } else {
      await Promise.resolve(closeResult).catch(() => {});
    }
  }

  if (await ownerMatches(resolved, token, options)) {
    try {
      stoppedPids = await stopProfileBrowsers(resolved, { ...options, ownerToken: token });
      const remaining = await inspectProfileProcesses(resolved, options);
      ownerCanBeReleased = remaining.available
        && remaining.pids.length === 0
        && await ownerMatches(resolved, token, options);
      if (ownerCanBeReleased && removeLocks) {
        await removeProfileLocks(resolved);
        profileLocksRemoved = true;
      }
    } catch {
      ownerCanBeReleased = false;
    }
  }
  const ownerReleased = releaseOwner && ownerCanBeReleased
    ? await releasePersistentProfileOwner(resolved, token, options)
    : false;
  return { closeTimedOut, stoppedPids, profileLocksRemoved, ownerReleased };
}

export async function ensureBrowserRuntimeDirs(outputDir) {
  const runtimeHome = path.join(outputDir, 'runtime-home');
  const runtimeCache = path.join(outputDir, 'runtime-cache');
  const fontCache = path.join(runtimeCache, 'fontconfig');
  const chromiumCache = path.join(runtimeCache, 'chromium');
  await Promise.all([
    fs.mkdir(runtimeHome, { recursive: true, mode: 0o700 }),
    fs.mkdir(runtimeCache, { recursive: true, mode: 0o700 }),
    fs.mkdir(chromiumCache, { recursive: true, mode: 0o700 }),
  ]);
  await fs.mkdir(fontCache, { recursive: true, mode: 0o700 });
  await Promise.all([
    fs.chmod(runtimeHome, 0o700).catch(() => {}),
    fs.chmod(runtimeCache, 0o700).catch(() => {}),
    fs.chmod(fontCache, 0o700).catch(() => {}),
    fs.chmod(chromiumCache, 0o700).catch(() => {}),
  ]);
  return { runtimeHome, runtimeCache, chromiumCache };
}
