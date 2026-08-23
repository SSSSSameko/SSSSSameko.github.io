import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  adminSessionCookie,
  createAdminSession,
  createLoginLimiter,
  expiredAdminSessionCookie,
  parseCookieHeader,
  verifyAdminPassword,
  verifyAdminSession,
} from './src/lib/adminAuth.js';
import {
  appendKeepaliveEvent,
  formatDurationMs,
  normalizeKeepaliveHistory,
} from './src/lib/adminStatus.js';
import {
  compactCookieEntriesByAccount,
  cookiePoolCounts,
} from './src/lib/cookiePool.js';
import { completedDrawStats } from './src/lib/drawReceipts.js';
import { normalizeFeedbackSubmission } from './src/lib/feedback.js';
import { safeAvatarUrl } from './src/lib/avatar.js';
import {
  clientAddress,
  firstHeaderValue,
  trustedForwardedHeader,
} from './src/lib/requestTrust.js';
import { retainLatestLines, selectFilesToPrune } from './src/lib/storageRetention.js';
import {
  analyzeMemoryTrend,
  parseCgroupMemoryStat,
  parseProcMeminfo,
  resolveCgroupV2Directory,
  summarizeCgroupMemory,
  summarizeHostMemory,
} from './src/lib/systemMetrics.js';
import {
  closePersistentBrowserContext,
  ensureBrowserRuntimeDirs,
  findProfileBrowserPids,
  preparePersistentProfile,
  stopProfileBrowsers,
} from './src/lib/weiboBrowserLifecycle.js';
import {
  isWeiboThrottleStatus,
  pageWaitPlan,
  throttleRetryDelayMs,
} from './src/lib/weiboPacing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname);
const distDir = path.join(rootDir, 'dist');
const publicDir = path.join(rootDir, 'public');
const adminDir = path.join(rootDir, 'server-admin');
const outputDir = path.join(rootDir, 'output');
const drawsDir = path.resolve(rootDir, process.env.DRAWS_DIR || 'output/draws');
const authDir = path.join(outputDir, 'auth');
const cookieStoreFile = path.join(authDir, 'weibo-cookie.json');
const weiboLoginProfileDir = path.join(authDir, 'weibo-login-profile');
const weiboLoginStateFile = path.join(authDir, 'weibo-login-state.json');
const drawAttemptsFile = path.join(rootDir, 'output', 'draw-attempts.jsonl');
const systemMetricsFile = path.join(outputDir, 'system-metrics.json');
const adminEventsFile = path.join(outputDir, 'admin-events.json');
const feedbackFile = path.resolve(rootDir, process.env.FEEDBACK_FILE || 'output/feedback.json');

function envNumber(name, fallback, minimum = 0) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

const port = envNumber('PORT', 4173, 1);
const host = String(process.env.HOST || '').trim();
const apiKey = String(process.env.API_KEY || '').trim();
const adminKey = String(process.env.ADMIN_KEY || '').trim();
const adminUsername = String(process.env.ADMIN_USERNAME || '').trim();
const adminPasswordHash = String(process.env.ADMIN_PASSWORD_HASH || '').trim();
const adminSessionSecret = String(process.env.ADMIN_SESSION_SECRET || '').trim();
const sourceFingerprintSecret = String(
  process.env.SOURCE_FINGERPRINT_SECRET || adminSessionSecret || crypto.randomBytes(32).toString('hex'),
);
const isProduction = process.env.NODE_ENV === 'production';
const adminSessionTtlMs = envNumber('ADMIN_SESSION_TTL_MS', 12 * 60 * 60_000, 60_000);
const adminSessionSecure = /^(1|true|yes)$/i.test(String(
  process.env.ADMIN_SESSION_SECURE
    ?? (process.env.NODE_ENV === 'production' ? '1' : '0'),
).trim());
const cookieWriteKey = String(process.env.COOKIE_WRITE_KEY || '').trim();
const fetchTimeoutMs = envNumber('FETCH_TIMEOUT_MS', 20_000, 1000);
const jobTtlMs = envNumber('JOB_TTL_MS', 10 * 60_000, 60_000);
const maxActiveJobs = envNumber('MAX_ACTIVE_JOBS', 2, 1);
const maxQueuedJobs = envNumber('MAX_QUEUED_JOBS', 20, 1);
const rateLimitWindowMs = envNumber('RATE_LIMIT_WINDOW_MS', 60_000, 1000);
const rateLimitMax = envNumber('RATE_LIMIT_MAX', 240, 1);
const rateLimitMaxBuckets = envNumber('RATE_LIMIT_MAX_BUCKETS', 5000, 100);
const jobCreateRateLimitMax = envNumber('JOB_CREATE_RATE_LIMIT_MAX', 10, 1);
const jobPollRateLimitMax = envNumber('JOB_POLL_RATE_LIMIT_MAX', 240, 1);
const drawSaveRateLimitMax = envNumber('DRAW_SAVE_RATE_LIMIT_MAX', 12, 1);
const avatarRateLimitMax = envNumber('AVATAR_RATE_LIMIT_MAX', 240, 1);
const feedbackRateLimitMax = envNumber('FEEDBACK_RATE_LIMIT_MAX', 4, 1);
const maxFeedbackBodyBytes = envNumber('MAX_FEEDBACK_BODY_BYTES', 16 * 1024, 2048);
const maxFeedbackEntries = envNumber('MAX_FEEDBACK_ENTRIES', 500, 20);
const feedbackDuplicateWindowMs = envNumber('FEEDBACK_DUPLICATE_WINDOW_MS', 10 * 60_000, 60_000);
const maxCookieBytes = envNumber('MAX_COOKIE_BYTES', 16_384, 1024);
const maxRepostJobBodyBytes = envNumber('MAX_REPOST_JOB_BODY_BYTES', 64 * 1024, 16 * 1024);
const maxWeiboResponseBytes = envNumber('MAX_WEIBO_RESPONSE_BYTES', 4 * 1024 * 1024, 64 * 1024);
const maxCandidates = envNumber('MAX_CANDIDATES', 20_000, 100);
const maxStoredCookies = envNumber('MAX_STORED_COOKIES', 30, 1);
const avatarProxyMaxBytes = envNumber('AVATAR_PROXY_MAX_BYTES', 512 * 1024, 16 * 1024);
const avatarCacheMaxBytes = envNumber('AVATAR_CACHE_MAX_BYTES', 12 * 1024 * 1024, 1024 * 1024);
const avatarCacheMaxEntries = envNumber('AVATAR_CACHE_MAX_ENTRIES', 512, 32);
const avatarCacheTtlMs = envNumber('AVATAR_CACHE_TTL_MS', 24 * 60 * 60_000, 60_000);
const disableCookieStore = /^(1|true|yes)$/i.test(String(process.env.DISABLE_COOKIE_STORE || '').trim());
const pageDelayJitterMs = envNumber('PAGE_DELAY_JITTER_MS', 450, 0);
const officialPageDelayMs = envNumber('OFFICIAL_PAGE_DELAY_MS', 900, 0);
const desktopPageDelayMs = envNumber('DESKTOP_PAGE_DELAY_MS', 1200, 0);
const legacyPageDelayMs = envNumber('LEGACY_PAGE_DELAY_MS', 1200, 0);
const mobilePageDelayMs = envNumber('MOBILE_PAGE_DELAY_MS', 1600, 0);
const pageCooldownEvery = envNumber('PAGE_COOLDOWN_EVERY', 8, 2);
const pageCooldownMs = envNumber('PAGE_COOLDOWN_MS', 5000, 0);
const weiboThrottleRetryMax = envNumber('WEIBO_THROTTLE_RETRY_MAX', 2, 0);
const weiboThrottleBackoffMs = envNumber('WEIBO_THROTTLE_BACKOFF_MS', 15_000, 1000);
const weiboThrottleMaxWaitMs = envNumber('WEIBO_THROTTLE_MAX_WAIT_MS', 120_000, 1000);
const sameStatusRequestGapMs = envNumber('SAME_STATUS_REQUEST_GAP_MS', 3000, 0);
const weiboLoginSessionTtlMs = envNumber('WEIBO_LOGIN_SESSION_TTL_MS', 8 * 60_000, 60_000);
const weiboKeepaliveIntervalMs = envNumber('WEIBO_KEEPALIVE_INTERVAL_MS', 12 * 60 * 60_000, 60_000);
const weiboKeepaliveStartupDelayMs = envNumber('WEIBO_KEEPALIVE_STARTUP_DELAY_MS', 90_000, 10_000);
const weiboKeepaliveRetryMs = envNumber('WEIBO_KEEPALIVE_RETRY_MS', 30 * 60_000, 60_000);
const weiboBrowserLaunchTimeoutMs = envNumber('WEIBO_BROWSER_LAUNCH_TIMEOUT_MS', 60_000, 10_000);
const maxDrawAttemptBodyBytes = envNumber('MAX_DRAW_ATTEMPT_BODY_BYTES', 256 * 1024, 16 * 1024);
const maxDrawAttemptEntries = envNumber('MAX_DRAW_ATTEMPTS', 5000, 100);
const maxDrawAttemptBytes = envNumber('MAX_DRAW_ATTEMPT_BYTES', 8 * 1024 * 1024, 256 * 1024);
const maxDrawSaveBodyBytes = envNumber('MAX_DRAW_SAVE_BODY_BYTES', 2 * 1024 * 1024, 64 * 1024);
const maxDrawResultGroups = envNumber('MAX_DRAW_RESULT_GROUPS', 20, 1);
const maxDrawWinners = envNumber('MAX_DRAW_WINNERS', 500, 1);
const maxSavedDraws = envNumber('MAX_SAVED_DRAWS', 1000, 20);
const maxSavedDrawBytes = envNumber('MAX_SAVED_DRAW_BYTES', 100 * 1024 * 1024, 1024 * 1024);
const enableWeiboKeepalive = !/^(0|false|no)$/i.test(String(process.env.WEIBO_KEEPALIVE_ENABLED ?? '1').trim());
const serviceRecycleIntervalMs = envNumber('SERVICE_RECYCLE_INTERVAL_MS', 24 * 60 * 60_000, 60_000);
const serviceMemoryHighMb = envNumber('SERVICE_MEMORY_HIGH_MB', 700, 1);
const serviceMemoryMaxMb = envNumber('SERVICE_MEMORY_MAX_MB', 850, 1);
const configuredCorsOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => normalizeConfiguredOrigin(origin))
  .filter(Boolean);
const OFFICIAL_PAGE_SIZE = 200;
const OFFICIAL_MAX_PAGES = 500;
const DESKTOP_FIRST_PAGE_SIZE = 10;
const DESKTOP_PAGE_SIZE = 20;
const DESKTOP_MAX_PAGES = 500;
const LEGACY_MAX_PAGES = 500;
const MOBILE_MAX_PAGES = 120;
const COOKIE_CHECK_URL = 'https://m.weibo.cn/api/config';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const WEIBO_QR_LOGIN_URL = 'https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog&url=https%3A%2F%2Fweibo.com%2F';
const WEIBO_URL_HOSTS = new Set(['weibo.com', 'www.weibo.com', 'm.weibo.cn', 'weibo.cn', 'www.weibo.cn']);
const ADMIN_SESSION_COOKIE = 'sameko_admin_session';
const jobs = new Map();
const jobQueue = [];
const rateLimitBuckets = new Map();
const statusLocks = new Map();
const avatarCache = new Map();
const serverStartedAt = new Date().toISOString();
let avatarCacheBytes = 0;
let weiboLoginSession = null;
let weiboKeepaliveRunning = false;
let weiboBrowserOperation = null;
let weiboKeepaliveContext = null;
let weiboKeepaliveTimer = null;
const adminLoginLimiter = createLoginLimiter({ maxAttempts: 5, windowMs: 15 * 60_000 });
const revokedAdminSessions = new Map();
const memorySamples = [];
const runtimeEvents = [];
const requestStats = {
  total: 0,
  clientErrors: 0,
  serverErrors: 0,
  lastRequestAt: '',
  slowestMs: 0,
};
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
let metricsWrite = Promise.resolve();
let adminEventWrite = Promise.resolve();
let cookieStoreOperation = Promise.resolve();
let weiboLoginStateOperation = Promise.resolve();
let drawAttemptOperation = Promise.resolve();
let feedbackWrite = Promise.resolve();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const WEIBO_BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Requests and access control

function normalizeConfiguredOrigin(origin) {
  const trimmed = String(origin || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : '';
  } catch {
    return '';
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...securityHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { ...securityHeaders(), 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function cspConnectSources() {
  const sources = new Set(["'self'", 'https://111.228.11.206', 'https://sssssameko.github.io']);
  for (const origin of configuredCorsOrigins) sources.add(origin);
  return [...sources].join(' ');
}

function securityHeaders() {
  return {
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      "script-src-attr 'none'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: blob: https:",
      `connect-src ${cspConnectSources()}`,
      "worker-src 'self' blob:",
      "frame-src 'none'",
      "media-src 'none'",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
}

function isApiPath(pathname) {
  return pathname === '/api/health' || pathname.startsWith('/api/');
}

function requestOriginSet(req) {
  const forwardedHost = trustedForwardedHeader(req, 'x-forwarded-host');
  const host = (forwardedHost || firstHeaderValue(req.headers.host)).trim();
  if (!host) return new Set();
  const forwardedProto = trustedForwardedHeader(req, 'x-forwarded-proto').split(',')[0].trim();
  return new Set([
    forwardedProto ? `${forwardedProto}://${host}` : '',
    `https://${host}`,
    `http://${host}`,
  ].filter(Boolean).map(normalizeConfiguredOrigin).filter(Boolean));
}

function isAllowedCorsOrigin(req, origin) {
  if (!origin) return true;
  const normalized = normalizeConfiguredOrigin(origin);
  if (!normalized) return false;
  if (requestOriginSet(req).has(normalized)) return true;
  if (configuredCorsOrigins.includes(normalized)) return true;
  return !isProduction && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(normalized);
}

function applyCors(req, res, pathname) {
  const origin = req.headers.origin;
  if (!origin || !isApiPath(pathname)) return true;
  if (!isAllowedCorsOrigin(req, origin)) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, x-api-key, x-admin-csrf, x-cookie-write-key');
  res.setHeader('access-control-max-age', '86400');
  return true;
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requestApiKey(req) {
  const headerKey = req.headers['x-api-key'];
  if (Array.isArray(headerKey)) return headerKey[0] || '';
  if (headerKey) return String(headerKey);
  const auth = String(req.headers.authorization || '');
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function configuredAdminAccount() {
  return Boolean(
    adminUsername
    && adminPasswordHash
    && Buffer.byteLength(adminSessionSecret, 'utf8') >= 32,
  );
}

function requestCookieWriteKey(req) {
  const value = req.headers['x-cookie-write-key'];
  return Array.isArray(value) ? value[0] || '' : String(value || '');
}

function requestAdminSession(req) {
  const token = parseCookieHeader(req.headers.cookie || '')[ADMIN_SESSION_COOKIE] || '';
  const session = verifyAdminSession(token, {
    username: adminUsername,
    secret: adminSessionSecret,
  });
  if (!session) return null;
  const now = Date.now();
  for (const [sessionId, expiresAt] of revokedAdminSessions) {
    if (expiresAt <= now) revokedAdminSessions.delete(sessionId);
  }
  return revokedAdminSessions.has(session.jti) ? null : session;
}

function authorizeAdminRequest(req) {
  if (adminKey && timingSafeEqualText(requestApiKey(req), adminKey)) {
    return { ok: true, mode: 'key', username: 'server-key' };
  }
  if (!configuredAdminAccount()) {
    return { ok: false, status: 503, error: '后台账号尚未配置' };
  }
  const session = requestAdminSession(req);
  if (!session) return { ok: false, status: 401, error: '登录已失效，请重新登录' };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const csrf = String(req.headers['x-admin-csrf'] || '');
    if (!timingSafeEqualText(csrf, session.csrf)) {
      return { ok: false, status: 403, error: '安全校验失败，请刷新后台后重试' };
    }
  }
  return {
    ok: true,
    mode: 'session',
    username: session.u,
    session,
  };
}

function authorizeApiRequest(req, pathname) {
  if (
    req.method === 'OPTIONS'
    || pathname === '/api/health'
    || (req.method === 'GET' && pathname === '/api/weibo/avatar')
    || (req.method === 'POST' && pathname === '/api/feedback')
    || (req.method === 'POST' && pathname === '/api/admin/login')
  ) {
    return { ok: true, mode: 'public' };
  }
  if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) {
    return authorizeAdminRequest(req);
  }
  if (!apiKey) return { ok: true, mode: 'public' };
  return timingSafeEqualText(requestApiKey(req), apiKey)
    ? { ok: true, mode: 'key' }
    : { ok: false, status: 401, error: '访问密钥不正确或未提供' };
}

function canWriteCookieStore(req) {
  return Boolean(cookieWriteKey) && timingSafeEqualText(requestCookieWriteKey(req), cookieWriteKey);
}

function clientRateKey(req) {
  return clientAddress(req);
}

function normalizedRatePath(pathname) {
  return pathname.startsWith('/api/weibo/reposts/jobs/') ? '/api/weibo/reposts/jobs/:id' : pathname;
}

function rateLimitMaxForPath(req, pathname) {
  if (req.method === 'POST' && pathname === '/api/weibo/reposts/jobs') return jobCreateRateLimitMax;
  if (req.method === 'GET' && pathname.startsWith('/api/weibo/reposts/jobs/')) return jobPollRateLimitMax;
  if (req.method === 'GET' && pathname === '/api/weibo/avatar') return avatarRateLimitMax;
  if (req.method === 'POST' && pathname === '/api/draws') return drawSaveRateLimitMax;
  if (req.method === 'POST' && pathname === '/api/feedback') return feedbackRateLimitMax;
  return rateLimitMax;
}

function checkRateLimit(req, pathname) {
  if (!isApiPath(pathname) || req.method === 'OPTIONS') return { ok: true };
  const now = Date.now();
  const limit = rateLimitMaxForPath(req, pathname);
  const key = `${clientRateKey(req)}:${normalizedRatePath(pathname)}`;
  const current = rateLimitBuckets.get(key);
  let bucket = current && current.resetAt > now ? current : null;
  if (!bucket) {
    if (current) rateLimitBuckets.delete(key);
    if (rateLimitBuckets.size >= rateLimitMaxBuckets) {
      pruneRateLimitBuckets(now);
    }
    while (rateLimitBuckets.size >= rateLimitMaxBuckets) {
      rateLimitBuckets.delete(rateLimitBuckets.keys().next().value);
    }
    bucket = { count: 0, resetAt: now + rateLimitWindowMs };
  }
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  return {
    ok: bucket.count <= limit,
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

function pruneRateLimitBuckets(now = Date.now()) {
  for (const [entryKey, entry] of rateLimitBuckets) {
    if (entry.resetAt <= now) rateLimitBuckets.delete(entryKey);
  }
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const contentType = firstHeaderValue(req.headers['content-type']).split(';')[0].trim().toLowerCase();
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json$/.test(contentType)) {
    const error = new Error('请求必须使用 application/json');
    error.status = 415;
    throw error;
  }
  const declaredLength = Number(firstHeaderValue(req.headers['content-length']));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = new Error('请求体过大');
    error.status = 413;
    throw error;
  }
  let raw = '';
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) {
      const error = new Error('请求体过大');
      error.status = 413;
      throw error;
    }
    raw += chunk;
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('JSON 格式不正确');
    error.status = 400;
    throw error;
  }
}

async function writeJsonFileAtomic(filePath, payload, options = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: options.directoryMode || 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode: options.fileMode || 0o600 });
    await fs.chmod(temporary, options.fileMode || 0o600).catch(() => {});
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, options.fileMode || 0o600).catch(() => {});
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function readResponseBuffer(response, maxBytes, tooLargeMessage = '返回内容过大') {
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body || []) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      const error = new Error(tooLargeMessage);
      error.status = 413;
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

