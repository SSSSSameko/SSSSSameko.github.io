import http from 'node:http';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
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
  cookieCandidatesWithFallback,
  cookiePoolCounts,
  cookiePoolStatusCounts,
} from './src/lib/cookiePool.js';
import { xsrfTokenFromCookie } from './src/lib/cookieHeaders.js';
import { completedDrawStats } from './src/lib/drawReceipts.js';
import { normalizeFeedbackSubmission } from './src/lib/feedback.js';
import {
  isWeiboHost,
  normalizeStoredStatusId,
  statusTokenFromReference,
} from './src/lib/weiboStatus.js';
import { safeAvatarUrl } from './src/lib/avatar.js';
import { createAsyncGate } from './src/lib/asyncGate.js';
import {
  createEmptyPageGuard,
  createRepeatedPageGuard,
  repostIdentity,
  uniqueReposts,
} from './src/lib/repostCandidates.js';
import { createSnapshotCache, repostTaskKey } from './src/lib/repostTaskCache.js';
import {
  clientAddress,
  firstHeaderValue,
  trustedForwardedHeader,
} from './src/lib/requestTrust.js';
import {
  removeFilesBestEffort,
  retainLatestLines,
  retainRecentEntries,
  selectNewestFiles,
  selectFilesToPrune,
} from './src/lib/storageRetention.js';
import { createLatestWriteQueue } from './src/lib/latestWriteQueue.js';
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
  prunePersistentProfileCaches,
  settlePromiseWithin,
} from './src/lib/weiboBrowserLifecycle.js';
import {
  isWeiboThrottleStatus,
  pageWaitPlan,
  shouldReconcileRepostHead,
  throttleRetryDelayMs,
} from './src/lib/weiboPacing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname);
const distDir = path.join(rootDir, 'dist');
const publicDir = path.join(rootDir, 'public');
const adminDir = path.join(rootDir, 'server-admin');
const outputDir = path.resolve(rootDir, process.env.OUTPUT_DIR || 'output');
const drawsDir = path.resolve(rootDir, process.env.DRAWS_DIR || path.join(outputDir, 'draws'));
const authDir = path.join(outputDir, 'auth');
const runtimeHomeDir = path.join(outputDir, 'runtime-home');
const runtimeCacheDir = path.join(outputDir, 'runtime-cache');
const cookieStoreFile = path.join(authDir, 'weibo-cookie.json');
const weiboLoginProfileDir = path.join(authDir, 'weibo-login-profile');
const weiboLoginStateFile = path.join(authDir, 'weibo-login-state.json');
const drawAttemptsFile = path.resolve(rootDir, process.env.DRAW_ATTEMPTS_FILE || path.join(outputDir, 'draw-attempts.jsonl'));
const drawSequenceFile = path.join(outputDir, 'draw-sequences.json');
const systemMetricsFile = path.join(outputDir, 'system-metrics.json');
const adminEventsFile = path.join(outputDir, 'admin-events.json');
const feedbackFile = path.resolve(rootDir, process.env.FEEDBACK_FILE || path.join(outputDir, 'feedback.json'));

function envNumber(name, fallback, minimum = 0) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

function envInteger(name, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

const port = envInteger('PORT', 4173, 1, 65_535);
const host = String(process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';
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
const completedJobReleaseMs = envNumber('COMPLETED_JOB_RELEASE_MS', 60_000, 10_000);
const jobQueueTimeoutMs = envNumber('JOB_QUEUE_TIMEOUT_MS', 5 * 60_000, 10_000);
const jobRunTimeoutMs = envNumber('JOB_RUN_TIMEOUT_MS', 85 * 60_000, 60_000);
const maxActiveJobs = envInteger('MAX_ACTIVE_JOBS', 2, 1);
const maxQueuedJobs = envInteger('MAX_QUEUED_JOBS', 20, 1);
const maxClientRepostJobs = envInteger('MAX_CLIENT_REPOST_JOBS', 2, 1);
const maxRetainedJobs = envInteger('MAX_RETAINED_JOBS', 8, 1);
const maxJobSubscribers = envInteger('MAX_JOB_SUBSCRIBERS', 32, 1);
const rateLimitWindowMs = envNumber('RATE_LIMIT_WINDOW_MS', 60_000, 1000);
const rateLimitMax = envInteger('RATE_LIMIT_MAX', 240, 1);
const rateLimitMaxBuckets = envInteger('RATE_LIMIT_MAX_BUCKETS', 5000, 100);
const jobCreateRateLimitMax = envInteger('JOB_CREATE_RATE_LIMIT_MAX', 10, 1);
const jobPollRateLimitMax = envInteger('JOB_POLL_RATE_LIMIT_MAX', 240, 1);
const drawSaveRateLimitMax = envInteger('DRAW_SAVE_RATE_LIMIT_MAX', 12, 1);
const maxQueuedDrawWrites = envInteger('MAX_QUEUED_DRAW_WRITES', 12, 1);
const drawBodyReadConcurrency = envInteger('DRAW_BODY_READ_CONCURRENCY', 4, 1);
const maxQueuedDrawBodyReads = envInteger('MAX_QUEUED_DRAW_BODY_READS', 8, 0);
const avatarRateLimitMax = envInteger('AVATAR_RATE_LIMIT_MAX', 240, 1);
const feedbackRateLimitMax = envInteger('FEEDBACK_RATE_LIMIT_MAX', 4, 1);
const feedbackSourceDailyMax = envInteger('FEEDBACK_SOURCE_DAILY_MAX', 12, 1);
const feedbackGlobalHourlyMax = envInteger('FEEDBACK_GLOBAL_HOURLY_MAX', 120, 1);
const maxQueuedFeedbackWrites = envInteger('MAX_QUEUED_FEEDBACK_WRITES', 8, 0);
const maxFeedbackBodyBytes = envNumber('MAX_FEEDBACK_BODY_BYTES', 16 * 1024, 2048);
const maxFeedbackEntries = envInteger('MAX_FEEDBACK_ENTRIES', 500, 20);
const maxFeedbackAgeDays = envNumber('MAX_FEEDBACK_AGE_DAYS', 90, 1);
const maxFeedbackAgeMs = maxFeedbackAgeDays * 24 * 60 * 60_000;
const maxCorruptJsonBackups = envInteger('MAX_CORRUPT_JSON_BACKUPS', 6, 1, 20);
const maxCookieStoreFileBytes = envNumber('MAX_COOKIE_STORE_FILE_BYTES', 1024 * 1024, 64 * 1024);
const maxWeiboLoginStateFileBytes = envNumber('MAX_WEIBO_LOGIN_STATE_FILE_BYTES', 256 * 1024, 16 * 1024);
const maxDrawSequenceFileBytes = envNumber('MAX_DRAW_SEQUENCE_FILE_BYTES', 2 * 1024 * 1024, 64 * 1024);
const maxSystemMetricsFileBytes = envNumber('MAX_SYSTEM_METRICS_FILE_BYTES', 2 * 1024 * 1024, 64 * 1024);
const maxAdminEventsFileBytes = envNumber('MAX_ADMIN_EVENTS_FILE_BYTES', 1024 * 1024, 64 * 1024);
const maxFeedbackFileBytes = envNumber('MAX_FEEDBACK_FILE_BYTES', 2 * 1024 * 1024, 64 * 1024);
const maxGenericStoredJsonBytes = envNumber('MAX_GENERIC_STORED_JSON_BYTES', 2 * 1024 * 1024, 64 * 1024);
const feedbackDuplicateWindowMs = envNumber('FEEDBACK_DUPLICATE_WINDOW_MS', 10 * 60_000, 60_000);
const maxCookieBytes = envNumber('MAX_COOKIE_BYTES', 16_384, 1024);
const maxAccessTokenBytes = Math.min(
  8192,
  Math.floor(envNumber('MAX_ACCESS_TOKEN_BYTES', 1024, 64)),
);
const maxRepostJobBodyBytes = envNumber('MAX_REPOST_JOB_BODY_BYTES', 64 * 1024, 16 * 1024);
const rejectedBodyDrainMs = envNumber('REJECTED_BODY_DRAIN_MS', 1000, 250);
const maxWeiboResponseBytes = envNumber('MAX_WEIBO_RESPONSE_BYTES', 4 * 1024 * 1024, 64 * 1024);
const maxCandidates = Math.min(20_000, envInteger('MAX_CANDIDATES', 20_000, 100));
const maxCandidatePayloadBytes = Math.min(
  32 * 1024 * 1024,
  Math.floor(envNumber('MAX_CANDIDATE_PAYLOAD_BYTES', 16 * 1024 * 1024, 1024 * 1024)),
);
const maxRetainedJobResponseBytes = Math.min(
  64 * 1024 * 1024,
  Math.floor(envNumber('MAX_RETAINED_JOB_RESPONSE_BYTES', 32 * 1024 * 1024, 1024 * 1024)),
);
const maxStoredCookies = envInteger('MAX_STORED_COOKIES', 30, 1);
const avatarProxyMaxBytes = envNumber('AVATAR_PROXY_MAX_BYTES', 512 * 1024, 16 * 1024);
const avatarCacheMaxBytes = envNumber('AVATAR_CACHE_MAX_BYTES', 12 * 1024 * 1024, 1024 * 1024);
const avatarCacheMaxEntries = envInteger('AVATAR_CACHE_MAX_ENTRIES', 512, 32);
const avatarCacheTtlMs = envNumber('AVATAR_CACHE_TTL_MS', 24 * 60 * 60_000, 60_000);
const avatarFetchConcurrency = envInteger('AVATAR_FETCH_CONCURRENCY', 8, 1);
const avatarFetchQueueMax = envInteger('AVATAR_FETCH_QUEUE_MAX', 128, 0);
const cookieAuthQuarantineMs = envNumber('COOKIE_AUTH_QUARANTINE_MS', 45 * 60_000, 60_000);
const disableCookieStore = /^(1|true|yes)$/i.test(String(process.env.DISABLE_COOKIE_STORE || '').trim());
const pageDelayJitterMs = envNumber('PAGE_DELAY_JITTER_MS', 450, 0);
const officialPageDelayMs = envNumber('OFFICIAL_PAGE_DELAY_MS', 900, 0);
const desktopPageDelayMs = envNumber('DESKTOP_PAGE_DELAY_MS', 1200, 0);
const legacyPageDelayMs = envNumber('LEGACY_PAGE_DELAY_MS', 1200, 0);
const mobilePageDelayMs = envNumber('MOBILE_PAGE_DELAY_MS', 1600, 0);
const pageCooldownEvery = envInteger('PAGE_COOLDOWN_EVERY', 8, 2);
const pageCooldownMs = envNumber('PAGE_COOLDOWN_MS', 5000, 0);
const weiboThrottleRetryMax = envInteger('WEIBO_THROTTLE_RETRY_MAX', 2, 0);
const weiboThrottleBackoffMs = envNumber('WEIBO_THROTTLE_BACKOFF_MS', 15_000, 1000);
const weiboThrottleMaxWaitMs = envNumber('WEIBO_THROTTLE_MAX_WAIT_MS', 120_000, 1000);
const sameStatusRequestGapMs = envNumber('SAME_STATUS_REQUEST_GAP_MS', 3000, 0);
const repostSnapshotTtlMs = envNumber('REPOST_SNAPSHOT_TTL_MS', 15_000, 5000);
const maxRepostSnapshots = envInteger('MAX_REPOST_SNAPSHOTS', 2, 1);
const weiboLoginSessionTtlMs = envNumber('WEIBO_LOGIN_SESSION_TTL_MS', 8 * 60_000, 60_000);
const weiboLoginPageTimeoutMs = envNumber('WEIBO_LOGIN_PAGE_TIMEOUT_MS', 45_000, 1000);
const weiboLoginScreenshotTimeoutMs = envNumber('WEIBO_LOGIN_SCREENSHOT_TIMEOUT_MS', 15_000, 1000);
const weiboLoginCookieTimeoutMs = envNumber('WEIBO_LOGIN_COOKIE_TIMEOUT_MS', 15_000, 1000);
const weiboKeepaliveIntervalMs = envNumber('WEIBO_KEEPALIVE_INTERVAL_MS', 12 * 60 * 60_000, 60_000);
const weiboKeepaliveStartupDelayMs = envNumber('WEIBO_KEEPALIVE_STARTUP_DELAY_MS', 90_000, 10_000);
const weiboKeepaliveRetryMs = envNumber('WEIBO_KEEPALIVE_RETRY_MS', 30 * 60_000, 60_000);
const weiboKeepaliveBusyRetryMs = envNumber(
  'WEIBO_KEEPALIVE_BUSY_RETRY_MS',
  Math.min(5 * 60_000, weiboKeepaliveRetryMs),
  10_000,
);
const weiboBrowserLaunchTimeoutMs = envNumber('WEIBO_BROWSER_LAUNCH_TIMEOUT_MS', 60_000, 10_000);
const weiboBrowserAbortCleanupMs = envNumber('WEIBO_BROWSER_ABORT_CLEANUP_MS', 5_000, 1_000);
const weiboBrowserDiskCacheBytes = envNumber('WEIBO_BROWSER_DISK_CACHE_BYTES', 32 * 1024 * 1024, 1024 * 1024);
const weiboBrowserMediaCacheBytes = envNumber('WEIBO_BROWSER_MEDIA_CACHE_BYTES', 8 * 1024 * 1024, 1024 * 1024);
const maxDrawSaveBodyBytes = envNumber('MAX_DRAW_SAVE_BODY_BYTES', 2 * 1024 * 1024, 64 * 1024);
const maxDrawResultGroups = envInteger('MAX_DRAW_RESULT_GROUPS', 20, 1);
const maxDrawWinners = envInteger('MAX_DRAW_WINNERS', 500, 1);
const maxDrawStatCount = Math.min(
  Number.MAX_SAFE_INTEGER,
  Math.floor(envNumber('MAX_DRAW_STAT_COUNT', 10_000_000, maxCandidates)),
);
const maxDrawAttempts = envInteger('MAX_DRAW_ATTEMPTS', 500, 20);
const maxDrawAttemptBytes = envInteger('MAX_DRAW_ATTEMPT_BYTES', 1024 * 1024, 4096, 64 * 1024 * 1024);
const maxDrawSequences = envInteger('MAX_DRAW_SEQUENCES', 5000, 100);
const maxSavedDraws = envInteger('MAX_SAVED_DRAWS', 1000, 20);
const maxSavedDrawBytes = envNumber('MAX_SAVED_DRAW_BYTES', 100 * 1024 * 1024, 1024 * 1024);
const maxSavedDrawFileBytes = envNumber(
  'MAX_SAVED_DRAW_FILE_BYTES',
  Math.max(4 * 1024 * 1024, maxDrawSaveBodyBytes * 2),
  maxDrawSaveBodyBytes,
);
const maxSavedDrawAgeDays = envNumber('MAX_SAVED_DRAW_AGE_DAYS', 180, 1);
const maxSavedDrawAgeMs = maxSavedDrawAgeDays * 24 * 60 * 60_000;
const drawFileScanMaxEntries = envInteger(
  'DRAW_FILE_SCAN_MAX_ENTRIES',
  Math.max(5000, maxSavedDraws * 4),
  Math.max(100, maxSavedDraws),
  100_000,
);
const drawRecoveryScanMaxEntries = envInteger(
  'DRAW_RECOVERY_SCAN_MAX_ENTRIES',
  Math.max(20_000, drawFileScanMaxEntries),
  drawFileScanMaxEntries,
  100_000,
);
const drawFileScanBudgetMs = envInteger('DRAW_FILE_SCAN_BUDGET_MS', 15_000, 1000, 120_000);
const drawCleanupBatchSize = Math.floor(envNumber('DRAW_CLEANUP_BATCH_SIZE', 256, 1));
const fileCleanupConcurrency = Math.floor(envNumber('FILE_CLEANUP_CONCURRENCY', 8, 1));
const enableWeiboKeepalive = !/^(0|false|no)$/i.test(String(process.env.WEIBO_KEEPALIVE_ENABLED ?? '1').trim());
const weiboBrowserSandbox = !/^(0|false|no)$/i.test(String(
  process.env.WEIBO_BROWSER_SANDBOX ?? (isProduction ? '1' : '0'),
).trim());
const serviceRecycleIntervalMs = envNumber('SERVICE_RECYCLE_INTERVAL_MS', 24 * 60 * 60_000, 60_000);
const serviceMemoryHighMb = envNumber('SERVICE_MEMORY_HIGH_MB', 700, 1);
const serviceMemoryMaxMb = envNumber('SERVICE_MEMORY_MAX_MB', 850, 1);
const adminScryptConcurrency = envInteger('ADMIN_SCRYPT_CONCURRENCY', 2, 1);
const diagnosticDirectoryMaxEntries = envInteger('DIAGNOSTIC_DIRECTORY_MAX_ENTRIES', 5000, 100);
const diagnosticDirectoryCacheMs = envNumber('DIAGNOSTIC_DIRECTORY_CACHE_MS', 5 * 60_000, 10_000);
const runtimeCacheMaxFiles = envInteger('RUNTIME_CACHE_MAX_FILES', 5000, 100);
const runtimeCacheMaxBytes = envNumber('RUNTIME_CACHE_MAX_BYTES', 64 * 1024 * 1024, 1024 * 1024);
const runtimeCacheMaxAgeDays = envNumber('RUNTIME_CACHE_MAX_AGE_DAYS', 30, 1);
const runtimeCacheMaxAgeMs = runtimeCacheMaxAgeDays * 24 * 60 * 60_000;
const runtimeCacheScanMaxEntries = envInteger('RUNTIME_CACHE_SCAN_MAX_ENTRIES', 20_000, 1000);
const maxAdminEventQueue = Math.min(512, Math.floor(envNumber('MAX_ADMIN_EVENT_QUEUE', 128, 8)));
const maxErrorMessageChars = envInteger('MAX_ERROR_MESSAGE_CHARS', 4096, 512, 16_384);
const configuredCorsOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => normalizeConfiguredOrigin(origin))
  .filter(Boolean);
const OFFICIAL_PAGE_SIZE = 200;
const OFFICIAL_MAX_PAGES = 500;
const DESKTOP_FIRST_PAGE_SIZE = 10;
const DESKTOP_PAGE_SIZE = 20;
const DESKTOP_MAX_PAGES = envInteger('DESKTOP_MAX_PAGES', 1000, 1, 1000);
const LEGACY_MAX_PAGES = 500;
const MOBILE_MAX_PAGES = 120;
const COOKIE_CHECK_URL = 'https://m.weibo.cn/api/config';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const WEIBO_QR_LOGIN_URL = 'https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog&url=https%3A%2F%2Fweibo.com%2F';
const ADMIN_SESSION_COOKIE = 'sameko_admin_session';
const MAX_REVOKED_ADMIN_SESSIONS = 1000;
const jobs = new Map();
const jobQueue = [];
const rateLimitBuckets = new Map();
let rateLimitEvictions = 0;
const statusLocks = new Map();
const sharedRepostJobs = new Map();
const repostSnapshotCache = createSnapshotCache({
  ttlMs: repostSnapshotTtlMs,
  maxEntries: maxRepostSnapshots,
});
const repostTaskStats = {
  fresh: 0,
  sharedRunning: 0,
  recentSnapshot: 0,
};
const avatarCache = new Map();
const avatarFetches = new Map();
const cookieAuthQuarantine = new Map();
const avatarFetchGate = createAsyncGate({
  concurrency: avatarFetchConcurrency,
  maxQueue: avatarFetchQueueMax,
  busyError: () => Object.assign(new Error('头像服务正忙，请稍后重试'), { status: 503 }),
});
const drawWriteGate = createAsyncGate({
  concurrency: 1,
  maxQueue: maxQueuedDrawWrites,
  busyError: () => Object.assign(new Error('开奖记录服务正忙，请稍后重试'), { status: 503 }),
});
let drawRetentionOperation = null;
const drawBodyReadGate = createAsyncGate({
  concurrency: drawBodyReadConcurrency,
  maxQueue: maxQueuedDrawBodyReads,
  busyError: () => Object.assign(new Error('开奖记录服务正忙，请稍后重试'), { status: 503 }),
});
const feedbackWriteGate = createAsyncGate({
  concurrency: 1,
  maxQueue: maxQueuedFeedbackWrites,
  busyError: () => Object.assign(new Error('反馈提交较多，请稍后再试'), { status: 429 }),
});
const serverStartedAt = new Date().toISOString();
let avatarCacheBytes = 0;
let weiboLoginSession = null;
let weiboLoginStopRevision = 0;
let weiboKeepaliveRunning = false;
let weiboBrowserOperation = null;
let weiboBrowserCleanupOperation = null;
let weiboKeepaliveContext = null;
let weiboKeepaliveTimer = null;
let weiboKeepaliveScheduleRevision = 0;
let weiboLoginRefreshOperation = null;
let weiboLoginCloseOperation = null;
let profileCacheCleanupState = {
  lastRunAt: '',
  removedCount: 0,
};
const adminLoginLimiter = createLoginLimiter({ maxAttempts: 5, windowMs: 15 * 60_000 });
let adminPasswordChecksActive = 0;
const revokedAdminSessions = new Map();
const jsonFileOperations = new Map();
let adminSessionNonce = crypto.randomBytes(32).toString('hex');
const memorySamples = [];
const runtimeEvents = [];
const directoryDiagnosticCache = new Map();
let runtimeCacheCleanupState = {
  lastRunAt: '',
  lastSuccessAt: '',
  removedCount: 0,
  removedBytes: 0,
  scannedFiles: 0,
  truncated: false,
  reset: false,
  retiredPendingCount: 0,
  retiredCleanupFailures: 0,
  skippedReason: '',
};
let drawRetentionState = {
  lastRunAt: '',
  scannedEntries: 0,
  matchedFiles: 0,
  scanComplete: true,
  recoveryScan: false,
  removedCount: 0,
  failedCount: 0,
  missingCount: 0,
  skippedRecent: 0,
  totalBytes: 0,
  retainedBytes: 0,
  freedBytes: 0,
  running: false,
  lastError: '',
  cleanupPending: false,
};
const requestStats = {
  total: 0,
  clientErrors: 0,
  serverErrors: 0,
  lastRequestAt: '',
  slowestMs: 0,
};
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
const metricsWriteQueue = createLatestWriteQueue((samples) => writeJsonArray(systemMetricsFile, samples));
let adminEventWrite = Promise.resolve();
let adminEventPending = 0;
let adminEventDropped = 0;
let cookieStoreOperation = Promise.resolve();
let weiboLoginStateOperation = Promise.resolve();
let drawAttemptWrite = Promise.resolve();
let drawSequenceOperation = Promise.resolve();
let completedDrawIndex = null;
let completedDrawIndexLoad = null;
let completedDrawIndexRevision = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const WEIBO_BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const KNOWN_API_RATE_PATHS = new Set([
  '/api/health',
  '/api/feedback',
  '/api/admin/login',
  '/api/admin/session',
  '/api/admin/logout',
  '/api/admin/summary',
  '/api/admin/weibo-login/start',
  '/api/admin/weibo-login/status',
  '/api/admin/weibo-login/stop',
  '/api/admin/weibo-login/refresh',
  '/api/admin/draws',
  '/api/admin/feedback',
  '/api/weibo/draw-count',
  '/api/weibo/avatar',
  '/api/weibo/cookie-status',
  '/api/weibo/reposts/jobs',
  '/api/draws',
]);

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

function responseCanWrite(res) {
  return !res.destroyed && !res.writableEnded && !res.headersSent;
}

function sendJsonBody(res, status, body) {
  if (!responseCanWrite(res)) return false;
  const content = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    ...securityHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': content.length,
  });
  res.end(content);
  return true;
}

