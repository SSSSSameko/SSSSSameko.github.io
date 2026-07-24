import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const PASSWORD_PREFIX = 'scrypt';
const SESSION_VERSION = 1;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizedPassword(value) {
  return String(value || '').normalize('NFKC');
}

export async function hashAdminPassword(password, options = {}) {
  const salt = options.salt || crypto.randomBytes(16);
  const keyLength = Number(options.keyLength || 64);
  const derived = await scrypt(normalizedPassword(password), salt, keyLength);
  return [
    PASSWORD_PREFIX,
    salt.toString('base64url'),
    Buffer.from(derived).toString('base64url'),
  ].join('$');
}

export async function verifyAdminPassword(password, encoded) {
  const [scheme, saltText, hashText] = String(encoded || '').split('$');
  if (scheme !== PASSWORD_PREFIX || !saltText || !hashText) return false;
  try {
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(hashText, 'base64url');
    const actual = await scrypt(normalizedPassword(password), salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function signPayload(payloadText, secret) {
  return crypto.createHmac('sha256', secret).update(payloadText).digest('base64url');
}

export function createAdminSession(options = {}) {
  const now = Number(options.now ?? Date.now());
  const ttlMs = Math.max(60_000, Number(options.ttlMs || 12 * 60 * 60_000));
  const payload = {
    v: SESSION_VERSION,
    u: String(options.username || ''),
    iat: now,
    exp: now + ttlMs,
    jti: options.sessionId || crypto.randomUUID(),
    csrf: options.csrfToken || crypto.randomBytes(24).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return {
    token: `${encoded}.${signPayload(encoded, options.secret)}`,
    payload,
  };
}

export function verifyAdminSession(token, options = {}) {
  const [encoded, signature] = String(token || '').split('.');
  if (!encoded || !signature || !options.secret) return null;
  if (!safeEqual(signature, signPayload(encoded, options.secret))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const now = Number(options.now ?? Date.now());
    if (payload.v !== SESSION_VERSION || payload.exp <= now || payload.iat > now + 60_000) return null;
    if (!payload.u || !payload.jti || !payload.csrf) return null;
    if (options.username && !safeEqual(payload.u, options.username)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookieHeader(value) {
  const cookies = {};
  for (const part of String(value || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const raw = part.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch {
      cookies[name] = raw;
    }
  }
  return cookies;
}

export function adminSessionCookie(name, token, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(Number(options.maxAgeSeconds || 0)))}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function expiredAdminSessionCookie(name, options = {}) {
  return adminSessionCookie(name, '', {
    secure: options.secure,
    maxAgeSeconds: 0,
  });
}

export function createLoginLimiter(options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 5));
  const windowMs = Math.max(1000, Number(options.windowMs || 15 * 60_000));
  const entries = new Map();

  function entryFor(key, now) {
    const id = String(key || 'unknown');
    const current = entries.get(id);
    if (current && current.resetAt > now) return [id, current];
    const next = { failures: 0, resetAt: now + windowMs };
    entries.set(id, next);
    return [id, next];
  }

  return {
    check(key, now = Date.now()) {
      const [, entry] = entryFor(key, now);
      return {
        allowed: entry.failures < maxAttempts,
        retryAfterMs: Math.max(0, entry.resetAt - now),
      };
    },
    fail(key, now = Date.now()) {
      const [, entry] = entryFor(key, now);
      entry.failures += 1;
      return {
        allowed: entry.failures < maxAttempts,
        remaining: Math.max(0, maxAttempts - entry.failures),
        retryAfterMs: Math.max(0, entry.resetAt - now),
      };
    },
    clear(key) {
      entries.delete(String(key || 'unknown'));
    },
    prune(now = Date.now()) {
      for (const [key, entry] of entries) {
        if (entry.resetAt <= now) entries.delete(key);
      }
    },
  };
}