function cachedAvatar(url) {
  const cached = avatarCache.get(url);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    avatarCache.delete(url);
    avatarCacheBytes -= cached.body.length;
    return null;
  }
  avatarCache.delete(url);
  avatarCache.set(url, cached);
  return cached;
}

function storeAvatar(url, entry) {
  if (!entry.body.length || entry.body.length > avatarCacheMaxBytes) return;
  const previous = avatarCache.get(url);
  if (previous) avatarCacheBytes -= previous.body.length;
  avatarCache.delete(url);
  while (
    avatarCache.size
    && (avatarCache.size >= avatarCacheMaxEntries || avatarCacheBytes + entry.body.length > avatarCacheMaxBytes)
  ) {
    const oldestKey = avatarCache.keys().next().value;
    const oldest = avatarCache.get(oldestKey);
    avatarCache.delete(oldestKey);
    avatarCacheBytes -= oldest.body.length;
  }
  avatarCache.set(url, entry);
  avatarCacheBytes += entry.body.length;
}

function sendAvatar(res, entry) {
  res.writeHead(200, {
    ...securityHeaders(),
    'content-type': entry.contentType,
    'content-length': entry.body.length,
    'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
    etag: entry.etag,
  });
  res.end(entry.body);
}

async function handleAvatarProxy(req, res, url) {
  const avatar = safeAvatarUrl(url.searchParams.get('url'));
  if (!avatar || avatar.length > 2048) {
    return sendJson(res, 400, { ok: false, error: '头像地址无效' });
  }
  const cached = cachedAvatar(avatar);
  if (cached) return sendAvatar(res, cached);

  const response = await fetch(avatar, {
    redirect: 'error',
    signal: AbortSignal.timeout(Math.min(fetchTimeoutMs, 10_000)),
    headers: {
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif',
      referer: 'https://weibo.com/',
      'user-agent': DESKTOP_UA,
    },
  });
  if (!response.ok) {
    const error = new Error(`头像服务返回 ${response.status}`);
    error.status = response.status === 404 ? 404 : 502;
    throw error;
  }
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^image\/(avif|gif|jpeg|png|webp)$/.test(contentType)) {
    const error = new Error('头像服务返回了非图片内容');
    error.status = 502;
    throw error;
  }
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > avatarProxyMaxBytes) {
    await response.body?.cancel().catch(() => {});
    const error = new Error('头像文件过大');
    error.status = 413;
    throw error;
  }
  const body = await readResponseBuffer(response, avatarProxyMaxBytes, '头像文件过大');
  if (!body.length) {
    const error = new Error('头像服务返回了空图片');
    error.status = 502;
    throw error;
  }
  const entry = {
    body,
    contentType,
    etag: `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 24)}"`,
    expiresAt: Date.now() + avatarCacheTtlMs,
  };
  storeAvatar(avatar, entry);
  return sendAvatar(res, entry);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const hasBuiltFrontend = await pathExists(path.join(distDir, 'index.html'));
const staticDir = hasBuiltFrontend ? distDir : publicDir;

// Draw records

function decodeBase62(value) {
  let result = 0n;
  for (const char of value) {
    const index = WEIBO_BASE62.indexOf(char);
    if (index < 0) return null;
    result = result * 62n + BigInt(index);
  }
  return result;
}

function bidToMid(value) {
  const bid = String(value || '').trim();
  if (!bid || /^\d+$/.test(bid)) return bid;

  let mid = '';
  for (let end = bid.length; end > 0; end -= 4) {
    const start = Math.max(0, end - 4);
    const chunk = bid.slice(start, end);
    const decoded = decodeBase62(chunk);
    if (decoded === null) return bid;
    let part = decoded.toString();
    if (start > 0) part = part.padStart(7, '0');
    mid = `${part}${mid}`;
  }
  return mid.replace(/^0+/, '') || bid;
}

function isWeiboUrlHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  return WEIBO_URL_HOSTS.has(host);
}

function canonicalStatusUrl(statusId) {
  const id = String(statusId || '').trim();
  return id ? `https://weibo.com/detail/${id}` : '';
}

function extractStatusId(input) {
  const text = String(input || '').trim();
  if (!text || text.length > 2048) return '';
  if (/^\d+$/.test(text) && text.length <= 64) return text;
  if (/^[0-9A-Za-z]+$/.test(text) && text.length >= 5 && text.length <= 64) return bidToMid(text);

  try {
    const url = new URL(text);
    if (!isWeiboUrlHost(url.hostname)) return '';
    const queryCandidate = url.searchParams.get('id') || url.searchParams.get('mid') || url.searchParams.get('mblogid');
    if (queryCandidate && /^[0-9A-Za-z]{1,64}$/.test(queryCandidate)) return bidToMid(queryCandidate);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const candidate = [...pathParts].reverse().find((part) => /^[0-9A-Za-z]{5,64}$/.test(part));
    return candidate ? bidToMid(candidate) : '';
  } catch {
    const match = text.match(/(?:status|detail|weibo\.com\/\d+)\/([0-9A-Za-z]+)/i);
    return match?.[1]?.length <= 64 ? bidToMid(match[1]) : '';
  }
}

function normalizeStatusUrl(input, statusId) {
  const fallback = canonicalStatusUrl(statusId);
  const text = String(input || '').trim();
  if (!text) return fallback;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || !isWeiboUrlHost(url.hostname)) return fallback;
    url.protocol = 'https:';
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.toString();
  } catch {
    return fallback;
  }
}

async function listDrawAttempts() {
  try {
    const text = await fs.readFile(drawAttemptsFile, 'utf8');
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function drawStatusIdFromPayload(payload) {
  return String(
    payload?.statusId
      || payload?.sourceMeta?.statusId
      || payload?.sourceMeta?.weibo?.statusId
      || payload?.audit?.statusId
      || '',
  ).trim();
}

async function getAttemptCountsByStatus() {
  const counts = new Map();
  const attempts = await listDrawAttempts();

  for (const payload of attempts) {
    try {
      const statusId = drawStatusIdFromPayload(payload);
      if (!statusId) continue;
      const current = counts.get(statusId) || {
        statusId,
        statusUrl: payload.statusUrl || payload.sourceMeta?.statusUrl || '',
        count: 0,
        lastDrawnAt: '',
      };
      current.count += 1;
      const drawnAt = payload.drawnAt || payload.createdAt || payload.savedAt || '';
      if (drawnAt && drawnAt > current.lastDrawnAt) current.lastDrawnAt = drawnAt;
      if (!current.statusUrl && payload.statusUrl) current.statusUrl = payload.statusUrl;
      counts.set(statusId, current);
    } catch {
      // Ignore malformed historical records so one bad line does not break the dashboard.
    }
  }

  return counts;
}

async function getAttemptCountForStatus(statusId) {
  if (!statusId) return { statusId: '', count: null, lastDrawnAt: '' };
  const counts = await getAttemptCountsByStatus();
  return counts.get(statusId) || { statusId, count: 0, lastDrawnAt: '' };
}

async function listCompletedDrawRecords() {
  const files = await listDrawFiles();
  const records = [];
  for (const file of files) {
    try {
      const { record } = await readDrawFile(file.file);
      if (record?.auditHash) records.push(record);
    } catch {
      // A malformed historical file must not hide otherwise valid draw counts.
    }
  }
  return records;
}

async function getDrawCountForStatus(statusId, auditHash = '') {
  if (!statusId) {
    return {
      statusId: '',
      statusUrl: '',
      count: null,
      drawNumber: null,
      lastDrawnAt: '',
    };
  }
  const records = await listCompletedDrawRecords();
  const stats = completedDrawStats(records, statusId, auditHash);
  const latest = records
    .filter((record) => drawStatusIdFromPayload(record) === statusId)
    .sort((left, right) => String(right.drawnAt || '').localeCompare(String(left.drawnAt || '')))
    .at(0);
  return {
    statusId,
    statusUrl: String(latest?.statusUrl || latest?.sourceMeta?.statusUrl || ''),
    ...stats,
  };
}

function appendDrawAttempt(payload) {
  const previous = drawAttemptOperation;
  let release;
  const currentOperation = new Promise((resolve) => { release = resolve; });
  drawAttemptOperation = previous.catch(() => {}).then(() => currentOperation);
  return previous
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(drawAttemptsFile), { recursive: true });
      await fs.appendFile(drawAttemptsFile, `${JSON.stringify(payload)}\n`, 'utf8');
      const stat = await fs.stat(drawAttemptsFile).catch(() => null);
      if (!stat) return;
      const lines = (await fs.readFile(drawAttemptsFile, 'utf8'))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      if (lines.length <= maxDrawAttemptEntries && stat.size <= maxDrawAttemptBytes) return;
      const retained = retainLatestLines(lines, {
        maxLines: maxDrawAttemptEntries,
        maxBytes: maxDrawAttemptBytes,
      });
      const temporary = `${drawAttemptsFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, `${retained.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporary, drawAttemptsFile);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    })
    .finally(() => release());
}

async function recordDrawAttempt(body) {
  const statusId = extractStatusId(body.statusId || body.statusUrl || body.sourceMeta?.statusId || body.sourceMeta?.statusUrl);
  if (!statusId) {
    const error = new Error('缺少微博链接、mid 或 bid，无法记录本次抽奖次数');
    error.status = 400;
    throw error;
  }

  const drawnAt = new Date().toISOString();
  const statusUrl = normalizeStatusUrl(body.statusUrl || body.sourceMeta?.statusUrl, statusId);
  const attemptHash = crypto.createHash('sha256')
    .update(JSON.stringify({
      statusId,
      statusUrl,
      source: body.source || '',
      seed: body.seed || '',
      drawnAt,
      eligibleCount: body.eligibleCount,
      prizeCount: body.prizeCount,
      candidateDigest: body.candidateDigest || '',
    }))
    .digest('hex');
  const payload = {
    attemptId: attemptHash.slice(0, 16),
    statusId,
    statusUrl,
    source: String(body.source || '').slice(0, 80),
    drawnAt,
    seed: String(body.seed || '').slice(0, 120),
    eligibleCount: finiteNumber(body.eligibleCount, null),
    candidateCount: finiteNumber(body.candidateCount, null),
    prizeCount: finiteNumber(body.prizeCount, null),
    candidateDigest: String(body.candidateDigest || '').slice(0, 120),
    rules: publicDrawRules(body.rules),
  };

  await appendDrawAttempt(payload);
  const stats = await getAttemptCountForStatus(statusId);
  return {
    ok: true,
    statusId,
    statusUrl,
    drawnAt,
    attemptId: payload.attemptId,
    drawCount: stats.count,
    lastDrawnAt: stats.lastDrawnAt || drawnAt,
  };
}

