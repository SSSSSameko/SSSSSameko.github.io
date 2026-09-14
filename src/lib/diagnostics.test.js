import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyHttpFailure,
  diagnosticCategoryLabel,
  isScannerPath,
  normalizeDiagnosticCategory,
  normalizeDiagnosticLevel,
  securitySignalLabel,
  summarizeDiagnosticEvents,
  summarizeEdgeAccessLog,
} from './diagnostics.js';

test('normalizeDiagnosticCategory merges historical server categories', () => {
  assert.equal(normalizeDiagnosticCategory('reposts'), 'weibo');
  assert.equal(normalizeDiagnosticCategory('keepalive'), 'cookie');
  assert.equal(normalizeDiagnosticCategory('admin-events'), 'admin');
  assert.equal(normalizeDiagnosticCategory('server'), 'system');
  assert.equal(normalizeDiagnosticCategory('不存在的分类'), 'system');
  assert.equal(diagnosticCategoryLabel('reposts'), '微博抓取');
});

test('normalizeDiagnosticLevel accepts the historical status values', () => {
  assert.equal(normalizeDiagnosticLevel('ok'), 'info');
  assert.equal(normalizeDiagnosticLevel('success'), 'info');
  assert.equal(normalizeDiagnosticLevel('blocked'), 'warning');
  assert.equal(normalizeDiagnosticLevel('warning'), 'warning');
  assert.equal(normalizeDiagnosticLevel('critical'), 'critical');
  assert.equal(normalizeDiagnosticLevel(''), 'info');
});

test('isScannerPath recognises probes without matching normal routes', () => {
  assert.equal(isScannerPath('/.env.production'), true);
  assert.equal(isScannerPath('/.git/config'), true);
  assert.equal(isScannerPath('/wp-login.php'), true);
  assert.equal(isScannerPath('/api/mcp'), true);
  assert.equal(isScannerPath('/sitemap.xml'), true);
  assert.equal(isScannerPath('/api/weibo/reposts/jobs'), false);
  assert.equal(isScannerPath('/pd-sim/'), false);
  assert.equal(isScannerPath('/'), false);
});

test('classifyHttpFailure separates probes, auth, rate limits and server faults', () => {
  assert.deepEqual(
    classifyHttpFailure({ status: 404, path: '/.env' }),
    { category: 'security', level: 'warning', code: 'scanner-probe', label: '扫描探测' },
  );
  assert.equal(classifyHttpFailure({ status: 401, path: '/api/admin/summary' }).category, 'auth');
  assert.equal(classifyHttpFailure({ status: 401, path: '/api/admin/summary' }).code, 'admin-auth-rejected');
  assert.equal(classifyHttpFailure({ status: 403, path: '/api/draws' }).code, 'auth-rejected');
  assert.equal(classifyHttpFailure({ status: 429, path: '/api/feedback' }).code, 'rate-limited');
  assert.equal(classifyHttpFailure({ status: 400, path: '/api/draws' }).code, 'invalid-request');
  assert.equal(classifyHttpFailure({ status: 404, path: '/api/missing' }).level, 'info');
  assert.equal(classifyHttpFailure({ status: 503, path: '/api/weibo/draw-count' }).code, 'server-error');
  assert.equal(classifyHttpFailure({ status: 200, path: '/' }).level, 'info');
});

test('summarizeDiagnosticEvents groups by category and keeps the newest level', () => {
  const events = [
    { at: '2026-09-14T10:00:00.000Z', category: 'reposts', status: 'warning', message: '候选不完整' },
    { at: '2026-09-14T10:05:00.000Z', category: 'reposts', status: 'error', message: '桌面端抓取失败' },
    { at: '2026-09-14T10:06:00.000Z', category: 'storage', status: 'error', message: '缓存清理失败' },
  ];
  const summary = summarizeDiagnosticEvents(events, { limit: 2 });

  assert.equal(summary.total, 3);
  assert.deepEqual(summary.byLevel.map((item) => item.level), ['warning', 'error']);
  const weibo = summary.byCategory.find((item) => item.category === 'weibo');
  assert.equal(weibo.count, 2);
  assert.equal(weibo.level, 'error');
  assert.equal(weibo.message, '桌面端抓取失败');
  assert.equal(summary.recent.length, 2);
  assert.equal(summary.recent[0].message, '缓存清理失败');
});

test('summarizeEdgeAccessLog aggregates probes and masks client addresses', () => {
  const log = [
    JSON.stringify({
      ts: 1789000000,
      status: 404,
      request: { remote_ip: '203.0.113.24', method: 'GET', uri: '/.env?token=secret' },
    }),
    JSON.stringify({
      ts: 1789000001,
      status: 404,
      request: { remote_ip: '203.0.113.24', method: 'GET', uri: '/.env.local' },
    }),
    JSON.stringify({
      ts: 1789000002,
      status: 200,
      request: { remote_ip: '198.51.100.9', method: 'GET', uri: '/assets/app.js' },
    }),
    'not json',
  ].join('\n');
  const summary = summarizeEdgeAccessLog(log, { top: 5 });

  assert.equal(summary.parsed, 3);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(summary.statusCounts, [{ status: 200, count: 1 }, { status: 404, count: 2 }]);
  assert.equal(summary.scanners.length, 2);
  assert.equal(summary.scanners.every((item) => !item.path.includes('?')), true);
  assert.deepEqual(summary.topSources, [{ source: '203.0.x.x', count: 2 }]);
  assert.equal(summary.firstAt, new Date(1789000000 * 1000).toISOString());
});

test('securitySignalLabel falls back for unknown keys', () => {
  assert.equal(securitySignalLabel('scanner-scan'), '疑似漏洞扫描');
  assert.equal(securitySignalLabel('unknown'), '安全提醒');
});