function sendJson(res, status, data) {
  return sendJsonBody(res, status, JSON.stringify(data));
}

function sendText(res, status, text) {
  if (!responseCanWrite(res)) return false;
  const content = Buffer.from(String(text), 'utf8');
  res.writeHead(status, {
    ...securityHeaders(),
    'content-type': 'text/plain; charset=utf-8',
    'content-length': content.length,
  });
  res.end(content);
  return true;
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
  const allowedOrigin = normalizeConfiguredOrigin(origin);
  if (!allowedOrigin || !isAllowedCorsOrigin(req, allowedOrigin)) return false;
  // nosemgrep: javascript.express.security.cors-misconfiguration.cors-misconfiguration -- normalized and allowlisted above
  res.setHeader('access-control-allow-origin', allowedOrigin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, x-api-key, x-admin-csrf, x-cookie-write-key, x-job-cancel-token, x-job-read-token');
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

function adminSessionSigningSecret() {
  return `${adminSessionSecret}:${adminSessionNonce}`;
}

function requestCookieWriteKey(req) {
  const value = req.headers['x-cookie-write-key'];
  return Array.isArray(value) ? value[0] || '' : String(value || '');
}

function requestAdminSession(req) {
  const token = parseCookieHeader(req.headers.cookie || '')[ADMIN_SESSION_COOKIE] || '';
  const session = verifyAdminSession(token, {
    username: adminUsername,
    secret: adminSessionSigningSecret(),
  });
  if (!session) return null;
  pruneRevokedAdminSessions();
  return revokedAdminSessions.has(session.jti) ? null : session;
}

function pruneRevokedAdminSessions(now = Date.now()) {
  for (const [sessionId, expiresAt] of revokedAdminSessions) {
    if (expiresAt <= now) revokedAdminSessions.delete(sessionId);
  }
  while (revokedAdminSessions.size > MAX_REVOKED_ADMIN_SESSIONS) {
    const oldestSessionId = revokedAdminSessions.keys().next().value;
    if (!oldestSessionId) break;
    revokedAdminSessions.delete(oldestSessionId);
  }
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
  if (pathname.startsWith('/api/weibo/reposts/jobs/')) return '/api/weibo/reposts/jobs/:id';
  if (pathname.startsWith('/api/admin/feedback/')) return '/api/admin/feedback/:id';
  if (pathname.startsWith('/api/admin/draws/')) return '/api/admin/draws/:file';
  return KNOWN_API_RATE_PATHS.has(pathname) ? pathname : '/api/unknown';
}

function rateLimitScope(req, pathname) {
  return `${req.method || 'UNKNOWN'}:${normalizedRatePath(pathname)}`;
}

function oldestRateLimitBucket(predicate = () => true) {
  let selected = null;
  for (const [key, entry] of rateLimitBuckets) {
    if (!predicate(entry)) continue;
    if (!selected || entry.createdAt < selected.entry.createdAt) selected = { key, entry };
  }
  return selected;
}

function makeRoomForRateLimitBucket(scope, now) {
  pruneRateLimitBuckets(now);
  if (rateLimitBuckets.size < rateLimitMaxBuckets) return;

  const unknownScope = `${scope.split(':', 1)[0]}:/api/unknown`;
  const selected = (
    scope !== unknownScope && oldestRateLimitBucket((entry) => entry.scope === unknownScope)
  ) || oldestRateLimitBucket((entry) => entry.scope === scope)
    || oldestRateLimitBucket();
  if (selected && rateLimitBuckets.delete(selected.key)) rateLimitEvictions += 1;
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
  const scope = rateLimitScope(req, pathname);
  const key = `${clientRateKey(req)}:${scope}`;
  const current = rateLimitBuckets.get(key);
  let bucket = current && current.resetAt > now ? current : null;
  if (!bucket) {
    if (current) rateLimitBuckets.delete(key);
    makeRoomForRateLimitBucket(scope, now);
    bucket = { count: 0, resetAt: now + rateLimitWindowMs, createdAt: now, scope };
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

function requestAbortedError() {
  const error = new Error('请求连接已中断');
  error.name = 'AbortError';
  error.status = 400;
  error.code = 'REQUEST_ABORTED';
  return error;
}

function throwIfRequestAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : requestAbortedError();
}

function createRequestAbortSignal(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(requestAbortedError());
  };
  const onRequestClose = () => {
    if (!req.complete) abort();
  };
  const onResponseClose = () => {
    if (!res.writableFinished && !res.writableEnded) abort();
  };
  req.once('aborted', abort);
  req.once('close', onRequestClose);
  res.once('close', onResponseClose);
  return {
    signal: controller.signal,
    cleanup() {
      req.removeListener('aborted', abort);
      req.removeListener('close', onRequestClose);
      res.removeListener('close', onResponseClose);
    },
  };
}

async function readJsonBody(req, maxBytes = 1024 * 1024, { signal } = {}) {
  throwIfRequestAborted(signal);
  const contentType = firstHeaderValue(req.headers['content-type']).split(';')[0].trim().toLowerCase();
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json$/.test(contentType)) {
    const error = new Error('请求必须使用 application/json');
    error.status = 415;
    error.closeConnection = true;
    beginRequestDrain(req, rejectedBodyDrainMs);
    throw error;
  }
  const declaredLength = Number(firstHeaderValue(req.headers['content-length']));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = new Error('请求体过大');
    error.status = 413;
    error.closeConnection = true;
    beginRequestDrain(req, rejectedBodyDrainMs);
    throw error;
  }

  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      req.removeListener('close', onClose);
      signal?.removeEventListener('abort', onSignalAbort);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes <= maxBytes) {
        chunks.push(buffer);
        return;
      }
      const error = new Error('请求体过大');
      error.status = 413;
      error.closeConnection = true;
      beginRequestDrain(req, rejectedBodyDrainMs);
      fail(error);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, bytes).toString('utf8'));
    };
    const onError = (error) => fail(error);
    const onAborted = () => {
      fail(requestAbortedError());
    };
    const onClose = () => {
      if (!req.complete) fail(requestAbortedError());
    };
    const onSignalAbort = () => {
      if (!req.complete && !req.readableEnded && !req.destroyed) {
        beginRequestDrain(req, rejectedBodyDrainMs);
      }
      fail(signal?.reason || requestAbortedError());
    };

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
    req.once('close', onClose);
    signal?.addEventListener('abort', onSignalAbort, { once: true });
    if (signal?.aborted) onSignalAbort();
  });
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      const error = new Error('请求体必须是 JSON 对象');
      error.status = 400;
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error?.status === 400 && error.message === '请求体必须是 JSON 对象') throw error;
    const parseError = new Error('JSON 格式不正确');
    parseError.status = 400;
    throw parseError;
  }
}

function beginRequestDrain(req, timeoutMs = 5000) {
  if (req.readableEnded || req.destroyed) return;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    req.removeListener('end', finish);
    req.removeListener('close', finish);
    req.removeListener('error', finish);
  };
  const timer = setTimeout(() => {
    if (!req.readableEnded && !req.destroyed) req.destroy();
    finish();
  }, Math.max(250, timeoutMs));
  timer.unref?.();
  req.once('end', finish);
  req.once('close', finish);
  req.once('error', finish);
  req.resume();
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function withJsonFileLock(filePath, task) {
  const key = path.resolve(filePath);
  const previous = jsonFileOperations.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => current);
  jsonFileOperations.set(key, tail);

  return previous
    .catch(() => {})
    .then(task)
    .finally(() => {
      release();
      if (jsonFileOperations.get(key) === tail) jsonFileOperations.delete(key);
    });
}

async function pruneCorruptJsonBackups(filePath) {
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.corrupt-`;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const stale = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))
    .slice(maxCorruptJsonBackups);
  await Promise.all(stale.map((name) => fs.rm(path.join(directory, name), { force: true })));
}

async function pruneJsonBackups(filePath, marker) {
  const directory = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}${marker}`;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const stale = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))
    .slice(maxCorruptJsonBackups);
  await Promise.all(stale.map((name) => fs.rm(path.join(directory, name), { force: true })));
}

async function isolateCorruptJsonFile(filePath, expectedRaw, maxBytes = null) {
  return await withJsonFileLock(filePath, async () => {
    if (typeof expectedRaw === 'string') {
      let currentRaw;
      try {
        currentRaw = await readTextFileWithinLimit(
          filePath,
          maxBytes ?? maxGenericStoredJsonBytes,
        );
      } catch (error) {
        if (error.code === 'ENOENT') return '';
        if (error.code === 'JSON_FILE_TOO_LARGE') return '';
        throw error;
      }
      if (currentRaw !== expectedRaw) return '';
    }

    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const isolatedPath = `${filePath}.corrupt-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await fs.rename(filePath, isolatedPath);
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }
    console.warn(`Isolated corrupt JSON file: ${path.basename(isolatedPath)}`);
    await pruneCorruptJsonBackups(filePath).catch((error) => {
      console.warn(`Corrupt JSON cleanup failed: ${safeError(error).message}`);
    });
    return isolatedPath;
  });
}

async function isolateOversizedJsonFile(filePath, maxBytes) {
  return await withJsonFileLock(filePath, async () => {
    let stat;
    try {
      stat = await fs.lstat(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= maxBytes) return '';

    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const isolatedPath = `${filePath}.oversized-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await fs.rename(filePath, isolatedPath);
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }
    console.warn(`Isolated oversized JSON file: ${path.basename(isolatedPath)}`);
    await pruneJsonBackups(filePath, '.oversized-').catch((error) => {
      console.warn(`Oversized JSON cleanup failed: ${safeError(error).message}`);
    });
    return isolatedPath;
  });
}

const readOnlyFileFlags = fsConstants.O_RDONLY | Number(fsConstants.O_NOFOLLOW || 0);

function nonRegularStorageFileError() {
  const error = new Error('存储文件不是普通文件');
  error.code = 'JSON_FILE_NOT_REGULAR';
  return error;
}