function stripHtml(input) {
  return String(input || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function stripLegacyHtml(input) {
  return stripHtml(String(input || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' '));
}

function escapeRegExp(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function candidateKey(raw) {
  const stable = [
    raw.uid,
    raw.screenName,
    raw.repostId,
    raw.text,
    raw.createdAt,
  ].filter(Boolean).join('|');
  return crypto.createHash('sha1').update(stable || crypto.randomUUID()).digest('hex').slice(0, 16);
}

function normalizeCandidate(item, source) {
  const user = item?.user || item?.mblog?.user || item?.retweeted_status?.user || {};
  const uid = String(user.idstr || user.id || item.uid || item.user_id || '').trim().slice(0, 80);
  const screenName = String(user.screen_name || user.name || item.screen_name || item.name || '未命名用户').trim().slice(0, 120);
  const text = stripHtml(item.text || item.raw_text || item.mblog?.text || item.reason || '').slice(0, 1000);
  const createdAt = String(item.created_at || item.createdAt || item.mblog?.created_at || '').slice(0, 100);
  const repostId = String(item.idstr || item.id || item.mid || item.mblog?.idstr || item.mblog?.id || '').trim().slice(0, 100);

  return {
    id: candidateKey({ uid, screenName, repostId, text, createdAt }),
    uid,
    screenName,
    avatar: safeAvatarUrl(user.profile_image_url || user.avatar_hd || user.avatar_large),
    verified: Boolean(user.verified),
    followers: Number(user.followers_count || 0),
    text,
    createdAt,
    repostId,
    source: String(source || '').slice(0, 80),
  };
}

function appendNormalizedCandidates(target, items, source) {
  const remaining = Math.max(0, maxCandidates - target.length);
  if (!remaining) return true;
  target.push(...items.slice(0, remaining).map((item) => normalizeCandidate(item, source)));
  return target.length >= maxCandidates;
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = candidate.uid || `${candidate.screenName}|${candidate.repostId}|${candidate.text}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
    if (result.length >= maxCandidates) break;
  }
  return result;
}

function uniqueByRepostId(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const stableRepostId = candidate.repostId && !candidate.repostId.startsWith('weibo-cn-') ? candidate.repostId : '';
    const key = stableRepostId || `${candidate.uid}|${candidate.screenName}|${candidate.text}|${candidate.createdAt}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
    if (result.length >= maxCandidates) break;
  }
  return result;
}

function safeError(error) {
  const rawStatus = Number(error?.status);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
  return {
    message: redactSensitiveText(error?.message || '未知错误'),
    status,
  };
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/((?:SUB|SUBP|ALF|SCF|SSOLoginState|XSRF-TOKEN|MLOGIN|M_WEIBOCN_PARAMS)=)[^;\s]+/gi, '$1[redacted]')
    .replace(/(cookie\s*[:=]\s*)[^\n；。]+/gi, '$1[redacted]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/((?:access_token|api[_-]?key|token)\s*[:=]\s*)[^\s,;&]+/gi, '$1[redacted]');
}

// Cookie and browser sessions

function cleanCookieHeader(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s*;\s*/g, '; ')
    .trim();
}

function isCookieHeaderWithinLimit(cookie) {
  return !/[\u0000-\u001F\u007F]/.test(cookie)
    && Buffer.byteLength(cookie, 'utf8') <= maxCookieBytes;
}

function assertCookieHeaderInput(cookie) {
  if (!cookie) return;
  if (/[\u0000-\u001F\u007F]/.test(cookie)) {
    const error = new Error('Cookie 包含不允许的控制字符');
    error.status = 400;
    throw error;
  }
  if (Buffer.byteLength(cookie, 'utf8') > maxCookieBytes) {
    const error = new Error(`Cookie 内容过长，请确认只粘贴微博 Cookie（最多 ${maxCookieBytes} 字节）`);
    error.status = 413;
    throw error;
  }
}

function cookieFingerprint(cookie) {
  return crypto.createHash('sha256').update(cleanCookieHeader(cookie)).digest('hex').slice(0, 16);
}

function normalizeCookieUser(user) {
  const id = String(user?.id || user?.idstr || '').trim();
  const screenName = String(user?.screenName || user?.screen_name || '').trim();
  return {
    ...(id ? { id } : {}),
    ...(screenName ? { screenName } : {}),
  };
}

function normalizeCookieEntries(payload) {
  const rawEntries = Array.isArray(payload?.cookies)
    ? payload.cookies
    : payload?.cookie
      ? [{ cookie: payload.cookie, savedAt: payload.savedAt }]
      : [];
  const entries = new Map();

  for (const entry of rawEntries) {
    const cookie = cleanCookieHeader(entry?.cookie);
    if (!cookie) continue;
    if (!isCookieHeaderWithinLimit(cookie)) continue;
    const id = entry.id || cookieFingerprint(cookie);
    const user = normalizeCookieUser(entry.user);
    entries.set(id, {
      id,
      cookie,
      savedAt: entry.savedAt || entry.createdAt || new Date(0).toISOString(),
      updatedAt: entry.updatedAt || entry.savedAt || '',
      lastCheckedAt: entry.lastCheckedAt || '',
      lastValidAt: entry.lastValidAt || '',
      lastError: entry.lastError || '',
      ...(user.id || user.screenName ? { user } : {}),
    });
  }

  return [...entries.values()];
}

async function readCookieStore() {
  if (disableCookieStore) return { version: 2, activeId: '', updatedAt: '', cookies: [] };
  try {
    const payload = JSON.parse(await fs.readFile(cookieStoreFile, 'utf8'));
    const cookies = normalizeCookieEntries(payload);
    return {
      version: 2,
      activeId: payload.activeId || cookies[0]?.id || '',
      updatedAt: payload.updatedAt || payload.savedAt || '',
      cookies,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { version: 2, activeId: '', updatedAt: '', cookies: [] };
    }
    throw error;
  }
}

async function writeCookieStore(store) {
  const normalized = sortCookieEntries(normalizeCookieEntries({ cookies: store.cookies || [] }), store.activeId);
  const cookies = compactCookieEntriesByAccount(normalized).slice(0, maxStoredCookies);
  const activeId = cookies.some((entry) => entry.id === store.activeId)
    ? store.activeId
    : cookies[0]?.id || '';
  const payload = {
    version: 2,
    updatedAt: new Date().toISOString(),
    activeId,
    cookies,
  };
  if (disableCookieStore) return payload;
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  await fs.chmod(authDir, 0o700).catch(() => {});
  await writeJsonFileAtomic(cookieStoreFile, payload, { directoryMode: 0o700, fileMode: 0o600 });
  return payload;
}

function withCookieStoreLock(task) {
  const previous = cookieStoreOperation;
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  cookieStoreOperation = previous.catch(() => {}).then(() => current);
  return previous
    .catch(() => {})
    .then(task)
    .finally(() => release());
}

function sortCookieEntries(entries, preferredId = '') {
  return [...entries].sort((a, b) => {
    if (preferredId && a.id === preferredId) return -1;
    if (preferredId && b.id === preferredId) return 1;
    const aValid = a.lastValidAt || '';
    const bValid = b.lastValidAt || '';
    if (aValid !== bValid) return bValid.localeCompare(aValid);
    return String(b.savedAt || '').localeCompare(String(a.savedAt || ''));
  });
}

function cookieStoreSummary(store, extra = {}) {
  const cookies = store.cookies || [];
  const sorted = sortCookieEntries(cookies, store.activeId);
  const counts = cookiePoolCounts(cookies);
  const newest = (key) => sorted.map((entry) => entry[key]).filter(Boolean).sort().at(-1) || '';
  return {
    ok: true,
    hasCookie: cookies.length > 0,
    cookieCount: counts.cookieCount,
    accountCount: counts.accountCount,
    activeId: store.activeId || sorted[0]?.id || '',
    savedAt: newest('savedAt'),
    lastCheckedAt: newest('lastCheckedAt'),
    lastValidAt: newest('lastValidAt'),
    lastError: newest('lastError'),
    ...extra,
  };
}

function isCookieAuthError(error) {
  const message = String(error?.message || error || '');
  return error?.status === 401
    || /Cookie.*(不可用|过期|失效|无效)/i.test(message)
    || /(未登录|登录已失效|访客系统|Sina Visitor System|passport\.sina|请先登录)/i.test(message);
}

async function checkCookieValidity(cookie) {
  const checkedAt = new Date().toISOString();
  try {
    const json = await fetchJson(COOKIE_CHECK_URL, {
      headers: mobileHeaders(cookie, ''),
    });
    if (json?.data?.login === true) {
      return {
        ok: true,
        checkedAt,
        lastValidAt: checkedAt,
        user: {
          id: String(json?.data?.uid || json?.data?.user?.idstr || json?.data?.user?.id || '').trim(),
          screenName: String(json?.data?.user?.screen_name || json?.data?.screen_name || '').trim(),
        },
      };
    }

    const error = new Error('微博返回未登录状态，Cookie 无效或已过期');
    error.status = 401;
    throw error;
  } catch (error) {
    return {
      ok: false,
      checkedAt,
      status: error.status || 0,
      message: error.message || 'Cookie 校验失败',
      invalid: isCookieAuthError(error),
    };
  }
}

async function upsertStoredCookie(cookie, validation = {}) {
  return withCookieStoreLock(async () => {
    const cleaned = cleanCookieHeader(cookie);
    if (!cleaned) return { cookie: '', savedAt: '' };
    assertCookieHeaderInput(cleaned);
    const now = new Date().toISOString();
    const id = cookieFingerprint(cleaned);
    const store = await readCookieStore();
    const existing = store.cookies.find((entry) => entry.id === id);
    const user = normalizeCookieUser(validation.user || existing?.user);
    const entry = {
      id,
      cookie: cleaned,
      savedAt: existing?.savedAt || now,
      updatedAt: now,
      lastCheckedAt: validation.checkedAt || existing?.lastCheckedAt || '',
      lastValidAt: validation.lastValidAt || existing?.lastValidAt || '',
      lastError: validation.ok === false ? validation.message || 'Cookie 校验失败' : '',
      ...(user.id || user.screenName ? { user } : {}),
    };
    if (disableCookieStore) return entry;
    const cookies = [entry, ...store.cookies.filter((item) => item.id !== id)];
    await writeCookieStore({ ...store, activeId: id, cookies });
    return entry;
  });
}

async function removeStoredCookie(idOrCookie) {
  return withCookieStoreLock(async () => {
    const id = String(idOrCookie || '').includes(';') ? cookieFingerprint(idOrCookie) : String(idOrCookie || '');
    const store = await readCookieStore();
    const cookies = store.cookies.filter((entry) => entry.id !== id);
    if (cookies.length === store.cookies.length) return cookieStoreSummary(store, { removedCount: 0 });
    const nextStore = await writeCookieStore({
      ...store,
      activeId: store.activeId === id ? cookies[0]?.id || '' : store.activeId,
      cookies,
    });
    return cookieStoreSummary(nextStore, { removedCount: 1 });
  });
}

async function validateStoredCookies(reportProgress) {
  return withCookieStoreLock(async () => {
    if (disableCookieStore) {
      return cookieStoreSummary({ version: 2, activeId: '', updatedAt: '', cookies: [] }, { cookieStoreDisabled: true });
    }
    const store = await readCookieStore();
    const kept = [];
    let removedCount = 0;

    for (let index = 0; index < store.cookies.length; index += 1) {
      const entry = store.cookies[index];
      reportProgress?.({
        phase: 'cookie-check',
        percent: Math.min(8, 1 + index),
        message: `校验服务器 Cookie：${index + 1}/${store.cookies.length}`,
      });
      const validation = await checkCookieValidity(entry.cookie);
      if (validation.ok) {
        const user = normalizeCookieUser(validation.user || entry.user);
        kept.push({
          ...entry,
          lastCheckedAt: validation.checkedAt,
          lastValidAt: validation.lastValidAt,
          lastError: '',
          ...(user.id || user.screenName ? { user } : {}),
        });
      } else if (validation.invalid) {
        removedCount += 1;
      } else {
        kept.push({
          ...entry,
          lastCheckedAt: validation.checkedAt,
          lastError: validation.message,
        });
      }
    }

    const active = sortCookieEntries(kept, store.activeId)[0]?.id || '';
    const nextStore = await writeCookieStore({ ...store, activeId: active, cookies: kept });
    return cookieStoreSummary(nextStore, {
      checkedCount: store.cookies.length,
      removedCount,
    });
  });
}

function emptyWeiboLoginState(extra = {}) {
  const state = {
    version: 1,
    updatedAt: '',
    lastStatus: 'idle',
    lastMessage: '',
    lastLoginAt: '',
    lastRefreshAt: '',
    lastAttemptAt: '',
    lastSuccessAt: '',
    lastFailureAt: '',
    lastError: '',
    lastReason: '',
    history: [],
    ...extra,
  };
  state.history = normalizeKeepaliveHistory(state.history, 12);
  return state;
}

async function readWeiboLoginState() {
  try {
    const payload = JSON.parse(await fs.readFile(weiboLoginStateFile, 'utf8'));
    return emptyWeiboLoginState(payload);
  } catch (error) {
    if (error.code === 'ENOENT') return emptyWeiboLoginState();
    throw error;
  }
}

function withWeiboLoginStateLock(task) {
  const previous = weiboLoginStateOperation;
  let release;
  const currentOperation = new Promise((resolve) => { release = resolve; });
  weiboLoginStateOperation = previous.catch(() => {}).then(() => currentOperation);
  return previous
    .catch(() => {})
    .then(task)
    .finally(() => release());
}

async function writeWeiboLoginState(patch = {}) {
  return await withWeiboLoginStateLock(async () => {
    const current = await readWeiboLoginState();
    const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    const next = emptyWeiboLoginState({
      ...current,
      ...cleanPatch,
      updatedAt: new Date().toISOString(),
    });
    await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
    await fs.chmod(authDir, 0o700).catch(() => {});
    await writeJsonFileAtomic(weiboLoginStateFile, next, { directoryMode: 0o700, fileMode: 0o600 });
    return next;
  });
}

async function appendWeiboLoginEvent(event = {}, patch = {}) {
  return await withWeiboLoginStateLock(async () => {
    const current = await readWeiboLoginState();
    const nextState = appendKeepaliveEvent(current, event, 12);
    const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    const next = emptyWeiboLoginState({
      ...current,
      ...cleanPatch,
      history: nextState.history,
      updatedAt: new Date().toISOString(),
    });
    await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
    await fs.chmod(authDir, 0o700).catch(() => {});
    await writeJsonFileAtomic(weiboLoginStateFile, next, { directoryMode: 0o700, fileMode: 0o600 });
    return next;
  });
}

function nextWeiboKeepaliveAt(state) {
  const lastSuccess = Date.parse(state.lastRefreshAt || state.lastLoginAt || '');
  const lastFailure = Date.parse(state.lastFailureAt || '');
  if (Number.isFinite(lastFailure) && (!Number.isFinite(lastSuccess) || lastFailure > lastSuccess)) {
    return new Date(lastFailure + weiboKeepaliveRetryMs).toISOString();
  }
  if (!Number.isFinite(lastSuccess)) return '';
  return new Date(lastSuccess + weiboKeepaliveIntervalMs).toISOString();
}

async function publicWeiboLoginState(extra = {}) {
  const state = await readWeiboLoginState();
  const profileReady = await pathExists(weiboLoginProfileDir);
  return {
    ok: true,
    enabled: enableWeiboKeepalive,
    intervalMs: weiboKeepaliveIntervalMs,
    intervalText: formatDurationMs(weiboKeepaliveIntervalMs),
    retryMs: weiboKeepaliveRetryMs,
    retryText: formatDurationMs(weiboKeepaliveRetryMs),
    startupDelayMs: weiboKeepaliveStartupDelayMs,
    startupDelayText: formatDurationMs(weiboKeepaliveStartupDelayMs),
    active: Boolean(weiboLoginSession),
    refreshing: weiboKeepaliveRunning,
    browserOperation: weiboBrowserOperation
      ? { label: weiboBrowserOperation.label, startedAt: weiboBrowserOperation.startedAt }
      : null,
    status: weiboLoginSession?.status || state.lastStatus || 'idle',
    message: weiboLoginSession?.message || state.lastMessage || '',
    sessionId: weiboLoginSession?.id || '',
    createdAt: weiboLoginSession?.createdAt || '',
    expiresAt: weiboLoginSession?.expiresAt || '',
    lastLoginAt: state.lastLoginAt || '',
    lastRefreshAt: state.lastRefreshAt || '',
    lastAttemptAt: state.lastAttemptAt || '',
    lastSuccessAt: state.lastSuccessAt || '',
    lastFailureAt: state.lastFailureAt || '',
    nextRefreshAt: nextWeiboKeepaliveAt(state),
    lastError: state.lastError || '',
    lastReason: state.lastReason || '',
    history: normalizeKeepaliveHistory(state.history, 12),
    profileReady,
    ...extra,
  };
}

async function importPlaywrightChromium() {
  try {
    const mod = await import('playwright');
    return mod.chromium;
  } catch (error) {
    const wrapped = new Error(`服务器还没有安装 Playwright 浏览器组件：${error.message}`);
    wrapped.status = 500;
    throw wrapped;
  }
}

async function runWeiboBrowserOperation(label, task) {
  if (weiboBrowserOperation) {
    const error = new Error(`微博浏览器正在执行${weiboBrowserOperation.label}，请稍后再试。`);
    error.status = 409;
    throw error;
  }
  const operation = { label, startedAt: new Date().toISOString() };
  weiboBrowserOperation = operation;
  try {
    return await task();
      } finally {
    if (weiboBrowserOperation === operation) weiboBrowserOperation = null;
  }
}

async function launchWeiboBrowserContext() {
  const chromium = await importPlaywrightChromium();
  const runtime = await ensureBrowserRuntimeDirs(outputDir);
  const cleanup = await preparePersistentProfile(weiboLoginProfileDir);
  if (cleanup.stoppedPids.length) {
    console.warn(`Stopped ${cleanup.stoppedPids.length} stale Weibo browser process(es) before launch.`);
  }
  const browserEnv = process.platform === 'linux'
    ? {
        ...process.env,
        HOME: runtime.runtimeHome,
        XDG_CACHE_HOME: runtime.runtimeCache,
      }
    : process.env;
  try {
    return await chromium.launchPersistentContext(weiboLoginProfileDir, {
      headless: true,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: DESKTOP_UA,
      viewport: { width: 430, height: 760 },
      timeout: weiboBrowserLaunchTimeoutMs,
      env: browserEnv,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  } catch (error) {
    await preparePersistentProfile(weiboLoginProfileDir).catch(() => {});
    const normalized = safeError(error);
    if (/timeout/i.test(normalized.message)) {
      const wrapped = new Error(`微博保活浏览器启动超时（${formatDurationMs(weiboBrowserLaunchTimeoutMs)}），已清理残留进程与 Profile 锁。`);
      wrapped.status = 504;
      throw wrapped;
    }
    throw error;
  }
}

async function hasVisibleWeiboQrCode(page) {
  return await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width >= 100 && rect.height >= 100 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return Array.from(document.querySelectorAll('img,canvas')).some((element) => {
      if (!visible(element)) return false;
      const src = element.getAttribute('src') || '';
      return element.tagName === 'CANVAS' || src.includes('qr.weibo.cn') || src.includes('/qrcode/') || src.includes('/inf/gen');
    });
  });
}

async function clickWeiboQrLoginTab(page) {
  return await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const scanLoginText = /\u626b\u7801\u767b\u5f55/;
    const targets = Array.from(document.querySelectorAll('button,a,div,span'))
      .filter((element) => visible(element) && scanLoginText.test((element.innerText || element.textContent || '').trim()))
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return leftRect.width * leftRect.height - rightRect.width * rightRect.height;
      });
    const target = targets[0];
    if (!target) return false;
    target.click();
    return true;
  });
}

async function waitForWeiboQrCode(page, timeoutMs = 10_000) {
  const endAt = Date.now() + timeoutMs;
  while (Date.now() < endAt) {
    if (await hasVisibleWeiboQrCode(page)) return true;
    await page.waitForTimeout(400);
  }
  return await hasVisibleWeiboQrCode(page);
}

async function weiboLoginPageIsWaitingForScan(page) {
  return await page.evaluate(() => {
    const text = document.body?.innerText || '';
    return /\u626b\u63cf\u4e8c\u7ef4\u7801\u767b\u5f55|\u6253\u5f00\u5fae\u535a\u624b\u673aAPP|\u5df2\u626b\u63cf|\u8bf7\u5728\u624b\u673a|\u786e\u8ba4/.test(text);
  });
}

async function openWeiboQrLoginPage(page) {
  const currentUrl = page.url();
  if (!currentUrl.includes('passport.weibo.com/sso/signin')) {
    await page.goto(WEIBO_QR_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }
  await page.waitForTimeout(1200);
  if (await hasVisibleWeiboQrCode(page)) return true;
  if (await weiboLoginPageIsWaitingForScan(page)) return false;

  const clicked = await clickWeiboQrLoginTab(page);
  if (clicked) await page.waitForTimeout(1200);
  return await waitForWeiboQrCode(page, clicked ? 10_000 : 3000);
}

async function takeWeiboLoginScreenshot(page) {
  const clip = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width >= 100 && rect.height >= 100 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const qr = Array.from(document.querySelectorAll('img,canvas')).find((element) => {
      if (!visible(element)) return false;
      const src = element.getAttribute('src') || '';
      return element.tagName === 'CANVAS' || src.includes('qr.weibo.cn') || src.includes('/qrcode/') || src.includes('/inf/gen');
    });
    if (!qr) return null;
    const rect = qr.getBoundingClientRect();
    const x = Math.max(0, Math.floor(rect.x - 110));
    const y = Math.max(0, Math.floor(rect.y - 125));
    const width = Math.min(window.innerWidth - x, Math.ceil(rect.width + 220));
    const height = Math.min(window.innerHeight - y, Math.ceil(rect.height + 220));
    return {
      x,
      y,
      width: Math.max(1, width),
      height: Math.max(1, height),
    };
  });
  if (clip) return await page.screenshot({ type: 'png', clip });
  return await page.screenshot({ type: 'png', fullPage: false });
}

async function cookieHeaderFromBrowserContext(context) {
  const cookies = await context.cookies(['https://weibo.com', 'https://m.weibo.cn', 'https://weibo.cn']);
  const byName = new Map();
  for (const cookie of cookies) {
    const domain = String(cookie.domain || '');
    if (!/weibo\.cn|weibo\.com/.test(domain)) continue;
    if (!cookie.name || !cookie.value) continue;
    byName.set(cookie.name, `${cookie.name}=${cookie.value}`);
  }
  return [...byName.values()].join('; ');
}

