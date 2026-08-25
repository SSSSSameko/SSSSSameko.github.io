import { safeWeiboUrl } from './appCore.js';

export const DRAW_COOLDOWN_MS = 60_000;
export const DRAW_GUARD_TTL_MS = 3 * 60_000;
export const DRAW_COOLDOWN_KEY = 'weibo-draw-cooldowns-v1';

function readRecords(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(DRAW_COOLDOWN_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeRecords(storage, records, now) {
  try {
    const entries = Object.entries(records)
      .filter(([, record]) => {
        const completedAt = Number(record?.completedAt || 0);
        return (completedAt > 0 && completedAt + DRAW_COOLDOWN_MS > now)
          || Number(record?.expiresAt || 0) > now;
      })
      .sort(([, left], [, right]) => (
        Math.max(Number(right?.completedAt || 0), Number(right?.startedAt || 0))
        - Math.max(Number(left?.completedAt || 0), Number(left?.startedAt || 0))
      ))
      .slice(0, 50);
    storage?.setItem(DRAW_COOLDOWN_KEY, JSON.stringify(Object.fromEntries(entries)));
    return true;
  } catch {
    return false;
  }
}

function token() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function drawCooldownScope({ source, statusId, statusUrl }) {
  if (source === 'manual') return '';
  const id = String(statusId || '').trim();
  if (id) return `weibo:${id}`;
  const url = safeWeiboUrl(statusUrl);
  return url ? `weibo-url:${url}` : '';
}

export function drawCooldownStatus(storage, scope, now = Date.now()) {
  if (!scope) return { blocked: false, reason: '', remainingMs: 0 };
  const record = readRecords(storage)[scope];
  if (!record) return { blocked: false, reason: '', remainingMs: 0 };

  const completedAt = Number(record.completedAt || 0);
  const cooldownRemaining = completedAt + DRAW_COOLDOWN_MS - now;
  if (completedAt > 0 && cooldownRemaining > 0) {
    return { blocked: true, reason: 'cooldown', remainingMs: cooldownRemaining };
  }
  const runningRemaining = Number(record.expiresAt || 0) - now;
  if (record.state === 'running' && runningRemaining > 0) {
    return { blocked: true, reason: 'running', remainingMs: runningRemaining };
  }
  return { blocked: false, reason: '', remainingMs: 0 };
}

export function acquireDrawGuard(storage, scope, now = Date.now()) {
  if (!scope) return { ok: true, scope: '', token: '' };
  const status = drawCooldownStatus(storage, scope, now);
  if (status.blocked) return { ok: false, ...status };

  const guardToken = token();
  const records = readRecords(storage);
  records[scope] = {
    state: 'running',
    token: guardToken,
    startedAt: now,
    expiresAt: now + DRAW_GUARD_TTL_MS,
  };
  if (!writeRecords(storage, records, now)) {
    return { ok: true, scope: '', token: '' };
  }
  const saved = readRecords(storage)[scope];
  return saved?.token === guardToken
    ? { ok: true, scope, token: guardToken }
    : { ok: false, blocked: true, reason: 'running', remainingMs: DRAW_GUARD_TTL_MS };
}

export function completeDrawGuard(storage, scope, guardToken, now = Date.now()) {
  if (!scope || !guardToken) return;
  const records = readRecords(storage);
  const record = records[scope];
  if (record?.token !== guardToken) return;
  records[scope] = { state: 'completed', completedAt: now };
  writeRecords(storage, records, now);
}

export function releaseDrawGuard(storage, scope, guardToken, now = Date.now()) {
  if (!scope || !guardToken) return;
  const records = readRecords(storage);
  if (records[scope]?.token !== guardToken) return;
  delete records[scope];
  writeRecords(storage, records, now);
}