async function openRegularStorageFile(filePath) {
  const initial = await fs.lstat(filePath);
  if (!initial.isFile() || initial.isSymbolicLink()) throw nonRegularStorageFileError();

  let handle;
  try {
    handle = await fs.open(filePath, readOnlyFileFlags);
  } catch (error) {
    if (error?.code === 'ELOOP') throw nonRegularStorageFileError();
    throw error;
  }

  try {
    const current = await fs.lstat(filePath);
    const stat = await handle.stat();
    if (!current.isFile() || current.isSymbolicLink() || !stat.isFile()) {
      throw nonRegularStorageFileError();
    }
    return { handle, stat };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readTextFileWithinLimit(filePath, maxBytes, signal) {
  const limit = Math.max(1, Math.floor(Number(maxBytes)));
  throwIfRequestAborted(signal);
  const { handle, stat } = await openRegularStorageFile(filePath);
  try {
    throwIfRequestAborted(signal);
    if (stat.size > limit) {
      const error = new Error(`存储文件超过 ${limit} 字节上限`);
      error.code = 'JSON_FILE_TOO_LARGE';
      error.maxBytes = limit;
      error.size = stat.size;
      throw error;
    }

    const chunks = [];
    let total = 0;
    while (true) {
      throwIfRequestAborted(signal);
      const remaining = limit - total + 1;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) {
        const error = new Error(`存储文件超过 ${limit} 字节上限`);
        error.code = 'JSON_FILE_TOO_LARGE';
        error.maxBytes = limit;
        error.size = total;
        throw error;
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    throwIfRequestAborted(signal);
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readStoredJson(filePath, fallback, validate, options = {}) {
  const maxBytes = options.maxBytes ?? maxGenericStoredJsonBytes;
  let raw;
  try {
    raw = await readTextFileWithinLimit(filePath, maxBytes, options.signal);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback();
    if (error.code === 'JSON_FILE_TOO_LARGE') {
      const isolated = await isolateOversizedJsonFile(filePath, Number(maxBytes)).catch((isolationError) => {
        console.warn(`Oversized JSON isolation failed for ${path.basename(filePath)}: ${safeError(isolationError).message}`);
        return '';
      });
      if (options.rejectOversize) {
        const oversizedError = new Error(
          `JSON 文件过大，已${isolated ? '隔离' : '拒绝读取'}：${path.basename(filePath)}`,
        );
        oversizedError.code = 'JSON_FILE_TOO_LARGE';
        oversizedError.status = 500;
        throw oversizedError;
      }
      console.warn(`Ignored oversized JSON file: ${path.basename(filePath)}`);
      return fallback();
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error.name !== 'SyntaxError') throw error;
    await isolateCorruptJsonFile(filePath, raw, maxBytes);
    if (options.rejectCorrupt) {
      const corruptError = new Error(`JSON 文件损坏，已隔离：${path.basename(filePath)}`);
      corruptError.status = 500;
      throw corruptError;
    }
    return fallback();
  }
  if (!validate(parsed)) {
    await isolateCorruptJsonFile(filePath, raw, maxBytes);
    if (options.rejectCorrupt) {
      const corruptError = new Error(`JSON 文件结构不正确，已隔离：${path.basename(filePath)}`);
      corruptError.status = 500;
      throw corruptError;
    }
    return fallback();
  }
  return parsed;
}

async function writeJsonFileAtomic(filePath, payload, options = {}) {
  await withJsonFileLock(filePath, async () => {
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
  });
}

async function readResponseBuffer(response, maxBytes, tooLargeMessage = '返回内容过大') {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body || []) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        const error = new Error(tooLargeMessage);
        error.status = 413;
        throw error;
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    await cancelResponseBody(response);
    throw error;
  }
  return Buffer.concat(chunks, total);
}

async function cancelResponseBody(response) {
  try {
    await Promise.resolve(response?.body?.cancel?.());
  } catch {
  }
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
  if (!responseCanWrite(res)) return false;
  res.writeHead(200, {
    ...securityHeaders(),
    'content-type': entry.contentType,
    'content-length': entry.body.length,
    'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
    etag: entry.etag,
  });
  res.end(entry.body);
  return true;
}

async function fetchAvatar(avatar) {
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
    await cancelResponseBody(response);
    const error = new Error(`头像服务返回 ${response.status}`);
    error.status = response.status === 404 ? 404 : 502;
    throw error;
  }
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^image\/(avif|gif|jpeg|png|webp)$/.test(contentType)) {
    await cancelResponseBody(response);
    const error = new Error('头像服务返回了非图片内容');
    error.status = 502;
    throw error;
  }
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > avatarProxyMaxBytes) {
    await cancelResponseBody(response);
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
  return entry;
}

async function avatarEntry(avatar) {
  const cached = cachedAvatar(avatar);
  if (cached) return cached;
  const running = avatarFetches.get(avatar);
  if (running) return await running;
  const operation = avatarFetchGate.run(() => fetchAvatar(avatar))
    .finally(() => avatarFetches.delete(avatar));
  avatarFetches.set(avatar, operation);
  return await operation;
}

async function handleAvatarProxy(req, res, url) {
  const avatar = safeAvatarUrl(url.searchParams.get('url'));
  if (!avatar || avatar.length > 2048) {
    return sendJson(res, 400, { ok: false, error: '头像地址无效' });
  }
  return sendAvatar(res, await avatarEntry(avatar));
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
const staticRootRealPath = await fs.realpath(staticDir).catch(() => path.resolve(staticDir));
const adminRootRealPath = await fs.realpath(adminDir).catch(() => path.resolve(adminDir));

function isPathWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function staticPathForbiddenError() {
  const error = new Error('静态资源路径无效');
  error.code = 'STATIC_PATH_FORBIDDEN';
  error.status = 403;
  return error;
}

async function resolvePathWithin(rootPath, filePath) {
  const realPath = await fs.realpath(filePath);
  if (!isPathWithin(rootPath, realPath)) throw staticPathForbiddenError();
  return realPath;
}

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
  return isWeiboHost(hostname);
}

function canonicalStatusUrl(statusId) {
  const id = normalizeStoredStatusId(statusId);
  return id ? `https://weibo.com/detail/${id}` : '';
}

function extractStatusId(input) {
  const token = statusTokenFromReference(input);
  return normalizeStoredStatusId(token ? bidToMid(token) : '');
}

function normalizeStatusUrl(input, statusId) {
  const fallback = canonicalStatusUrl(statusId);
  if (fallback) return fallback;
  const text = String(input || '').trim();
  if (!text || text.length > 2048) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || !isWeiboUrlHost(url.hostname)) return '';
    url.protocol = 'https:';
    url.port = '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

async function readTextFileTail(filePath, maxBytes) {
  const { handle, stat } = await openRegularStorageFile(filePath);
  try {
    const size = stat.size;
    const length = Math.min(size, maxBytes);
    const position = Math.max(0, size - length);
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    let content = buffer.subarray(0, offset);
    if (position > 0) {
      const firstLineEnd = content.indexOf(0x0a);
      content = firstLineEnd < 0 ? Buffer.alloc(0) : content.subarray(firstLineEnd + 1);
    }
    return content.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function listDrawAttempts(limit = maxDrawAttempts) {
  try {
    const text = await readTextFileTail(drawAttemptsFile, maxDrawAttemptBytes);
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
      .filter(Boolean)
      .slice(-Math.max(1, limit));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function appendDrawAttempt(item) {
  drawAttemptWrite = drawAttemptWrite.catch(() => {}).then(async () => {
    const items = await listDrawAttempts(maxDrawAttempts - 1);
    const lines = retainLatestLines(
      [...items.map((entry) => JSON.stringify(entry)), JSON.stringify(item)],
      { maxLines: maxDrawAttempts, maxBytes: maxDrawAttemptBytes },
    );
    await fs.mkdir(path.dirname(drawAttemptsFile), { recursive: true, mode: 0o700 });
    const temporary = `${drawAttemptsFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, lines.length ? `${lines.join('\n')}\n` : '', {
        encoding: 'utf8',
        mode: 0o600,
      });
      await fs.rename(temporary, drawAttemptsFile);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  });
  return await drawAttemptWrite;
}

function drawStatusIdFromPayload(payload) {
  const candidates = [
    payload?.statusId,
    payload?.sourceMeta?.statusId,
    payload?.sourceMeta?.weibo?.statusId,
    payload?.audit?.statusId,
  ];
  for (const candidate of candidates) {
    const statusId = normalizeStoredStatusId(candidate);
    if (statusId) return statusId;
  }
  return '';
}

function drawIndexEntry(record, file = '') {
  const results = Array.isArray(record?.results) ? record.results : [];
  const winnerCount = results.reduce((total, group) => (
    total + (Array.isArray(group?.winners) ? group.winners.length : 0)
  ), 0) || (Array.isArray(record?.winners) ? record.winners.length : 0);
  const statusId = drawStatusIdFromPayload(record);
  const statusUrl = normalizeStatusUrl(
    record?.statusUrl || record?.audit?.statusUrl || record?.sourceMeta?.statusUrl,
    statusId,
  );
  return {
    file,
    statusId,
    statusUrl,
    auditHash: String(record?.auditHash || ''),
    drawNumber: storedPositiveInteger(record?.drawNumber),
    drawnAt: String(record?.drawnAt || record?.audit?.drawnAt || record?.savedAt || ''),
    savedAt: String(record?.savedAt || ''),
    winnerCount,
  };
}

function emptyDrawSequenceStore() {
  return { version: 1, sequences: Object.create(null) };
}

function isSafeStoredSequenceKey(value) {
  const key = String(value || '');
  return key !== '__proto__'
    && key !== 'constructor'
    && key !== 'prototype'
    && /^[A-Za-z0-9._:-]{1,200}$/.test(key);
}

function isValidSequenceNumber(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validDrawSequenceStore(value) {
  if (!isPlainObject(value) || value.version !== 1 || !isPlainObject(value.sequences)) return false;
  return Object.values(value.sequences).every(isValidSequenceNumber);
}

function normalizeDrawSequenceStore(value) {
  const sequences = Object.create(null);
  for (const [statusId, number] of Object.entries(value.sequences)) {
    if (!isSafeStoredSequenceKey(statusId) || !isValidSequenceNumber(number)) continue;
    const normalized = normalizeStoredStatusId(statusId) || statusId;
    if (Object.prototype.hasOwnProperty.call(sequences, normalized)) delete sequences[normalized];
    sequences[normalized] = number;
  }
  const keys = Object.keys(sequences);
  for (const key of keys.slice(0, Math.max(0, keys.length - maxDrawSequences))) {
    delete sequences[key];
  }
  return { version: 1, sequences };
}

function touchDrawSequence(store, statusId, drawNumber) {
  const key = normalizeStoredStatusId(statusId);
  if (!key) return;
  delete store.sequences[key];
  store.sequences[key] = drawNumber;
  const keys = Object.keys(store.sequences);
  const removableKeys = keys.filter((candidate) => candidate !== key);
  const excess = Math.max(0, keys.length - maxDrawSequences);
  for (let index = 0; index < excess; index += 1) {
    delete store.sequences[removableKeys[index]];
  }
}

async function readDrawSequenceStore() {
  let sequenceFilePresent = true;
  try {
    await fs.access(drawSequenceFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    sequenceFilePresent = false;
  }
  if (!sequenceFilePresent) {
    try {
      const baseName = path.basename(drawSequenceFile);
      const recoveryPrefixes = [
        `${baseName}.corrupt-`,
        `${baseName}.oversized-`,
      ];
      const entries = await fs.readdir(path.dirname(drawSequenceFile));
      if (entries.some((name) => recoveryPrefixes.some((prefix) => name.startsWith(prefix)))) {
        const error = new Error('开奖编号记录曾损坏，需人工确认后再恢复开奖');
        error.status = 500;
        throw error;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const stored = await readStoredJson(
    drawSequenceFile,
    emptyDrawSequenceStore,
    validDrawSequenceStore,
    {
      maxBytes: maxDrawSequenceFileBytes,
      rejectCorrupt: true,
      rejectOversize: true,
    },
  );
  return normalizeDrawSequenceStore(stored);
}

async function writeDrawSequenceStore(store) {
  await writeJsonFileAtomic(drawSequenceFile, normalizeDrawSequenceStore(store), {
    directoryMode: 0o700,
    fileMode: 0o600,
  });
}

function withDrawSequenceLock(task) {
  const previous = drawSequenceOperation;
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  drawSequenceOperation = previous.catch(() => {}).then(() => current);
  return previous
    .catch(() => {})
    .then(task)
    .finally(() => release());
}

function maxPersistedDrawNumber(records, statusId) {
  const target = normalizeStoredStatusId(statusId);
  return (Array.isArray(records) ? records : []).reduce((maximum, record) => {
    if (drawStatusIdFromPayload(record) !== target) return maximum;
    const number = Number(record?.drawNumber);
    return Number.isSafeInteger(number) && number > maximum ? number : maximum;
  }, 0);
}

async function persistDrawRecord({ statusId, auditHash, file, payload }) {
  const persist = async () => {
    const records = await listCompletedDrawRecords();
    const currentStats = statusId
      ? completedDrawStats(records, statusId, auditHash)
      : { count: null, drawNumber: null, lastDrawnAt: '' };
    const existing = records.find((item) => item.auditHash === auditHash);

    if (existing && !statusId) {
      return {
        duplicate: true,
        savedAt: existing.savedAt || payload.savedAt,
        drawNumber: existing.drawNumber || null,
        drawCount: null,
        lastDrawnAt: existing.drawnAt || existing.savedAt || '',
        file: existing.file || '',
      };
    }

    if (currentStats.drawNumber) {
      return {
        duplicate: true,
        savedAt: existing?.savedAt || payload.savedAt,
        drawNumber: currentStats.drawNumber,
        drawCount: currentStats.count,
        lastDrawnAt: currentStats.lastDrawnAt,
        file: existing?.file || '',
      };
    }

    let drawNumber = null;
    let drawCount = currentStats.count;
    let sequenceStore = null;
    if (statusId) {
      sequenceStore = await readDrawSequenceStore();
      const ledgerNumber = Number(sequenceStore.sequences[statusId] || 0);
      const existingNumber = maxPersistedDrawNumber(records, statusId);
      const previousNumber = Math.max(ledgerNumber, existingNumber);
      drawNumber = previousNumber + 1;
      if (!Number.isSafeInteger(drawNumber)) {
        const error = new Error('开奖序号已达到安全上限，暂时无法继续保存');
        error.status = 500;
        throw error;
      }
      drawCount = Number(currentStats.count || 0) + 1;
    }

    payload.drawNumber = drawNumber;
    await writeJsonFileAtomic(file, payload, { directoryMode: 0o700, fileMode: 0o600 });
    invalidateCompletedDrawIndex();

    if (statusId && drawNumber) {
      touchDrawSequence(sequenceStore, statusId, drawNumber);
      try {
        await writeDrawSequenceStore(sequenceStore);
      } catch (error) {
        recordRuntimeEvent({
          category: 'records',
          action: 'sequence-write',
          status: 'error',
          message: '开奖记录已保存，但开奖序号账本更新失败',
          details: {
            file: path.basename(file),
            statusId,
            error: safeError(error).message,
          },
        });
      }
    }

    return {
      duplicate: false,
      savedAt: payload.savedAt,
      drawNumber,
      drawCount,
      lastDrawnAt: statusId ? payload.drawnAt : '',
      file: path.basename(file),
    };
  };

  return statusId ? await withDrawSequenceLock(persist) : await persist();
}

function invalidateCompletedDrawIndex() {
  completedDrawIndexRevision += 1;
  completedDrawIndex = null;
  completedDrawIndexLoad = null;
}

async function listCompletedDrawRecords() {
  if (completedDrawIndex) return completedDrawIndex;
  if (completedDrawIndexLoad) return await completedDrawIndexLoad;
  const revision = completedDrawIndexRevision;
  const operation = (async () => {
    const files = await scanCompletedDrawIndexFiles();
    const records = [];
    for (const file of files) {
      try {
        const { record } = await readDrawFile(file.file);
        records.push(drawIndexEntry(record, file.file));
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'CORRUPT_DRAW_RECORD') {
          console.warn(`Saved draw index skipped ${file.file}: ${safeError(error).message}`);
        }
      }
    }
    if (revision === completedDrawIndexRevision) completedDrawIndex = records;
    return records;
  })();
  completedDrawIndexLoad = operation;
  try {
    return await operation;
  } finally {
    if (completedDrawIndexLoad === operation) completedDrawIndexLoad = null;
  }
}

function drawRecordTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function compareDrawRecordsLatest(left, right) {
  const leftNumber = storedPositiveInteger(left?.drawNumber);
  const rightNumber = storedPositiveInteger(right?.drawNumber);
  if ((leftNumber !== null) !== (rightNumber !== null)) return rightNumber !== null ? 1 : -1;
  if (leftNumber && rightNumber && leftNumber !== rightNumber) return rightNumber - leftNumber;

  const leftDrawnAt = drawRecordTimestamp(left?.drawnAt);
  const rightDrawnAt = drawRecordTimestamp(right?.drawnAt);
  if ((leftDrawnAt !== null) !== (rightDrawnAt !== null)) return rightDrawnAt !== null ? 1 : -1;
  if (leftDrawnAt !== null && rightDrawnAt !== null && leftDrawnAt !== rightDrawnAt) {
    return rightDrawnAt - leftDrawnAt;
  }

  const drawnAtOrder = String(right?.drawnAt || '').localeCompare(String(left?.drawnAt || ''));
  if (drawnAtOrder) return drawnAtOrder;

  const leftSavedAt = drawRecordTimestamp(left?.savedAt);
  const rightSavedAt = drawRecordTimestamp(right?.savedAt);
  if ((leftSavedAt !== null) !== (rightSavedAt !== null)) return rightSavedAt !== null ? 1 : -1;
  if (leftSavedAt !== null && rightSavedAt !== null && leftSavedAt !== rightSavedAt) {
    return rightSavedAt - leftSavedAt;
  }

  const savedAtOrder = String(right?.savedAt || '').localeCompare(String(left?.savedAt || ''));
  if (savedAtOrder) return savedAtOrder;
  const hashOrder = String(right?.auditHash || '').localeCompare(String(left?.auditHash || ''));
  if (hashOrder) return hashOrder;
  return String(right?.file || '').localeCompare(String(left?.file || ''));
}

async function getDrawCountForStatus(statusId, auditHash = '') {
  const targetStatusId = normalizeStoredStatusId(statusId);
  if (!targetStatusId) {
    return {
      statusId: '',
      statusUrl: '',
      count: null,
      drawNumber: null,
      lastDrawnAt: '',
    };
  }
  const records = await listCompletedDrawRecords();
  const stats = completedDrawStats(records, targetStatusId, auditHash);
  const latest = records
    .filter((record) => drawStatusIdFromPayload(record) === targetStatusId)
    .sort(compareDrawRecordsLatest)
    .at(0);
  return {
    statusId: targetStatusId,
    statusUrl: normalizeStatusUrl(
      latest?.statusUrl || latest?.audit?.statusUrl || latest?.sourceMeta?.statusUrl,
      targetStatusId,
    ),
    ...stats,
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

function createCandidateCollection(candidates = []) {
  const seen = new Set();
  let bytes = 2;
  for (const [index, candidate] of candidates.entries()) {
    const key = repostIdentity(candidate);
    if (key) seen.add(key);
    bytes += Buffer.byteLength(JSON.stringify(candidate), 'utf8') + (index ? 1 : 0);
  }
  return {
    candidates,
    seen,
    bytes,
    limitReason: '',
    discardedCount: 0,
  };
}

function appendCandidates(collection, items, source = '') {
  for (const item of items || []) {
    const candidate = source ? normalizeCandidate(item, source) : item;
    const key = repostIdentity(candidate);
    if (!key || collection.seen.has(key)) continue;
    if (collection.candidates.length >= maxCandidates) {
      collection.limitReason ||= 'count';
      collection.discardedCount += 1;
      return true;
    }
    const bytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8')
      + (collection.candidates.length ? 1 : 0);
    if (collection.bytes + bytes > maxCandidatePayloadBytes) {
      collection.limitReason ||= 'bytes';
      collection.discardedCount += 1;
      return true;
    }
    collection.seen.add(key);
    collection.candidates.push(candidate);
    collection.bytes += bytes;
  }
  return false;
}

function prependCandidates(collection, items) {
  const additions = [];
  for (const candidate of uniqueReposts(items, maxCandidates)) {
    const key = repostIdentity(candidate);
    if (!key || collection.seen.has(key)) continue;
    if (collection.candidates.length + additions.length >= maxCandidates) {
      collection.limitReason ||= 'count';
      collection.discardedCount += 1;
      break;
    }
    const bytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8')
      + (collection.candidates.length || additions.length ? 1 : 0);
    if (collection.bytes + bytes > maxCandidatePayloadBytes) {
      collection.limitReason ||= 'bytes';
      collection.discardedCount += 1;
      break;
    }
    collection.seen.add(key);
    collection.bytes += bytes;
    additions.push(candidate);
  }
  if (additions.length) collection.candidates.unshift(...additions);
  return {
    addedCount: additions.length,
    truncatedCount: collection.discardedCount,
  };
}

function candidateCollectionMeta(collection) {
  return {
    candidatePayloadBytes: collection.bytes,
    candidatePayloadLimitBytes: maxCandidatePayloadBytes,
    candidateLimitReason: collection.limitReason,
  };
}

function candidateLimitWarnings(collection) {
  if (collection.limitReason === 'count') {
    return [`为控制服务器资源，本次最多载入 ${maxCandidates} 位候选。`];
  }
  if (collection.limitReason === 'bytes') {
    return [`候选数据体积已达到 ${Math.round(maxCandidatePayloadBytes / 1024 / 1024)} MB，本次载入 ${collection.candidates.length} 位候选后停止。`];
  }
  return [];
}

function safeError(error) {
  const rawStatus = Number(error?.status);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
  return {
    message: safeErrorMessage(error),
    status,
  };
}

function safeErrorMessage(error, maxChars = maxErrorMessageChars) {
  const value = error instanceof Error ? error.message : error;
  return safeText(value, maxChars, '未知错误');
}

function safeText(value, maxChars = maxErrorMessageChars, fallback = '') {
  const cleaned = redactSensitiveText(value || fallback)
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)?)/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s*\r?\n\s*/g, ' · ')
    .replace(/[\t ]+/g, ' ')
    .trim() || fallback;
  if (!cleaned) return '';
  const limit = Math.max(16, Math.floor(Number(maxChars) || maxErrorMessageChars));
  const characters = [...cleaned];
  return characters.length <= limit
    ? cleaned
    : `${characters.slice(0, limit - 1).join('')}…`;
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/((?:SUB|SUBP|ALF|SCF|SSOLoginState|XSRF-TOKEN|MLOGIN|M_WEIBOCN_PARAMS)=)[^;\s]+/gi, '$1[redacted]')
    .replace(/(cookie\s*[:=]\s*)[^\n；。]+/gi, '$1[redacted]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/((?:access_token|api[_-]?key|token)\s*[:=]\s*)[^\s,;&]+/gi, '$1[redacted]');
}

function decodeRequestPath(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    const error = new Error('请求路径编码不正确');
    error.status = 400;
    throw error;
  }
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
  const payload = await readStoredJson(
    cookieStoreFile,
    () => ({ version: 2, activeId: '', updatedAt: '', cookies: [] }),
    isPlainObject,
    { maxBytes: maxCookieStoreFileBytes },
  );
  const cookies = normalizeCookieEntries(payload);
  return {
    version: 2,
    activeId: payload.activeId || cookies[0]?.id || '',
    updatedAt: payload.updatedAt || payload.savedAt || '',
    cookies,
  };
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

function withCookieStoreLock(task, signal) {
  const previous = cookieStoreOperation;
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  cookieStoreOperation = previous.catch(() => {}).then(() => current);
  const operation = previous
    .catch(() => {})
    .then(() => {
      throwIfTaskCancelled(signal);
      return task();
    })
    .finally(() => release());
  return signal ? waitForPromiseOrAbort(operation, signal) : operation;
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

function cookieAvailability(store) {
  pruneCookieAuthQuarantine();
  const counts = cookiePoolStatusCounts(store.cookies || [], {
    quarantinedIds: cookieAuthQuarantine.keys(),
  });
  return {
    ...counts,
    availableCookieCount: counts.tryableCookieCount,
    availableAccountCount: counts.tryableAccountCount,
    quarantinedCount: counts.quarantinedCookieCount,
  };
}

function isCookieAuthError(error) {
  const message = String(error?.message || error || '');
  return error?.status === 401
    || /Cookie.*(不可用|过期|失效|无效)/i.test(message)
    || /(未登录|登录已失效|访客系统|Sina Visitor System|passport\.sina|请先登录)/i.test(message);
}

function pruneCookieAuthQuarantine(now = Date.now()) {
  for (const [id, expiresAt] of cookieAuthQuarantine) {
    if (expiresAt <= now) cookieAuthQuarantine.delete(id);
  }
}

function usableStoredCookies(entries, now = Date.now()) {
  pruneCookieAuthQuarantine(now);
  return entries.filter((entry) => !cookieAuthQuarantine.has(entry.id));
}

function quarantineStoredCookie(id) {
  if (id) cookieAuthQuarantine.set(id, Date.now() + cookieAuthQuarantineMs);
}

function clearCookieQuarantine(id) {
  if (id) cookieAuthQuarantine.delete(id);
}

function quarantinedCookieCount() {
  pruneCookieAuthQuarantine();
  return cookieAuthQuarantine.size;
}

async function checkCookieValidity(cookie, signal) {
  const checkedAt = new Date().toISOString();
  try {
    const json = await fetchJson(COOKIE_CHECK_URL, {
      signal,
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
    throwIfTaskCancelled(signal);
    return {
      ok: false,
      checkedAt,
      status: error.status || 0,
      message: error.message || 'Cookie 校验失败',
      invalid: isCookieAuthError(error),
    };
  }
}

async function upsertStoredCookie(cookie, validation = {}, signal) {
  return withCookieStoreLock(async () => {
    throwIfTaskCancelled(signal);
    const cleaned = cleanCookieHeader(cookie);
    if (!cleaned) return { cookie: '', savedAt: '' };
    assertCookieHeaderInput(cleaned);
    const now = new Date().toISOString();
    const id = cookieFingerprint(cleaned);
    const store = await readCookieStore();
    throwIfTaskCancelled(signal);
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
    if (validation.ok !== false) clearCookieQuarantine(id);
    if (disableCookieStore) return entry;
    const cookies = [entry, ...store.cookies.filter((item) => item.id !== id)];
    throwIfTaskCancelled(signal);
    await writeCookieStore({ ...store, activeId: id, cookies });
    return entry;
  });
}

async function removeStoredCookie(idOrCookie) {
  return withCookieStoreLock(async () => {
    const id = String(idOrCookie || '').includes(';') ? cookieFingerprint(idOrCookie) : String(idOrCookie || '');
    clearCookieQuarantine(id);
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

async function validateStoredCookies(reportProgress, signal) {
  return withCookieStoreLock(async () => {
    throwIfTaskCancelled(signal);
    if (disableCookieStore) {
      return cookieStoreSummary({ version: 2, activeId: '', updatedAt: '', cookies: [] }, { cookieStoreDisabled: true });
    }
    const store = await readCookieStore();
    const kept = [];
    let removedCount = 0;

    for (let index = 0; index < store.cookies.length; index += 1) {
      throwIfTaskCancelled(signal);
      const entry = store.cookies[index];
      reportProgress?.({
        phase: 'cookie-check',
        percent: Math.min(8, 1 + index),
        message: `校验服务器 Cookie：${index + 1}/${store.cookies.length}`,
      });
      const validation = await checkCookieValidity(entry.cookie, signal);
      if (validation.ok) {
        clearCookieQuarantine(entry.id);
        const user = normalizeCookieUser(validation.user || entry.user);
        kept.push({
          ...entry,
          lastCheckedAt: validation.checkedAt,
          lastValidAt: validation.lastValidAt,
          lastError: '',
          ...(user.id || user.screenName ? { user } : {}),
        });
      } else if (validation.invalid) {
        clearCookieQuarantine(entry.id);
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
  }, signal);
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
  const payload = await readStoredJson(
    weiboLoginStateFile,
    () => emptyWeiboLoginState(),
    isPlainObject,
    { maxBytes: maxWeiboLoginStateFileBytes },
  );
  return emptyWeiboLoginState(payload);
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
  const profilePresent = await pathExists(weiboLoginProfileDir);
  const profileReady = profilePresent && Boolean(state.lastLoginAt || state.lastSuccessAt);
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
      : weiboBrowserCleanupOperation
        ? { label: weiboBrowserCleanupOperation.label, startedAt: weiboBrowserCleanupOperation.startedAt }
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
    profilePresent,
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
  if (weiboBrowserCleanupOperation) {
    const error = new Error('微博浏览器正在清理上一次启动，请稍后再试。');
    error.status = 409;
    throw error;
  }
  const operation = {
    label,
    startedAt: new Date().toISOString(),
    controller: new AbortController(),
    promise: null,
  };
  weiboBrowserOperation = operation;
  const promise = Promise.resolve().then(() => task(operation));
  operation.promise = promise;
  try {
    return await promise;
  } finally {
    if (weiboBrowserOperation === operation) weiboBrowserOperation = null;
  }
}

function trackWeiboBrowserCleanup(promise) {
  const operation = {
    label: '上一次启动清理',
    startedAt: new Date().toISOString(),
    promise: null,
  };
  const tracked = Promise.resolve(promise).finally(() => {
    if (weiboBrowserCleanupOperation === operation) weiboBrowserCleanupOperation = null;
  });
  operation.promise = tracked;
  weiboBrowserCleanupOperation = operation;
  tracked.catch(() => {});
  return tracked;
}

async function waitForBrowserTask(promise, { signal, timeoutMs, message }) {
  const outcome = await settlePromiseWithin(
    waitForPromiseOrAbort(promise, signal),
    timeoutMs,
  );
  if (outcome.timedOut) {
    const error = new Error(message);
    error.code = 'WEIBO_BROWSER_TASK_TIMEOUT';
    error.status = 504;
    throw error;
  }
  if (!outcome.fulfilled) throw outcome.error;
  return outcome.value;
}

async function launchWeiboBrowserContext({ signal } = {}) {
  throwIfTaskCancelled(signal);
  const chromium = await importPlaywrightChromium();
  throwIfTaskCancelled(signal);
  const runtime = await ensureBrowserRuntimeDirs(outputDir);
  const profile = await preparePersistentProfile(weiboLoginProfileDir);
  if (signal?.aborted) {
    await closePersistentBrowserContext(null, weiboLoginProfileDir, {
      ownerToken: profile.ownerToken,
    }).catch(() => {});
    throw signal.reason || taskCancelledError();
  }
  profileCacheCleanupState = {
    lastRunAt: new Date().toISOString(),
    removedCount: profile.removedCaches.length,
  };
  if (profile.stoppedPids.length) {
    console.warn(`Stopped ${profile.stoppedPids.length} stale Weibo browser process(es) before launch.`);
  }
  const browserEnvKeys = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR',
    'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
    'LANG', 'LC_ALL', 'TZ', 'LD_LIBRARY_PATH', 'FONTCONFIG_FILE', 'FONTCONFIG_PATH',
    'PLAYWRIGHT_BROWSERS_PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  ];
  const browserEnv = Object.fromEntries(browserEnvKeys
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]));
  if (process.platform === 'linux') {
    browserEnv.HOME = runtime.runtimeHome;
    browserEnv.XDG_CACHE_HOME = runtime.runtimeCache;
  }
  let launchPromise = null;
  let lateCleanupScheduled = false;
  try {
    launchPromise = chromium.launchPersistentContext(weiboLoginProfileDir, {
      headless: true,
      chromiumSandbox: weiboBrowserSandbox,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: DESKTOP_UA,
      viewport: { width: 430, height: 760 },
      timeout: weiboBrowserLaunchTimeoutMs,
      env: browserEnv,
      args: [
        ...(!weiboBrowserSandbox ? ['--no-sandbox'] : []),
        '--disable-dev-shm-usage',
        '--disable-gpu',
        `--disk-cache-dir=${runtime.chromiumCache}`,
        `--disk-cache-size=${weiboBrowserDiskCacheBytes}`,
        `--media-cache-size=${weiboBrowserMediaCacheBytes}`,
      ],
    });
    try {
      return await waitForPromiseOrAbort(launchPromise, signal);
    } catch (error) {
      if (signal?.aborted) {
        lateCleanupScheduled = true;
        const cleanupOptions = {
          ownerToken: profile.ownerToken,
          closeTimeoutMs: weiboBrowserAbortCleanupMs,
          graceMs: 0,
        };
        const outcome = await settlePromiseWithin(launchPromise, weiboBrowserAbortCleanupMs);
        if (outcome.timedOut) {
          const lateCleanup = Promise.resolve(launchPromise)
            .then((lateContext) => closePersistentBrowserContext(
              lateContext,
              weiboLoginProfileDir,
              cleanupOptions,
            ))
            .catch(() => closePersistentBrowserContext(null, weiboLoginProfileDir, cleanupOptions))
            .catch(() => {});

          const watchdogDelayMs = Math.min(
            2_147_000_000,
            Math.max(
              weiboBrowserLaunchTimeoutMs + weiboBrowserAbortCleanupMs + 1000,
              weiboBrowserAbortCleanupMs * 2,
            ),
          );
          let watchdog;
          const watchdogCleanup = new Promise((resolve) => {
            watchdog = setTimeout(() => {
              closePersistentBrowserContext(null, weiboLoginProfileDir, {
                ...cleanupOptions,
                closeTimeoutMs: 0,
                removeLocks: true,
              }).catch(() => {}).finally(resolve);
            }, watchdogDelayMs);
            watchdog.unref?.();
          });
          trackWeiboBrowserCleanup(Promise.race([lateCleanup, watchdogCleanup]));
          lateCleanup.finally(() => clearTimeout(watchdog)).catch(() => {});

          await closePersistentBrowserContext(
            null,
            weiboLoginProfileDir,
            {
              ...cleanupOptions,
              closeTimeoutMs: 0,
              graceMs: 0,
              releaseOwner: false,
              removeLocks: false,
            },
          ).catch(() => {});
        } else if (outcome.fulfilled) {
          await closePersistentBrowserContext(
            outcome.value,
            weiboLoginProfileDir,
            cleanupOptions,
          ).catch(() => {});
        } else {
          await closePersistentBrowserContext(
            null,
            weiboLoginProfileDir,
            cleanupOptions,
          ).catch(() => {});
        }
      }
      throw error;
    }
  } catch (error) {
    if (signal?.aborted) {
      if (!lateCleanupScheduled) {
        await closePersistentBrowserContext(null, weiboLoginProfileDir, {
          ownerToken: profile.ownerToken,
        }).catch(() => {});
      }
      throw error;
    }
    await closePersistentBrowserContext(null, weiboLoginProfileDir, {
      ownerToken: profile.ownerToken,
    }).catch(() => {});
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

async function cookieHeaderFromBrowserContext(context, signal) {
  const cookies = await waitForBrowserTask(
    context.cookies(['https://weibo.com', 'https://m.weibo.cn', 'https://weibo.cn']),
    { signal, timeoutMs: weiboLoginCookieTimeoutMs, message: '读取微博登录 Cookie 超时' },
  );
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
  const signal = meta.signal;
  throwIfTaskCancelled(signal);
  const cookie = cleanCookieHeader(await cookieHeaderFromBrowserContext(context, signal));
  throwIfTaskCancelled(signal);
  if (!/(?:^|;\s*)SUB=/.test(cookie)) {
    const error = new Error('还没有检测到微博登录 Cookie，请扫码并确认登录。');
    error.status = 400;
    throw error;
  }
  assertCookieHeaderInput(cookie);
  const validation = await checkCookieValidity(cookie, signal);
  throwIfTaskCancelled(signal);
  if (!validation.ok) {
    const error = new Error(validation.message || '微博登录态校验失败，请重新扫码。');
    error.status = validation.invalid ? 401 : 502;
    throw error;
  }
  const saved = await upsertStoredCookie(cookie, validation, signal);
  throwIfTaskCancelled(signal);
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
  if (reason === 'qr-login') scheduleWeiboKeepalive();
  return {
    id: saved.id,
    savedAt: saved.savedAt,
    lastValidAt: saved.lastValidAt,
  };
}

async function closeWeiboLoginSession(message = '扫码窗口已关闭', { waitForRefresh = true } = {}) {
  if (weiboLoginCloseOperation) {
    await weiboLoginCloseOperation;
    return;
  }
  weiboLoginStopRevision += 1;
  const session = weiboLoginSession;
  const refreshOperation = waitForRefresh
    ? session?.refreshOperation || weiboLoginRefreshOperation
    : null;
  session?.controller?.abort();
  weiboLoginSession = null;
  const refreshWait = refreshOperation
    ? settlePromiseWithin(refreshOperation, weiboBrowserAbortCleanupMs)
    : null;
  if (!session) {
    if (refreshWait) await refreshWait;
    return;
  }
  clearTimeout(session.timer);
  const operation = (async () => {
    const closeOperation = closePersistentBrowserContext(
      session.context,
      weiboLoginProfileDir,
    ).catch(() => {});
    await Promise.allSettled([closeOperation, refreshWait].filter(Boolean));
    if (refreshOperation && weiboLoginRefreshOperation === refreshOperation) {
      weiboLoginRefreshOperation = null;
    }
    if (session.refreshOperation === refreshOperation) session.refreshOperation = null;
    await writeWeiboLoginState({
      lastStatus: session.status === 'logged_in' ? 'ok' : 'idle',
      lastMessage: message,
      lastError: session.status === 'error' ? session.error || '' : '',
    }).catch(() => {});
  })();
  weiboLoginCloseOperation = operation;
  try {
    await operation;
  } finally {
    if (weiboLoginCloseOperation === operation) weiboLoginCloseOperation = null;
  }
}

async function performWeiboLoginSessionRefresh({ includeScreenshot = true } = {}) {
  const session = weiboLoginSession;
  if (!session) return await publicWeiboLoginState();
  const signal = session.controller?.signal;
  try {
    throwIfTaskCancelled(signal);
    const saved = await saveBrowserCookieToPool(session.context, 'qr-login', { signal });
    throwIfTaskCancelled(signal);
    if (weiboLoginSession !== session) return await publicWeiboLoginState();
    session.status = 'logged_in';
    session.message = '扫码登录成功，Cookie 已保存到服务器。';
    session.updatedAt = new Date().toISOString();
    await closeWeiboLoginSession(session.message, { waitForRefresh: false });
    return await publicWeiboLoginState({ saved });
  } catch (error) {
    if (signal?.aborted || weiboLoginSession !== session) return await publicWeiboLoginState();
    if (error.status && error.status !== 400 && error.status !== 401 && !isCookieAuthError(error)) {
      session.status = 'error';
      session.error = safeError(error).message;
      session.message = session.error;
      await writeWeiboLoginState({
        lastStatus: 'error',
        lastMessage: session.message,
        lastError: session.error,
      });
      if (error.code === 'WEIBO_BROWSER_TASK_TIMEOUT') {
        await closeWeiboLoginSession(session.message, { waitForRefresh: false });
      }
      return await publicWeiboLoginState();
    }
    session.status = 'waiting_scan';
    session.message = '等待你使用微博 App 扫码并确认登录。';
    session.updatedAt = new Date().toISOString();
  }

  if (signal?.aborted || weiboLoginSession !== session) return await publicWeiboLoginState();
  let screenshot = '';
  if (includeScreenshot && session.page) {
    try {
      await waitForBrowserTask(openWeiboQrLoginPage(session.page), {
        signal,
        timeoutMs: weiboLoginPageTimeoutMs,
        message: '微博扫码登录页加载超时',
      });
      const image = await waitForBrowserTask(takeWeiboLoginScreenshot(session.page), {
        signal,
        timeoutMs: weiboLoginScreenshotTimeoutMs,
        message: '微博二维码截图生成超时',
      });
      screenshot = `data:image/png;base64,${Buffer.from(image).toString('base64')}`;
    } catch (error) {
      const message = `二维码截图生成失败：${safeError(error).message}`;
      session.message = message;
      if (error.code === 'WEIBO_BROWSER_TASK_TIMEOUT') {
        session.status = 'error';
        session.error = message;
        await closeWeiboLoginSession(message, { waitForRefresh: false });
        return await publicWeiboLoginState();
      }
    }
  }
  return await publicWeiboLoginState({ screenshot });
}

async function refreshWeiboLoginSession(options = {}) {
  if (weiboLoginRefreshOperation) return await weiboLoginRefreshOperation;
  const session = weiboLoginSession;
  const operation = Promise.resolve().then(() => performWeiboLoginSessionRefresh(options));
  weiboLoginRefreshOperation = operation;
  if (session) session.refreshOperation = operation;
  try {
    return await operation;
  } finally {
    if (weiboLoginRefreshOperation === operation) weiboLoginRefreshOperation = null;
    if (session?.refreshOperation === operation) session.refreshOperation = null;
  }
}

async function startWeiboLoginSession() {
  if (weiboLoginCloseOperation) {
    const error = new Error('上一次扫码浏览器正在清理，请稍后再试。');
    error.status = 409;
    throw error;
  }
  if (weiboLoginSession) return await refreshWeiboLoginSession();
  return await runWeiboBrowserOperation('扫码登录', async (operation) => {
    if (weiboLoginSession) return await refreshWeiboLoginSession();
    const stopRevision = weiboLoginStopRevision;
    const id = crypto.randomUUID();
    let context;
    try {
      context = await launchWeiboBrowserContext({ signal: operation.controller.signal });
    } catch (error) {
      if (operation.controller.signal.aborted || stopRevision !== weiboLoginStopRevision) {
        return await publicWeiboLoginState({ message: '扫码窗口已关闭。' });
      }
      throw error;
    }
    if (shutdownStarted || operation.controller.signal.aborted || stopRevision !== weiboLoginStopRevision) {
      await closePersistentBrowserContext(context, weiboLoginProfileDir).catch(() => {});
      return await publicWeiboLoginState({ message: '扫码窗口已关闭。' });
    }
    let page;
    try {
      page = context.pages()[0] || await context.newPage();
    } catch (error) {
      await closePersistentBrowserContext(context, weiboLoginProfileDir).catch(() => {});
      throw error;
    }
    if (shutdownStarted || operation.controller.signal.aborted || stopRevision !== weiboLoginStopRevision) {
      await closePersistentBrowserContext(context, weiboLoginProfileDir).catch(() => {});
      return await publicWeiboLoginState({ message: '扫码窗口已关闭。' });
    }
    const now = new Date();
    const session = {
      id,
      context,
      page,
      controller: new AbortController(),
      refreshOperation: null,
      status: 'starting',
      message: '正在打开微博登录页。',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + weiboLoginSessionTtlMs).toISOString(),
      error: '',
      timer: null,
    };
    weiboLoginSession = session;
    operation.controller.signal.addEventListener('abort', () => session.controller.abort(), { once: true });
    session.timer = setTimeout(() => {
      closeWeiboLoginSession('扫码窗口已超时关闭。').catch(() => {});
    }, weiboLoginSessionTtlMs);
    session.timer.unref?.();

    try {
      await waitForBrowserTask(openWeiboQrLoginPage(page), {
        signal: operation.controller.signal,
        timeoutMs: weiboLoginPageTimeoutMs,
        message: '微博扫码登录页加载超时',
      });
      if (weiboLoginSession !== session || stopRevision !== weiboLoginStopRevision) {
        await closePersistentBrowserContext(context, weiboLoginProfileDir).catch(() => {});
        return await publicWeiboLoginState({ message: '扫码窗口已关闭。' });
      }
      session.status = 'waiting_scan';
      session.message = '请用微博 App 扫码登录。';
      await writeWeiboLoginState({
        lastStatus: 'waiting_scan',
        lastMessage: session.message,
        lastError: '',
        lastReason: 'qr-login',
      });
      return await refreshWeiboLoginSession();
    } catch (error) {
      session.status = 'error';
      session.error = safeError(error).message;
      session.message = session.error;
      if (weiboLoginSession === session) {
        await closeWeiboLoginSession(session.message);
      } else {
        await closePersistentBrowserContext(context, weiboLoginProfileDir).catch(() => {});
      }
      return await publicWeiboLoginState();
    }
  });
}

async function refreshCookieFromBrowserProfile(reason = 'manual-refresh') {
  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();
  if (shutdownStarted) {
    return await publicWeiboLoginState({ message: '服务正在停止，本次保活已跳过。' });
  }
  if (weiboKeepaliveRunning) {
    scheduleWeiboKeepalive(weiboKeepaliveBusyRetryMs);
    return await publicWeiboLoginState({ message: '微博 Cookie 保活正在运行。' });
  }
  if (weiboLoginSession) {
    scheduleWeiboKeepalive(weiboKeepaliveBusyRetryMs);
    return await publicWeiboLoginState({ message: '扫码登录进行中，暂不启动保活。' });
  }
  const profileState = await readWeiboLoginState();
  const profileReady = await pathExists(weiboLoginProfileDir)
    && Boolean(profileState.lastLoginAt || profileState.lastSuccessAt);
  if (!profileReady) {
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
    scheduleWeiboKeepalive(weiboKeepaliveBusyRetryMs);
    return await publicWeiboLoginState({ message: `微博浏览器正在执行${weiboBrowserOperation.label}，本次保活已跳过。` });
  }

  return await runWeiboBrowserOperation('Cookie 保活', async (operation) => {
    const signal = operation.controller.signal;
    if (shutdownStarted) return await publicWeiboLoginState({ message: '服务正在停止，本次保活已跳过。' });
    weiboKeepaliveRunning = true;
    let context;
    try {
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
      context = await launchWeiboBrowserContext({ signal });
      weiboKeepaliveContext = context;
      const page = context.pages()[0] || await context.newPage();
      await waitForBrowserTask(
        page.goto('https://weibo.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 }),
        { signal, timeoutMs: 35_000, message: '微博保活页面载入超时' },
      );
      await sleep(2500, signal);
      const saved = await saveBrowserCookieToPool(context, reason, {
        signal,
        durationMs: Date.now() - startedAt.getTime(),
      });
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
      }).catch((eventError) => {
        console.warn(`Weibo keepalive event write failed: ${safeError(eventError).message}`);
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
      if (!shutdownStarted) {
        await collectSystemSample(`${reason}:after`).catch(() => {});
        scheduleWeiboKeepalive();
      }
    }
  });
}

function scheduleWeiboKeepalive(minimumDelayMs = 0) {
  if (!enableWeiboKeepalive || shutdownStarted) return;
  const revision = ++weiboKeepaliveScheduleRevision;
  clearTimeout(weiboKeepaliveTimer);
  weiboKeepaliveTimer = null;
  const forcedDelayMs = Math.max(0, finiteNumber(minimumDelayMs, 0));

  Promise.resolve()
    .then(async () => {
      let delayMs = weiboKeepaliveStartupDelayMs;
      try {
        const state = await readWeiboLoginState();
        if (!state.lastLoginAt && !state.lastSuccessAt) return;
        if (forcedDelayMs) {
          delayMs = Math.max(delayMs, forcedDelayMs);
        } else {
          const nextAt = nextWeiboKeepaliveAt(state);
          if (nextAt) delayMs = Math.max(1000, Date.parse(nextAt) - Date.now());
        }
      } catch (error) {
        console.warn(`Weibo keepalive schedule check failed: ${safeError(error).message}`);
      }
      if (shutdownStarted || revision !== weiboKeepaliveScheduleRevision) return;
      const maxTimerDelay = 2_147_000_000;
      weiboKeepaliveTimer = setTimeout(async () => {
        weiboKeepaliveTimer = null;
        if (shutdownStarted || revision !== weiboKeepaliveScheduleRevision) return;
        let busyRetry = false;
        try {
          await refreshCookieFromBrowserProfile('scheduled-refresh');
        } catch (error) {
          console.warn(`Weibo keepalive timer failed: ${safeError(error).message}`);
          busyRetry = error?.status === 409;
        } finally {
          if (!shutdownStarted && revision === weiboKeepaliveScheduleRevision) {
            scheduleWeiboKeepalive(busyRetry ? weiboKeepaliveBusyRetryMs : 0);
          }
        }
      }, Math.min(maxTimerDelay, delayMs));
      weiboKeepaliveTimer.unref?.();
    })
    .catch((error) => {
      console.warn(`Weibo keepalive scheduler failed: ${safeError(error).message}`);
    });
}

async function prepareCookieCandidates(body, reportProgress, { allowCookieStoreWrite = false, signal } = {}) {
  throwIfTaskCancelled(signal);
  const failures = [];
  const supplied = cleanCookieHeader(body.mobileCookie);

  const store = allowCookieStoreWrite
    ? null
    : await waitForPromiseOrAbort(readCookieStore(), signal);
  const summary = allowCookieStoreWrite
    ? await validateStoredCookies(reportProgress, signal)
    : cookieStoreSummary(store, { checkSkipped: Boolean(cookieWriteKey) });
  const currentStore = disableCookieStore
    ? { activeId: '', cookies: [] }
    : store || await waitForPromiseOrAbort(readCookieStore(), signal);
  const storedCandidates = usableStoredCookies(
    sortCookieEntries(currentStore.cookies, currentStore.activeId),
  );
  const now = new Date().toISOString();
  const fallback = supplied
    ? {
        id: cookieFingerprint(supplied),
        cookie: supplied,
        savedAt: now,
        updatedAt: now,
        lastCheckedAt: '',
        lastValidAt: '',
        lastError: '',
      }
    : null;
  const candidates = cookieCandidatesWithFallback(storedCandidates, fallback);
  return { candidates, failures, summary };
}

async function fetchCookieRepostsWithPool({ statusId, body, reportProgress, allowCookieStoreWrite = false, signal }) {
  const { candidates, failures, summary } = await prepareCookieCandidates(body, reportProgress, {
    allowCookieStoreWrite,
    signal,
  });
  if (!candidates.length) {
    const detail = failures.length ? `；${failures.join('；')}` : '';
    const error = new Error(`服务器登录态不可用，也未填写备用 Cookie${detail}`);
    error.status = 400;
    throw error;
  }

  const serverCandidateCount = candidates.filter((entry) => !entry.transient).length;
  let serverCandidateIndex = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const entry = candidates[index];
    if (!entry.transient) serverCandidateIndex += 1;
    reportProgress?.({
      phase: 'cookie',
      percent: 8,
      message: entry.transient
        ? '服务器登录态不可用，正在尝试备用 Cookie'
        : `使用服务器登录态：${serverCandidateIndex}/${serverCandidateCount}`,
    });

    try {
      if (entry.transient) assertCookieHeaderInput(entry.cookie);
      throwIfTaskCancelled(signal);
      const result = await fetchCookieReposts({ statusId, mobileCookie: entry.cookie, reportProgress, signal });
      if (!entry.transient) clearCookieQuarantine(entry.id);
      if (!entry.transient && allowCookieStoreWrite) {
        await upsertStoredCookie(entry.cookie, {
          ok: true,
          checkedAt: new Date().toISOString(),
          lastValidAt: new Date().toISOString(),
        }, signal);
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
          ...(entry.transient ? ['备用 Cookie 仅用于当前抓取任务，未写入服务器 Cookie 池。'] : []),
          ...(result.meta?.warnings || []),
        ],
      };
      return result;
    } catch (error) {
      throwIfTaskCancelled(signal);
      failures.push(`${entry.transient ? '备用 Cookie' : `服务器登录态 ${serverCandidateIndex}`}不可用：${safeErrorMessage(error, 800)}`);
      if (isCookieAuthError(error)) {
        if (!entry.transient && allowCookieStoreWrite) await removeStoredCookie(entry.id);
        else if (!entry.transient) quarantineStoredCookie(entry.id);
        continue;
      }
      throw error;
    }
  }

  const error = new Error(failures.join('；') || '服务器登录态与备用 Cookie 均不可用');
  error.status = 401;
  throw error;
}

// Repost collection

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function storedCount(value, fallback = null, maximum = maxDrawStatCount) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum
    ? number
    : fallback;
}

function storedPositiveInteger(value, fallback = null, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= maximum
    ? number
    : fallback;
}

function invalidDrawRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function drawRequestCount(value, label, { fallback = null, maximum = maxDrawStatCount } = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return fallback;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw invalidDrawRequest(`${label}必须是非负整数`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    throw invalidDrawRequest(`${label}必须是 0 到 ${maximum} 之间的整数`);
  }
  return number;
}

function taskCancelledError() {
  const error = new Error('候选载入已取消');
  error.name = 'AbortError';
  error.code = 'REPOST_JOB_CANCELLED';
  error.status = 409;
  return error;
}

function throwIfTaskCancelled(signal) {
  if (signal?.aborted) throw taskCancelledError();
}

function waitForPromiseOrAbort(promise, signal) {
  if (!signal) return promise;
  throwIfTaskCancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(taskCancelledError());
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
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
    if (signal?.aborted) throw taskCancelledError();
    const wrapped = new Error(`请求微博接口失败或超时：${safeErrorMessage(error, 800)}`);
    wrapped.status = error.name === 'TimeoutError' || error.name === 'AbortError' ? 504 : 502;
    throw wrapped;
  }
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxWeiboResponseBytes) {
    await cancelResponseBody(response);
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

  const businessFailed = json?.ok === 0 || json?.ok === false;
  if (!response.ok || businessFailed || json.error || json.error_code) {
    const error = new Error(safeErrorMessage(
      json.error || json.msg || `微博接口返回 ${response.status}`,
      1200,
    ));
    error.status = /频繁|风控|too many/i.test(error.message)
      ? 429
      : /(未登录|登录已失效|请先登录)/i.test(error.message) ? 401 : response.ok ? 502 : response.status || 502;
    error.weibo = {
      errorCode: safeText(json.error_code, 120),
      request: safeText(json.request, 500),
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
    if (signal?.aborted) throw taskCancelledError();
    const wrapped = new Error(`请求微博页面失败或超时：${safeErrorMessage(error, 800)}`);
    wrapped.status = error.name === 'TimeoutError' || error.name === 'AbortError' ? 504 : 502;
    throw wrapped;
  }
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxWeiboResponseBytes) {
    await cancelResponseBody(response);
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

async function sleep(ms, signal) {
  throwIfTaskCancelled(signal);
  await new Promise((resolve, reject) => {
    let timer;
    const finish = () => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(taskCancelledError());
    };
    timer = setTimeout(finish, ms);
    timer.unref?.();
    if (!signal) return;
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

async function fetchWeiboResponse(url, options = {}) {
  const { signal: configuredSignal, onThrottle, ...requestOptions } = options;
  for (let attempt = 0; ; attempt += 1) {
    throwIfTaskCancelled(configuredSignal);
    const timeoutSignal = AbortSignal.timeout(fetchTimeoutMs);
    const response = await fetch(url, {
      ...requestOptions,
      redirect: 'error',
      signal: configuredSignal
        ? AbortSignal.any([configuredSignal, timeoutSignal])
        : timeoutSignal,
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
    await cancelResponseBody(response);
    onThrottle?.({
      status: response.status,
      delayMs,
      attempt: attempt + 1,
      maxAttempts: weiboThrottleRetryMax,
    });
    await sleepWithJitter(delayMs, Math.min(pageDelayJitterMs, 1000), configuredSignal);
  }
}

async function sleepWithJitter(baseMs, jitterMs = pageDelayJitterMs, signal) {
  const base = Math.max(0, finiteNumber(baseMs, 0));
  const jitter = Math.max(0, finiteNumber(jitterMs, 0));
  const offset = jitter ? Math.floor(Math.random() * jitter) : 0;
  if (base || offset) await sleep(base + offset, signal);
}

function throttleProgress(reportProgress, label) {
  return ({ status, delayMs, attempt, maxAttempts }) => reportProgress?.({
    phase: 'wait',
    message: `${label}返回 ${status}，等待 ${Math.ceil(delayMs / 1000)} 秒后重试（${attempt}/${maxAttempts}）`,
  });
}

async function waitBetweenPages(label, delayMs, reportProgress, page, signal) {
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
  await sleep(plan.delayMs, signal);
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

function normalizeOfficialAccessToken(value) {
  if (typeof value !== 'string') {
    throw invalidDrawRequest('官方访问凭据必须是文本');
  }
  if (Buffer.byteLength(value, 'utf8') > maxAccessTokenBytes) {
    const error = invalidDrawRequest(`官方访问凭据不能超过 ${maxAccessTokenBytes} 字节`);
    error.code = 'ACCESS_TOKEN_TOO_LARGE';
    throw error;
  }
  const token = value.trim();
  if (!token) {
    throw invalidDrawRequest('官方接口需要在页面输入本次使用的访问凭据');
  }
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(token)) {
    const error = invalidDrawRequest('官方访问凭据包含不允许的控制字符');
    error.code = 'ACCESS_TOKEN_INVALID_CHARACTERS';
    throw error;
  }
  return token;
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

async function fetchOfficialReposts({ statusId, accessToken, reportProgress, signal }) {
  const token = normalizeOfficialAccessToken(accessToken);

  const candidates = [];
  const candidateCollection = createCandidateCollection(candidates);
  const pages = [];
  const startedAt = Date.now();
  let totalNumber = null;
  let hitPageCap = false;
  let hitCandidateCap = false;
  let repeatedPages = false;
  const repeatedPageGuard = createRepeatedPageGuard();

  for (let page = 1; page <= OFFICIAL_MAX_PAGES; page += 1) {
    const apiUrl = new URL('https://api.weibo.com/2/statuses/repost_timeline.json');
    apiUrl.searchParams.set('id', statusId);
    apiUrl.searchParams.set('access_token', token);
    apiUrl.searchParams.set('count', String(OFFICIAL_PAGE_SIZE));
    apiUrl.searchParams.set('page', String(page));

    const json = await fetchJson(apiUrl, {
      signal,
      onThrottle: throttleProgress(reportProgress, '官方接口'),
    });
    const list = Array.isArray(json.reposts) ? json.reposts : [];
    totalNumber = Number.isFinite(Number(json.total_number)) ? Number(json.total_number) : totalNumber;
    pages.push({ page, count: list.length });
    const previousCount = candidates.length;
    hitCandidateCap = appendCandidates(candidateCollection, list, 'official');
    repeatedPages = repeatedPageGuard.observe(list.length, candidates.length - previousCount);
    if (hitCandidateCap) break;
    if (repeatedPages) break;
    if (totalNumber !== null && candidates.length >= totalNumber) break;
    if (list.length < OFFICIAL_PAGE_SIZE) break;
    if (page === OFFICIAL_MAX_PAGES) hitPageCap = true;
    await waitBetweenPages('官方接口', officialPageDelayMs, reportProgress, page, signal);
  }

  const unique = candidates;
  let headAddedCount = 0;
  let headReconciled = false;
  let headWarning = '';
  if (shouldReconcileRepostHead({
    pageCount: pages.length,
    elapsedMs: Date.now() - startedAt,
    hitCandidateCap,
  })) {
    try {
      reportProgress?.({ phase: 'official', percent: 97, message: '核对抓取期间新增的转发' });
      const headUrl = new URL('https://api.weibo.com/2/statuses/repost_timeline.json');
      headUrl.searchParams.set('id', statusId);
      headUrl.searchParams.set('access_token', token);
      headUrl.searchParams.set('count', String(OFFICIAL_PAGE_SIZE));
      headUrl.searchParams.set('page', '1');
      const headJson = await fetchJson(headUrl, {
        signal,
        onThrottle: throttleProgress(reportProgress, '官方接口'),
      });
      totalNumber = finiteNumber(headJson?.total_number, totalNumber);
      const headCandidates = (Array.isArray(headJson.reposts) ? headJson.reposts : [])
        .map((item) => normalizeCandidate(item, 'official'));
      const merged = prependCandidates(candidateCollection, headCandidates);
      headAddedCount = merged.addedCount;
      hitCandidateCap ||= Boolean(candidateCollection.limitReason);
      headReconciled = true;
    } catch (error) {
      throwIfTaskCancelled(signal);
      headWarning = `最新转发复核失败：${error.message}`;
    }
  }
  return {
    candidates: unique,
    meta: {
      provider: 'official',
      pages,
      totalNumber,
      pageSize: OFFICIAL_PAGE_SIZE,
      headReconciled,
      headAddedCount,
      ...candidateCollectionMeta(candidateCollection),
      complete: !hitPageCap && !hitCandidateCap && !repeatedPages && !headWarning && (totalNumber === null || unique.length >= totalNumber || pages.at(-1)?.count < OFFICIAL_PAGE_SIZE),
      warnings: [
        '已自动分页抓取全部可见转发；官方开放接口的配额和可见范围以账号权限为准。',
        ...(headAddedCount ? [`结束前补入 ${headAddedCount} 条刚新增的可见转发。`] : []),
        ...(headWarning ? [headWarning] : []),
        ...(repeatedPages ? ['官方接口连续返回重复页面，已停止无效分页请求。'] : []),
        ...(hitPageCap ? [`为避免异常长任务，本次在 ${OFFICIAL_MAX_PAGES} 页后停止。`] : []),
        ...candidateLimitWarnings(candidateCollection),
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

async function fetchDesktopStatusInfo({ statusId, cookie, signal }) {
  const apiUrl = new URL('https://weibo.com/ajax/statuses/show');
  apiUrl.searchParams.set('id', statusId);
  const json = await fetchJson(apiUrl, {
    signal,
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

async function fetchDesktopReposts({ statusId, cookie, statusInfo: initialStatusInfo, reportProgress, signal }) {
  const candidates = [];
  const candidateCollection = createCandidateCollection(candidates);
  const pages = [];
  const startedAt = Date.now();
  let totalNumber = null;
  let maxPage = null;
  let hitPageCap = false;
  let hitCandidateCap = false;
  let repeatedPages = false;
  let stoppedOnEmptyPages = false;
  const repeatedPageGuard = createRepeatedPageGuard();
  const emptyPageGuard = createEmptyPageGuard();
  let statusInfo = null;

  try {
    reportProgress?.({ phase: 'desktop', percent: 4, message: '读取微博正文信息' });
    statusInfo = initialStatusInfo || await fetchDesktopStatusInfo({ statusId, cookie, signal });
    totalNumber = statusInfo.repostsCount;
  } catch {
    throwIfTaskCancelled(signal);
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
      signal,
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
    const previousCount = candidates.length;
    hitCandidateCap = appendCandidates(candidateCollection, list, 'desktop-cookie');
    repeatedPages = repeatedPageGuard.observe(list.length, candidates.length - previousCount);
    const tooManyEmptyPages = emptyPageGuard.observe(list.length);
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
    if (repeatedPages) break;
    if (maxPage && tooManyEmptyPages) {
      stoppedOnEmptyPages = true;
      break;
    }
    if (!maxPage && list.length === 0) break;
    if (maxPage && page >= maxPage) break;
    if (page === DESKTOP_MAX_PAGES) hitPageCap = true;
    await waitBetweenPages('桌面端接口', desktopPageDelayMs, reportProgress, page, signal);
  }

  const unique = candidates;
  let headAddedCount = 0;
  let headReconciled = false;
  let headWarning = '';
  if (shouldReconcileRepostHead({
    pageCount: pages.length,
    elapsedMs: Date.now() - startedAt,
    hitCandidateCap,
  })) {
    try {
      reportProgress?.({ phase: 'desktop', percent: 97, message: '核对抓取期间新增的转发' });
      const headUrl = new URL('https://weibo.com/ajax/statuses/repostTimeline');
      headUrl.searchParams.set('id', timelineId);
      headUrl.searchParams.set('page', '1');
      headUrl.searchParams.set('moduleID', 'feed');
      headUrl.searchParams.set('count', String(DESKTOP_PAGE_SIZE));
      const headJson = await fetchJson(headUrl, {
        signal,
        headers: desktopHeaders(cookie, statusInfo.referer),
        onThrottle: throttleProgress(reportProgress, '桌面端接口'),
      });
      totalNumber = finiteNumber(headJson?.total_number, totalNumber);
      const headCandidates = desktopTimelineList(headJson)
        .map((item) => normalizeCandidate(item, 'desktop-cookie'));
      const merged = prependCandidates(candidateCollection, headCandidates);
      headAddedCount = merged.addedCount;
      hitCandidateCap ||= Boolean(candidateCollection.limitReason);
      headReconciled = true;
    } catch (error) {
      throwIfTaskCancelled(signal);
      headWarning = `最新转发复核失败：${error.message}`;
    }
  }
  return {
    candidates: unique,
    meta: {
      provider: 'desktop-cookie',
      pages,
      totalNumber,
      maxPage,
      statusInfo,
      headReconciled,
      headAddedCount,
      ...candidateCollectionMeta(candidateCollection),
      complete: !hitPageCap
        && !hitCandidateCap
        && !repeatedPages
        && !stoppedOnEmptyPages
        && !headWarning
        && (totalNumber !== null || candidates.length > 0),
      warnings: [
        '已按桌面端微博页面脚本的方式请求 ajax/statuses/repostTimeline，并扫描接口声明的页数范围。',
        ...(headAddedCount ? [`结束前补入 ${headAddedCount} 条刚新增的可见转发。`] : []),
        ...(headWarning ? [headWarning] : []),
        ...(repeatedPages ? ['桌面端接口连续返回重复页面，已停止无效分页请求。'] : []),
        ...(stoppedOnEmptyPages ? ['桌面端接口连续返回空页，已停止继续请求并尝试备用入口。'] : []),
        ...(hitPageCap ? [`为避免异常长任务，桌面端在 ${DESKTOP_MAX_PAGES} 页后停止。`] : []),
        ...candidateLimitWarnings(candidateCollection),
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
      const divRepostId = item.html.match(/\bid=(["'])M_([^"']+)\1/i)?.[2] || '';
      const statusAnchor = anchors.find((anchor) => /\/(?:comment|detail)\/[A-Za-z0-9]+/i.test(anchor.href));
      const linkedRepostId = statusAnchor?.href.match(/\/(?:comment|detail)\/([A-Za-z0-9]+)/i)?.[1] || '';
      const screenName = userAnchor?.text || item.text.split(':')[0] || '未命名用户';
      const createdAt = item.text.match(/\d{2}月\d{2}日\s+\d{2}:\d{2}|[\d:]+分钟前|昨天\s+\d{2}:\d{2}/)?.[0] || '';
      const cleanedText = item.text.replace(/^\[热门\]\s*/, '').trimStart();
      const text = cleanedText.startsWith(screenName)
        ? cleanedText.slice(screenName.length).replace(/^\s*:?\s*/, '').trim()
        : cleanedText.trim();
      return {
        idstr: divRepostId || linkedRepostId
          || `weibo-cn-${page}-${index}-${uid || crypto.createHash('sha1').update(item.text).digest('hex').slice(0, 10)}`,
        text,
        created_at: createdAt,
        user: {
          idstr: uid,
          screen_name: screenName,
        },
      };
    });
}

async function fetchLegacyReposts({ statusId, cookie, statusInfo, reportProgress, signal }) {
  const info = statusInfo || await fetchDesktopStatusInfo({ statusId, cookie, signal });
  if (!info.bid || !info.uid) {
    return {
      candidates: [],
      meta: {
        provider: 'weibo-cn',
        pages: [],
        totalNumber: info.repostsCount,
      complete: info.repostsCount !== null,
        warnings: ['旧版 weibo.cn 页面缺少 bid 或 uid，已跳过。'],
      },
    };
  }

  const candidates = [];
  const candidateCollection = createCandidateCollection(candidates);
  const pages = [];
  let totalNumber = info.repostsCount;
  let maxPage = null;
  let hitPageCap = false;
  let hitCandidateCap = false;
  let repeatedPages = false;
  let stoppedOnEmptyPages = false;
  const repeatedPageGuard = createRepeatedPageGuard();
  const emptyPageGuard = createEmptyPageGuard();

  for (let page = 1; page <= LEGACY_MAX_PAGES; page += 1) {
    const apiUrl = new URL(`https://weibo.cn/repost/${info.bid}`);
    apiUrl.searchParams.set('uid', info.uid);
    apiUrl.searchParams.set('rl', '1');
    apiUrl.searchParams.set('page', String(page));
    const html = await fetchText(apiUrl, {
      signal,
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
    const previousCount = candidates.length;
    hitCandidateCap = appendCandidates(candidateCollection, list, 'weibo-cn');
    repeatedPages = repeatedPageGuard.observe(list.length, candidates.length - previousCount);
    const tooManyEmptyPages = emptyPageGuard.observe(list.length);
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
    if (repeatedPages) break;
    if (maxPage && tooManyEmptyPages) {
      stoppedOnEmptyPages = true;
      break;
    }
    if (!maxPage && list.length === 0) break;
    if (maxPage && page >= maxPage) break;
    if (page === LEGACY_MAX_PAGES) hitPageCap = true;
    await waitBetweenPages('旧版页面', legacyPageDelayMs, reportProgress, page, signal);
  }

  return {
    candidates,
    meta: {
      provider: 'weibo-cn',
      pages,
      totalNumber,
      maxPage,
      ...candidateCollectionMeta(candidateCollection),
      complete: !hitPageCap && !hitCandidateCap && !repeatedPages && !stoppedOnEmptyPages,
      warnings: [
        '已补扫旧版 weibo.cn 转发页面；该页面必须使用 bid/mblogid，纯数字 mid 会返回目标不存在。',
        ...(repeatedPages ? ['旧版页面连续返回重复内容，已停止无效分页请求。'] : []),
        ...(stoppedOnEmptyPages ? ['旧版页面连续返回空页，已停止继续请求。'] : []),
        ...(hitPageCap ? [`为避免异常长任务，旧版页面在 ${LEGACY_MAX_PAGES} 页后停止。`] : []),
        ...candidateLimitWarnings(candidateCollection),
      ],
    },
  };
}

async function fetchMobileReposts({ statusId, mobileCookie, reportProgress, signal }) {
  const candidates = [];
  const candidateCollection = createCandidateCollection(candidates);
  const pages = [];
  const startedAt = Date.now();
  let hitPageCap = false;
  let hitCandidateCap = false;
  const cookie = cookieRequired(mobileCookie);
  let totalNumber = null;
  let maxPage = null;
  let repeatedPages = false;
  let stoppedOnEmptyPages = false;
  const repeatedPageGuard = createRepeatedPageGuard();
  const emptyPageGuard = createEmptyPageGuard();

  for (let page = 1; page <= MOBILE_MAX_PAGES; page += 1) {
    const apiUrl = new URL('https://m.weibo.cn/api/statuses/repostTimeline');
    apiUrl.searchParams.set('id', statusId);
    apiUrl.searchParams.set('page', String(page));

    const json = await fetchJson(apiUrl, {
      signal,
      headers: mobileHeaders(cookie, statusId),
      onThrottle: throttleProgress(reportProgress, 'H5 接口'),
    });
    const list = mobileTimelineList(json);
    const advertisedMax = finiteNumber(json?.data?.max || json?.max);
    if (advertisedMax) maxPage = Math.max(maxPage || 0, advertisedMax);
    totalNumber = finiteNumber(json?.data?.total_number ?? json?.total_number, totalNumber);
    pages.push({
      source: 'mobile',
      page,
      count: list.length,
      maxPage,
      ok: json?.ok,
      msg: json?.msg || '',
    });
    const previousCount = candidates.length;
    hitCandidateCap = appendCandidates(candidateCollection, list, 'mobile');
    repeatedPages = repeatedPageGuard.observe(list.length, candidates.length - previousCount);
    const tooManyEmptyPages = emptyPageGuard.observe(list.length);
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
    if (repeatedPages) break;
    if (maxPage && tooManyEmptyPages) {
      stoppedOnEmptyPages = true;
      break;
    }
    if (!maxPage && list.length === 0) break;
    if (maxPage && page >= maxPage) break;
    if (page === MOBILE_MAX_PAGES) hitPageCap = true;
    await waitBetweenPages('H5 接口', mobilePageDelayMs, reportProgress, page, signal);
  }

  const unique = candidates;
  let headAddedCount = 0;
  let headReconciled = false;
  let headWarning = '';
  if (shouldReconcileRepostHead({
    pageCount: pages.length,
    elapsedMs: Date.now() - startedAt,
    hitCandidateCap,
  })) {
    try {
      reportProgress?.({ phase: 'mobile', percent: 97, message: '核对抓取期间新增的转发' });
      const headUrl = new URL('https://m.weibo.cn/api/statuses/repostTimeline');
      headUrl.searchParams.set('id', statusId);
      headUrl.searchParams.set('page', '1');
      const headJson = await fetchJson(headUrl, {
        signal,
        headers: mobileHeaders(cookie, statusId),
        onThrottle: throttleProgress(reportProgress, 'H5 接口'),
      });
      totalNumber = finiteNumber(headJson?.data?.total_number ?? headJson?.total_number, totalNumber);
      const headCandidates = mobileTimelineList(headJson)
        .map((item) => normalizeCandidate(item, 'mobile'));
      const merged = prependCandidates(candidateCollection, headCandidates);
      headAddedCount = merged.addedCount;
      hitCandidateCap ||= Boolean(candidateCollection.limitReason);
      headReconciled = true;
    } catch (error) {
      throwIfTaskCancelled(signal);
      headWarning = `最新转发复核失败：${error.message}`;
    }
  }
  return {
    candidates: unique,
    meta: {
      provider: 'mobile',
      pages,
      totalNumber,
      maxPage,
      headReconciled,
      headAddedCount,
      ...candidateCollectionMeta(candidateCollection),
      complete: !hitPageCap
        && !hitCandidateCap
        && !repeatedPages
        && !stoppedOnEmptyPages
        && !headWarning
        && (totalNumber !== null || candidates.length > 0),
      cookieMode: Boolean(cookie),
      warnings: [
        '已按 H5 接口返回的页数范围扫描可见转发。',
        ...(headAddedCount ? [`结束前补入 ${headAddedCount} 条刚新增的可见转发。`] : []),
        ...(headWarning ? [headWarning] : []),
        ...(repeatedPages ? ['H5 接口连续返回重复页面，已停止无效分页请求。'] : []),
        ...(stoppedOnEmptyPages ? ['H5 接口连续返回空页，已停止继续请求并尝试备用入口。'] : []),
        ...(hitPageCap ? [`为避免异常长任务，本次在 ${MOBILE_MAX_PAGES} 页后停止。`] : []),
        ...candidateLimitWarnings(candidateCollection),
      ],
    },
  };
}

async function fetchCookieReposts({ statusId, mobileCookie, reportProgress, signal }) {
  const cookie = cookieRequired(mobileCookie);
  const warnings = [];
  const results = [];
  const authErrors = [];
  let statusInfo = null;

  try {
    reportProgress?.({ phase: 'status', percent: 2, message: '识别微博 mid / bid' });
    statusInfo = await fetchDesktopStatusInfo({ statusId, cookie, signal });
  } catch (error) {
    throwIfTaskCancelled(signal);
    if (isWeiboThrottleStatus(error?.status)) throw error;
    warnings.push(`微博正文信息读取失败：${error.message}`);
  }

  const providerPlan = [
    ['desktop', () => fetchDesktopReposts({ statusId, cookie, statusInfo, reportProgress, signal })],
    ['mobile', () => fetchMobileReposts({ statusId, mobileCookie: cookie, reportProgress, signal })],
    ['legacy', () => fetchLegacyReposts({ statusId, cookie, statusInfo, reportProgress, signal })],
  ];

  for (const [label, fetcher] of providerPlan) {
    throwIfTaskCancelled(signal);
    try {
      const result = await fetcher();
      const totalNumber = finiteNumber(result.meta?.totalNumber);
      results.push(result);
      const completeByCount = totalNumber === null
        ? result.candidates.length > 0
        : result.candidates.length >= totalNumber;
      const providerComplete = result.meta?.complete !== false && completeByCount;
      const reachedCandidateLimit = Boolean(result.meta?.candidateLimitReason);
      if (providerComplete || reachedCandidateLimit) break;
      const labelText = label === 'desktop' ? '桌面端' : label === 'mobile' ? 'H5' : '旧版页面';
      warnings.push(`${labelText}返回的候选不完整，已自动尝试备用入口补齐。`);
    } catch (error) {
      throwIfTaskCancelled(signal);
      if (isWeiboThrottleStatus(error?.status)) throw error;
      const labelText = label === 'desktop' ? '桌面端' : label === 'legacy' ? '旧版页面' : 'H5';
      if (isCookieAuthError(error)) authErrors.push(error);
      warnings.push(`${labelText}抓取失败：${error.message}`);
      continue;
    }
  }

  if (!results.length) {
    const error = new Error(warnings.join('；') || 'Cookie 抓取失败');
    error.status = authErrors.length ? 401 : 502;
    error.authFailed = authErrors.length > 0;
    throw error;
  }

  const aggregate = createCandidateCollection([]);
  let rawVisibleNumber = 0;
  for (const result of results) {
    rawVisibleNumber += result.candidates.length;
    if (appendCandidates(aggregate, result.candidates)) break;
  }
  const candidates = aggregate.candidates;
  const pages = results.flatMap((result) => result.meta?.pages || []);
  const totalNumber = results.reduce((max, result) => {
    const value = finiteNumber(result.meta?.totalNumber);
    return value === null ? max : Math.max(max || 0, value);
  }, null);
  const completeByCount = totalNumber === null
    ? candidates.length > 0
    : candidates.length >= totalNumber;
  const completeByProvider = totalNumber !== null
    ? completeByCount
    : candidates.length > 0 && results.some((result) => result.meta?.complete !== false);
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
      rawVisibleNumber,
      statusInfo,
      headReconciled: results.some((result) => result.meta?.headReconciled === true),
      headAddedCount: results.reduce((maximum, result) => Math.max(
        maximum,
        finiteNumber(result.meta?.headAddedCount, 0),
      ), 0),
      ...candidateCollectionMeta(aggregate),
      complete: !aggregate.limitReason && completeByProvider,
      cookieMode: true,
      warnings: [
        '已优先使用桌面端可见转发入口，并在需要时尝试备用入口。',
        ...warnings,
        visibilityWarning,
        ...sourceWarnings,
        ...candidateLimitWarnings(aggregate),
      ].filter(Boolean),
    },
  };
}

function normalizeRepostSource(value) {
  const source = String(value || 'mobile').trim().toLowerCase();
  if (source === 'mobile' || source === 'official') return source;
  const error = new Error('未知数据源');
  error.status = 400;
  throw error;
}

async function buildRepostsPayload(body, reportProgress, signal) {
  throwIfTaskCancelled(signal);
  const source = normalizeRepostSource(body.source);
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
      signal,
    });
  } else if (source === 'mobile') {
    result = await fetchCookieRepostsWithPool({
      statusId,
      body,
      reportProgress,
      allowCookieStoreWrite: body.allowCookieStoreWrite === true,
      signal,
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
      loadedAt: new Date().toISOString(),
    },
  };
}

// Jobs and draw API

async function runWithStatusLock(statusId, task, signal) {
  const key = String(statusId || '').trim();
  if (!key) return await task();
  const hadPrevious = statusLocks.has(key);
  const previous = (statusLocks.get(key) || Promise.resolve()).catch(() => {});
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => turn);
  statusLocks.set(key, tail);
  tail.then(() => {
    if (statusLocks.get(key) === tail) statusLocks.delete(key);
  });

  const operation = previous.then(async () => {
    throwIfTaskCancelled(signal);
    if (hadPrevious && sameStatusRequestGapMs) {
      await sleepWithJitter(sameStatusRequestGapMs, Math.min(pageDelayJitterMs, 500), signal);
    }
    return await task();
  });
  operation.then(release, release);
  return await waitForPromiseOrAbort(operation, signal);
}

function createJob(clientKey = '') {
  const id = crypto.randomUUID();
  const job = {
    id,
    clientKey,
    subscribers: new Map(),
    controller: new AbortController(),
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
    responseBody: null,
    responseBytes: 0,
    error: null,
    delivery: 'fresh',
    shareKey: '',
    cleanupTimer: null,
    queueTimer: null,
    runTimer: null,
    operation: null,
    timedOut: false,
  };
  jobs.set(id, job);
  return job;
}

function discardJob(job) {
  if (!job || jobs.get(job.id) !== job) return false;
  jobs.delete(job.id);
  clearTimeout(job.cleanupTimer);
  clearTimeout(job.queueTimer);
  clearTimeout(job.runTimer);
  job.body = null;
  job.result = null;
  job.responseBody = null;
  job.responseBytes = 0;
  job.subscribers.clear();
  if (job.shareKey && sharedRepostJobs.get(job.shareKey) === job) {
    sharedRepostJobs.delete(job.shareKey);
  }
  return true;
}

function retainedJobCount() {
  return Array.from(jobs.values())
    .filter((job) => job.status !== 'queued' && job.status !== 'running')
    .length;
}

function retainedJobResponseBytes() {
  return Array.from(jobs.values())
    .filter((job) => job.status !== 'queued' && job.status !== 'running')
    .reduce((total, job) => total + (job.responseBytes || 0), 0);
}

function repostSubscriberCount() {
  let count = 0;
  for (const job of jobs.values()) count += job.subscribers.size;
  return count;
}

function pruneRetainedJobs() {
  const retained = Array.from(jobs.values())
    .filter((job) => job.status !== 'queued' && job.status !== 'running')
    .sort((left, right) => Date.parse(left.finishedAt || 0) - Date.parse(right.finishedAt || 0));
  let retainedBytes = retained.reduce((total, job) => total + (job.responseBytes || 0), 0);
  while (
    retained.length > maxRetainedJobs
    || (retained.length > 1 && retainedBytes > maxRetainedJobResponseBytes)
  ) {
    const oldest = retained.shift();
    retainedBytes -= oldest?.responseBytes || 0;
    discardJob(oldest);
  }
}

function expireJobLater(job, delayMs = completedJobReleaseMs) {
  clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(() => discardJob(job), delayMs);
  job.cleanupTimer.unref?.();
  pruneRetainedJobs();
}

function finishQueuedJob(job, message, status = 'error') {
  if (!job || job.status !== 'queued') return false;
  const queueIndex = jobQueue.findIndex((item) => item === job);
  if (queueIndex >= 0) jobQueue.splice(queueIndex, 1);
  clearTimeout(job.queueTimer);
  job.queueTimer = null;
  job.status = status;
  job.error = message;
  job.progress = { phase: status, percent: 0, message };
  job.finishedAt = new Date().toISOString();
  job.updatedAt = job.finishedAt;
  clearJobCredentials(job);
  if (job.shareKey && sharedRepostJobs.get(job.shareKey) === job) sharedRepostJobs.delete(job.shareKey);
  expireJobLater(job, completedJobReleaseMs);
  return true;
}

function activeJobCount() {
  return Array.from(jobs.values()).filter((job) => job.status === 'running').length;
}

function queuedJobCount() {
  return jobQueue.filter((job) => job.status === 'queued').length;
}

function clientRepostJobCount(clientKey) {
  if (!clientKey) return 0;
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status !== 'queued' && job.status !== 'running') continue;
    for (const subscriber of job.subscribers.values()) {
      if (subscriber.clientKey === clientKey) count += 1;
    }
  }
  return count;
}

function jobQueuePosition(job) {
  return jobQueue.findIndex((item) => item.id === job.id) + 1;
}

function subscribeRepostJob(job, clientKey) {
  if (job.subscribers.size >= maxJobSubscribers) return '';
  const readToken = crypto.randomBytes(24).toString('base64url');
  const cancelToken = crypto.randomBytes(24).toString('base64url');
  job.subscribers.set(readToken, { cancelToken, clientKey });
  return { readToken, cancelToken };
}

function repostJobResponse(job, delivery = job.delivery, subscriber = null) {
  const readToken = String(subscriber?.readToken || '').trim();
  const cancelToken = String(subscriber?.cancelToken || '').trim();
  return {
    ok: true,
    jobId: job.id,
    status: job.status,
    ...(delivery ? { delivery } : {}),
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
    ...(readToken ? { readToken } : {}),
    ...(cancelToken ? { cancelToken } : {}),
  };
}

function findRepostSubscriber(job, token, field = 'readToken') {
  const supplied = String(token || '').trim();
  if (!supplied) return null;
  if (field === 'readToken') {
    for (const [readToken, subscriber] of job.subscribers) {
      if (timingSafeEqualText(supplied, readToken)) {
        return { readToken, cancelToken: subscriber.cancelToken };
      }
    }
    return null;
  }
  for (const [readToken, subscriber] of job.subscribers) {
    if (timingSafeEqualText(supplied, subscriber.cancelToken)) {
      return { readToken, cancelToken: subscriber.cancelToken };
    }
  }
  return null;
}

function cancelRepostSubscription(job, subscriber) {
  if (!job || !subscriber?.readToken || !job.subscribers.has(subscriber.readToken)) {
    return { detached: false, cancelled: false };
  }
  job.subscribers.delete(subscriber.readToken);
  if (job.subscribers.size) return { detached: true, cancelled: false };
  if (job.status === 'queued') {
    finishQueuedJob(job, '候选载入已取消', 'cancelled');
    drainJobQueue();
    return { detached: false, cancelled: true };
  }
  if (job.status === 'running') {
    job.progress = { ...job.progress, phase: 'cancelling', message: '正在取消候选载入' };
    job.updatedAt = new Date().toISOString();
    job.controller.abort();
    return { detached: false, cancelled: true };
  }
  return { detached: false, cancelled: false };
}

function cancelSubscriptionIfResponseCloses(res, job, subscriber) {
  const onClose = () => {
    if (!res.writableFinished) cancelRepostSubscription(job, subscriber);
  };
  const onFinish = () => res.removeListener('close', onClose);
  res.once('close', onClose);
  res.once('finish', onFinish);
}

function clearJobCredentials(job) {
  if (job.body) {
    job.body.mobileCookie = '';
    job.body.accessToken = '';
  }
  job.body = null;
}

async function repostCredentialScope(body) {
  const source = normalizeRepostSource(body?.source);
  const credential = source === 'official'
    ? String(body?.accessToken || '').trim()
    : cleanCookieHeader(body?.mobileCookie);
  const canWritePool = source === 'mobile' && body?.allowCookieStoreWrite === true;
  if (!credential && !canWritePool) return '';
  return crypto
    .createHmac('sha256', sourceFingerprintSecret)
    .update(`${source}:${canWritePool ? 'write-pool' : 'read-only'}:${credential}`)
    .digest('hex')
    .slice(0, 20);
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
  clearTimeout(job.queueTimer);
  job.queueTimer = null;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.updatedAt = job.startedAt;
  job.progress = { phase: 'start', percent: 1, message: '准备抓取微博转发列表' };
  const statusId = extractStatusId(job.body.statusUrl || job.body.statusId);
  job.runTimer = setTimeout(() => {
    if (job.status !== 'running') return;
    job.timedOut = true;
    job.progress = { ...job.progress, phase: 'timeout', message: '候选载入超过服务端时间限制，正在停止' };
    job.updatedAt = new Date().toISOString();
    job.controller.abort();
  }, jobRunTimeoutMs);
  job.runTimer.unref?.();

  const operation = runWithStatusLock(statusId, () => buildRepostsPayload(job.body, (progress) => {
    job.progress = {
      ...job.progress,
      ...progress,
      percent: Math.max(0, Math.min(100, finiteNumber(progress.percent, job.progress.percent))),
    };
    job.updatedAt = new Date().toISOString();
  }, job.controller.signal), job.controller.signal)
    .then((result) => {
      throwIfTaskCancelled(job.controller.signal);
      job.status = 'done';
      job.result = result;
      job.progress = { phase: 'done', percent: 100, message: `抓取完成：${result.candidates.length} 条记录` };
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      repostSnapshotCache.set(job.shareKey, result);
      // A completed response is shared by subscribers; delivery is subscriber-specific.
      job.responseBody = Buffer.from(JSON.stringify(repostJobResponse(job, '')), 'utf8');
      job.responseBytes = job.responseBody.length;
      job.result = null;
    })
    .catch((error) => {
      const cancelled = !job.timedOut && (job.controller.signal.aborted || error?.code === 'REPOST_JOB_CANCELLED');
      const failedPhase = String(job.progress?.phase || '');
      job.status = cancelled ? 'cancelled' : 'error';
      job.error = job.timedOut
        ? `候选载入超过 ${formatDurationMs(jobRunTimeoutMs)}，已自动停止`
        : cancelled ? '候选载入已取消' : safeError(error).message;
      job.progress = {
        phase: cancelled ? 'cancelled' : 'error',
        percent: cancelled ? job.progress.percent : 100,
        message: job.error,
      };
      job.result = null;
      job.responseBody = null;
      job.responseBytes = 0;
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      if (!cancelled) {
        recordRuntimeEvent({
          category: 'reposts',
          action: 'load',
          status: 'error',
          message: `候选载入失败：${job.error}`,
          details: {
            statusId,
            phase: failedPhase,
            durationMs: Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt || job.createdAt)),
          },
        });
      }
    })
    .finally(() => {
      clearTimeout(job.runTimer);
      job.runTimer = null;
      clearJobCredentials(job);
      if (job.shareKey && sharedRepostJobs.get(job.shareKey) === job) {
        sharedRepostJobs.delete(job.shareKey);
      }
      if (job.operation === operation) job.operation = null;
      expireJobLater(job, completedJobReleaseMs);
      drainJobQueue();
    });
  job.operation = operation;
  return operation;
}