async function saveBrowserCookieToPool(context, reason = 'manual', meta = {}) {
  const cookie = cleanCookieHeader(await cookieHeaderFromBrowserContext(context));
  if (!/(?:^|;\s*)SUB=/.test(cookie)) {
    const error = new Error('还没有检测到微博登录 Cookie，请扫码并确认登录。');
    error.status = 400;
    throw error;
  }
  assertCookieHeaderInput(cookie);
  const validation = await checkCookieValidity(cookie);
  if (!validation.ok) {
    const error = new Error(validation.message || '微博登录态校验失败，请重新扫码。');
    error.status = validation.invalid ? 401 : 502;
    throw error;
  }
  const saved = await upsertStoredCookie(cookie, validation);
  const now = new Date().toISOString();
  const message = reason === 'qr-login'
    ? '扫码登录成功，Cookie 已保存到服务器。'
    : '服务器 Cookie 已保活刷新。';
  await appendWeiboLoginEvent({
    at: now,
    status: 'ok',
    reason,
    message,
    durationMs: meta.durationMs,
  }, {
    lastStatus: 'ok',
    lastMessage: message,
    lastLoginAt: reason === 'qr-login' ? now : undefined,
    lastRefreshAt: now,
    lastSuccessAt: now,
    lastError: '',
    lastReason: reason,
  });
  return {
    id: saved.id,
    savedAt: saved.savedAt,
    lastValidAt: saved.lastValidAt,
  };
}

async function closeWeiboLoginSession(message = '扫码窗口已关闭') {
  const session = weiboLoginSession;
  weiboLoginSession = null;
  if (!session) return;
  clearTimeout(session.timer);
  await closePersistentBrowserContext(session.context, weiboLoginProfileDir).catch(() => {});
  await writeWeiboLoginState({
    lastStatus: session.status === 'logged_in' ? 'ok' : 'idle',
    lastMessage: message,
    lastError: session.status === 'error' ? session.error || '' : '',
  }).catch(() => {});
}

async function refreshWeiboLoginSession({ includeScreenshot = true } = {}) {
  const session = weiboLoginSession;
  if (!session) return await publicWeiboLoginState();
  try {
    const saved = await saveBrowserCookieToPool(session.context, 'qr-login');
    session.status = 'logged_in';
    session.message = '扫码登录成功，Cookie 已保存到服务器。';
    session.updatedAt = new Date().toISOString();
    await closeWeiboLoginSession(session.message);
    return await publicWeiboLoginState({ saved });
  } catch (error) {
    if (error.status && error.status !== 400 && error.status !== 401 && !isCookieAuthError(error)) {
      session.status = 'error';
      session.error = safeError(error).message;
      session.message = session.error;
      await writeWeiboLoginState({
        lastStatus: 'error',
        lastMessage: session.message,
        lastError: session.error,
      });
      return await publicWeiboLoginState();
    }
    session.status = 'waiting_scan';
    session.message = '等待你使用微博 App 扫码并确认登录。';
    session.updatedAt = new Date().toISOString();
  }

  let screenshot = '';
  if (includeScreenshot && session.page) {
    try {
      await openWeiboQrLoginPage(session.page);
      const image = await takeWeiboLoginScreenshot(session.page);
      screenshot = `data:image/png;base64,${Buffer.from(image).toString('base64')}`;
    } catch (error) {
      session.message = `二维码截图生成失败：${safeError(error).message}`;
    }
  }
  return await publicWeiboLoginState({ screenshot });
}

async function startWeiboLoginSession() {
  if (weiboLoginSession) return await refreshWeiboLoginSession();
  return await runWeiboBrowserOperation('扫码登录', async () => {
    if (weiboLoginSession) return await refreshWeiboLoginSession();
    const id = crypto.randomUUID();
    const context = await launchWeiboBrowserContext();
    const page = context.pages()[0] || await context.newPage();
    const now = new Date();
    weiboLoginSession = {
      id,
      context,
      page,
      status: 'starting',
      message: '正在打开微博登录页。',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + weiboLoginSessionTtlMs).toISOString(),
      error: '',
      timer: null,
    };
    weiboLoginSession.timer = setTimeout(() => {
      closeWeiboLoginSession('扫码窗口已超时关闭。').catch(() => {});
    }, weiboLoginSessionTtlMs);
    weiboLoginSession.timer.unref?.();

    try {
      await openWeiboQrLoginPage(page);
      weiboLoginSession.status = 'waiting_scan';
      weiboLoginSession.message = '请用微博 App 扫码登录。';
      await writeWeiboLoginState({
        lastStatus: 'waiting_scan',
        lastMessage: weiboLoginSession.message,
        lastError: '',
        lastReason: 'qr-login',
      });
      return await refreshWeiboLoginSession();
    } catch (error) {
      weiboLoginSession.status = 'error';
      weiboLoginSession.error = safeError(error).message;
      weiboLoginSession.message = weiboLoginSession.error;
      await closeWeiboLoginSession(weiboLoginSession.message);
      return await publicWeiboLoginState();
    }
  });
}

async function refreshCookieFromBrowserProfile(reason = 'manual-refresh') {
  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();
  if (weiboKeepaliveRunning) {
    return await publicWeiboLoginState({ message: '微博 Cookie 保活正在运行。' });
  }
  if (weiboLoginSession) {
    return await publicWeiboLoginState({ message: '扫码登录进行中，暂不启动保活。' });
  }
  if (!await pathExists(weiboLoginProfileDir)) {
    const error = new Error('还没有服务器扫码登录记录，请先在后台扫码登录一次。');
    error.status = 400;
    await appendWeiboLoginEvent({
      at: startedAtIso,
      status: 'error',
      reason,
      message: error.message,
      durationMs: Date.now() - startedAt.getTime(),
    }, {
      lastStatus: 'error',
      lastMessage: error.message,
      lastAttemptAt: startedAtIso,
      lastFailureAt: startedAtIso,
      lastError: error.message,
      lastReason: reason,
    });
    if (reason === 'scheduled-refresh') return await publicWeiboLoginState();
    throw error;
  }

  if (weiboBrowserOperation) {
    return await publicWeiboLoginState({ message: `微博浏览器正在执行${weiboBrowserOperation.label}，本次保活已跳过。` });
  }

  return await runWeiboBrowserOperation('Cookie 保活', async () => {
    weiboKeepaliveRunning = true;
    await collectSystemSample(`${reason}:before`).catch(() => {});
    await appendWeiboLoginEvent({
      at: startedAtIso,
      status: 'refreshing',
      reason,
      message: '正在打开微博页面刷新服务器登录态。',
    }, {
      lastStatus: 'refreshing',
      lastMessage: '正在打开微博页面刷新服务器登录态。',
      lastAttemptAt: startedAtIso,
      lastError: '',
      lastReason: reason,
    });
    let context;
    try {
      context = await launchWeiboBrowserContext();
      weiboKeepaliveContext = context;
      const page = context.pages()[0] || await context.newPage();
      await page.goto('https://weibo.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(2500);
      const saved = await saveBrowserCookieToPool(context, reason, { durationMs: Date.now() - startedAt.getTime() });
      await writeWeiboLoginState({
        lastStatus: 'ok',
        lastMessage: '服务器 Cookie 已保活刷新。',
        lastError: '',
        lastReason: reason,
      });
      return await publicWeiboLoginState({ saved });
    } catch (error) {
      const normalized = safeError(error);
      const failedAt = new Date().toISOString();
      await appendWeiboLoginEvent({
        at: failedAt,
        status: 'error',
        reason,
        message: normalized.message,
        durationMs: Date.now() - startedAt.getTime(),
      }, {
        lastStatus: 'error',
        lastMessage: normalized.message,
        lastAttemptAt: startedAtIso,
        lastFailureAt: failedAt,
        lastError: normalized.message,
        lastReason: reason,
      });
      console.warn(`Weibo keepalive failed (${reason}): ${normalized.message}`);
      if (reason === 'scheduled-refresh') return await publicWeiboLoginState();
      const wrapped = new Error(normalized.message);
      wrapped.status = normalized.status;
      throw wrapped;
    } finally {
      if (context) {
        const cleanup = await closePersistentBrowserContext(
          context,
          weiboLoginProfileDir,
        ).catch(() => null);
        if (cleanup?.closeTimedOut || cleanup?.stoppedPids.length) {
          console.warn(
            `Cleaned ${cleanup.stoppedPids.length} remaining Weibo browser process(es) after keepalive.`,
          );
        }
      }
      weiboKeepaliveContext = null;
      weiboKeepaliveRunning = false;
      await collectSystemSample(`${reason}:after`).catch(() => {});
      scheduleWeiboKeepalive();
    }
  });
}

function scheduleWeiboKeepalive() {
  if (!enableWeiboKeepalive || shutdownStarted) return;
  clearTimeout(weiboKeepaliveTimer);
  weiboKeepaliveTimer = null;

  Promise.resolve()
    .then(async () => {
      let delayMs = weiboKeepaliveStartupDelayMs;
      try {
        const state = await readWeiboLoginState();
        const nextAt = nextWeiboKeepaliveAt(state);
        if (nextAt) delayMs = Math.max(1000, Date.parse(nextAt) - Date.now());
      } catch (error) {
        console.warn(`Weibo keepalive schedule check failed: ${safeError(error).message}`);
      }
      const maxTimerDelay = 2_147_000_000;
      weiboKeepaliveTimer = setTimeout(async () => {
        try {
          await refreshCookieFromBrowserProfile('scheduled-refresh');
        } catch (error) {
          console.warn(`Weibo keepalive timer failed: ${safeError(error).message}`);
        } finally {
          scheduleWeiboKeepalive();
        }
      }, Math.min(maxTimerDelay, delayMs));
      weiboKeepaliveTimer.unref?.();
    })
    .catch((error) => {
      console.warn(`Weibo keepalive scheduler failed: ${safeError(error).message}`);
    });
}

async function prepareCookieCandidates(body, reportProgress, { allowCookieStoreWrite = false } = {}) {
  const failures = [];
  const warnings = [];
  const supplied = cleanCookieHeader(body.mobileCookie);

  if (supplied) {
    assertCookieHeaderInput(supplied);
    reportProgress?.({ phase: 'cookie-check', percent: 1, message: '校验本次输入的微博 Cookie' });
    const validation = await checkCookieValidity(supplied);
    if (!validation.ok) {
      const error = new Error(`输入的 Cookie 无效：${validation.message}`);
      error.status = validation.invalid ? 401 : 502;
      throw error;
    }
    const now = new Date().toISOString();
    const transient = {
      id: cookieFingerprint(supplied),
      cookie: supplied,
      transient: true,
      savedAt: now,
      updatedAt: now,
      lastCheckedAt: validation.checkedAt || now,
      lastValidAt: validation.lastValidAt || '',
      lastError: '',
    };
    warnings.push('本次 Cookie 仅用于当前抓取请求，未写入服务器 Cookie 池。');
    return {
      candidates: [transient],
      failures,
      warnings,
      summary: {
        hasCookie: true,
        cookieCount: 1,
        accountCount: 1,
        removedCount: 0,
      },
    };
  }

  const store = allowCookieStoreWrite
    ? null
    : await readCookieStore();
  const summary = allowCookieStoreWrite
    ? await validateStoredCookies(reportProgress)
    : cookieStoreSummary(store, { checkSkipped: Boolean(cookieWriteKey) });
  if (disableCookieStore) {
    return {
      candidates: [],
      failures,
      warnings,
      summary: {
        ...summary,
        hasCookie: false,
        cookieCount: 0,
      },
    };
  }
  const currentStore = store || await readCookieStore();
  const candidates = sortCookieEntries(currentStore.cookies, currentStore.activeId);
  return { candidates, failures, warnings, summary };
}

async function fetchCookieRepostsWithPool({ statusId, body, reportProgress, allowCookieStoreWrite = false }) {
  const { candidates, failures, warnings, summary } = await prepareCookieCandidates(body, reportProgress, { allowCookieStoreWrite });
  if (!candidates.length) {
    const detail = failures.length ? `；${failures.join('；')}` : '';
    const error = new Error(`未填写用户 Cookie，服务器端也没有可用微博 Cookie${detail}`);
    error.status = 400;
    throw error;
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const entry = candidates[index];
    reportProgress?.({
      phase: 'cookie',
      percent: 8,
      message: entry.transient
        ? '使用本次输入的 Cookie'
        : `使用服务器 Cookie 池：${index + 1}/${candidates.length}`,
    });

    try {
      const result = await fetchCookieReposts({ statusId, mobileCookie: entry.cookie, reportProgress });
      if (!entry.transient && allowCookieStoreWrite) {
        await upsertStoredCookie(entry.cookie, {
          ok: true,
          checkedAt: new Date().toISOString(),
          lastValidAt: new Date().toISOString(),
        });
      }
      result.meta = {
        ...result.meta,
        cookiePool: {
          usedId: entry.id,
          cookieCount: summary.cookieCount,
          removedCount: summary.removedCount || 0,
          source: entry.transient ? 'user-input' : 'server-pool',
        },
        warnings: [
          ...(failures.length ? failures : []),
          ...(warnings.length ? warnings : []),
          ...(result.meta?.warnings || []),
        ],
      };
      return result;
    } catch (error) {
      failures.push(`${entry.transient ? '输入的 Cookie' : `服务器 Cookie ${index + 1}`}不可用：${error.message}`);
      if (isCookieAuthError(error)) {
        if (!entry.transient && allowCookieStoreWrite) await removeStoredCookie(entry.id);
        continue;
      }
      if (index === candidates.length - 1) throw error;
    }
  }

  const error = new Error(failures.join('；') || '服务器端 Cookie 池没有可用 Cookie');
  error.status = 401;
  throw error;
}

function xsrfTokenFromCookie(cookie) {
  const match = cleanCookieHeader(cookie).match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

// Repost collection

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function fetchJson(url, options = {}) {
  const { headers = {}, signal, onThrottle, ...rest } = options;
  let response;
  try {
    response = await fetchWeiboResponse(url, {
      ...rest,
      signal,
      onThrottle,
      headers: {
        accept: 'application/json, text/plain, */*',
        ...headers,
      },
    });
  } catch (error) {
    const wrapped = new Error(`请求微博接口失败或超时：${error.message}`);
    wrapped.status = error.name === 'TimeoutError' || error.name === 'AbortError' ? 504 : 502;
    throw wrapped;
  }
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxWeiboResponseBytes) {
    await response.body?.cancel().catch(() => {});
    const error = new Error('微博接口返回内容过大');
    error.status = 502;
    throw error;
  }
  const text = (await readResponseBuffer(response, maxWeiboResponseBytes, '微博接口返回内容过大')).toString('utf8');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const visitorSystem = /Sina Visitor System|passport\.sina|visitor/i.test(text);
    const error = new Error(
      visitorSystem
        ? '微博返回访客系统页面，当前 H5 Cookie 不可用或已过期；请更新 Cookie 后重试，或改用手动导入名单'
        : `返回内容不是 JSON：${text.slice(0, 120)}`,
    );
    error.status = response.status || 502;
    throw error;
  }

  if (!response.ok || json.error || json.error_code) {
    const error = new Error(json.error || json.msg || `微博接口返回 ${response.status}`);
    error.status = response.status || 502;
    error.weibo = {
      errorCode: json.error_code,
      request: json.request,
    };
    throw error;
  }
  return json;
}

async function fetchText(url, options = {}) {
  const { headers = {}, signal, onThrottle, ...rest } = options;
  let response;
  try {
    response = await fetchWeiboResponse(url, {
      ...rest,
      signal,
      onThrottle,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...headers,
      },
    });
  } catch (error) {
    const wrapped = new Error(`请求微博页面失败或超时：${error.message}`);
    wrapped.status = error.name === 'TimeoutError' || error.name === 'AbortError' ? 504 : 502;
    throw wrapped;
  }
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxWeiboResponseBytes) {
    await response.body?.cancel().catch(() => {});
    const error = new Error('微博页面返回内容过大');
    error.status = 502;
    throw error;
  }
  const text = (await readResponseBuffer(response, maxWeiboResponseBytes, '微博页面返回内容过大')).toString('utf8');
  if (!response.ok) {
    const error = new Error(`微博页面返回 ${response.status}`);
    error.status = response.status || 502;
    throw error;
  }
  return text;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWeiboResponse(url, options = {}) {
  const { signal: configuredSignal, onThrottle, ...requestOptions } = options;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      ...requestOptions,
      signal: configuredSignal || AbortSignal.timeout(fetchTimeoutMs),
    });
    if (!isWeiboThrottleStatus(response.status) || attempt >= weiboThrottleRetryMax) {
      return response;
    }

    const delayMs = throttleRetryDelayMs({
      retryAfter: response.headers.get('retry-after'),
      attempt,
      baseMs: weiboThrottleBackoffMs,
      maxMs: weiboThrottleMaxWaitMs,
    });
    await response.body?.cancel().catch(() => {});
    onThrottle?.({
      status: response.status,
      delayMs,
      attempt: attempt + 1,
      maxAttempts: weiboThrottleRetryMax,
    });
    await sleepWithJitter(delayMs, Math.min(pageDelayJitterMs, 1000));
  }
}

async function sleepWithJitter(baseMs, jitterMs = pageDelayJitterMs) {
  const base = Math.max(0, finiteNumber(baseMs, 0));
  const jitter = Math.max(0, finiteNumber(jitterMs, 0));
  const offset = jitter ? Math.floor(Math.random() * jitter) : 0;
  if (base || offset) await sleep(base + offset);
}

function throttleProgress(reportProgress, label) {
  return ({ status, delayMs, attempt, maxAttempts }) => reportProgress?.({
    phase: 'wait',
    message: `${label}返回 ${status}，等待 ${Math.ceil(delayMs / 1000)} 秒后重试（${attempt}/${maxAttempts}）`,
  });
}

