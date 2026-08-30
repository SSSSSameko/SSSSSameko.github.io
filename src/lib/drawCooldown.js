import { safeWeiboUrl } from './appCore.js';

export const DRAW_COOLDOWN_MS = 60_000;
const DRAW_GUARD_TTL_MS = 3 * 60_000;
const DRAW_COOLDOWN_KEY = 'weibo-draw-cooldowns-v1';

const DRAW_LOCK_PREFIX = 'sameko-weibo-draw:';
const memoryByStorage = new WeakMap();
const sharedMemory = new Map();

function memoryRecords(storage) {
  if (!storage || (typeof storage !== 'object' && typeof storage !== 'function')) {
    return sharedMemory;
  }
  let records = memoryByStorage.get(storage);
  if (!records) {
    records = new Map();
    memoryByStorage.set(storage, records);
  }
  return records;
}

function timestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const state = record.state === 'running' || record.state === 'completed'
    ? record.state
    : '';
  if (!state) return null;
  const token = String(record.token || '');
  const startedAt = timestamp(record.startedAt);
  const expiresAt = timestamp(record.expiresAt);
  const completedAt = timestamp(record.completedAt);
  if (state === 'running' && (!token || !expiresAt)) return null;
  if (state === 'completed' && !completedAt) return null;
  return {
    state,
    ...(token ? { token } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(completedAt ? { completedAt } : {}),
  };
}

function parseRecords(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
  const records = new Map();
  for (const [scope, record] of Object.entries(value)) {
    const normalized = normalizeRecord(record);
    if (normalized) records.set(scope, normalized);
  }
  return records;
}

function readPersistentRecords(storage) {
  if (typeof storage?.getItem !== 'function') {
    return { available: false, records: new Map() };
  }
  let raw;
  try {
    raw = storage.getItem(DRAW_COOLDOWN_KEY);
  } catch {
    return { available: false, records: new Map() };
  }
  try {
    return { available: true, records: parseRecords(JSON.parse(raw || '{}')) };
  } catch {
    return { available: true, records: new Map(), malformed: true };
  }
}

function recordExpiry(record) {
  return record?.state === 'completed'
    ? timestamp(record.completedAt) + DRAW_COOLDOWN_MS
    : timestamp(record?.expiresAt);
}

function recordIsActive(record, now) {
  return Boolean(record) && recordExpiry(record) > now;
}

function memoryRecordIsActive(record, now) {
  if (record?.state === 'released') return timestamp(record.suppressUntil) > now;
  return Math.max(recordExpiry(record), timestamp(record?.suppressUntil)) > now;
}

function recordTime(record) {
  return record?.state === 'completed'
    ? timestamp(record.completedAt)
    : timestamp(record?.startedAt);
}

function pruneRecords(records, now) {
  return new Map(
    [...records.entries()]
      .map(([scope, record]) => [scope, normalizeRecord(record)])
      .filter(([, record]) => recordIsActive(record, now))
      .sort(([, left], [, right]) => recordTime(right) - recordTime(left))
      .slice(0, 50),
  );
}

function writePersistentRecords(storage, records, now) {
  if (typeof storage?.setItem !== 'function') {
    return { ok: false, reason: 'unavailable', observed: null };
  }
  const cleaned = pruneRecords(records, now);
  let serialized;
  try {
    serialized = JSON.stringify(Object.fromEntries(cleaned));
    storage.setItem(DRAW_COOLDOWN_KEY, serialized);
  } catch (error) {
    return {
      ok: false,
      reason: isQuotaError(error) ? 'quota' : 'unavailable',
      observed: null,
    };
  }
  if (typeof storage.getItem !== 'function') {
    return { ok: false, reason: 'unavailable', observed: null };
  }
  try {
    const stored = storage.getItem(DRAW_COOLDOWN_KEY);
    if (stored === serialized) return { ok: true, reason: '', observed: cleaned };
    let observed = null;
    try {
      observed = parseRecords(JSON.parse(stored || '{}'));
    } catch {
      observed = null;
    }
    return { ok: false, reason: 'verify', observed };
  } catch {
    return { ok: false, reason: 'unavailable', observed: null };
  }
}

function isQuotaError(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.name === 'QuotaExceededError'
    || error?.code === 22
    || error?.code === 1014
    || message.includes('quota');
}