function drainJobQueue() {
  if (shutdownStarted) {
    for (const job of [...jobQueue]) finishQueuedJob(job, '服务器正在重启，候选载入已取消', 'cancelled');
    return;
  }
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
  job.queueTimer = setTimeout(() => {
    if (finishQueuedJob(job, `候选载入排队超过 ${formatDurationMs(jobQueueTimeoutMs)}，请稍后重试`)) {
      drainJobQueue();
    }
  }, jobQueueTimeoutMs);
  job.queueTimer.unref?.();
  updateQueuedProgress();
  drainJobQueue();
}

async function handleStartRepostsJob(req, res) {
  if (shutdownStarted) {
    return sendJson(res, 503, { ok: false, error: '服务器正在重启，请稍后重试' });
  }
  const body = await readJsonBody(req, maxRepostJobBodyBytes);
  body.source = normalizeRepostSource(body.source);
  if (body.source === 'official') {
    body.accessToken = normalizeOfficialAccessToken(body.accessToken);
  }
  body.allowCookieStoreWrite = canWriteCookieStore(req);
  const statusId = extractStatusId(body.statusUrl || body.statusId);
  if (!statusId) return sendJson(res, 400, { ok: false, error: '请输入微博链接、mid 或 bid' });
  const shareKey = repostTaskKey(statusId, {
    source: body.source,
    authScope: await repostCredentialScope(body),
  });
  const clientKey = clientRateKey(req);
  const sharedJob = shareKey ? sharedRepostJobs.get(shareKey) : null;

  if (sharedJob && (sharedJob.status === 'queued' || sharedJob.status === 'running')) {
    if (clientRepostJobCount(clientKey) >= maxClientRepostJobs) {
      return sendJson(res, 429, {
        ok: false,
        error: '当前页面已有候选载入任务，请等待完成后再试',
      });
    }
    const subscriber = subscribeRepostJob(sharedJob, clientKey);
    if (!subscriber) {
      return sendJson(res, 429, {
        ok: false,
        error: '同一微博正在被较多页面载入，请稍后再试',
      });
    }
    repostTaskStats.sharedRunning += 1;
    cancelSubscriptionIfResponseCloses(res, sharedJob, subscriber);
    return sendJson(res, 202, repostJobResponse(
      sharedJob,
      'shared-running',
      subscriber,
    ));
  }

  const snapshot = body.forceRefresh === true ? null : repostSnapshotCache.get(shareKey);
  if (snapshot) {
    const drawStats = await getDrawCountForStatus(statusId);
    const result = {
      ...snapshot.result,
      drawCount: drawStats.count,
      lastDrawnAt: drawStats.lastDrawnAt,
      meta: {
        ...(snapshot.result.meta || {}),
        snapshotAgeMs: snapshot.ageMs,
      },
    };
    repostTaskStats.recentSnapshot += 1;
    return sendJson(res, 200, {
      ok: true,
      jobId: '',
      status: 'done',
      delivery: 'recent-snapshot',
      queue: {
        position: 0,
        active: activeJobCount(),
        queued: queuedJobCount(),
        maxActive: maxActiveJobs,
        maxQueued: maxQueuedJobs,
      },
      progress: { phase: 'done', percent: 100, message: `已复用刚刚载入的 ${result.candidates.length} 条记录` },
      result,
      error: null,
    });
  }

  if (clientRepostJobCount(clientKey) >= maxClientRepostJobs) {
    return sendJson(res, 429, {
      ok: false,
      error: '当前页面已有候选载入任务，请等待完成后再试',
    });
  }

  if (queuedJobCount() >= maxQueuedJobs) {
    return sendJson(res, 429, {
      ok: false,
      error: `当前抓取队列已满，请稍后再试（MAX_QUEUED_JOBS=${maxQueuedJobs}）`,
    });
  }

  const job = createJob(clientKey);
  job.shareKey = shareKey;
  if (shareKey) sharedRepostJobs.set(shareKey, job);
  const subscriber = subscribeRepostJob(job, clientKey);
  if (!subscriber) {
    discardJob(job);
    return sendJson(res, 429, { ok: false, error: '当前载入任务订阅已满，请稍后再试' });
  }
  repostTaskStats.fresh += 1;
  enqueueRepostsJob(job, body);
  cancelSubscriptionIfResponseCloses(res, job, subscriber);
  return sendJson(res, 202, repostJobResponse(job, 'fresh', subscriber));
}