async function waitBetweenPages(label, delayMs, reportProgress, page) {
  const plan = pageWaitPlan({
    page,
    baseMs: delayMs,
    jitterMs: pageDelayJitterMs,
    cooldownEvery: pageCooldownEvery,
    cooldownMs: pageCooldownMs,
  });
  if (!plan.delayMs) return;
  reportProgress?.({
    phase: 'wait',
    message: plan.cooldownMs
      ? `${label}：已读取 ${page} 页，冷却 ${Math.ceil(plan.delayMs / 1000)} 秒后继续`
      : `${label}：等待 ${Math.ceil(plan.delayMs / 1000)} 秒后读取下一页`,
  });
  await sleep(plan.delayMs);
}

function cookieRequired(mobileCookie) {
  const cookie = cleanCookieHeader(mobileCookie);
  if (!cookie) {
    const error = new Error('H5 Cookie 模式需要在页面输入微博 Cookie');
    error.status = 400;
    throw error;
  }
  assertCookieHeaderInput(cookie);
  return cookie;
}

function desktopHeaders(cookie, referer = 'https://weibo.com/') {
  const xsrfToken = xsrfTokenFromCookie(cookie);
  return {
    'user-agent': DESKTOP_UA,
    'accept-language': 'zh-CN,zh;q=0.9',
    referer,
    origin: 'https://weibo.com',
    'x-requested-with': 'XMLHttpRequest',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    ...(cookie ? { cookie } : {}),
    ...(xsrfToken ? { 'x-xsrf-token': xsrfToken } : {}),
  };
}

function mobileHeaders(cookie, statusId) {
  const xsrfToken = xsrfTokenFromCookie(cookie);
  return {
    'user-agent': MOBILE_UA,
    'accept-language': 'zh-CN,zh;q=0.9',
    referer: `https://m.weibo.cn/detail/${statusId}`,
    'x-requested-with': 'XMLHttpRequest',
    ...(cookie ? { cookie } : {}),
    ...(xsrfToken ? { 'x-xsrf-token': xsrfToken } : {}),
  };
}

function legacyHeaders(cookie, referer = 'https://weibo.cn/') {
  return {
    'user-agent': MOBILE_UA,
    'accept-language': 'zh-CN,zh;q=0.9',
    referer,
    ...(cookie ? { cookie } : {}),
  };
}

function reportPageProgress(reportProgress, { phase, label, start, end, page, totalPages, count }) {
  if (!reportProgress) return;
  const total = Math.max(1, finiteNumber(totalPages, page || 1));
  const ratio = Math.min(1, Math.max(0, (page || 0) / total));
  const percent = Math.round(start + (end - start) * ratio);
  reportProgress({
    phase,
    percent,
    message: `${label}：第 ${page || 0}/${total} 页，本页 ${count ?? 0} 条`,
  });
}

async function fetchOfficialReposts({ statusId, accessToken, reportProgress }) {
  const token = String(accessToken || '').trim();
  if (!token) {
    const error = new Error('官方接口需要在页面输入本次使用的访问凭据');
    error.status = 400;
    throw error;
  }

  const candidates = [];
  const pages = [];
  let totalNumber = null;
  let hitPageCap = false;
  let hitCandidateCap = false;

  for (let page = 1; page <= OFFICIAL_MAX_PAGES; page += 1) {
    const apiUrl = new URL('https://api.weibo.com/2/statuses/repost_timeline.json');
    apiUrl.searchParams.set('id', statusId);
    apiUrl.searchParams.set('access_token', token);
    apiUrl.searchParams.set('count', String(OFFICIAL_PAGE_SIZE));
    apiUrl.searchParams.set('page', String(page));

    const json = await fetchJson(apiUrl, {
      onThrottle: throttleProgress(reportProgress, '官方接口'),
    });
    const list = Array.isArray(json.reposts) ? json.reposts : [];
    totalNumber = Number.isFinite(Number(json.total_number)) ? Number(json.total_number) : totalNumber;
    pages.push({ page, count: list.length });
    hitCandidateCap = appendNormalizedCandidates(candidates, list, 'official');
    if (hitCandidateCap) break;
    if (totalNumber !== null && candidates.length >= totalNumber) break;
    if (list.length < OFFICIAL_PAGE_SIZE) break;
    if (page === OFFICIAL_MAX_PAGES) hitPageCap = true;
    await waitBetweenPages('官方接口', officialPageDelayMs, reportProgress, page);
  }

  const unique = uniqueCandidates(candidates);
  return {
    candidates: unique,
    meta: {
      provider: 'official',
      pages,
      totalNumber,
      pageSize: OFFICIAL_PAGE_SIZE,
      complete: !hitPageCap && !hitCandidateCap && (totalNumber === null || unique.length >= totalNumber || pages.at(-1)?.count < OFFICIAL_PAGE_SIZE),
      warnings: [
        '已自动分页抓取全部可见转发；官方开放接口的配额和可见范围以账号权限为准。',
        ...(hitPageCap ? [`为避免异常长任务，本次在 ${OFFICIAL_MAX_PAGES} 页后停止。`] : []),
        ...(hitCandidateCap ? [`为控制服务器资源，本次最多载入 ${maxCandidates} 位候选。`] : []),
      ],
    },
  };
}

function desktopTimelineList(json) {
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.data?.data)) return json.data.data;
  if (Array.isArray(json?.reposts)) return json.reposts;
  return [];
}

async function fetchDesktopStatusInfo({ statusId, cookie }) {
  const apiUrl = new URL('https://weibo.com/ajax/statuses/show');
  apiUrl.searchParams.set('id', statusId);
  const json = await fetchJson(apiUrl, {
    headers: desktopHeaders(cookie, `https://weibo.com/detail/${statusId}`),
  });
  const uid = String(json?.user?.idstr || json?.user?.id || '').trim();
  const bid = String(json?.mblogid || '').trim();
  return {
    id: String(json?.idstr || json?.id || json?.mid || statusId).trim(),
    mid: String(json?.mid || json?.idstr || json?.id || statusId).trim(),
    bid,
    uid,
    referer: uid && bid ? `https://weibo.com/${uid}/${bid}` : `https://weibo.com/detail/${statusId}`,
    repostsCount: finiteNumber(json?.reposts_count),
  };
}

async function fetchDesktopReposts({ statusId, cookie, statusInfo: initialStatusInfo, reportProgress }) {
  const candidates = [];
  const pages = [];
  let totalNumber = null;
  let maxPage = null;
  let hitPageCap = false;
  let hitCandidateCap = false;
  let statusInfo = null;

  try {
    reportProgress?.({ phase: 'desktop', percent: 4, message: '读取微博正文信息' });
    statusInfo = initialStatusInfo || await fetchDesktopStatusInfo({ statusId, cookie });
    totalNumber = statusInfo.repostsCount;
  } catch {
    statusInfo = {
      id: statusId,
      mid: statusId,
      bid: '',
      uid: '',
      referer: `https://weibo.com/detail/${statusId}`,
      repostsCount: null,
    };
  }

  const timelineId = statusInfo.id || statusId;
  for (let page = 1; page <= DESKTOP_MAX_PAGES; page += 1) {
    const apiUrl = new URL('https://weibo.com/ajax/statuses/repostTimeline');
    apiUrl.searchParams.set('id', timelineId);
    apiUrl.searchParams.set('page', String(page));
    apiUrl.searchParams.set('moduleID', 'feed');
    apiUrl.searchParams.set('count', String(page === 1 ? DESKTOP_FIRST_PAGE_SIZE : DESKTOP_PAGE_SIZE));

    const json = await fetchJson(apiUrl, {
      headers: desktopHeaders(cookie, statusInfo.referer),
      onThrottle: throttleProgress(reportProgress, '桌面端接口'),
    });
    const list = desktopTimelineList(json);
    const advertisedMax = finiteNumber(json?.max_page);
    if (advertisedMax) maxPage = Math.max(maxPage || 0, advertisedMax);
    totalNumber = finiteNumber(json?.total_number, totalNumber);
    pages.push({
      source: 'desktop',
      page,
      count: list.length,
      maxPage,
      nextCursor: json?.next_cursor || 0,
    });
    hitCandidateCap = appendNormalizedCandidates(candidates, list, 'desktop-cookie');
    reportPageProgress(reportProgress, {
      phase: 'desktop',
      label: '桌面端接口',
      start: 5,
      end: 95,
      page,
      totalPages: maxPage || page,
      count: list.length,
    });

    if (hitCandidateCap) break;
    if (!maxPage && list.length === 0) break;
    if (maxPage && page >= maxPage) break;
    if (page === DESKTOP_MAX_PAGES) hitPageCap = true;
    await waitBetweenPages('桌面端接口', desktopPageDelayMs, reportProgress, page);
  }

  return {
    candidates: uniqueByRepostId(candidates),
    meta: {
      provider: 'desktop-cookie',
      pages,
      totalNumber,
      maxPage,
      statusInfo,
      complete: !hitPageCap && !hitCandidateCap,
      warnings: [
        '已按桌面端微博页面脚本的方式请求 ajax/statuses/repostTimeline，并扫描接口声明的页数范围。',
        ...(hitPageCap ? [`为避免异常长任务，桌面端在 ${DESKTOP_MAX_PAGES} 页后停止。`] : []),
        ...(hitCandidateCap ? [`为控制服务器资源，本次最多载入 ${maxCandidates} 位候选。`] : []),
      ],
    },
  };
}

function mobileTimelineList(json) {
  const data = json?.data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.reposts)) return data.reposts;
  if (Array.isArray(data?.cards)) return data.cards.flatMap((card) => card.card_group || card.mblog || card);
  if (Array.isArray(json?.reposts)) return json.reposts;
  return [];
}

function legacyDivs(html) {
  return [...String(html || '').matchAll(/<div class="c"[^>]*>([\s\S]*?)<\/div>/g)].map((match) => match[0]);
}

function legacyMaxPage(html) {
  const mpInput = String(html || '').match(/<input[^>]*name="mp"[^>]*>/)?.[0] || '';
  const mpMatch = mpInput.match(/value="(\d+)"/);
  if (mpMatch) return finiteNumber(mpMatch[1]);
  const pageLinks = [...String(html || '').matchAll(/[?&]page=(\d+)/g)].map((match) => finiteNumber(match[1], 0));
  return pageLinks.length ? Math.max(...pageLinks) : null;
}

function legacyTimelineList(html, page) {
  const praisePattern = /\u8d5e\[\d+\]/;
  return legacyDivs(html)
    .map((div) => ({ html: div, text: stripLegacyHtml(div) }))
    .filter((item) => praisePattern.test(item.text))
    .map((item, index) => {
      const anchors = [...item.html.matchAll(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((match) => ({
        href: match[1],
        text: stripLegacyHtml(match[2]),
      }));
      const userAnchor = anchors.find((anchor) => /(?:\/u\/|weibo\.cn\/|^\/)\d+/.test(anchor.href));
      const uid = userAnchor?.href.match(/(?:\/u\/|weibo\.cn\/|^\/)(\d+)/)?.[1] || '';
      const screenName = userAnchor?.text || item.text.split(':')[0] || '未命名用户';
      const createdAt = item.text.match(/\d{2}月\d{2}日\s+\d{2}:\d{2}|[\d:]+分钟前|昨天\s+\d{2}:\d{2}/)?.[0] || '';
      const text = item.text.replace(/^\[热门\]\s*/, '').replace(new RegExp(`^${escapeRegExp(screenName)}\\s*:?\\s*`), '').trim();
      return {
        idstr: `weibo-cn-${page}-${index}-${uid || crypto.createHash('sha1').update(item.text).digest('hex').slice(0, 10)}`,
        text,
        created_at: createdAt,
        user: {
          idstr: uid,
          screen_name: screenName,
        },
      };
    });
}

async function fetchLegacyReposts({ statusId, cookie, statusInfo, reportProgress }) {
  const info = statusInfo || await fetchDesktopStatusInfo({ statusId, cookie });
  if (!info.bid || !info.uid) {
    return {
      candidates: [],
      meta: {
        provider: 'weibo-cn',
        pages: [],
        totalNumber: info.repostsCount,
        complete: true,
        warnings: ['旧版 weibo.cn 页面缺少 bid 或 uid，已跳过。'],
      },
    };
  }

  const candidates = [];
  const pages = [];
  let totalNumber = info.repostsCount;
  let maxPage = null;
  let hitPageCap = false;
  let hitCandidateCap = false;

  for (let page = 1; page <= LEGACY_MAX_PAGES; page += 1) {
    const apiUrl = new URL(`https://weibo.cn/repost/${info.bid}`);
    apiUrl.searchParams.set('uid', info.uid);
    apiUrl.searchParams.set('rl', '1');
    apiUrl.searchParams.set('page', String(page));
    const html = await fetchText(apiUrl, {
      headers: legacyHeaders(cookie, `https://weibo.cn/${info.uid}/${info.bid}`),
      onThrottle: throttleProgress(reportProgress, '旧版页面'),
    });
    const list = legacyTimelineList(html, page);
    const advertisedMax = legacyMaxPage(html);
    if (advertisedMax) maxPage = Math.max(maxPage || 0, advertisedMax);
    pages.push({
      source: 'weibo-cn',
      page,
      count: list.length,
      maxPage,
    });
    hitCandidateCap = appendNormalizedCandidates(candidates, list, 'weibo-cn');
    reportPageProgress(reportProgress, {
      phase: 'weibo-cn',
      label: '旧版页面',
      start: 32,
      end: 63,
      page,
      totalPages: maxPage || page,
      count: list.length,
    });

    if (hitCandidateCap) break;
    if (!maxPage && list.length === 0) break;
    if (maxPage && page >= maxPage) break;
    if (page === LEGACY_MAX_PAGES) hitPageCap = true;
    await waitBetweenPages('旧版页面', legacyPageDelayMs, reportProgress, page);
  }

  return {
    candidates: uniqueByRepostId(candidates),
    meta: {
      provider: 'weibo-cn',
      pages,
      totalNumber,
      maxPage,
      complete: !hitPageCap && !hitCandidateCap,
      warnings: [
        '已补扫旧版 weibo.cn 转发页面；该页面必须使用 bid/mblogid，纯数字 mid 会返回目标不存在。',
        ...(hitPageCap ? [`为避免异常长任务，旧版页面在 ${LEGACY_MAX_PAGES} 页后停止。`] : []),
        ...(hitCandidateCap ? [`为控制服务器资源，本次最多载入 ${maxCandidates} 位候选。`] : []),
      ],
    },
  };
}

async function fetchMobileReposts({ statusId, mobileCookie, reportProgress }) {
  const candidates = [];
  const pages = [];
  let hitPageCap = false;
  let hitCandidateCap = false;
  const cookie = cookieRequired(mobileCookie);
  let totalNumber = null;
  let maxPage = null;

  for (let page = 1; page <= MOBILE_MAX_PAGES; page += 1) {
    const apiUrl = new URL('https://m.weibo.cn/api/statuses/repostTimeline');
    apiUrl.searchParams.set('id', statusId);
    apiUrl.searchParams.set('page', String(page));

    const json = await fetchJson(apiUrl, {
      headers: mobileHeaders(cookie, statusId),
      onThrottle: throttleProgress(reportProgress, 'H5 接口'),
    });
    const list = mobileTimelineList(json);
    const advertisedMax = finiteNumber(json?.data?.max || json?.max);
    if (advertisedMax) maxPage = Math.max(maxPage || 0, advertisedMax);
    totalNumber = finiteNumber(json?.data?.total_number || json?.total_number, totalNumber);
    pages.push({
      source: 'mobile',
      page,
      count: list.length,
      maxPage,
      ok: json?.ok,
      msg: json?.msg || '',
    });
    hitCandidateCap = appendNormalizedCandidates(candidates, list, 'mobile');
    reportPageProgress(reportProgress, {
      phase: 'mobile',
      label: 'H5 接口',
      start: 64,
      end: 95,
      page,
      totalPages: maxPage || page,
      count: list.length,
    });
    if (hitCandidateCap) break;
    if (!maxPage && list.length === 0) break;
    if (maxPage && page >= maxPage) break;
    if (page === MOBILE_MAX_PAGES) hitPageCap = true;
    await waitBetweenPages('H5 接口', mobilePageDelayMs, reportProgress, page);
  }

  const unique = uniqueCandidates(candidates);
  return {
    candidates: uniqueByRepostId(unique),
    meta: {
      provider: 'mobile',
      pages,
      totalNumber,
      maxPage,
      complete: !hitPageCap && !hitCandidateCap,
      cookieMode: Boolean(cookie),
      warnings: [
        '已按 H5 接口返回的页数范围扫描可见转发。',
        ...(hitPageCap ? [`为避免异常长任务，本次在 ${MOBILE_MAX_PAGES} 页后停止。`] : []),
        ...(hitCandidateCap ? [`为控制服务器资源，本次最多载入 ${maxCandidates} 位候选。`] : []),
      ],
    },
  };
}

async function fetchCookieReposts({ statusId, mobileCookie, reportProgress }) {
  const cookie = cookieRequired(mobileCookie);
  const warnings = [];
  const results = [];
  let statusInfo = null;

  try {
    reportProgress?.({ phase: 'status', percent: 2, message: '识别微博 mid / bid' });
    statusInfo = await fetchDesktopStatusInfo({ statusId, cookie });
  } catch (error) {
    warnings.push(`微博正文信息读取失败：${error.message}`);
  }

  const providerPlan = [
    ['desktop', () => fetchDesktopReposts({ statusId, cookie, statusInfo, reportProgress })],
    ['mobile', () => fetchMobileReposts({ statusId, mobileCookie: cookie, reportProgress })],
    ['legacy', () => fetchLegacyReposts({ statusId, cookie, statusInfo, reportProgress })],
  ];

  for (const [label, fetcher] of providerPlan) {
    try {
      const result = await fetcher();
      const totalNumber = finiteNumber(result.meta?.totalNumber);
      const hasVisibleCandidates = result.candidates.length > 0;
      const looksEmpty = !hasVisibleCandidates && totalNumber !== 0;
      results.push(result);
      if (!looksEmpty) break;
      warnings.push(`${label === 'desktop' ? '桌面端' : label === 'mobile' ? 'H5' : '旧版页面'}没有拿到可见记录，已自动尝试备用入口。`);
    } catch (error) {
      const labelText = label === 'desktop' ? '桌面端' : label === 'legacy' ? '旧版页面' : 'H5';
      warnings.push(`${labelText}抓取失败：${error.message}`);
      continue;
    }
  }

  if (!results.length) {
    const error = new Error(warnings.join('；') || 'Cookie 抓取失败');
    error.status = 502;
    throw error;
  }

  const rawCandidates = results.flatMap((result) => result.candidates);
  const candidates = uniqueCandidates(rawCandidates);
  const pages = results.flatMap((result) => result.meta?.pages || []);
  const totalNumber = results.reduce((max, result) => {
    const value = finiteNumber(result.meta?.totalNumber);
    return value === null ? max : Math.max(max || 0, value);
  }, null);
  const completeByCount = totalNumber === null || candidates.length >= totalNumber;
  const sourceWarnings = results.flatMap((result) => result.meta?.warnings || []);
  const visibilityWarning = totalNumber !== null && candidates.length < totalNumber
    ? `微博接口显示总转发约 ${totalNumber} 条，本次只拿到 ${candidates.length} 条可见可抽记录；差额通常来自隐藏、删除、不可见用户或接口风控。`
    : '';

  return {
    candidates,
    meta: {
      provider: 'cookie',
      providers: results.map((result) => result.meta?.provider).filter(Boolean),
      pages,
      totalNumber,
      visibleNumber: candidates.length,
      rawVisibleNumber: rawCandidates.length,
      statusInfo,
      complete: results.every((result) => result.meta?.complete !== false) && completeByCount,
      cookieMode: true,
      warnings: [
        '已优先使用桌面端可见转发入口，并在需要时尝试备用入口。',
        ...warnings,
        visibilityWarning,
        ...sourceWarnings,
      ].filter(Boolean),
    },
  };
}

async function buildRepostsPayload(body, reportProgress) {
  const source = String(body.source || 'official');
  const statusId = extractStatusId(body.statusUrl || body.statusId);
  if (!statusId) {
    const error = new Error('请输入微博链接、mid 或 bid');
    error.status = 400;
    throw error;
  }

  const startedAt = Date.now();
  reportProgress?.({ phase: 'start', percent: 1, message: '准备抓取微博转发列表' });

  let result;
  if (source === 'official') {
    result = await fetchOfficialReposts({
      statusId,
      accessToken: body.accessToken,
      reportProgress,
    });
  } else if (source === 'mobile') {
    result = await fetchCookieRepostsWithPool({
      statusId,
      body,
      reportProgress,
      allowCookieStoreWrite: body.allowCookieStoreWrite === true,
    });
  } else {
    const error = new Error('未知数据源');
    error.status = 400;
    throw error;
  }

  const drawStats = await getDrawCountForStatus(statusId);
  reportProgress?.({ phase: 'done', percent: 100, message: `抓取完成：${result.candidates.length} 条记录` });
  return {
    ok: true,
    statusId,
    statusUrl: normalizeStatusUrl(body.statusUrl, statusId),
    drawCount: drawStats.count,
    lastDrawnAt: drawStats.lastDrawnAt,
    elapsedMs: Date.now() - startedAt,
    candidates: result.candidates,
    meta: {
      ...result.meta,
      statusId,
      statusUrl: normalizeStatusUrl(body.statusUrl, statusId),
    },
  };
}

// Jobs and draw API

async function runWithStatusLock(statusId, task) {
  const key = String(statusId || '').trim();
  if (!key) return await task();
  const hadPrevious = statusLocks.has(key);
  const previous = statusLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const chained = previous.catch(() => {}).then(() => current);
  statusLocks.set(key, chained);
  try {
    await previous.catch(() => {});
    if (hadPrevious && sameStatusRequestGapMs) await sleepWithJitter(sameStatusRequestGapMs, Math.min(pageDelayJitterMs, 500));
    return await task();
  } finally {
    release();
    if (statusLocks.get(key) === chained) statusLocks.delete(key);
  }
}

function createJob() {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
    startedAt: '',
    finishedAt: '',
    progress: {
      phase: 'queued',
      percent: 0,
      message: '排队中',
    },
    result: null,
    error: null,
    cleanupTimer: null,
  };
  jobs.set(id, job);
  return job;
}

function expireJobLater(job) {
  clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => {
    jobs.delete(job.id);
    job.body = null;
    job.result = null;
  }, jobTtlMs);
  job.cleanupTimer.unref?.();
}

