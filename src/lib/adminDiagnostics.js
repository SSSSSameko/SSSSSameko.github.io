import { normalizeDiagnosticCategory, normalizeDiagnosticLevel } from './diagnostics.js';

export function diagnosticCount(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export const STOP_LABELS = {
  'count-reached': '已达到接口声明数量',
  'large-list-tolerance': '大名单缺口在容差内',
  'within-tolerance': '缺口在容差内',
  'stable-small-gap': '多渠道缺口稳定',
  'unknown-total': '接口未提供总数',
  'providers-exhausted': '可用渠道已尝试',
  'candidate-limit': '达到名单安全上限',
  'page-limit': '达到分页上限',
  'pagination-error': '后续分页异常',
  'repeated-pages': '分页重复',
  'empty-end': '后续页面为空',
  'declared-end': '接口声明分页结束',
  'short-page': '返回不足一页',
  'next-provider': '继续尝试下一渠道',
  skipped: '跳过此渠道',
};
export const stopLabel = (value) => STOP_LABELS[value] || String(value || '未记录');
const time = (value) => Date.parse(value || '') || 0;
const canonical = (value) => JSON.stringify(value, (_, item) => (
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item
));

// Only collapse mirrored terminal/result events with a trace ID and identical payload.
// Repeated uncorrelated errors may be distinct incidents and must remain visible.
export function diagnosticEvents(events = []) {
  const seen = new Set();
  return (Array.isArray(events) ? events : []).filter((item) => item && typeof item === 'object')
    .slice().sort((a, b) => time(b.at) - time(a.at)).filter((item) => {
      const data = item.details || {};
      const traceResult = data.crawlId && (item.action === 'load-result'
        || (item.action === 'provider-result' && data.finishedAt));
      if (!traceResult) return true;
      const key = canonical([item.action, item.level ?? item.status, data]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function filterDiagnosticEvents(events, { query = '', level = '', category = '', hours = '', now = Date.now() } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  const cutoff = Number(hours) > 0 ? now - Number(hours) * 3_600_000 : 0;
  return events.filter((item) => (!level || normalizeDiagnosticLevel(item.level ?? item.status) === level)
    && (!category || normalizeDiagnosticCategory(item.category) === category)
    && (!cutoff || time(item.at) >= cutoff)
    && (!needle || [item.message, item.action, item.requestId, JSON.stringify(item.details || {})]
      .join(' ').toLocaleLowerCase().includes(needle)));
}

export function crawlTraces(events) {
  const groups = new Map();
  for (const event of diagnosticEvents(events)) {
    const id = event.details?.crawlId;
    if (!id || !['provider-result', 'provider-error', 'load-result'].includes(event.action)) continue;
    if (!groups.has(id)) groups.set(id, { id, at: event.at, events: [], result: null });
    const group = groups.get(id);
    group.events.push(event);
    if (event.action === 'load-result' && !group.result) group.result = event.details;
  }
  return [...groups.values()].map((group) => ({ ...group,
    statusId: group.result?.statusId || group.events.find((event) => event.details?.statusId)?.details.statusId || '',
    steps: group.events.filter((event) => event.action !== 'load-result').reverse(),
  }));
}

export function sourceEvidence(meta = {}) {
  const total = diagnosticCount(meta.totalNumber);
  const visible = diagnosticCount(meta.visibleNumber);
  const missing = diagnosticCount(meta.missingCount) ?? (total !== null && visible !== null ? Math.max(0, total - visible) : null);
  return { total, visible, missing, percent: total > 0 && missing !== null ? missing / total * 100 : null,
    label: meta.complete === true ? '数量已达到' : meta.complete === false ? '部分名单' : '完整性未记录' };
}

// Export a strict allowlist, not raw event messages, URLs, headers, or arbitrary details.
// The technical disclosure inside the authenticated page is separate from copy/share.
export function diagnosticReport(events, version = '') {
  const counts = {};
  for (const event of events) {
    const key = normalizeDiagnosticLevel(event.level ?? event.status);
    counts[key] = (counts[key] || 0) + 1;
  }
  const safeId = (value) => /^[a-zA-Z0-9_-]{1,80}$/.test(String(value || '')) ? value : '未记录';
  return JSON.stringify({ version: /^\d+\.\d+\.\d+$/.test(version) ? version : '未知',
    scope: '当前筛选的近期事件；不代表全量历史', eventCount: events.length, levels: counts,
    crawls: crawlTraces(events).map((trace) => ({ crawlId: safeId(trace.id),
      statusId: safeId(trace.statusId), resultRecorded: Boolean(trace.result),
      ...sourceEvidence(trace.result || {}),
      stopReason: STOP_LABELS[trace.result?.stopReason] || '未记录',
      channels: trace.steps.map(({ action, details = {} }) => ({ action,
        returned: diagnosticCount(details.visibleNumber), added: diagnosticCount(details.addedCount),
        duplicates: diagnosticCount(details.duplicateCount), pages: diagnosticCount(details.pages),
        durationMs: diagnosticCount(details.durationMs), scanStopReason: STOP_LABELS[details.scanStopReason] || '未记录',
      })),
    })),
  }, null, 2);
}
