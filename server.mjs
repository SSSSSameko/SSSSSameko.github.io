import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname);
const distDir = path.join(rootDir, 'dist');
const publicDir = path.join(rootDir, 'public');
const adminDir = path.join(rootDir, 'server-admin');
const drawsDir = path.join(rootDir, 'output', 'draws');
const authDir = path.join(rootDir, 'output', 'auth');
const cookieStoreFile = path.join(authDir, 'weibo-cookie.json');
const weiboLoginProfileDir = path.join(authDir, 'weibo-login-profile');
const weiboLoginStateFile = path.join(authDir, 'weibo-login-state.json');
const drawAttemptsFile = path.join(rootDir, 'output', 'draw-attempts.jsonl');

function envNumber(name, fallback, minimum = 0) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

const port = envNumber('PORT', 4173, 1);
const host = String(process.env.HOST || '').trim();
const apiKey = String(process.env.API_KEY || '').trim();
const adminKey = String(process.env.ADMIN_KEY || '').trim();
const cookieWriteKey = String(process.env.COOKIE_WRITE_KEY || '').trim();
const fetchTimeoutMs = envNumber('FETCH_TIMEOUT_MS', 20_000, 1000);
const jobTtlMs = envNumber('JOB_TTL_MS', 10 * 60_000, 60_000);
const maxActiveJobs = envNumber('MAX_ACTIVE_JOBS', 2, 1);
const maxQueuedJobs = envNumber('MAX_QUEUED_JOBS', 20, 1);
const rateLimitWindowMs = envNumber('RATE_LIMIT_WINDOW_MS', 60_000, 1000);
const rateLimitMax = envNumber('RATE_LIMIT_MAX', 240, 1);
const jobCreateRateLimitMax = envNumber('JOB_CREATE_RATE_LIMIT_MAX', 10, 1);
const jobPollRateLimitMax = envNumber('JOB_POLL_RATE_LIMIT_MAX', 240, 1);
const maxCookieBytes = envNumber('MAX_COOKIE_BYTES', 16_384, 1024);
const maxStoredCookies = envNumber('MAX_STORED_COOKIES', 30, 1);
const disableCookieStore = /^(1|true|yes)$/i.test(String(process.env.DISABLE_COOKIE_STORE || '').trim());
const pageDelayJitterMs = envNumber('PAGE_DELAY_JITTER_MS', 450, 0);
const officialPageDelayMs = envNumber('OFFICIAL_PAGE_DELAY_MS', 900, 0);
const desktopPageDelayMs = envNumber('DESKTOP_PAGE_DELAY_MS', 1200, 0);
const legacyPageDelayMs = envNumber('LEGACY_PAGE_DELAY_MS', 1200, 0);
const mobilePageDelayMs = envNumber('MOBILE_PAGE_DELAY_MS', 1600, 0);
const sameStatusRequestGapMs = envNumber('SAME_STATUS_REQUEST_GAP_MS', 3000, 0);
const weiboLoginSessionTtlMs = envNumber('WEIBO_LOGIN_SESSION_TTL_MS', 8 * 60_000, 60_000);
const weiboKeepaliveIntervalMs = envNumber('WEIBO_KEEPALIVE_INTERVAL_MS', 2 * 24 * 60 * 60_000, 60_000);
const weiboKeepaliveStartupDelayMs = envNumber('WEIBO_KEEPALIVE_STARTUP_DELAY_MS', 90_000, 10_000);
const enableWeiboKeepalive = !/^(0|false|no)$/i.test(String(process.env.WEIBO_KEEPALIVE_ENABLED ?? '1').trim());
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
const jobs = new Map();
const jobQueue = [];
const rateLimitBuckets = new Map();
const statusLocks = new Map();
let weiboLoginSession = null;
let weiboKeepaliveRunning = false;

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
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      `connect-src ${cspConnectSources()}`,
      "worker-src 'self' blob:",
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

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  const normalized = String(origin).replace(/\/+$/, '');
  if (configuredCorsOrigins.includes(normalized)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(normalized);
}

function applyCors(req, res, pathname) {
  const origin = req.headers.origin;
  if (!origin || !isApiPath(pathname)) return true;
  if (!isAllowedCorsOrigin(origin)) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, x-api-key');
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

function isAuthorizedApiRequest(req, pathname) {
  if (req.method === 'OPTIONS' || pathname === '/api/health') return true;
  if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) {
    return Boolean(adminKey) && timingSafeEqualText(requestApiKey(req), adminKey);
  }
  if (!apiKey) return true;
  return timingSafeEqualText(requestApiKey(req), apiKey);
}

