import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticCount, diagnosticEvents, filterDiagnosticEvents, crawlTraces, sourceEvidence, diagnosticReport } from './adminDiagnostics.js';

const step = { at: '2026-11-05T10:00:00Z', action: 'provider-result', level: 'info', category: 'weibo',
  details: { crawlId: 'crawl-a', statusId: '123', provider: 'desktop', finishedAt: '2026-11-05T10:00:00Z', visibleNumber: 180, addedCount: 180, duplicateCount: 0 } };
test('only mirrored result events are collapsed; repeated failures and independent crawls survive', () => {
  const repeatedError = { ...step, action: 'provider-error', level: 'error' };
  const items = diagnosticEvents([step, { ...step, at: '2026-11-05T10:00:01Z' }, repeatedError, repeatedError,
    { ...step, details: { ...step.details, crawlId: 'crawl-b' } }, { ...step, details: { visibleNumber: 180 } }, { ...step, details: { visibleNumber: 180 } }]);
  assert.equal(items.length, 6);
  assert.equal(crawlTraces(items).length, 2);
  assert.equal(crawlTraces(items)[0].result, null);
});
test('unknown totals never become zero; count differences do not prove completion', () => {
  for (const value of [null, undefined, '', false, -1, NaN]) assert.equal(diagnosticCount(value), null);
  assert.equal(diagnosticCount(0), 0);
  assert.deepEqual(sourceEvidence({ totalNumber: null, visibleNumber: 180, complete: false }), { total: null, visible: 180, missing: null, percent: null, label: '部分名单' });
  assert.equal(sourceEvidence({ totalNumber: 200, visibleNumber: 180 }).percent, 10);
  assert.equal(sourceEvidence({ totalNumber: 200, visibleNumber: 210 }).missing, 0);
  assert.equal(sourceEvidence({}).label, '完整性未记录');
});
test('filtering combines query, normalized severity, category and time window', () => {
  const events = [step, { ...step, level: 'warn', message: '分页受限', requestId: 'request-1' }];
  assert.equal(filterDiagnosticEvents(events, { query: 'CRAWL-A', level: 'warning', category: 'weibo', hours: 1, now: Date.parse('2026-11-05T10:30:00Z') }).length, 1);
  assert.equal(filterDiagnosticEvents(events, { query: 'request-1' }).length, 1);
  assert.equal(filterDiagnosticEvents(events, { hours: 1, now: Date.parse('2026-11-05T12:30:00Z') }).length, 0);
});
test('trace final results and strict diagnostic sharing exclude raw secrets', () => {
  const events = [step, { at: '2026-11-05T10:01:00Z', action: 'load-result', message: 'Cookie: private-value', details: {
    crawlId: 'crawl-a', statusId: '123', complete: false, totalNumber: 200, visibleNumber: 180, tolerance: 40,
    stopReason: 'large-list-tolerance', token: 'private-value', url: 'https://example.com?key=private-value',
  } }];
  assert.equal(crawlTraces(events)[0].result.complete, false);
  const report = diagnosticReport(events, '3.6.4');
  assert.doesNotMatch(report, /private-value|Cookie|https:/);
  assert.match(report, /大名单缺口在容差内/);
  assert.equal(JSON.parse(report).crawls[0].missing, 20);
  assert.equal(JSON.parse(report).crawls[0].channels[0].added, 180);
});