async function handleGetRepostsJob(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    return sendJson(res, 404, { ok: false, error: '任务不存在或已过期' });
  }
  const subscriber = findRepostSubscriber(job, firstHeaderValue(req.headers['x-job-read-token']));
  if (!subscriber) {
    return sendJson(res, 403, { ok: false, error: '无法读取这个载入任务' });
  }
  if (job.status === 'done' && job.responseBody) {
    return sendJsonBody(res, 200, job.responseBody);
  }
  return sendJson(res, 200, repostJobResponse(job, job.delivery, subscriber));
}

async function handleCancelRepostsJob(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) return sendJson(res, 404, { ok: false, error: '任务不存在或已过期' });
  const subscriber = findRepostSubscriber(
    job,
    firstHeaderValue(req.headers['x-job-cancel-token']),
    'cancelToken',
  );
  if (!subscriber) {
    return sendJson(res, 403, { ok: false, error: '无法取消这个载入任务' });
  }
  if (job.status === 'done' && job.responseBody) {
    return sendJsonBody(res, 200, job.responseBody);
  }
  const cancellation = cancelRepostSubscription(job, subscriber);
  if (cancellation.detached) {
    return sendJson(res, 200, {
      ...repostJobResponse(job, job.delivery, subscriber),
      detached: true,
      message: '已停止当前页面等待，服务器继续为其他页面载入候选',
    });
  }
  return sendJson(res, 200, repostJobResponse(job, job.delivery, subscriber));
}