function canWriteCookieStore(req) {
  return !cookieWriteKey || timingSafeEqualText(requestApiKey(req), cookieWriteKey);
}

function clientRateKey(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function normalizedRatePath(pathname) {
  return pathname.startsWith('/api/weibo/reposts/jobs/') ? '/api/weibo/reposts/jobs/:id' : pathname;
}

function rateLimitMaxForPath(req, pathname) {
  if (req.method === 'POST' && pathname === '/api/weibo/reposts/jobs') return jobCreateRateLimitMax;
  if (req.method === 'GET' && pathname.startsWith('/api/weibo/reposts/jobs/')) return jobPollRateLimitMax;
  return rateLimitMax;
}

function checkRateLimit(req, pathname) {
  if (!isApiPath(pathname) || req.method === 'OPTIONS') return { ok: true };
  const now = Date.now();
  const limit = rateLimitMaxForPath(req, pathname);
  const key = `${clientRateKey(req)}:${normalizedRatePath(pathname)}`;
  const current = rateLimitBuckets.get(key);
  const bucket = current && current.resetAt > now
    ? current
    : { count: 0, resetAt: now + rateLimitWindowMs };
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  if (rateLimitBuckets.size > 5000) {
    for (const [entryKey, entry] of rateLimitBuckets.entries()) {
      if (entry.resetAt <= now) rateLimitBuckets.delete(entryKey);
    }
  }
  return {
    ok: bucket.count <= limit,
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
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

function extractStatusId(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  if (/^\d+$/.test(text)) return text;
  if (/^[0-9A-Za-z]+$/.test(text) && text.length >= 5) return bidToMid(text);

  try {
    const url = new URL(text);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const candidate = [...pathParts].reverse().find((part) => /^[0-9A-Za-z]+$/.test(part) && part.length >= 5);
    return candidate ? bidToMid(candidate) : '';
  } catch {
    const match = text.match(/(?:status|detail|weibo\.com\/\d+)\/([0-9A-Za-z]+)/i);
    return match ? bidToMid(match[1]) : '';
  }
}

function normalizeStatusUrl(input, statusId) {
  const text = String(input || '').trim();
  if (!text) return statusId ? `https://weibo.com/detail/${statusId}` : '';
  try {
    const url = new URL(text);
    url.hash = '';
    return url.toString();
  } catch {
    return text;
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

async function getDrawCountsByStatus() {
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

async function getDrawCountForStatus(statusId) {
  if (!statusId) return { statusId: '', count: null, lastDrawnAt: '' };
  const counts = await getDrawCountsByStatus();
  return counts.get(statusId) || { statusId, count: 0, lastDrawnAt: '' };
}

async function recordDrawAttempt(body) {
  const statusId = extractStatusId(body.statusId || body.statusUrl || body.sourceMeta?.statusId || body.sourceMeta?.statusUrl);
  if (!statusId) {
    const error = new Error('缺少微博链接、mid 或 bid，无法记录本次抽奖次数');
    error.status = 400;
    throw error;
  }

  await fs.mkdir(path.dirname(drawAttemptsFile), { recursive: true });
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
    source: body.source || '',
    drawnAt,
    seed: body.seed || '',
    eligibleCount: finiteNumber(body.eligibleCount, null),
    candidateCount: finiteNumber(body.candidateCount, null),
    prizeCount: finiteNumber(body.prizeCount, null),
    candidateDigest: body.candidateDigest || '',
    rules: body.rules || null,
  };

  await fs.appendFile(drawAttemptsFile, `${JSON.stringify(payload)}\n`, 'utf8');
  const stats = await getDrawCountForStatus(statusId);
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
  const uid = String(user.idstr || user.id || item.uid || item.user_id || '').trim();
  const screenName = String(user.screen_name || user.name || item.screen_name || item.name || '未命名用户').trim();
  const text = stripHtml(item.text || item.raw_text || item.mblog?.text || item.reason || '');
  const createdAt = item.created_at || item.createdAt || item.mblog?.created_at || '';
  const repostId = String(item.idstr || item.id || item.mid || item.mblog?.idstr || item.mblog?.id || '').trim();

  return {
    id: candidateKey({ uid, screenName, repostId, text, createdAt }),
    uid,
    screenName,
    avatar: user.profile_image_url || user.avatar_hd || user.avatar_large || '',
    verified: Boolean(user.verified),
    followers: Number(user.followers_count || 0),
    text,
    createdAt,
    repostId,
    source,
  };
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = candidate.uid || `${candidate.screenName}|${candidate.repostId}|${candidate.text}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
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
  }
  return result;
}

function safeError(error) {
  return {
    message: redactSensitiveText(error?.message || '未知错误'),
    status: error?.status || 500,
  };
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/((?:SUB|SUBP|ALF|SCF|SSOLoginState|XSRF-TOKEN|MLOGIN|M_WEIBOCN_PARAMS)=)[^;\s]+/gi, '$1[redacted]')
    .replace(/(cookie\s*[:=]\s*)[^\n；。]+/gi, '$1[redacted]');
}

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
    entries.set(id, {
      id,
      cookie,
      savedAt: entry.savedAt || entry.createdAt || new Date(0).toISOString(),
      updatedAt: entry.updatedAt || entry.savedAt || '',
      lastCheckedAt: entry.lastCheckedAt || '',
      lastValidAt: entry.lastValidAt || '',
      lastError: entry.lastError || '',
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
  const cookies = sortCookieEntries(normalizeCookieEntries({ cookies: store.cookies || [] }), store.activeId).slice(0, maxStoredCookies);
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
  await fs.writeFile(cookieStoreFile, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(cookieStoreFile, 0o600).catch(() => {});
  return payload;
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
  const newest = (key) => sorted.map((entry) => entry[key]).filter(Boolean).sort().at(-1) || '';
  return {
    ok: true,
    hasCookie: cookies.length > 0,
    cookieCount: cookies.length,
    activeId: store.activeId || sorted[0]?.id || '',
    savedAt: newest('savedAt'),
    lastCheckedAt: newest('lastCheckedAt'),
    lastValidAt: newest('lastValidAt'),
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
  const cleaned = cleanCookieHeader(cookie);
  if (!cleaned) return { cookie: '', savedAt: '' };
  assertCookieHeaderInput(cleaned);
  const now = new Date().toISOString();
  const id = cookieFingerprint(cleaned);
  const store = await readCookieStore();
  const existing = store.cookies.find((entry) => entry.id === id);
  const entry = {
    id,
    cookie: cleaned,
    savedAt: existing?.savedAt || now,
    updatedAt: now,
    lastCheckedAt: validation.checkedAt || existing?.lastCheckedAt || '',
    lastValidAt: validation.lastValidAt || existing?.lastValidAt || '',
    lastError: validation.ok === false ? validation.message || 'Cookie 校验失败' : '',
  };
  if (disableCookieStore) return entry;
  const cookies = [entry, ...store.cookies.filter((item) => item.id !== id)];
  await writeCookieStore({ ...store, activeId: id, cookies });
  return entry;
}

async function removeStoredCookie(idOrCookie) {
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
}

async function validateStoredCookies(reportProgress) {
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
      kept.push({
        ...entry,
        lastCheckedAt: validation.checkedAt,
        lastValidAt: validation.lastValidAt,
        lastError: '',
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
}

function emptyWeiboLoginState(extra = {}) {
  return {
    version: 1,
    updatedAt: '',
    lastStatus: 'idle',
    lastMessage: '',
    lastLoginAt: '',
    lastRefreshAt: '',
    lastError: '',
    lastReason: '',
    ...extra,
  };
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

async function writeWeiboLoginState(patch = {}) {
  const current = await readWeiboLoginState();
  const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const next = emptyWeiboLoginState({
    ...current,
    ...cleanPatch,
    updatedAt: new Date().toISOString(),
  });
  await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
  await fs.chmod(authDir, 0o700).catch(() => {});
  await fs.writeFile(weiboLoginStateFile, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(weiboLoginStateFile, 0o600).catch(() => {});
  return next;
}

function nextWeiboKeepaliveAt(state) {
  const last = Date.parse(state.lastRefreshAt || state.lastLoginAt || '');
  if (!Number.isFinite(last)) return '';
  return new Date(last + weiboKeepaliveIntervalMs).toISOString();
}

async function publicWeiboLoginState(extra = {}) {
  const state = await readWeiboLoginState();
  const profileReady = await pathExists(weiboLoginProfileDir);
  return {
    ok: true,
    enabled: enableWeiboKeepalive,
    active: Boolean(weiboLoginSession),
    refreshing: weiboKeepaliveRunning,
    status: weiboLoginSession?.status || state.lastStatus || 'idle',
    message: weiboLoginSession?.message || state.lastMessage || '',
    sessionId: weiboLoginSession?.id || '',
    createdAt: weiboLoginSession?.createdAt || '',
    expiresAt: weiboLoginSession?.expiresAt || '',
    lastLoginAt: state.lastLoginAt || '',
    lastRefreshAt: state.lastRefreshAt || '',
    nextRefreshAt: nextWeiboKeepaliveAt(state),
    lastError: state.lastError || '',
    lastReason: state.lastReason || '',
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

async function launchWeiboBrowserContext() {
  const chromium = await importPlaywrightChromium();
  await fs.mkdir(weiboLoginProfileDir, { recursive: true, mode: 0o700 });
  await fs.chmod(weiboLoginProfileDir, 0o700).catch(() => {});
  return await chromium.launchPersistentContext(weiboLoginProfileDir, {
    headless: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: DESKTOP_UA,
    viewport: { width: 430, height: 760 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
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

async function saveBrowserCookieToPool(context, reason = 'manual') {
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
  await writeWeiboLoginState({
    lastStatus: 'ok',
    lastMessage: '微博登录态已保存到服务器 Cookie 池。',
    lastLoginAt: reason === 'qr-login' ? now : undefined,
    lastRefreshAt: now,
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
  try {
    await session.context?.close();
  } catch {
  }
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
      await session.page.waitForTimeout(350);
      const image = await session.page.screenshot({ type: 'png', fullPage: false });
      screenshot = `data:image/png;base64,${Buffer.from(image).toString('base64')}`;
    } catch (error) {
      session.message = `二维码截图生成失败：${safeError(error).message}`;
    }
  }
  return await publicWeiboLoginState({ screenshot });
}

async function startWeiboLoginSession() {
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
    await page.goto('https://weibo.com/login.php', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1500);
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
}

async function refreshCookieFromBrowserProfile(reason = 'manual-refresh') {
  if (weiboKeepaliveRunning) {
    return await publicWeiboLoginState({ message: '微博 Cookie 保活正在运行。' });
  }
  if (weiboLoginSession) {
    return await publicWeiboLoginState({ message: '扫码登录进行中，暂不启动保活。' });
  }
  if (!await pathExists(weiboLoginProfileDir)) {
    const error = new Error('还没有服务器扫码登录记录，请先在后台扫码登录一次。');
    error.status = 400;
    throw error;
  }

  weiboKeepaliveRunning = true;
  await writeWeiboLoginState({
    lastStatus: 'refreshing',
    lastMessage: '正在打开微博页面刷新服务器登录态。',
    lastError: '',
    lastReason: reason,
  });
  let context;
  try {
    context = await launchWeiboBrowserContext();
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://weibo.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2500);
    const saved = await saveBrowserCookieToPool(context, reason);
    await writeWeiboLoginState({
      lastStatus: 'ok',
      lastMessage: '服务器 Cookie 已保活刷新。',
      lastError: '',
      lastReason: reason,
    });
    return await publicWeiboLoginState({ saved });
  } catch (error) {
    const normalized = safeError(error);
    await writeWeiboLoginState({
      lastStatus: 'error',
      lastMessage: normalized.message,
      lastError: normalized.message,
      lastReason: reason,
    });
    if (reason === 'scheduled-refresh') return await publicWeiboLoginState();
    const wrapped = new Error(normalized.message);
    wrapped.status = normalized.status;
    throw wrapped;
  } finally {
    weiboKeepaliveRunning = false;
    if (context) await context.close().catch(() => {});
  }
}

function scheduleWeiboKeepalive() {
  if (!enableWeiboKeepalive) return;
  setTimeout(async () => {
    try {
      const state = await readWeiboLoginState();
      const nextAt = nextWeiboKeepaliveAt(state);
      if (nextAt && Date.now() >= Date.parse(nextAt)) {
        await refreshCookieFromBrowserProfile('scheduled-refresh');
      }
    } catch {
    } finally {
      setInterval(() => {
        refreshCookieFromBrowserProfile('scheduled-refresh').catch(() => {});
      }, weiboKeepaliveIntervalMs).unref?.();
    }
  }, weiboKeepaliveStartupDelayMs).unref?.();
}

async function prepareCookieCandidates(body, reportProgress, options = {}) {
  const failures = [];
  const warnings = [];
  const canSaveCookie = options.canWriteCookie !== false;
  let preferredId = '';
  let inlineCandidate = null;
  const supplied = cleanCookieHeader(body.mobileCookie);

  if (supplied) {
    assertCookieHeaderInput(supplied);
    reportProgress?.({ phase: 'cookie-check', percent: 1, message: '校验本次输入的微博 Cookie' });
    const validation = await checkCookieValidity(supplied);
    if (validation.ok) {
      const now = new Date().toISOString();
      const transient = {
        id: cookieFingerprint(supplied),
        cookie: supplied,
        savedAt: now,
        updatedAt: now,
        lastCheckedAt: validation.checkedAt || now,
        lastValidAt: validation.lastValidAt || '',
        lastError: '',
      };
      if (!disableCookieStore && canSaveCookie) {
        const saved = await upsertStoredCookie(supplied, validation);
        preferredId = saved.id;
      } else {
        inlineCandidate = transient;
        if (!disableCookieStore && !canSaveCookie) {
          warnings.push('本次 Cookie 只临时用于抓取，未保存到服务器。');
        }
      }
    } else {
      await removeStoredCookie(supplied);
      failures.push(`输入的 Cookie 无效：${validation.message}`);
    }
  }

  const summary = await validateStoredCookies(reportProgress);
  if (disableCookieStore) {
    return {
      candidates: inlineCandidate ? [inlineCandidate] : [],
      failures,
      warnings,
      summary: {
        ...summary,
        hasCookie: Boolean(inlineCandidate),
        cookieCount: inlineCandidate ? 1 : 0,
      },
    };
  }
  const store = await readCookieStore();
  const storedCandidates = sortCookieEntries(store.cookies, preferredId || store.activeId);
  const candidates = inlineCandidate
    ? [inlineCandidate, ...storedCandidates.filter((entry) => entry.id !== inlineCandidate.id)]
    : storedCandidates;
  return { candidates, failures, warnings, summary };
}

async function fetchCookieRepostsWithPool({ statusId, body, reportProgress, canWriteCookie = true }) {
  const { candidates, failures, warnings, summary } = await prepareCookieCandidates(body, reportProgress, { canWriteCookie });
  if (!candidates.length) {
    const detail = failures.length ? `；${failures.join('；')}` : '';
    const error = new Error(`服务器端没有可用微博 Cookie，请先粘贴一次有效 Cookie${detail}`);
    error.status = 400;
    throw error;
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const entry = candidates[index];
    reportProgress?.({
      phase: 'cookie',
      percent: 8,
      message: `使用服务器 Cookie 池：${index + 1}/${candidates.length}`,
    });

    try {
      const result = await fetchCookieReposts({ statusId, mobileCookie: entry.cookie, reportProgress });
      await upsertStoredCookie(entry.cookie, {
        ok: true,
        checkedAt: new Date().toISOString(),
        lastValidAt: new Date().toISOString(),
      });
      result.meta = {
        ...result.meta,
        cookiePool: {
          usedId: entry.id,
          cookieCount: summary.cookieCount,
          removedCount: summary.removedCount || 0,
        },
        warnings: [
          ...(failures.length ? failures : []),
          ...(warnings.length ? warnings : []),
          ...(result.meta?.warnings || []),
        ],
      };
      return result;
    } catch (error) {
      failures.push(`服务器 Cookie ${index + 1} 不可用：${error.message}`);
      if (isCookieAuthError(error)) {
        await removeStoredCookie(entry.id);
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

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function fetchJson(url, options = {}) {
  const { headers = {}, signal = AbortSignal.timeout(fetchTimeoutMs), ...rest } = options;
  let response;
  try {
    response = await fetch(url, {
      ...rest,
      signal,
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
  const text = await response.text();
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
  const { headers = {}, signal = AbortSignal.timeout(fetchTimeoutMs), ...rest } = options;
  let response;
  try {
    response = await fetch(url, {
      ...rest,
      signal,
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
  const text = await response.text();
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

async function sleepWithJitter(baseMs, jitterMs = pageDelayJitterMs) {
  const base = Math.max(0, finiteNumber(baseMs, 0));
  const jitter = Math.max(0, finiteNumber(jitterMs, 0));
  const offset = jitter ? Math.floor(Math.random() * jitter) : 0;
  if (base || offset) await sleep(base + offset);
}

async function waitBetweenPages(label, delayMs, reportProgress) {
  if (!delayMs && !pageDelayJitterMs) return;
  reportProgress?.({
    phase: 'wait',
    message: `${label}：稍等一下再读取下一页`,
  });
  await sleepWithJitter(delayMs);
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

  for (let page = 1; page <= OFFICIAL_MAX_PAGES; page += 1) {
    const apiUrl = new URL('https://api.weibo.com/2/statuses/repost_timeline.json');
    apiUrl.searchParams.set('id', statusId);
    apiUrl.searchParams.set('access_token', token);
    apiUrl.searchParams.set('count', String(OFFICIAL_PAGE_SIZE));
    apiUrl.searchParams.set('page', String(page));

    const json = await fetchJson(apiUrl);
    const list = Array.isArray(json.reposts) ? json.reposts : [];
    totalNumber = Number.isFinite(Number(json.total_number)) ? Number(json.total_number) : totalNumber;
    pages.push({ page, count: list.length });
    candidates.push(...list.map((item) => normalizeCandidate(item, 'official')));
    if (totalNumber !== null && candidates.length >= totalNumber) break;
    if (list.length < OFFICIAL_PAGE_SIZE) break;
    if (page === OFFICIAL_MAX_PAGES) hitPageCap = true;
    await waitBetweenPages('官方接口', officialPageDelayMs, reportProgress);
  }

  const unique = uniqueCandidates(candidates);
  return {
    candidates: unique,
    meta: {
      provider: 'official',
      pages,
      totalNumber,
      pageSize: OFFICIAL_PAGE_SIZE,
      complete: !hitPageCap && (totalNumber === null || unique.length >= totalNumber || pages.at(-1)?.count < OFFICIAL_PAGE_SIZE),
      warnings: [
        '已自动分页抓取全部可见转发；官方开放接口的配额和可见范围以账号权限为准。',
        ...(hitPageCap ? [`为避免异常长任务，本次在 ${OFFICIAL_MAX_PAGES} 页后停止。`] : []),
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
    candidates.push(...list.map((item) => normalizeCandidate(item, 'desktop-cookie')));
    reportPageProgress(reportProgress, {
      phase: 'desktop',
      label: '桌面端接口',
      start: 5,
      end: 95,
      page,
      totalPages: maxPage || page,
      count: list.length,
    });

    if (!maxPage && list.length === 0) break;
    if (maxPage && page >= maxPage) break;
    if (page === DESKTOP_MAX_PAGES) hitPageCap = true;
    await waitBetweenPages('桌面端接口', desktopPageDelayMs, reportProgress);
  }

  return {
    candidates: uniqueByRepostId(candidates),
    meta: {
      provider: 'desktop-cookie',
      pages,
      totalNumber,
      maxPage,
      statusInfo,
      complete: !hitPageCap,
      warnings: [
        '已按桌面端微博页面脚本的方式请求 ajax/statuses/repostTimeline，并扫描接口声明的页数范围。',
        ...(hitPageCap ? [`为避免异常长任务，桌面端在 ${DESKTOP_MAX_PAGES} 页后停止。`] : []),
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

  for (let page = 1; page <= LEGACY_MAX_PAGES; page += 1) {
    const apiUrl = new URL(`https://weibo.cn/repost/${info.bid}`);
    apiUrl.searchParams.set('uid', info.uid);
    apiUrl.searchParams.set('rl', '1');
    apiUrl.searchParams.set('page', String(page));
    const html = await fetchText(apiUrl, {
      headers: legacyHeaders(cookie, `https://weibo.cn/${info.uid}/${info.bid}`),
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
    candidates.push(...list.map((item) => normalizeCandidate(item, 'weibo-cn')));
    reportPageProgress(reportProgress, {
      phase: 'weibo-cn',
      label: '旧版页面',
      start: 32,
      end: 63,
      page,
      totalPages: maxPage || page,
      count: list.length,
    });

    if (!maxPage && list.length === 0) break;
    if (maxPage && page >= maxPage) break;
    if (page === LEGACY_MAX_PAGES) hitPageCap = true;
    await waitBetweenPages('旧版页面', legacyPageDelayMs, reportProgress);
  }

  return {
    candidates: uniqueByRepostId(candidates),
    meta: {
      provider: 'weibo-cn',
      pages,
      totalNumber,
      maxPage,
      complete: !hitPageCap,
      warnings: [
        '已补扫旧版 weibo.cn 转发页面；该页面必须使用 bid/mblogid，纯数字 mid 会返回目标不存在。',
        ...(hitPageCap ? [`为避免异常长任务，旧版页面在 ${LEGACY_MAX_PAGES} 页后停止。`] : []),
      ],
    },
  };
}

async function fetchMobileReposts({ statusId, mobileCookie, reportProgress }) {
  const candidates = [];
  const pages = [];
  let hitPageCap = false;
  const cookie = cookieRequired(mobileCookie);
  let totalNumber = null;
  let maxPage = null;

  for (let page = 1; page <= MOBILE_MAX_PAGES; page += 1) {
    const apiUrl = new URL('https://m.weibo.cn/api/statuses/repostTimeline');
    apiUrl.searchParams.set('id', statusId);
    apiUrl.searchParams.set('page', String(page));

    const json = await fetchJson(apiUrl, {
      headers: mobileHeaders(cookie, statusId),
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
    candidates.push(...list.map((item) => normalizeCandidate(item, 'mobile')));
    reportPageProgress(reportProgress, {
      phase: 'mobile',
      label: 'H5 接口',
      start: 64,
      end: 95,
      page,
      totalPages: maxPage || page,
      count: list.length,
    });
    if (!maxPage && list.length === 0) break;
    if (maxPage && page >= maxPage) break;
    if (page === MOBILE_MAX_PAGES) hitPageCap = true;
    await waitBetweenPages('H5 接口', mobilePageDelayMs, reportProgress);
  }

  const unique = uniqueCandidates(candidates);
  return {
    candidates: uniqueByRepostId(unique),
    meta: {
      provider: 'mobile',
      pages,
      totalNumber,
      maxPage,
      complete: !hitPageCap,
      cookieMode: Boolean(cookie),
      warnings: [
        '已按 H5 接口返回的页数范围扫描可见转发。',
        ...(hitPageCap ? [`为避免异常长任务，本次在 ${MOBILE_MAX_PAGES} 页后停止。`] : []),
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

async function buildRepostsPayload(body, reportProgress, options = {}) {
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
      canWriteCookie: options.canWriteCookie !== false,
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

async function handleReposts(req, res) {
  const body = await readJsonBody(req);
  const statusId = extractStatusId(body.statusUrl || body.statusId);
  const payload = await runWithStatusLock(statusId, () => buildRepostsPayload(body, null, { canWriteCookie: canWriteCookieStore(req) }));
  return sendJson(res, 200, payload);
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
  };
  jobs.set(id, job);
  setTimeout(() => jobs.delete(id), jobTtlMs).unref?.();
  return job;
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
  }, { canWriteCookie: job.canWriteCookie }))
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

function enqueueRepostsJob(job, body, canWriteCookie) {
  job.body = body;
  job.canWriteCookie = canWriteCookie;
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
  const body = await readJsonBody(req);
  const job = createJob();
  enqueueRepostsJob(job, body, canWriteCookieStore(req));
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
  const body = await readJsonBody(req, 2 * 1024 * 1024);
  const result = await recordDrawAttempt(body);
  return sendJson(res, 200, result);
}

async function handleSaveDraw(req, res) {
  const body = await readJsonBody(req, 10 * 1024 * 1024);
  const rawResultGroups = Array.isArray(body.results) ? body.results : [];
  const bodyWinners = Array.isArray(body.winners) ? body.winners : [];
  const rawWinners = bodyWinners.length ? bodyWinners : rawResultGroups.flatMap((item) => Array.isArray(item?.winners) ? item.winners : []);
  const winners = rawWinners.map(publicWinner).filter((winner) => winner.uid || winner.screenName);
  const resultGroups = rawResultGroups
    .map((item, index) => ({
      prize: publicPrize(item?.prize, index),
      winners: (Array.isArray(item?.winners) ? item.winners : []).map(publicWinner).filter((winner) => winner.uid || winner.screenName),
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
  const stableDrawnAt = body.audit?.drawnAt || body.drawnAt || savedAt;
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
  const stamp = stableDrawnAt.replace(/[-:.TZ]/g, '').slice(0, 14) || savedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
  const file = path.join(drawsDir, `draw-${stamp}-${auditHash.slice(0, 8)}.json`);
  const sourceMeta = body.sourceMeta && typeof body.sourceMeta === 'object' ? body.sourceMeta : {};
  const audit = body.audit && typeof body.audit === 'object' ? body.audit : {};
  const rules = audit.rules && typeof audit.rules === 'object' ? audit.rules : body.rules;
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
      rules: rules && typeof rules === 'object' ? {
        filters: rules.filters || null,
        prizes: Array.isArray(rules.prizes) ? rules.prizes.map(publicPrize).slice(0, 20) : null,
      } : null,
    },
    savedAt,
    drawnAt: stableDrawnAt,
    auditHash,
  };
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const drawStats = statusId ? await getDrawCountForStatus(statusId) : { count: null, lastDrawnAt: '' };

  return sendJson(res, 200, {
    ok: true,
    savedAt,
    auditHash,
    statusId,
    statusUrl,
    drawCount: drawStats.count,
    lastDrawnAt: drawStats.lastDrawnAt,
    file: path.basename(file),
  });
}

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
      rules: record.audit?.rules || record.rules || null,
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

async function handleAdminSummary(req, res) {
  const [draws, attempts, cookieSummary, weiboLogin] = await Promise.all([
    listSavedDraws({ limit: 500 }),
    listDrawAttempts(),
    cookieStoreSummary(await readCookieStore()),
    publicWeiboLoginState(),
  ]);
  const statusIds = new Set(draws.map((item) => item.statusId).filter(Boolean));
  const winnerCount = draws.reduce((sum, item) => sum + item.winnerCount, 0);
  return sendJson(res, 200, {
    ok: true,
    adminEnabled: Boolean(adminKey),
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
      activeId: cookieSummary.activeId,
      savedAt: cookieSummary.savedAt,
      lastValidAt: cookieSummary.lastValidAt,
      lastInvalidAt: cookieSummary.lastInvalidAt,
      cookieStoreDisabled: disableCookieStore,
      cookieStoreWriteProtected: Boolean(cookieWriteKey),
    },
    weiboLogin,
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
  const result = await refreshCookieFromBrowserProfile('manual-refresh');
  return sendJson(res, 200, result);
}

async function handleAdminDraws(req, res, url) {
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
  const search = url.searchParams.get('search') || '';
  const items = await listSavedDraws({ limit, search });
  return sendJson(res, 200, { ok: true, items });
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
  return sendJson(res, 200, { ok: true, removed: safeName });
}

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
    if (isApiPath(url.pathname) && !isAuthorizedApiRequest(req, url.pathname)) {
      return sendJson(res, 401, { ok: false, error: '访问密钥不正确或未提供' });
    }
    if (adminAssetName(url.pathname)) {
      return await serveAdminAsset(req, res, url.pathname);
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'sameko-weibo-lottery',
        staticDir: path.basename(staticDir),
        frontendBuilt: hasBuiltFrontend,
        activeJobs: activeJobCount(),
        queuedJobs: queuedJobCount(),
        maxActiveJobs,
        maxQueuedJobs,
        apiKeyRequired: Boolean(apiKey),
        cookieStoreDisabled: disableCookieStore,
        cookieStoreWriteProtected: Boolean(cookieWriteKey),
      });
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
    if (url.pathname.startsWith('/api/admin/draws/')) {
      const fileName = decodeURIComponent(url.pathname.replace('/api/admin/draws/', ''));
      if (req.method === 'GET') return await handleAdminDrawDetail(req, res, fileName);
      if (req.method === 'DELETE') return await handleAdminDeleteDraw(req, res, fileName);
    }
    if (req.method === 'GET' && url.pathname === '/api/weibo/draw-count') {
      return await handleDrawCount(req, res, url);
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
    if (req.method === 'POST' && url.pathname === '/api/weibo/reposts') {
      return await handleReposts(req, res);
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
    return sendJson(res, normalized.status, { ok: false, error: normalized.message });
  }
});

server.requestTimeout = 120_000;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 5_000;

scheduleWeiboKeepalive();

server.listen(port, host || undefined, () => {
  console.log(`Sameko Weibo Lottery running at http://${host || 'localhost'}:${port}`);
  console.log(`Serving static files from ${staticDir}`);
});
