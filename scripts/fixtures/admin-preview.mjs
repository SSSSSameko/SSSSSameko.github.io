// Synthetic data only. No production accounts, cookies or draw records.
import { readReleaseInfo } from '../release-info.mjs';
import { fileURLToPath } from 'node:url';
const releaseInfo = readReleaseInfo(fileURLToPath(new URL('../../', import.meta.url)));

export const draws = Array.from({ length: 18 }, (_, index) => {
  const number = index + 1;
  const winner = { uid: `1000${number}`, screenName: `中奖用户 ${number}`, text: `测试转发 ${number}` };
  return {
    file: `draw-preview-${number}.json`,
    source: '微博转发',
    statusId: `P${number}`,
    statusUrl: `https://weibo.com/123/P${number}`,
    drawnAt: new Date(Date.now() - index * 3_600_000).toISOString(),
    savedAt: new Date().toISOString(),
    winnerCount: 1,
    winners: [winner],
    totalCount: 128 + index,
    eligibleCount: 120 + index,
    auditHash: `${number}`.padStart(64, '0'),
    results: [{ prize: { name: '一等奖', count: 1 }, winners: [winner] }],
  };
});

draws[0].statusUrl = 'javascript:alert(1)';
draws[0].winners[0].screenName = '<img src=x onerror="window.__adminXss=1">';

const samples = Array.from({ length: 24 }, (_, index) => ({
  cgroupCurrentMb: 210 + index * 4,
  cgroupAnonMb: 120 + index * 2,
}));

export const summary = {
  ok: true,
  adminEnabled: true,
  version: releaseInfo.version,
  releaseDate: releaseInfo.date,
  releaseTitle: releaseInfo.title,
  savedDrawCount: 18,
  cumulativeDrawCount: 1288,
  winnerCount: 18,
  cumulativeWinnerCount: 3512,
  cumulativeStatsSource: 'sequence-ledger-and-retained-files',
  cumulativeStatsUpdatedAt: '2026-09-13T04:00:00.000Z',
  recentAttempts: [],
  cookie: {
    accountCount: 2,
    cookieCount: 3,
    hasCookie: true,
    tryableAccountCount: 2,
    verifiedAccountCount: 1,
    pendingAccountCount: 1,
    checkFailedAccountCount: 1,
    quarantinedAccountCount: 0,
  },
  queue: {
    active: 1,
    queued: 0,
    maxActive: 2,
    maxQueued: 8,
    retained: 3,
    maxRetained: 24,
    subscribers: 5,
    maxSubscribersPerTask: 12,
    sameStatusLocks: 0,
    sharedTasks: 1,
    recentSnapshots: 1,
    snapshotTtlMs: 15_000,
    maxSnapshots: 2,
    deliveries: { fresh: 8, sharedRunning: 3, recentSnapshot: 2 },
  },
  weiboLogin: { status: 'idle', history: [] },
  system: {
    now: new Date().toISOString(),
    startedAt: new Date(Date.now() - 86_400_000).toISOString(),
    uptimeText: '1 天',
    nodeVersion: 'v24.0.0',
    platform: 'win32/x64',
    pid: 1234,
    hostname: 'preview',
    cpus: 2,
    loadAverage: [0.12, 0.2, 0.18],
    memory: {
      rssMb: 92,
      heapUsedMb: 42,
      heapTotalMb: 84,
      hostTotalMb: 2048,
      hostAvailableMb: 1320,
      hostUsedMb: 728,
      hostUsedPercent: 35.5,
      hostCachedMb: 340,
      hostSlabMb: 86,
      hostSlabReclaimableMb: 52,
      hostSlabUnreclaimableMb: 34,
      cgroupAvailable: true,
      cgroupCurrentMb: 300,
      cgroupPeakMb: 420,
      cgroupAnonMb: 166,
      cgroupReclaimableMb: 72,
      trend: { status: 'stable', perHourMb: 1.5 },
      samples,
    },
    browser: {
      processCount: 0,
      profileCacheCleanup: {
        lastRunAt: new Date(Date.now() - 7_200_000).toISOString(),
        removedCount: 4,
      },
    },
    runtime: {
      eventLoopP99Ms: 18,
      eventLoopMeanMs: 7,
      rateLimitBuckets: 3,
      adminLoginBuckets: 1,
      revokedAdminSessions: 2,
      requests: {
        total: 240,
        clientErrors: 2,
        serverErrors: 1,
        applicationErrors: 1,
        routeMisses: 1,
        probeRequests: 0,
        probeErrors: 0,
        slowestMs: 86,
        lastErrorAt: new Date().toISOString(),
      },
      http: {
        statusCounts: [{ status: 404, count: 2 }, { status: 503, count: 1 }],
        routeErrors: [{ status: 404, method: 'GET', path: '/api/missing', count: 2 }],
        recentErrors: [{
          at: new Date().toISOString(),
          requestId: 'request-12345678',
          method: 'GET',
          path: '/api/weibo/reposts/jobs/test',
          status: 503,
          elapsedMs: 86,
          upstream: { host: 'weibo.com', path: '/ajax/statuses/repostTimeline', status: 429 },
        }],
      },
      diagnostics: {
        total: 12,
        dropped: 0,
        byLevel: [
          { level: 'warning', label: '警告', count: 3 },
          { level: 'error', label: '错误', count: 2 },
        ],
        byCategory: [
          {
            category: 'weibo',
            label: '微博抓取',
            level: 'error',
            count: 2,
            lastAt: new Date().toISOString(),
            message: '桌面端抓取失败',
          },
          {
            category: 'security',
            label: '安全防护',
            level: 'warning',
            count: 3,
            lastAt: new Date().toISOString(),
            message: '扫描探测：GET /.env → 404',
          },
        ],
        buckets: [{
          category: 'security',
          level: 'warning',
          code: 'scanner-probe',
          action: 'GET /.env',
          count: 3,
          firstAt: new Date().toISOString(),
          lastAt: new Date().toISOString(),
        }],
        signals: [{
          key: 'scanner-scan',
          title: '疑似漏洞扫描',
          level: 'warning',
          count: 12,
          firstAt: new Date().toISOString(),
          lastAt: new Date().toISOString(),
          detail: '10 分钟内 12 次扫描探测',
        }],
        recent: [],
        signalWindowText: '10 分钟',
        signalThreshold: 8,
        edge: {
          enabled: true,
          available: true,
          path: 'sameko-access.log',
          scannerCount: 21,
          errorCount: 23,
          readAt: new Date().toISOString(),
          truncated: false,
          scanners: [{ method: 'GET', path: '/.env', count: 7 }],
          topSources: [],
        },
      },
    },
    service: {
      version: releaseInfo.version,
      memoryHighMb: 700,
      memoryMaxMb: 850,
      nextRecycleAt: new Date(Date.now() + 43_200_000).toISOString(),
      recycleIntervalText: '12 小时',
    },
    disk: { available: true, usedPercent: 38, usedMb: 3800, availableMb: 6200 },
    config: {
      browserDiskCacheBytes: 64 * 1024 * 1024,
      browserMediaCacheBytes: 16 * 1024 * 1024,
    },
    events: [{
      category: 'reposts',
      action: 'provider-error',
      status: 'error',
      message: '桌面端抓取失败',
      at: new Date().toISOString(),
      details: {
        statusId: '1234567890',
        upstream: { host: 'weibo.com', path: '/ajax/statuses/repostTimeline', status: 429 },
      },
    }],
    storage: [],
  },
};