function activeRecord(storage, scope, now) {
  const persistent = readPersistentRecords(storage);
  const memory = memoryRecords(storage);
  for (const [key, record] of memory) {
    if (!memoryRecordIsActive(record, now)) memory.delete(key);
  }
  const memoryRecord = memory.get(scope);
  const persistentRecord = persistent.records.get(scope);
  const memorySuppressesPersistent = memoryRecord?.state === 'released'
    || (
      memoryRecord?.state === 'completed'
      && !recordIsActive(memoryRecord, now)
      && timestamp(memoryRecord.suppressUntil) > now
    );
  if (memorySuppressesPersistent) {
    if (recordIsActive(persistentRecord, now) && persistentRecord.token === memoryRecord.token) {
      return {
        record: null,
        source: 'memory',
        suppressed: true,
        suppressedToken: memoryRecord.token,
        persistent,
        memory,
      };
    }
    memory.delete(scope);
  }
  const memoryActive = recordIsActive(memory.get(scope), now);
  const persistentActive = recordIsActive(persistentRecord, now);
  if (memoryActive && persistentActive) {
    if (memory.get(scope).token && memory.get(scope).token === persistentRecord.token) {
      return {
        record: memory.get(scope),
        source: memory.get(scope).persistent === true ? 'persistent' : 'memory',
        persistent,
        memory,
      };
    }
    return { record: persistentRecord, source: 'persistent', persistent, memory };
  }
  if (memoryActive) {
    return { record: memory.get(scope), source: 'memory', persistent, memory };
  }
  if (persistentActive) {
    return { record: persistentRecord, source: 'persistent', persistent, memory };
  }
  return { record: null, source: '', suppressed: false, persistent, memory };
}

function blockedResult(record, source, now) {
  return {
    ok: false,
    blocked: true,
    reason: record.state === 'completed' ? 'cooldown' : 'running',
    remainingMs: Math.max(0, recordExpiry(record) - now),
    persistent: source === 'persistent',
  };
}

function token() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function unlockedLease() {
  return {
    ok: true,
    supported: false,
    release: () => Promise.resolve(),
  };
}

export async function acquireDrawTabLock(scope, locks = globalThis.navigator?.locks) {
  const key = String(scope || '').trim();
  if (!key || typeof locks?.request !== 'function') return unlockedLease();

  let settle;
  let settled = false;
  let releaseLock;
  let requestPromise;
  const acquired = new Promise((resolve) => {
    settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });
  const hold = new Promise((resolve) => { releaseLock = resolve; });
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      releaseLock();
    }
    return requestPromise?.catch(() => {}) || Promise.resolve();
  };

  try {
    requestPromise = Promise.resolve(locks.request(
      `${DRAW_LOCK_PREFIX}${key}`,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (!lock) {
          settle({
            ok: false,
            supported: true,
            reason: 'running',
            release: () => Promise.resolve(),
          });
          return;
        }
        settle({ ok: true, supported: true, release });
        await hold;
      },
    ));
    requestPromise.catch(() => settle(unlockedLease()));
  } catch {
    return unlockedLease();
  }

  return acquired;
}

export function drawCooldownScope({ source, statusId, statusUrl } = {}) {
  if (source === 'manual') return '';
  const id = String(statusId || '').trim();
  if (id) return `weibo:${id}`;
  const url = safeWeiboUrl(statusUrl);
  return url ? `weibo-url:${url}` : '';
}

export function drawCooldownStatus(storage, scope, now = Date.now()) {
  const key = String(scope || '').trim();
  if (!key) return { blocked: false, reason: '', remainingMs: 0, persistent: true };
  const current = activeRecord(storage, key, now);
  if (!current.record) {
    return {
      blocked: false,
      reason: '',
      remainingMs: 0,
      persistent: current.suppressed ? false : current.persistent.available,
    };
  }
  return {
    blocked: true,
    reason: current.record.state === 'completed' ? 'cooldown' : 'running',
    remainingMs: Math.max(0, recordExpiry(current.record) - now),
    persistent: current.source === 'persistent',
  };
}