async function handleCookieStatus(req, res, url) {
  const request = createRequestAbortSignal(req, res);
  try {
    const shouldCheck = url.searchParams.get('check') === '1';
    const canCheck = !shouldCheck || canWriteCookieStore(req);
    const store = await waitForPromiseOrAbort(readCookieStore(), request.signal);
    const summary = shouldCheck && canCheck
      ? await validateStoredCookies(undefined, request.signal)
      : cookieStoreSummary(store);
    const currentStore = shouldCheck && canCheck
      ? await waitForPromiseOrAbort(readCookieStore(), request.signal)
      : store;
    if (request.signal.aborted) return;
    const availability = cookieAvailability(currentStore);
    return sendJson(res, 200, {
      ok: true,
      hasCookie: Boolean(summary.hasCookie),
      cookieCount: Number(summary.cookieCount || 0),
      accountCount: Number(summary.accountCount || 0),
      lastValidAt: String(summary.lastValidAt || ''),
      ...availability,
      cookieStoreWriteProtected: Boolean(cookieWriteKey),
      checkSkipped: shouldCheck && !canCheck,
    });
  } finally {
    request.cleanup();
  }
}

async function handleDrawCount(req, res, url) {
  const statusId = extractStatusId(url.searchParams.get('statusId') || url.searchParams.get('statusUrl'));
  if (!statusId) {
    return sendJson(res, 200, {
      ok: true,
      statusId: '',
      statusUrl: '',
      drawCount: null,
      lastDrawnAt: '',
    });
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

async function handleSaveDraw(req, res) {
  const request = createRequestAbortSignal(req, res);
  try {
    let body;
    try {
      body = await drawBodyReadGate.run(
        (signal) => readJsonBody(req, maxDrawSaveBodyBytes, { signal }),
        { signal: request.signal },
      );
    } catch (error) {
      if (error?.status === 503 && !req.readableEnded) {
        error.closeConnection = true;
        beginRequestDrain(req, rejectedBodyDrainMs);
      }
      throw error;
    }
    return await drawWriteGate.run(() => saveDrawRecord(body, res));
  } finally {
    request.cleanup();
  }
}

async function saveDrawRecord(body, res) {
  const rawResultGroups = Array.isArray(body.results) ? body.results : [];
  const bodyWinners = Array.isArray(body.winners) ? body.winners : [];
  const sourceMeta = isPlainObject(body.sourceMeta) ? body.sourceMeta : {};
  const audit = isPlainObject(body.audit) ? body.audit : {};
  if (rawResultGroups.length > maxDrawResultGroups) {
    return sendJson(res, 400, { ok: false, error: `单次最多保存 ${maxDrawResultGroups} 个奖项` });
  }
  const groupedWinnerCount = rawResultGroups.reduce(
    (total, item) => total + (Array.isArray(item?.winners) ? item.winners.length : 0),
    0,
  );
  if (groupedWinnerCount > maxDrawWinners || bodyWinners.length > maxDrawWinners) {
    return sendJson(res, 400, { ok: false, error: `单次最多保存 ${maxDrawWinners} 位中奖用户` });
  }
  const totalCount = drawRequestCount(body.totalCount ?? body.candidateCount, '候选总数');
  const eligibleCount = drawRequestCount(body.eligibleCount ?? audit.eligibleCount, '可抽人数');
  const sourceTotalNumber = drawRequestCount(sourceMeta.totalNumber, '来源总数');
  const sourceVisibleNumber = drawRequestCount(sourceMeta.visibleNumber, '来源可见数');
  const sourceRawVisibleNumber = drawRequestCount(sourceMeta.rawVisibleNumber, '来源原始可见数');
  if (totalCount !== null && eligibleCount !== null && eligibleCount > totalCount) {
    throw invalidDrawRequest('可抽人数不能超过候选总数');
  }
  if (sourceTotalNumber !== null && sourceVisibleNumber !== null && sourceVisibleNumber > sourceTotalNumber) {
    throw invalidDrawRequest('来源可见数不能超过来源总数');
  }
  if (sourceVisibleNumber !== null && sourceRawVisibleNumber !== null && sourceRawVisibleNumber < sourceVisibleNumber) {
    throw invalidDrawRequest('来源原始可见数不能少于去重后的可见数');
  }
  const resultGroups = rawResultGroups
    .map((item, index) => {
      const winners = (Array.isArray(item?.winners) ? item.winners : [])
        .map(publicWinner)
        .filter((winner) => winner.uid || winner.screenName);
      const count = drawRequestCount(item?.prize?.count, `第 ${index + 1} 个奖项人数`, {
        fallback: winners.length,
        maximum: maxDrawWinners,
      });
      if (count !== winners.length) {
        throw invalidDrawRequest(`第 ${index + 1} 个奖项人数与中奖名单数量不一致`);
      }
      return {
        prize: publicPrize({ ...item?.prize, count }, index),
        winners,
      };
    })
    .filter((item) => item.winners.length);
  const fallbackWinners = bodyWinners
    .map(publicWinner)
    .filter((winner) => winner.uid || winner.screenName);
  const normalizedResults = resultGroups.length
    ? resultGroups
    : [{ prize: { name: '中奖名单', count: fallbackWinners.length, color: '' }, winners: fallbackWinners }];
  const winners = normalizedResults.flatMap((item) => item.winners);
  if (!winners.length) {
    return sendJson(res, 400, { ok: false, error: '没有可保存的中奖结果' });
  }
  if (eligibleCount !== null && winners.length > eligibleCount) {
    throw invalidDrawRequest('中奖人数不能超过可抽人数');
  }
  if (totalCount !== null && winners.length > totalCount) {
    throw invalidDrawRequest('中奖人数不能超过候选总数');
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
  const rules = publicDrawRules(isPlainObject(audit.rules) ? audit.rules : body.rules);
  const payload = {
    source: String(body.source || '').slice(0, 80),
    statusId,
    statusUrl,
    sourceMeta: {
      provider: String(sourceMeta.provider || '').slice(0, 80),
      providers: Array.isArray(sourceMeta.providers) ? sourceMeta.providers.map((item) => String(item).slice(0, 80)).slice(0, 10) : [],
      statusId,
      statusUrl,
      totalNumber: sourceTotalNumber,
      visibleNumber: sourceVisibleNumber,
      rawVisibleNumber: sourceRawVisibleNumber,
      complete: typeof sourceMeta.complete === 'boolean' ? sourceMeta.complete : null,
    },
    results: normalizedResults,
    winners,
    totalCount,
    eligibleCount,
    audit: {
      seed: String(audit.seed || body.seed || '').slice(0, 120),
      drawnAt: stableDrawnAt,
      statusId,
      statusUrl,
      candidateDigest: String(audit.candidateDigest || body.candidateDigest || '').slice(0, 120),
      eligibleCount,
      rules,
    },
    savedAt,
    drawnAt: stableDrawnAt,
    drawNumber: null,
    auditHash,
  };
  const persisted = await persistDrawRecord({
    statusId,
    auditHash,
    file,
    payload,
  });
  if (persisted.duplicate) {
    return sendJson(res, 200, {
      ok: true,
      savedAt: persisted.savedAt,
      auditHash,
      statusId,
      statusUrl,
      drawNumber: persisted.drawNumber,
      drawCount: persisted.drawCount,
      lastDrawnAt: persisted.lastDrawnAt,
      file: persisted.file,
      duplicate: true,
      prunedFiles: 0,
    });
  }
  let prunedFiles = 0;
  try {
    const retention = await pruneSavedDrawFiles();
    prunedFiles = retention.removedCount;
  } catch (error) {
    recordRuntimeEvent({
      category: 'records',
      action: 'retention',
      status: 'error',
      message: '开奖记录已保存，但历史记录清理失败',
      details: { error: safeError(error).message },
    });
  }
  await appendDrawAttempt({
    attemptId: auditHash,
    drawnAt: stableDrawnAt,
    statusId,
    statusUrl,
    source: payload.source,
    drawNumber: persisted.drawNumber,
    eligibleCount: payload.eligibleCount,
    candidateCount: payload.totalCount,
    prizeCount: normalizedResults.length,
  }).catch(() => {});

  return sendJson(res, 200, {
    ok: true,
    savedAt,
    auditHash,
    statusId,
    statusUrl,
    drawNumber: persisted.drawNumber,
    drawCount: persisted.drawCount,
    lastDrawnAt: persisted.lastDrawnAt,
    file: persisted.file,
    prunedFiles,
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

function emptyFileRemoval() {
  return {
    removedCount: 0,
    missingCount: 0,
    failedCount: 0,
    freedBytes: 0,
    failures: [],
    attempted: 0,
    pending: false,
    skippedRecent: 0,
    scannedEntries: 0,
    matchedFiles: 0,
  };
}

function mergeFileRemoval(target, source) {
  target.removedCount += Number(source?.removedCount || 0);
  target.missingCount += Number(source?.missingCount || 0);
  target.failedCount += Number(source?.failedCount || 0);
  target.freedBytes += Number(source?.freedBytes || 0);
  target.attempted += Number(source?.attempted || 0);
  target.skippedRecent += Number(source?.skippedRecent || 0);
  target.scannedEntries += Number(source?.scannedEntries || 0);
  target.matchedFiles += Number(source?.matchedFiles || 0);
  target.pending = target.pending || Boolean(source?.pending);
  for (const failure of source?.failures || []) {
    if (target.failures.length >= 20) break;
    target.failures.push(failure);
  }
  return target;
}

async function removeDrawFileBatch(files) {
  const items = Array.isArray(files) ? files : [];
  if (!items.length) return emptyFileRemoval();
  const removal = await removeFilesBestEffort(
    items,
    (item) => fs.unlink(item.filePath),
    { concurrency: fileCleanupConcurrency },
  );
  return { ...removal, attempted: items.length };
}

async function removeDrawFilesInBatches(files, maxAttempts = drawCleanupBatchSize) {
  const items = Array.isArray(files) ? files : [];
  const attemptLimit = Math.max(0, Math.floor(Number(maxAttempts)));
  const result = emptyFileRemoval();
  if (!items.length) return result;
  if (!attemptLimit) {
    result.pending = true;
    return result;
  }

  const selected = items.slice(0, attemptLimit);
  for (let index = 0; index < selected.length; index += drawCleanupBatchSize) {
    mergeFileRemoval(result, await removeDrawFileBatch(selected.slice(index, index + drawCleanupBatchSize)));
  }
  result.pending = items.length > selected.length;
  return result;
}

async function scanDrawFiles({
  limit = maxSavedDraws,
  scanMaxEntries = drawFileScanMaxEntries,
  scanBudgetMs = drawFileScanBudgetMs,
  signal,
} = {}) {
  throwIfRequestAborted(signal);
  const collectLimit = Math.max(0, Math.floor(Number(limit) || 0));
  const entryLimit = Number.isFinite(Number(scanMaxEntries))
    ? Math.max(0, Math.floor(Number(scanMaxEntries)))
    : Number.POSITIVE_INFINITY;
  const timeBudget = Number.isFinite(Number(scanBudgetMs))
    ? Math.max(1, Math.floor(Number(scanBudgetMs)))
    : Number.POSITIVE_INFINITY;
  const files = [];
  const scanStartedAt = Date.now();
  let scannedEntries = 0;
  let matchedFiles = 0;
  let totalBytes = 0;
  let truncated = false;
  let directory;
  try {
    directory = await fs.opendir(drawsDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        files,
        scannedEntries,
        matchedFiles,
        totalBytes,
        truncated,
        startedAt: scanStartedAt,
        finishedAt: Date.now(),
      };
    }
    throw error;
  }

  for await (const entry of directory) {
    throwIfRequestAborted(signal);
    if (scannedEntries >= entryLimit || Date.now() - scanStartedAt >= timeBudget) {
      truncated = true;
      break;
    }
    scannedEntries += 1;
    try {
      if (!entry.isFile() || !/^draw-[0-9A-Za-z._-]+\.json$/.test(entry.name)) continue;
      const filePath = path.join(drawsDir, entry.name);
      const stat = await fs.stat(filePath);
      throwIfRequestAborted(signal);
      matchedFiles += 1;
      totalBytes += stat.size;
      if (collectLimit) {
        files.push({ file: entry.name, filePath, mtimeMs: stat.mtimeMs, size: stat.size });
        const trimThreshold = Math.max(collectLimit + 1, collectLimit * 2);
        if (files.length > trimThreshold) {
          files.splice(0, files.length, ...selectNewestFiles(files, collectLimit));
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  files.splice(0, files.length, ...selectNewestFiles(files, collectLimit));
  return {
    files,
    scannedEntries,
    matchedFiles,
    totalBytes,
    truncated,
    startedAt: scanStartedAt,
    finishedAt: Date.now(),
  };
}

async function scanCompletedDrawIndexFiles() {
  let scan = await scanDrawFiles({ limit: maxSavedDraws });
  if (!scan.truncated) return scan.files;

  scan = await scanDrawFiles({
    limit: maxSavedDraws,
    scanMaxEntries: drawRecoveryScanMaxEntries,
    scanBudgetMs: drawFileScanBudgetMs,
  });
  if (!scan.truncated) return scan.files;

  pruneSavedDrawFiles().catch(() => {});
  const error = new Error('开奖记录正在分批整理，请稍后重试');
  error.code = 'DRAW_INDEX_INCOMPLETE';
  error.status = 503;
  throw error;
}

async function performSavedDrawPrune() {
  const lastRunAt = new Date().toISOString();
  const initialScan = await scanDrawFiles({ limit: drawFileScanMaxEntries });
  let scan = initialScan;
  let recoveryScan = false;
  let removal = emptyFileRemoval();
  let cleanupPending = initialScan.truncated;

  if (initialScan.truncated) {
    recoveryScan = true;
    scan = await scanDrawFiles({
      limit: drawRecoveryScanMaxEntries,
      scanMaxEntries: drawRecoveryScanMaxEntries,
      scanBudgetMs: drawFileScanBudgetMs,
    });
    if (!scan.truncated) {
      const retention = selectFilesToPrune(scan.files, {
        maxFiles: maxSavedDraws,
        maxBytes: maxSavedDrawBytes,
        maxAgeMs: maxSavedDrawAgeMs,
      });
      mergeFileRemoval(removal, await removeDrawFilesInBatches(retention.removals));
    }
    cleanupPending = scan.truncated || removal.pending;
  } else {
    const retention = selectFilesToPrune(initialScan.files, {
      maxFiles: maxSavedDraws,
      maxBytes: maxSavedDrawBytes,
      maxAgeMs: maxSavedDrawAgeMs,
    });
    mergeFileRemoval(removal, await removeDrawFilesInBatches(retention.removals));
    cleanupPending = removal.pending;
  }

  if (removal.removedCount || removal.missingCount) invalidateCompletedDrawIndex();
  if (removal.failedCount) {
    console.warn(`Saved draw cleanup failed for ${removal.failedCount} file(s).`);
  }
  drawRetentionState = {
    lastRunAt,
    scannedEntries: scan.scannedEntries,
    matchedFiles: scan.matchedFiles,
    scanComplete: !scan.truncated,
    recoveryScan,
    removedCount: removal.removedCount,
    failedCount: removal.failedCount,
    missingCount: removal.missingCount,
    skippedRecent: removal.skippedRecent,
    totalBytes: Math.max(0, scan.totalBytes),
    retainedBytes: Math.max(0, scan.totalBytes - removal.freedBytes),
    freedBytes: Math.max(0, removal.freedBytes),
    running: false,
    lastError: '',
    cleanupPending: cleanupPending || removal.failedCount > 0,
  };
  return {
    removedCount: removal.removedCount,
    missingCount: removal.missingCount,
    failedCount: removal.failedCount,
    retainedBytes: Math.max(0, scan.totalBytes - removal.freedBytes),
    totalBytes: Math.max(0, scan.totalBytes),
    freedBytes: Math.max(0, removal.freedBytes),
    scannedEntries: scan.scannedEntries,
    matchedFiles: scan.matchedFiles,
    recoveryScan,
    skippedRecent: removal.skippedRecent,
    scanComplete: !scan.truncated,
    cleanupPending: drawRetentionState.cleanupPending,
  };
}

function pruneSavedDrawFiles() {
  if (drawRetentionOperation) return drawRetentionOperation;

  drawRetentionState = {
    ...drawRetentionState,
    running: true,
    lastError: '',
  };
  const operation = performSavedDrawPrune();
  drawRetentionOperation = operation;
  const finish = (error) => {
    if (drawRetentionOperation !== operation) return;
    drawRetentionOperation = null;
    if (error) {
      drawRetentionState = {
        ...drawRetentionState,
        running: false,
        lastError: safeError(error).message,
      };
    }
  };
  operation.then(() => finish(null), (error) => finish(error));
  return operation;
}

function drawFileReadError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function readDrawText(filePath, signal) {
  try {
    return await readTextFileWithinLimit(filePath, maxSavedDrawFileBytes, signal);
  } catch (error) {
    if (error?.code !== 'JSON_FILE_TOO_LARGE') throw error;
    throw drawFileReadError('开奖记录文件过大，已跳过读取', 'DRAW_RECORD_TOO_LARGE', 413);
  }
}

async function readDrawFile(fileName, { signal } = {}) {
  throwIfRequestAborted(signal);
  const safeName = safeDrawFileName(fileName);
  const filePath = path.join(drawsDir, safeName);
  const relativePath = path.relative(drawsDir, filePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    const error = new Error('开奖记录路径不正确');
    error.status = 400;
    throw error;
  }
  let text;
  try {
    text = await readDrawText(filePath, signal);
  } catch (error) {
    if (signal?.aborted) throwIfRequestAborted(signal);
    if (error.code === 'ENOENT') {
      error.status = 404;
      error.message = '开奖记录不存在';
    }
    throw error;
  }

  try {
    const record = JSON.parse(text);
    if (!isPlainObject(record)) throw new SyntaxError('开奖记录必须是 JSON 对象');
    return { file: safeName, filePath, record };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const isolatedPath = await isolateCorruptJsonFile(
      filePath,
      text,
      maxSavedDrawFileBytes,
    );
    invalidateCompletedDrawIndex();
    recordRuntimeEvent({
      category: 'records',
      action: 'isolate-corrupt',
      status: 'error',
      message: `损坏的开奖记录已隔离：${safeName}`,
      details: { file: safeName, isolated: path.basename(isolatedPath || '') },
    });
    const corruptError = new Error('开奖记录文件损坏，已移出有效记录目录');
    corruptError.code = 'CORRUPT_DRAW_RECORD';
    corruptError.status = 500;
    throw corruptError;
  }
}

function publicWinner(winner = {}) {
  const source = isPlainObject(winner) ? winner : {};
  return {
    uid: String(source.uid || source.id || '').slice(0, 80),
    screenName: String(source.screenName || source.name || '').slice(0, 120),
    avatar: safeAvatarUrl(source.avatar || source.profile_image_url),
  };
}

function publicPrize(prize = {}, fallbackIndex = 0) {
  const source = isPlainObject(prize) ? prize : {};
  return {
    name: String(source.name || `奖项${fallbackIndex + 1}`).slice(0, 80),
    count: storedCount(source.count, null, maxDrawWinners),
    color: String(source.color || '').slice(0, 32),
  };
}

function publicDrawRules(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return null;
  const filters = rules.filters && typeof rules.filters === 'object' && !Array.isArray(rules.filters)
      ? {
        keyword: String(rules.filters.keyword || '').slice(0, 100),
        mentionMin: storedCount(rules.filters.mentionMin, 0, 100),
        blocklistCount: storedCount(rules.filters.blocklistCount, 0, maxCandidates),
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
  const statusId = drawStatusIdFromPayload(record);
  const statusUrl = normalizeStatusUrl(
    record.statusUrl || record.audit?.statusUrl || record.sourceMeta?.statusUrl,
    statusId,
  ).slice(0, 500);
  const summary = {
    file,
    savedAt,
    drawnAt,
    source: String(record.source || record.sourceMeta?.provider || '').slice(0, 80),
    statusId,
    statusUrl,
    drawNumber: storedPositiveInteger(record.drawNumber),
    auditHash: String(record.auditHash || '').slice(0, 80),
    prizeCount: results.length,
    winnerCount: winners.length,
    totalCount: storedCount(record.totalCount ?? record.candidateCount, null),
    eligibleCount: storedCount(record.eligibleCount ?? record.audit?.eligibleCount, null),
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
      totalNumber: storedCount(record.sourceMeta?.totalNumber, null),
      visibleNumber: storedCount(record.sourceMeta?.visibleNumber, null),
      rawVisibleNumber: storedCount(record.sourceMeta?.rawVisibleNumber, null),
      complete: typeof record.sourceMeta?.complete === 'boolean' ? record.sourceMeta.complete : null,
    },
  };
}

function parseDrawListCursor(value) {
  const encoded = String(value || '').trim();
  if (!encoded) return null;
  try {
    if (encoded.length > 512) throw new Error('cursor too long');
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const mtimeMs = Number(parsed?.[0]);
    const file = String(parsed?.[1] || '');
    if (!Number.isFinite(mtimeMs) || mtimeMs < 0 || !/^draw-[0-9A-Za-z._-]+\.json$/.test(file)) {
      throw new Error('invalid cursor values');
    }
    return { mtimeMs, file };
  } catch {
    const error = new Error('开奖记录分页位置无效，请刷新后重试');
    error.code = 'INVALID_DRAW_CURSOR';
    error.status = 400;
    throw error;
  }
}

function encodeDrawListCursor(fileInfo) {
  if (!fileInfo) return '';
  return Buffer.from(JSON.stringify([fileInfo.mtimeMs, fileInfo.file]), 'utf8').toString('base64url');
}

function drawFileIsOlderThanCursor(fileInfo, cursor) {
  if (fileInfo.mtimeMs !== cursor.mtimeMs) return fileInfo.mtimeMs < cursor.mtimeMs;
  return fileInfo.file.localeCompare(cursor.file) < 0;
}

async function listSavedDraws({ limit = 100, offset = 0, cursor = null, search = '', signal } = {}) {
  throwIfRequestAborted(signal);
  const scan = await scanDrawFiles({ signal });
  const files = scan.files;
  const normalizedSearch = String(search || '').trim().toLowerCase();
  const pageOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const pageLimit = Math.max(1, Math.floor(Number(limit) || 1));
  const items = [];
  let matched = 0;
  let hasMore = false;
  let lastFileInfo = null;
  for (const fileInfo of files) {
    throwIfRequestAborted(signal);
    try {
      const { record } = await readDrawFile(fileInfo.file, { signal });
      throwIfRequestAborted(signal);
      const item = drawRecordPublic(record, fileInfo.file, false);
      const fullResults = drawResultGroups(record);
      const haystack = [
        item.file,
        item.statusId,
        item.statusUrl,
        item.source,
        item.auditHash,
        ...fullResults.map((result) => result.prize.name),
        ...fullResults.flatMap((result) => result.winners.map((winner) => (
          `${winner.screenName} ${winner.uid} ${result.prize.name}`
        ))),
      ].join(' ').toLowerCase();
      if (!normalizedSearch || haystack.includes(normalizedSearch)) {
        const followsCursor = !cursor || drawFileIsOlderThanCursor(fileInfo, cursor);
        if (followsCursor && (cursor || matched >= pageOffset)) {
          if (items.length >= pageLimit) {
            hasMore = true;
            break;
          }
          items.push({ ...item, size: fileInfo.size });
          lastFileInfo = fileInfo;
        }
        if (!cursor) matched += 1;
      }
    } catch (error) {
      if (signal?.aborted) throwIfRequestAborted(signal);
      if (error?.name === 'AbortError' || error?.code === 'REQUEST_ABORTED') throw error;
      if (error?.code !== 'ENOENT' && error?.code !== 'CORRUPT_DRAW_RECORD') {
        console.warn(`Saved draw list skipped ${fileInfo.file}: ${safeError(error).message}`);
      }
    }
  }
  return {
    items,
    hasMore,
    nextOffset: pageOffset + items.length,
    nextCursor: hasMore ? encodeDrawListCursor(lastFileInfo) : '',
    scanTruncated: scan.truncated,
    scannedEntries: scan.scannedEntries,
    matchedFiles: scan.matchedFiles,
    totalBytes: scan.totalBytes,
    retainedLimit: maxSavedDraws,
  };
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

function jsonArrayMaxBytes(filePath) {
  const resolved = path.resolve(filePath);
  if (resolved === path.resolve(systemMetricsFile)) return maxSystemMetricsFileBytes;
  if (resolved === path.resolve(adminEventsFile)) return maxAdminEventsFileBytes;
  if (resolved === path.resolve(feedbackFile)) return maxFeedbackFileBytes;
  return maxGenericStoredJsonBytes;
}

async function readJsonArray(filePath, options = {}) {
  return await readStoredJson(filePath, () => [], Array.isArray, {
    ...options,
    maxBytes: options.maxBytes ?? jsonArrayMaxBytes(filePath),
  });
}

async function writeJsonArray(filePath, items) {
  await writeJsonFileAtomic(filePath, items, {
    directoryMode: 0o700,
    fileMode: 0o600,
  });
}

function retainedFeedback(entries, now = Date.now()) {
  return retainRecentEntries(entries, {
    maxEntries: maxFeedbackEntries,
    maxAgeMs: maxFeedbackAgeMs,
    now,
  });
}

function withFeedbackLock(task) {
  return feedbackWriteGate.run(task);
}

async function appendFeedback(item) {
  return await withFeedbackLock(async () => {
    const stored = retainedFeedback(await readJsonArray(feedbackFile));
    const now = Date.now();
    const sourceDailyCount = stored.filter((entry) => (
      entry?.source === item.source
      && Date.parse(entry?.createdAt || 0) >= now - 24 * 60 * 60_000
    )).length;
    const globalHourlyCount = stored.filter((entry) => (
      Date.parse(entry?.createdAt || 0) >= now - 60 * 60_000
    )).length;
    if (sourceDailyCount >= feedbackSourceDailyMax || globalHourlyCount >= feedbackGlobalHourlyMax) {
      const error = new Error('反馈提交较多，请稍后再试');
      error.status = 429;
      throw error;
    }
    const duplicate = stored.find((entry) => (
      entry?.source === item.source
      && entry?.contentHash === item.contentHash
      && Date.parse(entry?.createdAt || 0) >= now - feedbackDuplicateWindowMs
    ));
    if (duplicate) {
      const error = new Error('相同反馈已经提交，请勿重复发送');
      error.status = 409;
      throw error;
    }
    await writeJsonFileAtomic(feedbackFile, retainedFeedback([...stored, item]), {
      directoryMode: 0o700,
      fileMode: 0o600,
    });
  });
}

async function pruneFeedback() {
  return await withFeedbackLock(async () => {
    const stored = await readJsonArray(feedbackFile);
    const retained = retainedFeedback(stored);
    if (retained.length !== stored.length) {
      await writeJsonFileAtomic(feedbackFile, retained, {
        directoryMode: 0o700,
        fileMode: 0o600,
      });
    }
    return { removedCount: stored.length - retained.length };
  });
}

async function listFeedback(limit = maxFeedbackEntries) {
  const stored = retainedFeedback(await readJsonArray(feedbackFile));
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
      status: item.status === 'handled' ? 'handled' : 'open',
      handledAt: String(item.handledAt || ''),
    }));
}

function safeFeedbackId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    const error = new Error('反馈编号不正确');
    error.status = 400;
    throw error;
  }
  return id;
}

async function updateStoredFeedback(id, change) {
  return await withFeedbackLock(async () => {
    const stored = retainedFeedback(await readJsonArray(feedbackFile));
    const index = stored.findIndex((item) => item?.id === id);
    if (index < 0) {
      const error = new Error('反馈不存在或已到期');
      error.status = 404;
      throw error;
    }
    const next = [...stored];
    next[index] = { ...next[index], ...change };
    await writeJsonFileAtomic(feedbackFile, next, {
      directoryMode: 0o700,
      fileMode: 0o600,
    });
    return next[index];
  });
}

async function deleteStoredFeedback(id) {
  return await withFeedbackLock(async () => {
    const stored = retainedFeedback(await readJsonArray(feedbackFile));
    const next = stored.filter((item) => item?.id !== id);
    if (next.length === stored.length) {
      const error = new Error('反馈不存在或已到期');
      error.status = 404;
      throw error;
    }
    await writeJsonFileAtomic(feedbackFile, next, {
      directoryMode: 0o700,
      fileMode: 0o600,
    });
  });
}

function sourceFingerprint(req) {
  return crypto
    .createHmac('sha256', sourceFingerprintSecret)
    .update(clientRateKey(req))
    .digest('hex')
    .slice(0, 12);
}

function boundedRuntimeValue(value, depth = 0) {
  if (typeof value === 'string') return safeText(value, 1200);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (depth >= 3) return safeText(String(value ?? ''), 300);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => boundedRuntimeValue(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return safeText(String(value ?? ''), 300);
  const result = {};
  for (const key of Object.keys(value).slice(0, 30)) {
    result[safeText(key, 80)] = boundedRuntimeValue(value[key], depth + 1);
  }
  return result;
}

function recordRuntimeEvent(event) {
  const value = boundedRuntimeValue(event);
  const normalized = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  runtimeEvents.push({
    ...normalized,
    at: new Date().toISOString(),
    status: safeText(normalized?.status, 32, 'info'),
    message: safeText(normalized?.message, maxErrorMessageChars),
  });
  if (runtimeEvents.length > 50) runtimeEvents.splice(0, runtimeEvents.length - 50);
}

async function appendAdminEvent(event) {
  if (adminEventPending >= maxAdminEventQueue) {
    adminEventDropped += 1;
    recordRuntimeEvent({
      category: 'admin-events',
      action: 'queue-full',
      status: 'warning',
      message: '后台事件写入队列已满，已跳过一条事件',
    });
    return false;
  }
  adminEventPending += 1;
  const queuedWrite = adminEventWrite
    .catch(() => {})
    .then(async () => {
      const stored = await readJsonArray(adminEventsFile);
      const value = boundedRuntimeValue(event);
      const normalized = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      stored.push({
        ...normalized,
        at: new Date().toISOString(),
        category: safeText(normalized?.category, 80, 'admin'),
        status: safeText(normalized?.status, 32, 'info'),
        message: safeText(normalized?.message, maxErrorMessageChars),
      });
      await writeJsonArray(adminEventsFile, stored.slice(-100));
    });
  adminEventWrite = queuedWrite.finally(() => {
    adminEventPending = Math.max(0, adminEventPending - 1);
  }).catch(() => {});
  return await queuedWrite;
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
  await metricsWriteQueue.enqueue(memorySamples.slice());
  return sample;
}

async function loadDiagnosticHistory() {
  const samples = await readJsonArray(systemMetricsFile);
  memorySamples.push(...samples.slice(-287));
}

async function measureDirectory(directory) {
  let size = 0;
  let itemCount = 0;
  let truncated = false;
  const pending = [directory];

  while (pending.length && !truncated) {
    const current = pending.pop();
    let handle;
    try {
      handle = await fs.opendir(current);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for await (const entry of handle) {
      if (itemCount >= diagnosticDirectoryMaxEntries) {
        truncated = true;
        break;
      }
      itemCount += 1;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) {
        try {
          size += (await fs.stat(target)).size;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  }
  return { size, itemCount, truncated };
}

async function directoryDiagnostic(filePath) {
  const cached = directoryDiagnosticCache.get(filePath);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await measureDirectory(filePath);
  directoryDiagnosticCache.set(filePath, {
    expiresAt: Date.now() + diagnosticDirectoryCacheMs,
    value,
  });
  return value;
}

async function scanCacheFiles(directory) {
  const files = [];
  const pending = [directory];
  let itemCount = 0;
  let truncated = false;

  while (pending.length && !truncated) {
    const current = pending.pop();
    let handle;
    try {
      handle = await fs.opendir(current);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for await (const entry of handle) {
      if (itemCount >= runtimeCacheScanMaxEntries) {
        truncated = true;
        break;
      }
      itemCount += 1;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(target);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(target);
          files.push({ file: target, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  }
  return { files, truncated };
}

async function removeRetiredRuntimeCaches(limit = 16) {
  let directory;
  try {
    directory = await fs.opendir(outputDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { removedCount: 0, failedCount: 0, remainingCount: 0 };
    }
    throw error;
  }
  const prefix = `${path.basename(runtimeCacheDir)}.retired-`;
  const retired = [];
  for await (const entry of directory) {
    if (entry.isDirectory() && entry.name.startsWith(prefix)) retired.push(entry.name);
  }
  retired.sort();
  let removed = 0;
  let failed = 0;
  for (const name of retired.slice(0, Math.max(1, limit))) {
    const target = path.join(outputDir, name);
    const relative = path.relative(outputDir, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    try {
      await fs.rm(target, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      failed += 1;
      console.warn(`Retired runtime cache cleanup failed: ${safeError(error).message}`);
    }
  }
  return {
    removedCount: removed,
    failedCount: failed,
    remainingCount: Math.max(0, retired.length - removed),
  };
}

async function pruneRuntimeCache() {
  const lastRunAt = new Date().toISOString();
  if (weiboLoginSession || weiboKeepaliveRunning || weiboBrowserOperation || weiboKeepaliveContext) {
    runtimeCacheCleanupState = {
      ...runtimeCacheCleanupState,
      lastRunAt,
      skippedReason: '浏览器任务正在运行',
    };
    return runtimeCacheCleanupState;
  }

  return await runWeiboBrowserOperation('运行缓存回收', async () => {
    const retiredCleanup = await removeRetiredRuntimeCaches();
    const removedProfileCaches = await prunePersistentProfileCaches(weiboLoginProfileDir);
    profileCacheCleanupState = {
      lastRunAt,
      removedCount: removedProfileCaches.length,
    };
    let scan;
    try {
      scan = await scanCacheFiles(runtimeCacheDir);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      scan = { files: [], truncated: false };
    }
    scan.files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (scan.truncated) {
      if (retiredCleanup.remainingCount > 0) {
        runtimeCacheCleanupState = {
          ...runtimeCacheCleanupState,
          lastRunAt,
          scannedFiles: scan.files.length,
          truncated: true,
          reset: false,
          retiredPendingCount: retiredCleanup.remainingCount,
          retiredCleanupFailures: retiredCleanup.failedCount,
          skippedReason: '上次待清理缓存尚未释放，已暂停创建新的待清理目录',
        };
        return runtimeCacheCleanupState;
      }
      const relative = path.relative(outputDir, runtimeCacheDir);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('浏览器运行缓存路径不在 output 目录内，已停止回收');
      }
      const retired = `${runtimeCacheDir}.retired-${Date.now()}-${crypto.randomUUID()}`;
      try {
        await fs.rename(runtimeCacheDir, retired);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await ensureBrowserRuntimeDirs(outputDir);
      let retiredCleanupFailed = false;
      await fs.rm(retired, { recursive: true, force: true }).catch((error) => {
        retiredCleanupFailed = true;
        console.warn(`Retired runtime cache cleanup failed: ${safeError(error).message}`);
      });
      directoryDiagnosticCache.delete(runtimeCacheDir);
      const removedBytes = scan.files.reduce((sum, item) => sum + Number(item.size || 0), 0);
      runtimeCacheCleanupState = {
        ...runtimeCacheCleanupState,
        lastRunAt,
        lastSuccessAt: lastRunAt,
        removedCount: scan.files.length,
        removedBytes,
        scannedFiles: scan.files.length,
        truncated: true,
        reset: true,
        retiredPendingCount: retiredCleanupFailed ? 1 : 0,
        retiredCleanupFailures: retiredCleanupFailed ? 1 : 0,
        skippedReason: '',
      };
      recordRuntimeEvent({
        category: 'storage',
        action: 'runtime-cache-reset',
        status: 'success',
        message: '浏览器运行缓存项目过多，已重建缓存目录',
        details: { scannedFiles: scan.files.length, removedBytes },
      });
      return runtimeCacheCleanupState;
    }
    const retention = selectFilesToPrune(scan.files, {
      maxFiles: runtimeCacheMaxFiles,
      maxBytes: runtimeCacheMaxBytes,
      maxAgeMs: runtimeCacheMaxAgeMs,
    });
    let removedCount = 0;
    let removedBytes = 0;
    for (const item of retention.removals) {
      try {
        await fs.rm(item.file, { force: true });
        removedCount += 1;
        removedBytes += item.size;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.warn(`Runtime cache file cleanup failed: ${safeError(error).message}`);
        }
      }
    }
    directoryDiagnosticCache.delete(runtimeCacheDir);
    runtimeCacheCleanupState = {
      ...runtimeCacheCleanupState,
      lastRunAt,
      lastSuccessAt: lastRunAt,
      removedCount,
      removedBytes,
      scannedFiles: scan.files.length,
      truncated: scan.truncated,
      reset: false,
      retiredPendingCount: retiredCleanup.remainingCount,
      retiredCleanupFailures: retiredCleanup.failedCount,
      skippedReason: '',
    };
    if (removedCount) {
      recordRuntimeEvent({
        category: 'storage',
        action: 'runtime-cache-prune',
        status: 'success',
        message: `浏览器运行缓存已回收 ${removedCount} 项`,
        details: { removedBytes },
      });
    }
    return runtimeCacheCleanupState;
  });
}

async function fileDiagnostic(label, filePath) {
  try {
    const stat = await fs.stat(filePath);
    const usage = stat.isDirectory()
      ? await directoryDiagnostic(filePath)
      : { size: stat.size, itemCount: 1, truncated: false };
    return {
      label,
      exists: true,
      type: stat.isDirectory() ? 'dir' : 'file',
      ...usage,
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
      fileDiagnostic('浏览器运行缓存', runtimeCacheDir),
      fileDiagnostic('浏览器运行目录', runtimeHomeDir),
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
      profileCacheCleanup: { ...profileCacheCleanupState },
    },
    runtime: {
      eventLoopMeanMs: delayMeanMs,
      eventLoopP99Ms: delayP99Ms,
      userCpuMs: Math.round(resources.userCPUTime / 1000),
      systemCpuMs: Math.round(resources.systemCPUTime / 1000),
      maxRssMb: Math.round((resources.maxRSS / 1024) * 10) / 10,
      involuntaryContextSwitches: resources.involuntaryContextSwitches,
      rateLimitBuckets: rateLimitBuckets.size,
      rateLimitEvictions,
      adminLoginBuckets: adminLoginLimiter.size(),
      revokedAdminSessions: revokedAdminSessions.size,
      avatarFetches: avatarFetchGate.active,
      avatarFetchQueue: avatarFetchGate.queued,
      drawBodyReads: drawBodyReadGate.active,
      drawBodyReadQueue: drawBodyReadGate.queued,
      drawWrites: drawWriteGate.active,
      drawWriteQueue: drawWriteGate.queued,
      feedbackWrites: feedbackWriteGate.active,
      feedbackWriteQueue: feedbackWriteGate.queued,
      metricsWriteActive: metricsWriteQueue.active,
      metricsWritePending: metricsWriteQueue.pending,
      metricsWriteCount: metricsWriteQueue.writeCount,
      metricsWriteCoalesced: metricsWriteQueue.coalescedCount,
      metricsWriteFailures: metricsWriteQueue.failureCount,
      metricsWriteLastFailureAt: metricsWriteQueue.lastFailureAt,
      metricsWriteLastSuccessAt: metricsWriteQueue.lastSuccessAt,
      adminEventQueue: adminEventPending,
      adminEventDropped,
      avatarCacheEntries: avatarCache.size,
      avatarCacheMb: bytesToMb(avatarCacheBytes),
      quarantinedCookies: quarantinedCookieCount(),
      runtimeCacheCleanup: { ...runtimeCacheCleanupState },
      drawRetention: { ...drawRetentionState },
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
      maxClientRepostJobs,
      maxRetainedJobs,
      maxRetainedJobResponseBytes,
      maxCandidatePayloadBytes,
      maxJobSubscribers,
      jobQueueTimeoutMs,
      jobQueueTimeoutText: formatDurationMs(jobQueueTimeoutMs),
      jobRunTimeoutMs,
      jobRunTimeoutText: formatDurationMs(jobRunTimeoutMs),
      completedJobReleaseMs,
      completedJobReleaseText: formatDurationMs(completedJobReleaseMs),
      maxCandidates,
      maxAccessTokenBytes,
      rateLimitMax,
      jobCreateRateLimitMax,
      drawSaveRateLimitMax,
      drawBodyReadConcurrency,
      maxQueuedDrawBodyReads,
      maxQueuedDrawWrites,
      maxDrawAttempts,
      maxDrawAttemptBytes,
      maxSavedDraws,
      maxSavedDrawBytes,
      maxSavedDrawFileBytes,
      maxDrawSequences,
      maxSavedDrawAgeDays,
      drawFileScanMaxEntries,
      drawCleanupBatchSize,
      fileCleanupConcurrency,
      maxCookieStoreFileBytes,
      maxWeiboLoginStateFileBytes,
      maxDrawSequenceFileBytes,
      maxSystemMetricsFileBytes,
      maxAdminEventsFileBytes,
      maxFeedbackFileBytes,
      maxFeedbackEntries,
      maxFeedbackAgeDays,
      feedbackSourceDailyMax,
      feedbackGlobalHourlyMax,
      maxQueuedFeedbackWrites,
      keepaliveEnabled: enableWeiboKeepalive,
      keepaliveIntervalMs: weiboKeepaliveIntervalMs,
      keepaliveIntervalText: formatDurationMs(weiboKeepaliveIntervalMs),
      keepaliveRetryMs: weiboKeepaliveRetryMs,
      keepaliveRetryText: formatDurationMs(weiboKeepaliveRetryMs),
      keepaliveStartupDelayMs: weiboKeepaliveStartupDelayMs,
      keepaliveStartupDelayText: formatDurationMs(weiboKeepaliveStartupDelayMs),
      browserLaunchTimeoutMs: weiboBrowserLaunchTimeoutMs,
      browserLaunchTimeoutText: formatDurationMs(weiboBrowserLaunchTimeoutMs),
      browserAbortCleanupMs: weiboBrowserAbortCleanupMs,
      browserAbortCleanupText: formatDurationMs(weiboBrowserAbortCleanupMs),
      browserDiskCacheBytes: weiboBrowserDiskCacheBytes,
      browserMediaCacheBytes: weiboBrowserMediaCacheBytes,
      playwrightBrowsersPathSet: Boolean(process.env.PLAYWRIGHT_BROWSERS_PATH),
      cookieStoreDisabled: disableCookieStore,
      cookieStoreWriteProtected: Boolean(cookieWriteKey),
      adminAccountEnabled: configuredAdminAccount(),
      adminSessionTtlMs,
      adminSessionTtlText: formatDurationMs(adminSessionTtlMs),
      adminScryptConcurrency,
      avatarFetchConcurrency,
      avatarFetchQueueMax,
      cookieAuthQuarantineMs,
      cookieAuthQuarantineText: formatDurationMs(cookieAuthQuarantineMs),
      runtimeCacheMaxFiles,
      runtimeCacheMaxBytes,
      runtimeCacheMaxAgeDays,
      maxAdminEventQueue,
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
  if (adminPasswordChecksActive >= adminScryptConcurrency) {
    res.setHeader('retry-after', '1');
    return sendJson(res, 429, { ok: false, error: '后台正在处理其他登录请求，请稍后重试' });
  }
  const userMatches = timingSafeEqualText(username, adminUsername);
  let passwordMatches = false;
  adminPasswordChecksActive += 1;
  try {
    passwordMatches = await verifyAdminPassword(password, adminPasswordHash);
  } finally {
    adminPasswordChecksActive -= 1;
  }
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
    secret: adminSessionSigningSecret(),
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
  if (session) {
    revokedAdminSessions.set(session.jti, session.exp);
    pruneRevokedAdminSessions();
  }
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
    listCompletedDrawRecords(),
    listDrawAttempts(),
    readCookieStore(),
    publicWeiboLoginState(),
    adminSystemSummary(),
  ]);
  const cookieSummary = cookieStoreSummary(cookieStore);
  const availability = cookieAvailability(cookieStore);
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
      maxPerClient: maxClientRepostJobs,
      retained: retainedJobCount(),
      maxRetained: maxRetainedJobs,
      retainedResponseBytes: retainedJobResponseBytes(),
      maxRetainedResponseBytes: maxRetainedJobResponseBytes,
      subscribers: repostSubscriberCount(),
      maxSubscribersPerTask: maxJobSubscribers,
      sameStatusLocks: statusLocks.size,
      sharedTasks: sharedRepostJobs.size,
      recentSnapshots: repostSnapshotCache.size,
      snapshotTtlMs: repostSnapshotTtlMs,
      maxSnapshots: maxRepostSnapshots,
      deliveries: { ...repostTaskStats },
    },
    cookie: {
      hasCookie: cookieSummary.hasCookie,
      cookieCount: cookieSummary.cookieCount,
      accountCount: cookieSummary.accountCount,
      ...availability,
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
  if (weiboBrowserOperation?.label === '扫码登录') {
    weiboBrowserOperation.controller.abort();
  }
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
  const request = createRequestAbortSignal(req, res);
  try {
    const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '', 10);
    const limit = Math.min(200, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 100));
    const requestedOffset = Number.parseInt(url.searchParams.get('offset') || '', 10);
    const offset = Math.min(
      maxSavedDraws,
      Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0),
    );
    const cursor = parseDrawListCursor(url.searchParams.get('cursor'));
    const search = String(url.searchParams.get('search') || '').slice(0, 200);
    const page = await listSavedDraws({ limit, offset, cursor, search, signal: request.signal });
    if (request.signal.aborted) return;
    return sendJson(res, 200, { ok: true, ...page });
  } finally {
    request.cleanup();
  }
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
    status: 'open',
    handledAt: '',
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

async function handleAdminFeedbackStatus(req, res, feedbackId) {
  const id = safeFeedbackId(feedbackId);
  const body = await readJsonBody(req, 4096);
  if (typeof body.handled !== 'boolean') {
    return sendJson(res, 400, { ok: false, error: '请提供正确的处理状态' });
  }
  const handledAt = body.handled ? new Date().toISOString() : '';
  const item = await updateStoredFeedback(id, {
    status: body.handled ? 'handled' : 'open',
    handledAt,
  });
  await appendAdminEvent({
    category: 'feedback',
    action: body.handled ? 'resolve' : 'reopen',
    status: 'ok',
    source: sourceFingerprint(req),
    message: body.handled ? '已将用户反馈标为已处理' : '已重新打开用户反馈',
  }).catch(() => {});
  return sendJson(res, 200, {
    ok: true,
    item: {
      id: item.id,
      status: item.status,
      handledAt: item.handledAt,
    },
  });
}

async function handleAdminDeleteFeedback(req, res, feedbackId) {
  const id = safeFeedbackId(feedbackId);
  await deleteStoredFeedback(id);
  await appendAdminEvent({
    category: 'feedback',
    action: 'delete',
    status: 'ok',
    source: sourceFingerprint(req),
    message: '已删除一条用户反馈',
  }).catch(() => {});
  return sendJson(res, 200, { ok: true, removed: id });
}

async function handleAdminDrawDetail(req, res, fileName) {
  const request = createRequestAbortSignal(req, res);
  try {
    const { file, record } = await readDrawFile(fileName, { signal: request.signal });
    if (request.signal.aborted) return;
    return sendJson(res, 200, { ok: true, item: drawRecordPublic(record, file, true) });
  } finally {
    request.cleanup();
  }
}

async function handleAdminDeleteDraw(req, res, fileName) {
  const safeName = safeDrawFileName(fileName);
  return await drawWriteGate.run(async () => {
    const filePath = path.join(drawsDir, safeName);
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return sendJson(res, 404, { ok: false, error: '开奖记录不存在' });
      }
      throw error;
    }
    invalidateCompletedDrawIndex();
    await appendAdminEvent({
      category: 'records',
      action: 'delete',
      status: 'ok',
      source: sourceFingerprint(req),
      message: `已删除开奖记录 ${safeName}`,
    }).catch(() => {});
    return sendJson(res, 200, { ok: true, removed: safeName });
  });
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
  if (/\.(?:avif|gif|jpe?g|png|webp)$/i.test(name)) {
    return { 'cache-control': 'public, max-age=2592000' };
  }
  return { 'cache-control': 'public, max-age=3600' };
}

function adminAssetName(pathname) {
  if (pathname === '/admin' || pathname === '/admin/') return 'admin.html';
  if (pathname === '/admin/admin.css') return 'admin.css';
  if (pathname === '/admin/admin.js') return 'admin.js';
  if (pathname === '/admin/admin-list-state.js') return 'admin-list-state.js';
  if (pathname === '/admin/api-response.js') return 'api-response.js';
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
    const safePath = await resolvePathWithin(adminRootRealPath, filePath);
    const content = await fs.readFile(safePath);
    res.writeHead(200, {
      ...securityHeaders(),
      'content-type': MIME[path.extname(safePath)] || 'application/octet-stream',
      'cache-control': assetName === 'admin.html' ? 'no-store' : 'no-cache',
      'x-robots-tag': 'noindex, nofollow',
    });
    res.end(content);
  } catch (error) {
    sendText(res, error?.code === 'STATIC_PATH_FORBIDDEN' ? 403 : 404, error?.code === 'STATIC_PATH_FORBIDDEN' ? 'Forbidden' : 'Not Found');
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
  let pathname = decodeRequestPath(requestUrl.pathname);
  if (pathname === '/') pathname = '/index.html';

  const requested = path.resolve(staticDir, `.${pathname}`);
  const relativePath = path.relative(staticDir, requested);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return sendText(res, 403, 'Forbidden');
  }

  try {
    const safeRequested = await resolvePathWithin(staticRootRealPath, requested);
    const stat = await fs.stat(safeRequested);
    const filePath = stat.isDirectory() ? path.join(safeRequested, 'index.html') : safeRequested;
    const safeFilePath = await resolvePathWithin(staticRootRealPath, filePath);
    const fileStat = await fs.stat(safeFilePath);
    if (!fileStat.isFile()) {
      const error = new Error('静态资源不是文件');
      error.code = 'ENOENT';
      throw error;
    }
    const content = await fs.readFile(safeFilePath);
    res.writeHead(200, {
      ...securityHeaders(),
      'content-type': MIME[path.extname(safeFilePath)] || 'application/octet-stream',
      ...staticCacheHeaders(safeFilePath),
    });
    res.end(content);
  } catch (error) {
    if (error?.code === 'STATIC_PATH_FORBIDDEN') {
      return sendText(res, 403, 'Forbidden');
    }
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
    let fallback;
    try {
      const safeIndexFile = await resolvePathWithin(staticRootRealPath, indexFile);
      fallback = await fs.readFile(safeIndexFile);
    } catch (fallbackError) {
      if (fallbackError?.code === 'STATIC_PATH_FORBIDDEN') {
        return sendText(res, 403, 'Forbidden');
      }
      fallback = Buffer.from(missingBuildHtml(), 'utf8');
    }
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
    if (url.pathname.startsWith('/api/admin/feedback/')) {
      const feedbackId = decodeRequestPath(url.pathname.replace('/api/admin/feedback/', ''));
      if (req.method === 'PATCH') return await handleAdminFeedbackStatus(req, res, feedbackId);
      if (req.method === 'DELETE') return await handleAdminDeleteFeedback(req, res, feedbackId);
    }
    if (url.pathname.startsWith('/api/admin/draws/')) {
      const fileName = decodeRequestPath(url.pathname.replace('/api/admin/draws/', ''));
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
      const jobId = decodeRequestPath(url.pathname.replace('/api/weibo/reposts/jobs/', ''));
      return await handleGetRepostsJob(req, res, jobId);
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/weibo/reposts/jobs/')) {
      const jobId = decodeRequestPath(url.pathname.replace('/api/weibo/reposts/jobs/', ''));
      return await handleCancelRepostsJob(req, res, jobId);
    }
    if (req.method === 'POST' && url.pathname === '/api/draws') {
      return await handleSaveDraw(req, res);
    }
    if (isApiPath(url.pathname)) {
      return sendJson(res, 404, { ok: false, error: '接口不存在' });
    }
    if (req.method === 'GET') return await serveStatic(req, res);
    return sendText(res, 405, 'Method Not Allowed');
  } catch (error) {
    const closeConnection = error?.closeConnection === true;
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
      console.error(`${req.method || 'REQUEST'} ${pathname || '/'} failed: ${normalized.message}`);
    }
    if (res.destroyed || res.writableEnded) return;
    if (closeConnection) {
      res.setHeader('connection', 'close');
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
  weiboKeepaliveScheduleRevision += 1;
  weiboLoginStopRevision += 1;
  weiboBrowserOperation?.controller?.abort();
  clearTimeout(weiboKeepaliveTimer);
  weiboKeepaliveTimer = null;
  console.log(`Received ${signal}; closing HTTP and Weibo browser resources.`);
  const forceExit = setTimeout(() => process.exit(1), 15_000);
  forceExit.unref?.();

  const jobOperations = [];
  const browserOperation = weiboBrowserOperation?.promise;
  const browserCleanupOperation = weiboBrowserCleanupOperation?.promise;
  for (const job of jobs.values()) {
    if (job.status === 'queued') {
      finishQueuedJob(job, '服务器正在重启，候选载入已取消', 'cancelled');
    } else if (job.status === 'running') {
      job.controller.abort();
      if (job.operation) jobOperations.push(job.operation);
    }
  }

  const httpClosed = new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
  const keepaliveContext = weiboKeepaliveContext;
  await Promise.all([
    httpClosed,
    Promise.allSettled(jobOperations),
    closeWeiboLoginSession('服务器正在重启，扫码窗口已关闭。').catch(() => {}),
    closePersistentBrowserContext(
      keepaliveContext,
      weiboLoginProfileDir,
    ).catch(() => {}),
    browserOperation?.catch(() => {}),
    browserCleanupOperation?.catch(() => {}),
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

async function startServer() {
  await loadDiagnosticHistory().catch((error) => {
    console.warn(`Diagnostic history load failed: ${safeError(error).message}`);
  });
  if (shutdownStarted) return;

  await collectSystemSample('startup').catch((error) => {
    console.warn(`Initial system sample failed: ${safeError(error).message}`);
  });
  if (shutdownStarted) return;

  try {
    await pruneSavedDrawFiles();
    if (shutdownStarted) return;
    await pruneFeedback();
    if (shutdownStarted) return;
    await pruneRuntimeCache();
  } catch (error) {
    console.warn(`Storage retention cleanup failed: ${safeError(error).message}`);
  }
  if (shutdownStarted) return;

  setInterval(() => {
    collectSystemSample('interval').catch((error) => {
      console.warn(`System sample failed: ${safeError(error).message}`);
    });
  }, 5 * 60_000).unref?.();

  setInterval(() => {
    pruneRateLimitBuckets();
    adminLoginLimiter.prune();
    pruneCookieAuthQuarantine();
    const now = Date.now();
    for (const [key, entry] of directoryDiagnosticCache) {
      if (entry.expiresAt <= now) directoryDiagnosticCache.delete(key);
    }
  }, 60_000).unref?.();

  setInterval(() => {
    Promise.all([pruneSavedDrawFiles(), pruneFeedback(), pruneRuntimeCache()]).catch((error) => {
      console.warn(`Storage retention cleanup failed: ${safeError(error).message}`);
    });
  }, 6 * 60 * 60_000).unref?.();

  scheduleWeiboKeepalive();

  if (isProduction && adminKey && Buffer.byteLength(adminKey) < 32) {
    console.warn('ADMIN_KEY is shorter than 32 bytes; account login remains the recommended admin access method.');
  }

  if (shutdownStarted) return;
  server.listen(port, host, () => {
    const address = server.address();
    const boundHost = typeof address === 'object' && address ? address.address : host;
    const displayHost = String(boundHost || host).includes(':') && !String(boundHost || host).startsWith('[')
      ? `[${boundHost || host}]`
      : boundHost || host;
    const boundPort = typeof address === 'object' && address?.port ? address.port : port;
    console.log(`Sameko Weibo Lottery running at http://${displayHost}:${boundPort}`);
    console.log(`Serving static files from ${staticDir}`);
  });
}

await startServer();