function activeJobCount() {
  return Array.from(jobs.values()).filter((job) => job.status === 'running').length;
}

function queuedJobCount() {
  return jobQueue.filter((job) => job.status === 'queued').length;
}

function jobQueuePosition(job) {
  return jobQueue.findIndex((item) => item.id === job.id) + 1;
}

function updateQueuedProgress() {
  for (let index = 0; index < jobQueue.length; index += 1) {
    const job = jobQueue[index];
    if (job.status !== 'queued') continue;
    job.progress = {
      phase: 'queued',
      percent: 0,
      message: `排队中：前面还有 ${index} 个任务`,
    };
    job.updatedAt = new Date().toISOString();
  }
}

function runRepostsJob(job) {
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.updatedAt = job.startedAt;
  job.progress = { phase: 'start', percent: 1, message: '准备抓取微博转发列表' };
  const statusId = extractStatusId(job.body.statusUrl || job.body.statusId);

  runWithStatusLock(statusId, () => buildRepostsPayload(job.body, (progress) => {
    job.progress = {
      ...job.progress,
      ...progress,
      percent: Math.max(0, Math.min(100, finiteNumber(progress.percent, job.progress.percent))),
    };
    job.updatedAt = new Date().toISOString();
  }))
    .then((result) => {
      job.status = 'done';
      job.result = result;
      job.progress = { phase: 'done', percent: 100, message: `抓取完成：${result.candidates.length} 条记录` };
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
    })
    .catch((error) => {
      job.status = 'error';
      job.error = safeError(error).message;
      job.progress = { phase: 'error', percent: 100, message: job.error };
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
    })
    .finally(() => {
      if (job.body) {
        job.body.mobileCookie = '';
        job.body.accessToken = '';
      }
      expireJobLater(job);
      drainJobQueue();
    });
}

function drainJobQueue() {
  updateQueuedProgress();
  while (activeJobCount() < maxActiveJobs && jobQueue.length) {
    const job = jobQueue.shift();
    if (!job || job.status !== 'queued') continue;
    runRepostsJob(job);
  }
  updateQueuedProgress();
}

function enqueueRepostsJob(job, body) {
  job.body = body;
  jobQueue.push(job);
  updateQueuedProgress();
  drainJobQueue();
}

async function handleStartRepostsJob(req, res) {
  if (queuedJobCount() >= maxQueuedJobs) {
    return sendJson(res, 429, {
      ok: false,
      error: `当前抓取队列已满，请稍后再试（MAX_QUEUED_JOBS=${maxQueuedJobs}）`,
    });
  }
  const body = await readJsonBody(req, maxRepostJobBodyBytes);
  body.allowCookieStoreWrite = canWriteCookieStore(req);
  const job = createJob();
  enqueueRepostsJob(job, body);
  sendJson(res, 202, {
    ok: true,
    jobId: job.id,
    status: job.status,
    queue: {
      position: job.status === 'queued' ? jobQueuePosition(job) : 0,
      active: activeJobCount(),
      queued: queuedJobCount(),
      maxActive: maxActiveJobs,
      maxQueued: maxQueuedJobs,
    },
    progress: job.progress,
  });
}

async function handleGetRepostsJob(_req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    return sendJson(res, 404, { ok: false, error: '任务不存在或已过期' });
  }
  return sendJson(res, 200, {
    ok: true,
    jobId: job.id,
    status: job.status,
    queue: {
      position: job.status === 'queued' ? jobQueuePosition(job) : 0,
      active: activeJobCount(),
      queued: queuedJobCount(),
      maxActive: maxActiveJobs,
      maxQueued: maxQueuedJobs,
    },
    progress: job.progress,
    result: job.result,
    error: job.error,
  });
}

async function handleCookieStatus(req, res, url) {
  const shouldCheck = url.searchParams.get('check') === '1';
  const canCheck = !shouldCheck || canWriteCookieStore(req);
  const summary = shouldCheck && canCheck
    ? await validateStoredCookies()
    : cookieStoreSummary(await readCookieStore());
  return sendJson(res, 200, {
    ...summary,
    cookieStoreWriteProtected: Boolean(cookieWriteKey),
    checkSkipped: shouldCheck && !canCheck,
  });
}

async function handleDrawCount(req, res, url) {
  const statusId = extractStatusId(url.searchParams.get('statusId') || url.searchParams.get('statusUrl'));
  if (!statusId) {
    return sendJson(res, 200, { ok: true, statusId: '', drawCount: null, lastDrawnAt: '' });
  }
  const result = await getDrawCountForStatus(statusId);
  return sendJson(res, 200, {
    ok: true,
    statusId,
    drawCount: result.count,
    lastDrawnAt: result.lastDrawnAt,
    statusUrl: result.statusUrl || normalizeStatusUrl(url.searchParams.get('statusUrl'), statusId),
  });
}

async function handleDrawAttempt(req, res) {
  const body = await readJsonBody(req, maxDrawAttemptBodyBytes);
  const result = await recordDrawAttempt(body);
  return sendJson(res, 200, result);
}

async function handleSaveDraw(req, res) {
  const body = await readJsonBody(req, maxDrawSaveBodyBytes);
  const rawResultGroups = Array.isArray(body.results) ? body.results.slice(0, maxDrawResultGroups) : [];
  const bodyWinners = Array.isArray(body.winners) ? body.winners.slice(0, maxDrawWinners) : [];
  const rawWinners = bodyWinners.length
    ? bodyWinners
    : rawResultGroups
      .flatMap((item) => Array.isArray(item?.winners) ? item.winners : [])
      .slice(0, maxDrawWinners);
  const winners = rawWinners.map(publicWinner).filter((winner) => winner.uid || winner.screenName).slice(0, maxDrawWinners);
  const resultGroups = rawResultGroups
    .map((item, index) => ({
      prize: publicPrize(item?.prize, index),
      winners: (Array.isArray(item?.winners) ? item.winners : [])
        .slice(0, maxDrawWinners)
        .map(publicWinner)
        .filter((winner) => winner.uid || winner.screenName),
    }))
    .filter((item) => item.winners.length);
  const normalizedResults = resultGroups.length
    ? resultGroups
    : [{ prize: { name: '中奖名单', count: winners.length, color: '' }, winners }];
  if (!winners.length) {
    return sendJson(res, 400, { ok: false, error: '没有可保存的中奖结果' });
  }

  await fs.mkdir(drawsDir, { recursive: true });
  const savedAt = new Date().toISOString();
  const statusId = extractStatusId(body.statusId || body.statusUrl || body.sourceMeta?.statusId || body.sourceMeta?.statusUrl);
  const statusUrl = normalizeStatusUrl(body.statusUrl || body.sourceMeta?.statusUrl, statusId);
  const clientDrawnAt = String(body.audit?.drawnAt || body.drawnAt || '');
  const parsedDrawnAt = Date.parse(clientDrawnAt);
  const stableDrawnAt = Number.isFinite(parsedDrawnAt)
    && Math.abs(parsedDrawnAt - Date.now()) <= 7 * 24 * 60 * 60_000
    ? new Date(parsedDrawnAt).toISOString()
    : savedAt;
  const auditHash = crypto.createHash('sha256')
    .update(JSON.stringify({
      source: body.source || '',
      statusId,
      statusUrl,
      drawnAt: stableDrawnAt,
      seed: body.audit?.seed || body.seed || '',
      candidateDigest: body.audit?.candidateDigest || body.candidateDigest || '',
      results: normalizedResults.map((item) => ({
        prize: { name: item?.prize?.name || '', count: finiteNumber(item?.prize?.count, null) },
        winners: Array.isArray(item?.winners)
          ? item.winners.map((winner) => winner?.uid || winner?.screenName || winner?.id || '')
          : [],
      })),
      winners: winners.map((winner) => winner?.uid || winner?.screenName || winner?.id || ''),
    }))
    .digest('hex');
  const stamp = savedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
  const file = path.join(drawsDir, `draw-${stamp}-${auditHash.slice(0, 8)}.json`);
  const sourceMeta = body.sourceMeta && typeof body.sourceMeta === 'object' ? body.sourceMeta : {};
  const audit = body.audit && typeof body.audit === 'object' ? body.audit : {};
  const rules = publicDrawRules(audit.rules && typeof audit.rules === 'object' ? audit.rules : body.rules);
  const payload = {
    source: String(body.source || '').slice(0, 80),
    statusId,
    statusUrl,
    sourceMeta: {
      provider: String(sourceMeta.provider || '').slice(0, 80),
      providers: Array.isArray(sourceMeta.providers) ? sourceMeta.providers.map((item) => String(item).slice(0, 80)).slice(0, 10) : [],
      statusId,
      statusUrl,
      totalNumber: finiteNumber(sourceMeta.totalNumber, null),
      visibleNumber: finiteNumber(sourceMeta.visibleNumber, null),
      rawVisibleNumber: finiteNumber(sourceMeta.rawVisibleNumber, null),
      complete: typeof sourceMeta.complete === 'boolean' ? sourceMeta.complete : null,
    },
    results: normalizedResults,
    winners,
    totalCount: finiteNumber(body.totalCount ?? body.candidateCount, null),
    eligibleCount: finiteNumber(body.eligibleCount ?? audit.eligibleCount, null),
    audit: {
      seed: String(audit.seed || body.seed || '').slice(0, 120),
      drawnAt: stableDrawnAt,
      statusId,
      statusUrl,
      candidateDigest: String(audit.candidateDigest || body.candidateDigest || '').slice(0, 120),
      eligibleCount: finiteNumber(body.eligibleCount ?? audit.eligibleCount, null),
      rules,
    },
    savedAt,
    drawnAt: stableDrawnAt,
    drawNumber: null,
    auditHash,
  };
  await writeJsonFileAtomic(file, payload, { directoryMode: 0o700, fileMode: 0o600 });
  const drawStats = statusId
    ? await getDrawCountForStatus(statusId, auditHash)
    : { count: null, drawNumber: null, lastDrawnAt: '' };
  payload.drawNumber = drawStats.drawNumber;
  await writeJsonFileAtomic(file, payload, { directoryMode: 0o700, fileMode: 0o600 });
  const retention = await pruneSavedDrawFiles();

  return sendJson(res, 200, {
    ok: true,
    savedAt,
    auditHash,
    statusId,
    statusUrl,
    drawNumber: drawStats.drawNumber,
    drawCount: drawStats.count,
    lastDrawnAt: drawStats.lastDrawnAt,
    file: path.basename(file),
    prunedFiles: retention.removedCount,
  });
}

// Admin

function safeDrawFileName(input) {
  const name = path.basename(String(input || '').trim());
  if (!/^draw-[0-9A-Za-z._-]+\.json$/.test(name)) {
    const error = new Error('开奖记录文件名不正确');
    error.status = 400;
    throw error;
  }
  return name;
}