export function acquireDrawGuard(storage, scope, now = Date.now()) {
  const key = String(scope || '').trim();
  if (!key) return { ok: true, scope: '', token: '' };

  const current = activeRecord(storage, key, now);
  if (current.record) return blockedResult(current.record, current.source, now);

  const guardToken = token();
  const record = {
    state: 'running',
    token: guardToken,
    startedAt: now,
    expiresAt: now + DRAW_GUARD_TTL_MS,
    persistent: false,
  };
  current.memory.set(key, record);
  if (!current.persistent.available) {
    return { ok: true, scope: key, token: guardToken, persistent: false };
  }

  const latest = readPersistentRecords(storage);
  const existing = latest.records.get(key);
  if (recordIsActive(existing, now) && existing.token !== current.suppressedToken) {
    current.memory.delete(key);
    return blockedResult(existing, 'persistent', now);
  }
  const persisted = writePersistentRecords(
    storage,
    new Map([...latest.records, [key, record]]),
    now,
  );
  if (persisted.ok) {
    current.memory.set(key, { ...record, persistent: true });
    return { ok: true, scope: key, token: guardToken, persistent: true };
  }
  const observed = persisted.observed?.get(key);
  if (recordIsActive(observed, now) && observed.token !== guardToken) {
    current.memory.delete(key);
    return blockedResult(observed, 'persistent', now);
  }
  return { ok: true, scope: key, token: guardToken, persistent: false };
}

export function completeDrawGuard(storage, scope, guardToken, now = Date.now()) {
  const key = String(scope || '').trim();
  if (!key || !guardToken) return;
  const current = activeRecord(storage, key, now);
  const memoryRecord = current.memory.get(key);
  const persistentRecord = current.persistent.records.get(key);
  const memoryOwns = memoryRecord?.state === 'running' && memoryRecord.token === guardToken;
  const persistentOwns = persistentRecord?.state === 'running'
    && persistentRecord.token === guardToken;
  if (current.persistent.available && recordIsActive(persistentRecord, now) && !persistentOwns) {
    if (memoryOwns) current.memory.delete(key);
    return { ok: false, persistent: true };
  }
  if (!memoryOwns && !persistentOwns) {
    return { ok: false, persistent: current.persistent.available };
  }

  const stalePersistentUntil = memoryRecord?.persistent === true || persistentOwns
    ? Math.max(recordExpiry(memoryRecord), recordExpiry(persistentRecord))
    : 0;
  const completed = {
    state: 'completed',
    token: guardToken,
    completedAt: now,
    persistent: false,
    ...(stalePersistentUntil ? { suppressUntil: stalePersistentUntil } : {}),
  };
  current.memory.set(key, completed);
  if (!persistentOwns) return { ok: true, persistent: false };
  const records = new Map(current.persistent.records);
  records.set(key, completed);
  const persisted = writePersistentRecords(storage, records, now);
  if (persisted.ok) current.memory.set(key, { ...completed, persistent: true });
  return { ok: true, persistent: persisted.ok };
}

export function releaseDrawGuard(storage, scope, guardToken, now = Date.now()) {
  const key = String(scope || '').trim();
  if (!key || !guardToken) return;
  const current = activeRecord(storage, key, now);
  const memoryRecord = current.memory.get(key);
  const persistentRecord = current.persistent.records.get(key);
  const memoryOwns = memoryRecord?.state === 'running' && memoryRecord.token === guardToken;
  const persistentOwns = persistentRecord?.state === 'running'
    && persistentRecord.token === guardToken;
  if (current.persistent.available && recordIsActive(persistentRecord, now) && !persistentOwns) {
    if (memoryOwns) current.memory.delete(key);
    return { ok: false, persistent: true };
  }
  if (!memoryOwns && !persistentOwns) {
    return { ok: false, persistent: current.persistent.available };
  }

  current.memory.delete(key);
  if (!persistentOwns) {
    if (memoryOwns && memoryRecord.persistent === true) {
      current.memory.set(key, {
        state: 'released',
        token: guardToken,
        suppressUntil: recordExpiry(memoryRecord),
      });
    }
    return { ok: true, persistent: false };
  }
  const records = new Map(current.persistent.records);
  records.delete(key);
  const persisted = writePersistentRecords(storage, records, now);
  if (!persisted.ok) {
    current.memory.set(key, {
      state: 'released',
      token: guardToken,
      suppressUntil: Math.max(now + DRAW_GUARD_TTL_MS, recordExpiry(persistentRecord)),
    });
  }
  return { ok: true, persistent: persisted.ok };
}