export const feedback = [
  {
    id: 'feedback-1',
    category: 'problem',
    content: '<img src=x onerror="window.__feedbackXss=1">\n点击载入后没有反应。',
    createdAt: new Date().toISOString(),
    source: 'a1b2c3d4e5',
  },
  {
    id: 'feedback-2',
    category: 'suggestion',
    content: '希望增加开奖前的名单确认。',
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    source: 'f6e7d8c9b0',
  },
];

export const crawlMeta = { crawlId: 'preview-crawl-001', statusId: '1234567890', totalNumber: 200, visibleNumber: 180,
  missingCount: 20, tolerance: 40, complete: false, stopReason: 'large-list-tolerance', durationMs: 18200,
  loadedAt: new Date().toISOString(), identityUncertainCount: 0, providers: ['desktop', 'mobile'] };
draws[0].sourceMeta = crawlMeta;
summary.system.events.push(
  { at: new Date().toISOString(), action: 'load-result', category: 'weibo', level: 'warning', message: '保留部分名单', details: crawlMeta },
  ...['desktop', 'mobile'].map((provider, index) => ({ at: new Date(Date.now() - 1000 + index * 200).toISOString(),
    action: 'provider-result', category: 'weibo', level: 'info', message: `${provider} 返回候选`,
    details: { crawlId: crawlMeta.crawlId, statusId: crawlMeta.statusId, provider, finishedAt: new Date().toISOString(),
      visibleNumber: 180, addedCount: index ? 0 : 180, duplicateCount: index ? 180 : 0, pages: 10,
      scanStopReason: 'empty-end', durationMs: 6500 } })),
  { at: new Date().toISOString(), action: 'provider-error', level: 'error', category: 'weibo', message: '<img src=x onerror="window.__adminXss=1">',
    details: { crawlId: 'preview-crawl-002', statusId: '9876543210', provider: 'mobile' } },
);