async function listDrawFiles() {
  try {
    const entries = await fs.readdir(drawsDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^draw-[0-9A-Za-z._-]+\.json$/.test(entry.name)) continue;
      const filePath = path.join(drawsDir, entry.name);
      const stat = await fs.stat(filePath);
      files.push({ file: entry.name, filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    }
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function pruneSavedDrawFiles() {
  const files = await listDrawFiles();
  const { removals, retainedBytes } = selectFilesToPrune(files, {
    maxFiles: maxSavedDraws,
    maxBytes: maxSavedDrawBytes,
  });
  await Promise.all(removals.map((item) => fs.unlink(item.filePath).catch(() => {})));
  return { removedCount: removals.length, retainedBytes };
}

async function readDrawFile(fileName) {
  const safeName = safeDrawFileName(fileName);
  const filePath = path.join(drawsDir, safeName);
  const relativePath = path.relative(drawsDir, filePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    const error = new Error('开奖记录路径不正确');
    error.status = 400;
    throw error;
  }
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return { file: safeName, filePath, record: JSON.parse(text) };
  } catch (error) {
    if (error.code === 'ENOENT') {
      error.status = 404;
      error.message = '开奖记录不存在';
    }
    throw error;
  }
}

function publicWinner(winner = {}) {
  return {
    uid: String(winner.uid || winner.id || '').slice(0, 80),
    screenName: String(winner.screenName || winner.name || '').slice(0, 120),
    avatar: safeAvatarUrl(winner.avatar || winner.profile_image_url),
    profileUrl: String(winner.profileUrl || winner.url || '').slice(0, 400),
    text: String(winner.text || '').slice(0, 500),
    source: String(winner.source || '').slice(0, 80),
  };
}

function publicPrize(prize = {}, fallbackIndex = 0) {
  return {
    name: String(prize.name || `奖项${fallbackIndex + 1}`).slice(0, 80),
    count: finiteNumber(prize.count, null),
    color: String(prize.color || '').slice(0, 32),
  };
}

function publicDrawRules(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return null;
  const filters = rules.filters && typeof rules.filters === 'object' && !Array.isArray(rules.filters)
    ? {
        keyword: String(rules.filters.keyword || '').slice(0, 100),
        mentionMin: Math.max(0, Math.min(100, finiteNumber(rules.filters.mentionMin, 0))),
        uniqueByUser: rules.filters.uniqueByUser !== false,
        excludePrevious: rules.filters.excludePrevious === true,
      }
    : null;
  const prizes = Array.isArray(rules.prizes)
    ? rules.prizes.slice(0, maxDrawResultGroups).map(publicPrize)
    : null;
  return filters || prizes ? { filters, prizes } : null;
}

function drawResultGroups(record = {}) {
  if (Array.isArray(record.results) && record.results.length) {
    return record.results.map((item, index) => ({
      prize: publicPrize(item?.prize, index),
      winners: Array.isArray(item?.winners) ? item.winners.map(publicWinner) : [],
    }));
  }
  const winners = Array.isArray(record.winners) ? record.winners.map(publicWinner) : [];
  return winners.length ? [{ prize: { name: '中奖名单', count: winners.length, color: '' }, winners }] : [];
}

function drawRecordPublic(record, file, detail = false) {
  const results = drawResultGroups(record);
  const winners = results.flatMap((item) => item.winners.map((winner) => ({
    ...winner,
    prizeName: item.prize.name,
  })));
  const savedAt = String(record.savedAt || record.drawnAt || record.audit?.drawnAt || '');
  const drawnAt = String(record.drawnAt || record.audit?.drawnAt || savedAt);
  const summary = {
    file,
    savedAt,
    drawnAt,
    source: String(record.source || record.sourceMeta?.provider || '').slice(0, 80),
    statusId: String(record.statusId || record.audit?.statusId || record.sourceMeta?.statusId || '').slice(0, 80),
    statusUrl: String(record.statusUrl || record.audit?.statusUrl || record.sourceMeta?.statusUrl || '').slice(0, 500),
    drawNumber: finiteNumber(record.drawNumber, null),
    auditHash: String(record.auditHash || '').slice(0, 80),
    prizeCount: results.length,
    winnerCount: winners.length,
    totalCount: finiteNumber(record.totalCount ?? record.candidateCount, null),
    eligibleCount: finiteNumber(record.eligibleCount ?? record.audit?.eligibleCount, null),
    results,
    winners,
  };
  if (!detail) {
    return {
      ...summary,
      results: results.map((item) => ({
        prize: item.prize,
        winners: item.winners.slice(0, 3),
        winnerCount: item.winners.length,
      })),
      winners: winners.slice(0, 8),
    };
  }
  return {
    ...summary,
    audit: {
      seed: String(record.audit?.seed || record.seed || '').slice(0, 120),
      candidateDigest: String(record.audit?.candidateDigest || record.candidateDigest || '').slice(0, 120),
      rules: publicDrawRules(record.audit?.rules || record.rules),
    },
    sourceMeta: {
      provider: record.sourceMeta?.provider || '',
      providers: Array.isArray(record.sourceMeta?.providers) ? record.sourceMeta.providers : [],
      totalNumber: finiteNumber(record.sourceMeta?.totalNumber, null),
      complete: record.sourceMeta?.complete,
    },
  };
}

async function listSavedDraws({ limit = 100, search = '' } = {}) {
  const files = await listDrawFiles();
  const normalizedSearch = String(search || '').trim().toLowerCase();
  const items = [];
  for (const fileInfo of files) {
    try {
      const { record } = await readDrawFile(fileInfo.file);
      const item = drawRecordPublic(record, fileInfo.file, false);
      const haystack = [
        item.file,
        item.statusId,
        item.statusUrl,
        item.source,
        ...item.results.map((result) => result.prize.name),
        ...item.winners.map((winner) => `${winner.screenName} ${winner.uid} ${winner.prizeName}`),
      ].join(' ').toLowerCase();
      if (!normalizedSearch || haystack.includes(normalizedSearch)) {
        items.push({ ...item, size: fileInfo.size });
      }
      if (items.length >= limit) break;
    } catch {
    }
  }
  return items;
}

function bytesToMb(bytes) {
  const value = Number(bytes);
  return Number.isFinite(value) ? Math.round((value / 1024 / 1024) * 10) / 10 : 0;
}

async function cgroupMemoryDiagnostic() {
  if (process.platform !== 'linux') return null;
  try {
    const cgroupText = await fs.readFile('/proc/self/cgroup', 'utf8');
    const cgroupDir = resolveCgroupV2Directory(cgroupText);
    if (!cgroupDir) return null;
    const [currentText, peakText, statText] = await Promise.all([
      fs.readFile(path.join(cgroupDir, 'memory.current'), 'utf8'),
      fs.readFile(path.join(cgroupDir, 'memory.peak'), 'utf8').catch(() => '0'),
      fs.readFile(path.join(cgroupDir, 'memory.stat'), 'utf8'),
    ]);
    return summarizeCgroupMemory({
      current: Number(currentText.trim()),
      peak: Number(peakText.trim()),
      stat: parseCgroupMemoryStat(statText),
    });
  } catch {
    return null;
  }
}

async function hostMemoryDiagnostic() {
  if (process.platform === 'linux') {
    try {
      return summarizeHostMemory(parseProcMeminfo(
        await fs.readFile('/proc/meminfo', 'utf8'),
      ));
    } catch {
    }
  }
  const total = os.totalmem();
  const free = os.freemem();
  return {
    total,
    free,
    available: free,
    cached: 0,
    buffers: 0,
    slab: 0,
    slabReclaimable: 0,
    slabUnreclaimable: 0,
    anon: 0,
    used: Math.max(0, total - free),
    usedPercent: total ? Math.round(((total - free) / total) * 1000) / 10 : 0,
  };
}

async function diskDiagnostic() {
  try {
    const stat = await fs.statfs(outputDir);
    const total = Number(stat.blocks) * Number(stat.bsize);
    const available = Number(stat.bavail) * Number(stat.bsize);
    const used = Math.max(0, total - available);
    return {
      available: true,
      total,
      used,
      availableBytes: available,
      usedPercent: total ? Math.round((used / total) * 1000) / 10 : 0,
    };
  } catch (error) {
    return {
      available: false,
      total: 0,
      used: 0,
      availableBytes: 0,
      usedPercent: 0,
      error: safeError(error).message,
    };
  }
}

async function readJsonArray(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'SyntaxError') return [];
    throw error;
  }
}

async function writeJsonArray(filePath, items) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(items, null, 2), 'utf8');
  await fs.rename(temporary, filePath);
}

async function appendFeedback(item) {
  feedbackWrite = feedbackWrite
    .catch(() => {})
    .then(async () => {
      const stored = await readJsonArray(feedbackFile);
      const duplicate = stored.find((entry) => (
        entry?.source === item.source
        && entry?.contentHash === item.contentHash
        && Date.parse(entry?.createdAt || 0) >= Date.now() - feedbackDuplicateWindowMs
      ));
      if (duplicate) {
        const error = new Error('相同反馈已经提交，请勿重复发送');
        error.status = 409;
        throw error;
      }
      stored.push(item);
      await writeJsonFileAtomic(feedbackFile, stored.slice(-maxFeedbackEntries), {
        directoryMode: 0o700,
        fileMode: 0o600,
      });
    });
  return await feedbackWrite;
}

async function listFeedback(limit = maxFeedbackEntries) {
  const stored = await readJsonArray(feedbackFile);
  return stored
    .filter((item) => item && typeof item === 'object' && item.id && item.content)
    .slice(-Math.max(1, Math.min(maxFeedbackEntries, limit)))
    .reverse()
    .map((item) => ({
      id: String(item.id),
      category: String(item.category || 'other'),
      content: String(item.content),
      createdAt: String(item.createdAt || ''),
      source: String(item.source || ''),
    }));
}

function sourceFingerprint(req) {
  return crypto
    .createHmac('sha256', sourceFingerprintSecret)
    .update(clientRateKey(req))
    .digest('hex')
    .slice(0, 12);
}

function recordRuntimeEvent(event) {
  runtimeEvents.push({
    at: new Date().toISOString(),
    status: 'info',
    ...event,
  });
  if (runtimeEvents.length > 50) runtimeEvents.splice(0, runtimeEvents.length - 50);
}

async function appendAdminEvent(event) {
  adminEventWrite = adminEventWrite
    .catch(() => {})
    .then(async () => {
      const stored = await readJsonArray(adminEventsFile);
      stored.push({
        at: new Date().toISOString(),
        category: 'admin',
        status: 'info',
        ...event,
      });
      await writeJsonArray(adminEventsFile, stored.slice(-100));
    });
  return await adminEventWrite;
}

async function collectSystemSample(reason = 'interval') {
  const [cgroup, browserPids, hostMemory] = await Promise.all([
    cgroupMemoryDiagnostic(),
    findProfileBrowserPids(weiboLoginProfileDir).catch(() => []),
    hostMemoryDiagnostic(),
  ]);
  const memory = process.memoryUsage();
  const sample = {
    at: new Date().toISOString(),
    reason,
    rssMb: bytesToMb(memory.rss),
    heapUsedMb: bytesToMb(memory.heapUsed),
    cgroupCurrentMb: bytesToMb(cgroup?.current),
    cgroupAnonMb: bytesToMb(cgroup?.anon),
    cgroupFileMb: bytesToMb(cgroup?.file),
    reclaimableMb: bytesToMb(cgroup?.reclaimable),
    hostAvailableMb: bytesToMb(hostMemory.available),
    hostSlabMb: bytesToMb(hostMemory.slab),
    hostSlabUnreclaimableMb: bytesToMb(hostMemory.slabUnreclaimable),
    browserProcessCount: browserPids.length,
  };
  memorySamples.push(sample);
  if (memorySamples.length > 288) memorySamples.splice(0, memorySamples.length - 288);
  metricsWrite = metricsWrite
    .catch(() => {})
    .then(() => writeJsonArray(systemMetricsFile, memorySamples));
  await metricsWrite;
  return sample;
}

async function loadDiagnosticHistory() {
  const samples = await readJsonArray(systemMetricsFile);
  memorySamples.push(...samples.slice(-287));
}

async function fileDiagnostic(label, filePath) {
  try {
    const stat = await fs.stat(filePath);
    return {
      label,
      exists: true,
      type: stat.isDirectory() ? 'dir' : 'file',
      size: stat.isDirectory() ? 0 : stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { label, exists: false, type: '', size: 0, modifiedAt: '' };
    }
    return { label, exists: false, type: '', size: 0, modifiedAt: '', error: safeError(error).message };
  }
}

async function adminSystemSummary() {
  const memory = process.memoryUsage();
  const resources = process.resourceUsage();
  const [storage, browserPids, cgroupMemory, hostMemory, disk, adminEvents] = await Promise.all([
    Promise.all([
      fileDiagnostic('output/auth', authDir),
      fileDiagnostic('Cookie 池', cookieStoreFile),
      fileDiagnostic('扫码浏览器 Profile', weiboLoginProfileDir),
      fileDiagnostic('登录状态文件', weiboLoginStateFile),
      fileDiagnostic('开奖记录目录', drawsDir),
      fileDiagnostic('系统采样', systemMetricsFile),
      fileDiagnostic('后台事件', adminEventsFile),
      fileDiagnostic('用户反馈', feedbackFile),
    ]),
    findProfileBrowserPids(weiboLoginProfileDir),
    cgroupMemoryDiagnostic(),
    hostMemoryDiagnostic(),
    diskDiagnostic(),
    readJsonArray(adminEventsFile),
  ]);
  const recentSamples = memorySamples.slice(-288);
  const memoryTrend = analyzeMemoryTrend(recentSamples.slice(-72));
  const now = Date.now();
  const nextRecycleAt = new Date(
    Date.parse(serverStartedAt) + serviceRecycleIntervalMs,
  ).toISOString();
  const delayMeanMs = Number.isFinite(eventLoopDelay.mean)
    ? Math.round((eventLoopDelay.mean / 1e6) * 100) / 100
    : 0;
  const delayP99Ms = Number.isFinite(eventLoopDelay.percentile(99))
    ? Math.round((eventLoopDelay.percentile(99) / 1e6) * 100) / 100
    : 0;
  return {
    now: new Date(now).toISOString(),
    startedAt: serverStartedAt,
    uptimeMs: Math.round(process.uptime() * 1000),
    uptimeText: formatDurationMs(process.uptime() * 1000),
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    pid: process.pid,
    hostname: os.hostname(),
    cpus: os.cpus()?.length || 0,
    loadAverage: os.loadavg().map((value) => Math.round(value * 100) / 100),
    memory: {
      rssMb: bytesToMb(memory.rss),
      heapUsedMb: bytesToMb(memory.heapUsed),
      heapTotalMb: bytesToMb(memory.heapTotal),
      externalMb: bytesToMb(memory.external),
      hostTotalMb: bytesToMb(hostMemory.total),
      hostFreeMb: bytesToMb(hostMemory.free),
      hostAvailableMb: bytesToMb(hostMemory.available),
      hostCachedMb: bytesToMb(hostMemory.cached),
      hostAnonMb: bytesToMb(hostMemory.anon),
      hostSlabMb: bytesToMb(hostMemory.slab),
      hostSlabReclaimableMb: bytesToMb(hostMemory.slabReclaimable),
      hostSlabUnreclaimableMb: bytesToMb(hostMemory.slabUnreclaimable),
      hostUsedMb: bytesToMb(hostMemory.used),
      hostUsedPercent: hostMemory.usedPercent,
      cgroupAvailable: Boolean(cgroupMemory),
      cgroupCurrentMb: bytesToMb(cgroupMemory?.current),
      cgroupPeakMb: bytesToMb(cgroupMemory?.peak),
      cgroupAnonMb: bytesToMb(cgroupMemory?.anon),
      cgroupFileMb: bytesToMb(cgroupMemory?.file),
      cgroupKernelMb: bytesToMb(cgroupMemory?.kernel),
      cgroupReclaimableMb: bytesToMb(cgroupMemory?.reclaimable),
      trend: memoryTrend,
      samples: recentSamples,
    },
    browser: {
      processCount: browserPids.length,
      pids: browserPids,
      operation: weiboBrowserOperation
        ? { label: weiboBrowserOperation.label, startedAt: weiboBrowserOperation.startedAt }
        : null,
    },
    runtime: {
      eventLoopMeanMs: delayMeanMs,
      eventLoopP99Ms: delayP99Ms,
      userCpuMs: Math.round(resources.userCPUTime / 1000),
      systemCpuMs: Math.round(resources.systemCPUTime / 1000),
      maxRssMb: Math.round((resources.maxRSS / 1024) * 10) / 10,
      involuntaryContextSwitches: resources.involuntaryContextSwitches,
      rateLimitBuckets: rateLimitBuckets.size,
      adminLoginBuckets: adminLoginLimiter.size(),
      requests: { ...requestStats },
    },
    service: {
      recycleIntervalMs: serviceRecycleIntervalMs,
      recycleIntervalText: formatDurationMs(serviceRecycleIntervalMs),
      nextRecycleAt,
      recycleInMs: Math.max(0, Date.parse(nextRecycleAt) - now),
      memoryHighMb: serviceMemoryHighMb,
      memoryMaxMb: serviceMemoryMaxMb,
    },
    disk: {
      ...disk,
      totalMb: bytesToMb(disk.total),
      usedMb: bytesToMb(disk.used),
      availableMb: bytesToMb(disk.availableBytes),
    },
    config: {
      nodeEnv: process.env.NODE_ENV || '',
      staticDir: path.basename(staticDir),
      frontendBuilt: hasBuiltFrontend,
      maxActiveJobs,
      maxQueuedJobs,
      rateLimitMax,
      jobCreateRateLimitMax,
      drawSaveRateLimitMax,
      maxSavedDraws,
      maxSavedDrawBytes,
      keepaliveEnabled: enableWeiboKeepalive,
      keepaliveIntervalMs: weiboKeepaliveIntervalMs,
      keepaliveIntervalText: formatDurationMs(weiboKeepaliveIntervalMs),
      keepaliveRetryMs: weiboKeepaliveRetryMs,
      keepaliveRetryText: formatDurationMs(weiboKeepaliveRetryMs),
      keepaliveStartupDelayMs: weiboKeepaliveStartupDelayMs,
      keepaliveStartupDelayText: formatDurationMs(weiboKeepaliveStartupDelayMs),
      browserLaunchTimeoutMs: weiboBrowserLaunchTimeoutMs,
      browserLaunchTimeoutText: formatDurationMs(weiboBrowserLaunchTimeoutMs),
      playwrightBrowsersPathSet: Boolean(process.env.PLAYWRIGHT_BROWSERS_PATH),
      cookieStoreDisabled: disableCookieStore,
      cookieStoreWriteProtected: Boolean(cookieWriteKey),
      adminAccountEnabled: configuredAdminAccount(),
      adminSessionTtlMs,
      adminSessionTtlText: formatDurationMs(adminSessionTtlMs),
    },
    storage,
    events: [...adminEvents.slice(-50), ...runtimeEvents]
      .sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0))
      .slice(0, 50),
  };
}

async function handleAdminLogin(req, res) {
  if (!configuredAdminAccount()) {
    return sendJson(res, 503, { ok: false, error: '后台账号尚未配置' });
  }
  const rateKey = clientRateKey(req);
  const allowance = adminLoginLimiter.check(rateKey);
  if (!allowance.allowed) {
    await appendAdminEvent({
      category: 'auth',
      action: 'login',
      status: 'blocked',
      source: sourceFingerprint(req),
      message: '登录尝试已被限流',
    }).catch(() => {});
    res.setHeader('retry-after', String(Math.max(1, Math.ceil(allowance.retryAfterMs / 1000))));
    return sendJson(res, 429, { ok: false, error: '登录尝试过多，请稍后再试' });
  }

  const body = await readJsonBody(req, 4096);
  const username = String(body.username || '').trim().slice(0, 120);
  const password = String(body.password || '').slice(0, 512);
  const [userMatches, passwordMatches] = await Promise.all([
    Promise.resolve(timingSafeEqualText(username, adminUsername)),
    verifyAdminPassword(password, adminPasswordHash),
  ]);
  if (!userMatches || !passwordMatches) {
    const failed = adminLoginLimiter.fail(rateKey);
    if (!failed.allowed) {
      res.setHeader('retry-after', String(Math.max(1, Math.ceil(failed.retryAfterMs / 1000))));
    }
    await appendAdminEvent({
      category: 'auth',
      action: 'login',
      status: 'error',
      source: sourceFingerprint(req),
      message: '后台登录失败',
    }).catch(() => {});
    return sendJson(res, 401, { ok: false, error: '账号或密码不正确' });
  }

  adminLoginLimiter.clear(rateKey);
  const created = createAdminSession({
    username: adminUsername,
    secret: adminSessionSecret,
    ttlMs: adminSessionTtlMs,
  });
  res.setHeader('set-cookie', adminSessionCookie(
    ADMIN_SESSION_COOKIE,
    created.token,
    {
      secure: adminSessionSecure,
      maxAgeSeconds: Math.floor(adminSessionTtlMs / 1000),
    },
  ));
  res.setHeader('cache-control', 'no-store');
  await appendAdminEvent({
    category: 'auth',
    action: 'login',
    status: 'ok',
    source: sourceFingerprint(req),
    message: '后台登录成功',
  }).catch(() => {});
  return sendJson(res, 200, {
    ok: true,
    username: adminUsername,
    csrfToken: created.payload.csrf,
    expiresAt: new Date(created.payload.exp).toISOString(),
  });
}

async function handleAdminSession(req, res) {
  const session = req.adminAuth?.session;
  if (!session) {
    return sendJson(res, 401, { ok: false, error: '登录已失效，请重新登录' });
  }
  res.setHeader('cache-control', 'no-store');
  return sendJson(res, 200, {
    ok: true,
    username: session.u,
    csrfToken: session.csrf,
    expiresAt: new Date(session.exp).toISOString(),
  });
}

async function handleAdminLogout(req, res) {
  const session = req.adminAuth?.session;
  if (session) revokedAdminSessions.set(session.jti, session.exp);
  await appendAdminEvent({
    category: 'auth',
    action: 'logout',
    status: 'ok',
    source: sourceFingerprint(req),
    message: '后台已退出',
  }).catch(() => {});
  res.setHeader('set-cookie', expiredAdminSessionCookie(
    ADMIN_SESSION_COOKIE,
    { secure: adminSessionSecure },
  ));
  res.setHeader('cache-control', 'no-store');
  return sendJson(res, 200, { ok: true });
}

async function handleAdminSummary(req, res) {
  const [draws, attempts, cookieStore, weiboLogin, system] = await Promise.all([
    listSavedDraws({ limit: 500 }),
    listDrawAttempts(),
    readCookieStore(),
    publicWeiboLoginState(),
    adminSystemSummary(),
  ]);
  const cookieSummary = cookieStoreSummary(cookieStore);
  const statusIds = new Set(draws.map((item) => item.statusId).filter(Boolean));
  const winnerCount = draws.reduce((sum, item) => sum + item.winnerCount, 0);
  return sendJson(res, 200, {
    ok: true,
    adminEnabled: configuredAdminAccount() || Boolean(adminKey),
    adminAccount: req.adminAuth?.username || '',
    savedDrawCount: draws.length,
    attemptCount: attempts.length,
    winnerCount,
    statusCount: statusIds.size,
    queue: {
      active: activeJobCount(),
      queued: queuedJobCount(),
      maxActive: maxActiveJobs,
      maxQueued: maxQueuedJobs,
      sameStatusLocks: statusLocks.size,
    },
    cookie: {
      hasCookie: cookieSummary.hasCookie,
      cookieCount: cookieSummary.cookieCount,
      accountCount: cookieSummary.accountCount,
      activeId: cookieSummary.activeId,
      savedAt: cookieSummary.savedAt,
      lastValidAt: cookieSummary.lastValidAt,
      lastCheckedAt: cookieSummary.lastCheckedAt,
      lastInvalidAt: cookieSummary.lastInvalidAt,
      lastError: cookieSummary.lastError,
      cookieStoreDisabled: disableCookieStore,
      cookieStoreWriteProtected: Boolean(cookieWriteKey),
    },
    weiboLogin,
    system,
    recentDraws: draws.slice(0, 8),
    recentAttempts: attempts.slice(-12).reverse().map((item) => ({
      attemptId: item.attemptId,
      drawnAt: item.drawnAt,
      statusId: item.statusId,
      statusUrl: item.statusUrl,
      source: item.source,
      eligibleCount: item.eligibleCount,
      candidateCount: item.candidateCount,
      prizeCount: item.prizeCount,
    })),
  });
}

async function handleAdminWeiboLoginStart(req, res) {
  const result = await startWeiboLoginSession();
  return sendJson(res, 200, result);
}

async function handleAdminWeiboLoginStatus(req, res) {
  const result = await refreshWeiboLoginSession({ includeScreenshot: true });
  return sendJson(res, 200, result);
}

async function handleAdminWeiboLoginStop(req, res) {
  await closeWeiboLoginSession('扫码窗口已手动关闭。');
  return sendJson(res, 200, await publicWeiboLoginState());
}

async function handleAdminWeiboLoginRefresh(req, res) {
  await appendAdminEvent({
    category: 'keepalive',
    action: 'manual-refresh',
    status: 'started',
    source: sourceFingerprint(req),
    message: '手动 Cookie 保活已开始',
  }).catch(() => {});
  const result = await refreshCookieFromBrowserProfile('manual-refresh');
  await appendAdminEvent({
    category: 'keepalive',
    action: 'manual-refresh',
    status: result.status === 'error' ? 'error' : 'ok',
    source: sourceFingerprint(req),
    message: result.status === 'error' ? '手动 Cookie 保活失败' : '手动 Cookie 保活完成',
  }).catch(() => {});
  return sendJson(res, 200, result);
}

async function handleAdminDraws(req, res, url) {
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Math.min(500, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 100));
  const search = String(url.searchParams.get('search') || '').slice(0, 200);
  const items = await listSavedDraws({ limit, search });
  return sendJson(res, 200, { ok: true, items });
}

async function handleFeedback(req, res) {
  const body = await readJsonBody(req, maxFeedbackBodyBytes);
  const submission = normalizeFeedbackSubmission(body);
  const item = {
    id: crypto.randomUUID(),
    ...submission,
    createdAt: new Date().toISOString(),
    source: sourceFingerprint(req),
    contentHash: crypto
      .createHmac('sha256', sourceFingerprintSecret)
      .update(`${submission.category}\0${submission.content}`)
      .digest('hex')
      .slice(0, 24),
  };
  await appendFeedback(item);
  recordRuntimeEvent({
    category: 'feedback',
    action: 'submit',
    status: 'ok',
    message: '收到一条新的用户反馈',
  });
  return sendJson(res, 201, { ok: true, id: item.id, createdAt: item.createdAt });
}

async function handleAdminFeedback(req, res, url) {
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Math.min(
    maxFeedbackEntries,
    Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : maxFeedbackEntries),
  );
  return sendJson(res, 200, { ok: true, items: await listFeedback(limit) });
}

async function handleAdminDrawDetail(req, res, fileName) {
  const { file, record } = await readDrawFile(fileName);
  return sendJson(res, 200, { ok: true, item: drawRecordPublic(record, file, true) });
}

async function handleAdminDeleteDraw(req, res, fileName) {
  const safeName = safeDrawFileName(fileName);
  const filePath = path.join(drawsDir, safeName);
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return sendJson(res, 404, { ok: false, error: '开奖记录不存在' });
    }
    throw error;
  }
  await appendAdminEvent({
    category: 'records',
    action: 'delete',
    status: 'ok',
    source: sourceFingerprint(req),
    message: `已删除开奖记录 ${safeName}`,
  }).catch(() => {});
  return sendJson(res, 200, { ok: true, removed: safeName });
}

// HTTP server

function staticCacheHeaders(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const name = path.basename(filePath);
  if (name === 'index.html' || name === 'config.js') {
    return { 'cache-control': 'no-cache' };
  }
  if (normalized.includes('/assets/')) {
    return { 'cache-control': 'public, max-age=31536000, immutable' };
  }
  return { 'cache-control': 'public, max-age=3600' };
}

function adminAssetName(pathname) {
  if (pathname === '/admin' || pathname === '/admin/') return 'admin.html';
  if (pathname === '/admin/admin.css') return 'admin.css';
  if (pathname === '/admin/admin.js') return 'admin.js';
  if (pathname === '/admin/admin-list-state.js') return 'admin-list-state.js';
  return '';
}

async function serveAdminAsset(req, res, pathname) {
  const assetName = adminAssetName(pathname);
  if (!assetName) return false;
  if (req.method !== 'GET') {
    sendText(res, 405, 'Method Not Allowed');
    return true;
  }
  const filePath = path.join(adminDir, assetName);
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      ...securityHeaders(),
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': assetName === 'admin.html' ? 'no-store' : 'no-cache',
      'x-robots-tag': 'noindex, nofollow',
    });
    res.end(content);
  } catch {
    sendText(res, 404, 'Not Found');
  }
  return true;
}

function missingBuildHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>前端尚未构建</title>
</head>
<body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; max-width: 720px; margin: 64px auto; padding: 0 20px; line-height: 1.7;">
  <h1>前端尚未构建</h1>
  <p>请先在项目目录执行 <code>npm install</code> 和 <code>npm run build</code>，再启动 <code>npm start</code>。</p>
  <p>如果你使用 GitHub Pages 托管前端，这台服务器只需要提供 <code>/api/*</code> 接口。</p>
</body>
</html>`;
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === '/') pathname = '/index.html';

  const requested = path.resolve(staticDir, `.${pathname}`);
  const relativePath = path.relative(staticDir, requested);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return sendText(res, 403, 'Forbidden');
  }

  try {
    const stat = await fs.stat(requested);
    const filePath = stat.isDirectory() ? path.join(requested, 'index.html') : requested;
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      ...securityHeaders(),
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      ...staticCacheHeaders(filePath),
    });
    res.end(content);
  } catch {
    if (!hasBuiltFrontend && (pathname === '/index.html' || !path.extname(pathname))) {
      const fallback = Buffer.from(missingBuildHtml(), 'utf8');
      res.writeHead(200, {
        ...securityHeaders(),
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
      });
      return res.end(fallback);
    }
    if (path.extname(pathname)) {
      return sendText(res, 404, 'Not Found');
    }
    const indexFile = path.join(staticDir, 'index.html');
    const fallback = await pathExists(indexFile)
      ? await fs.readFile(indexFile)
      : Buffer.from(missingBuildHtml(), 'utf8');
    res.writeHead(200, {
      ...securityHeaders(),
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.end(fallback);
  }
}

const server = http.createServer(async (req, res) => {
  const requestStarted = performance.now();
  res.once('finish', () => {
    const elapsed = Math.round((performance.now() - requestStarted) * 10) / 10;
    requestStats.total += 1;
    requestStats.lastRequestAt = new Date().toISOString();
    requestStats.slowestMs = Math.max(requestStats.slowestMs, elapsed);
    if (res.statusCode >= 500) requestStats.serverErrors += 1;
    else if (res.statusCode >= 400) requestStats.clientErrors += 1;
  });
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const corsOk = applyCors(req, res, url.pathname);
    if (req.method === 'OPTIONS' && isApiPath(url.pathname)) {
      res.writeHead(corsOk ? 204 : 403, securityHeaders());
      return res.end();
    }
    if (!corsOk) {
      return sendText(res, 403, 'CORS origin is not allowed');
    }
    const rateLimit = checkRateLimit(req, url.pathname);
    if (!rateLimit.ok) {
      res.setHeader('retry-after', String(rateLimit.retryAfter));
      return sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
    }
    if (isApiPath(url.pathname)) {
      const authorization = authorizeApiRequest(req, url.pathname);
      if (!authorization.ok) {
        return sendJson(res, authorization.status || 401, {
          ok: false,
          error: authorization.error || '登录已失效，请重新登录',
        });
      }
      req.adminAuth = authorization;
    }
    if (adminAssetName(url.pathname)) {
      return await serveAdminAsset(req, res, url.pathname);
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'sameko-weibo-lottery',
        startedAt: serverStartedAt,
        uptimeMs: Math.round(process.uptime() * 1000),
        staticDir: path.basename(staticDir),
        frontendBuilt: hasBuiltFrontend,
        activeJobs: activeJobCount(),
        queuedJobs: queuedJobCount(),
        maxActiveJobs,
        maxQueuedJobs,
        apiKeyRequired: Boolean(apiKey),
        cookieStoreDisabled: disableCookieStore,
        cookieStoreWriteProtected: Boolean(cookieWriteKey),
        weiboKeepaliveEnabled: enableWeiboKeepalive,
        weiboKeepaliveIntervalMs,
        weiboKeepaliveIntervalText: formatDurationMs(weiboKeepaliveIntervalMs),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/feedback') {
      return await handleFeedback(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      return await handleAdminLogin(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/session') {
      return await handleAdminSession(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
      return await handleAdminLogout(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/summary') {
      return await handleAdminSummary(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/weibo-login/start') {
      return await handleAdminWeiboLoginStart(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/weibo-login/status') {
      return await handleAdminWeiboLoginStatus(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/weibo-login/stop') {
      return await handleAdminWeiboLoginStop(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/weibo-login/refresh') {
      return await handleAdminWeiboLoginRefresh(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/draws') {
      return await handleAdminDraws(req, res, url);
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/feedback') {
      return await handleAdminFeedback(req, res, url);
    }
    if (url.pathname.startsWith('/api/admin/draws/')) {
      const fileName = decodeURIComponent(url.pathname.replace('/api/admin/draws/', ''));
      if (req.method === 'GET') return await handleAdminDrawDetail(req, res, fileName);
      if (req.method === 'DELETE') return await handleAdminDeleteDraw(req, res, fileName);
    }
    if (req.method === 'GET' && url.pathname === '/api/weibo/draw-count') {
      return await handleDrawCount(req, res, url);
    }
    if (req.method === 'GET' && url.pathname === '/api/weibo/avatar') {
      return await handleAvatarProxy(req, res, url);
    }
    if (req.method === 'GET' && url.pathname === '/api/weibo/cookie-status') {
      return await handleCookieStatus(req, res, url);
    }
    if (req.method === 'POST' && url.pathname === '/api/weibo/reposts/jobs') {
      return await handleStartRepostsJob(req, res);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/weibo/reposts/jobs/')) {
      const jobId = decodeURIComponent(url.pathname.replace('/api/weibo/reposts/jobs/', ''));
      return await handleGetRepostsJob(req, res, jobId);
    }
    if (req.method === 'POST' && url.pathname === '/api/weibo/draw-attempts') {
      return await handleDrawAttempt(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/draws') {
      return await handleSaveDraw(req, res);
    }
    if (req.method === 'GET') return await serveStatic(req, res);
    return sendText(res, 405, 'Method Not Allowed');
  } catch (error) {
    const normalized = safeError(error);
    if (normalized.status >= 500) {
      const pathname = (() => {
        try {
          return new URL(req.url, 'http://localhost').pathname;
        } catch {
          return '';
        }
      })();
      recordRuntimeEvent({
        category: 'server',
        action: req.method || '',
        status: 'error',
        message: `${pathname || '未知接口'}：${normalized.message}`,
      });
    }
    return sendJson(res, normalized.status, {
      ok: false,
      error: normalized.status >= 500 ? '服务器暂时无法完成请求，请稍后再试' : normalized.message,
    });
  }
});

server.requestTimeout = 120_000;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;
server.on('clientError', (_error, socket) => {
  if (!socket.writable) return socket.destroy();
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});

let shutdownStarted = false;

async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  clearTimeout(weiboKeepaliveTimer);
  weiboKeepaliveTimer = null;
  console.log(`Received ${signal}; closing HTTP and Weibo browser resources.`);
  const forceExit = setTimeout(() => process.exit(1), 15_000);
  forceExit.unref?.();
  server.close();
  await Promise.all([
    closeWeiboLoginSession('服务器正在重启，扫码窗口已关闭。').catch(() => {}),
    closePersistentBrowserContext(
      weiboKeepaliveContext,
      weiboLoginProfileDir,
    ).catch(() => {}),
  ]);
  weiboKeepaliveContext = null;
  clearTimeout(forceExit);
}

process.once('SIGTERM', () => shutdown('SIGTERM').catch((error) => {
  console.error(`Shutdown failed: ${safeError(error).message}`);
}));
process.once('SIGINT', () => shutdown('SIGINT').catch((error) => {
  console.error(`Shutdown failed: ${safeError(error).message}`);
}));

await loadDiagnosticHistory().catch((error) => {
  console.warn(`Diagnostic history load failed: ${safeError(error).message}`);
});
await collectSystemSample('startup').catch((error) => {
  console.warn(`Initial system sample failed: ${safeError(error).message}`);
});
setInterval(() => {
  collectSystemSample('interval').catch((error) => {
    console.warn(`System sample failed: ${safeError(error).message}`);
  });
}, 5 * 60_000).unref?.();

setInterval(() => {
  pruneRateLimitBuckets();
  adminLoginLimiter.prune();
}, 60_000).unref?.();

scheduleWeiboKeepalive();

server.listen(port, host || undefined, () => {
  console.log(`Sameko Weibo Lottery running at http://${host || 'localhost'}:${port}`);
  console.log(`Serving static files from ${staticDir}`);
});
