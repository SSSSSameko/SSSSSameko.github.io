import { buildFilterSummary, DRAW_RANDOM_ALGORITHM, safeWeiboUrl } from './appCore.js';

export const DRAW_HISTORY_KEY = 'weibo-draw-history-v2';
export const DRAW_HISTORY_LIMIT = 50;
const DRAW_HISTORY_MAX_BYTES = 1_500_000;
export const DRAW_HISTORY_VERSION = 2;
const DRAW_HISTORY_BACKUP_KIND = 'sameko-weibo-draw-history';
const DRAW_HISTORY_BACKUP_VERSION = 1;

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function boundedText(value, maxLength) {
  return String(value || '').slice(0, maxLength);
}

function isQuotaError(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.name === 'QuotaExceededError'
    || error?.code === 22
    || error?.code === 1014
    || message.includes('quota');
}

function positiveLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallback;
}

function utf8ByteLength(value) {
  const text = String(value || '');
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).byteLength;
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(text, 'utf8');
  return text.length;
}

function normalizeWinner(winner = {}) {
  return {
    id: boundedText(winner.id || winner.repostId || winner.uid || winner.screenName, 160),
    uid: boundedText(winner.uid, 96),
    screenName: boundedText(winner.screenName || winner.name, 240),
    avatar: boundedText(winner.avatar, 2048),
    source: boundedText(winner.source, 80),
  };
}

function normalizeResults(results) {
  if (!Array.isArray(results)) return [];
  return results.map((group, index) => {
    const winners = Array.isArray(group?.winners)
      ? group.winners.map(normalizeWinner)
      : [];
    return {
      prize: {
        name: String(group?.prize?.name || `奖项 ${index + 1}`),
        count: finiteNonNegative(group?.prize?.count, winners.length),
        color: String(group?.prize?.color || ''),
      },
      winners,
    };
  });
}

function receiptSummary(results) {
  return results
    .map((group) => {
      const names = group.winners
        .map((winner) => winner.screenName || winner.uid)
        .filter(Boolean)
        .join('、');
      return `${group.prize.name}：${names || '暂无中奖用户'}`;
    })
    .join(' | ');
}

function localReceiptId(input, drawnAt, summary) {
  const stable = [
    input.statusId,
    input.statusUrl,
    drawnAt,
    summary,
  ].filter(Boolean).join('|');
  return `local-${stable || 'record'}`;
}

function validDrawNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function recordTimeText(record) {
  return String(record?.savedAt || record?.drawnAt || '').trim();
}

function compareRecordTime(left, right) {
  const leftText = recordTimeText(left);
  const rightText = recordTimeText(right);
  const leftTime = Date.parse(leftText);
  const rightTime = Date.parse(rightText);
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);
  if (leftValid && rightValid && leftTime !== rightTime) return leftTime - rightTime;
  if (leftValid !== rightValid) return leftValid ? 1 : -1;
  return leftText.localeCompare(rightText);
}

function stableRecordKey(record) {
  return [
    String(record?.drawnAt || ''),
    String(record?.savedAt || ''),
    String(record?.auditHash || ''),
    String(record?.id || ''),
    String(record?.file || ''),
    String(record?.recordState || ''),
    JSON.stringify(record?.results || []),
  ].join('\u0000');
}

function comparePreferredRecord(left, right) {
  const leftServer = left?.recordState === 'server' ? 1 : 0;
  const rightServer = right?.recordState === 'server' ? 1 : 0;
  if (leftServer !== rightServer) return rightServer - leftServer;

  const leftNumber = validDrawNumber(left?.drawNumber);
  const rightNumber = validDrawNumber(right?.drawNumber);
  if (Boolean(leftNumber) !== Boolean(rightNumber)) return rightNumber ? 1 : -1;

  const leftSaved = String(left?.savedAt || '').trim() ? 1 : 0;
  const rightSaved = String(right?.savedAt || '').trim() ? 1 : 0;
  if (leftSaved !== rightSaved) return rightSaved - leftSaved;
  return stableRecordKey(left).localeCompare(stableRecordKey(right));
}

export function completedDrawStats(records, statusId, targetAuditHash = '') {
  const unique = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (String(record?.statusId || '') !== String(statusId || '')) continue;
    const hash = String(record?.auditHash || '').trim();
    if (!hash) continue;
    const previous = unique.get(hash);
    if (!previous || comparePreferredRecord(record, previous) < 0) unique.set(hash, record);
  }

  const ordered = [...unique.values()].sort((left, right) => {
    const leftNumber = validDrawNumber(left?.drawNumber);
    const rightNumber = validDrawNumber(right?.drawNumber);
    if (Boolean(leftNumber) !== Boolean(rightNumber)) return leftNumber ? 1 : -1;
    if (leftNumber && rightNumber && leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }
    const timeOrder = compareRecordTime(left, right);
    if (timeOrder) return timeOrder;
    const leftDrawnAt = String(left?.drawnAt || '');
    const rightDrawnAt = String(right?.drawnAt || '');
    if (leftDrawnAt !== rightDrawnAt) return leftDrawnAt.localeCompare(rightDrawnAt);
    const hashOrder = String(left?.auditHash || '').localeCompare(String(right?.auditHash || ''));
    if (hashOrder) return hashOrder;
    return String(left?.id || '').localeCompare(String(right?.id || ''));
  });
  const targetIndex = ordered.findIndex((record) => (
    String(record.auditHash || '') === String(targetAuditHash || '')
  ));
  const targetNumber = Number(ordered[targetIndex]?.drawNumber);
  const persistedTargetNumber = Number.isSafeInteger(targetNumber) && targetNumber > 0
    ? targetNumber
    : null;

  return {
    count: ordered.length,
    drawNumber: targetIndex >= 0 ? persistedTargetNumber || targetIndex + 1 : null,
    lastDrawnAt: String(ordered.at(-1)?.drawnAt || ordered.at(-1)?.savedAt || ''),
  };
}

export function drawCountCopy({ source, count, completed }) {
  const safeCount = Math.max(0, Math.floor(Number(count || 0)));
  if (source === 'manual') {
    if (completed) return `手动名单 · 本机第 ${Math.max(1, safeCount)} 次开奖`;
    return safeCount > 0 ? `本机已完成 ${safeCount} 次手动开奖` : '手动名单';
  }
  if (completed && safeCount > 0) return `本链接第 ${safeCount} 次开奖`;
  return safeCount > 0 ? `此前已完成 ${safeCount} 次` : '本链接尚无开奖记录';
}

export function nextManualDrawNumber(history, excludeId = '') {
  const excluded = String(excludeId || '');
  let maximum = 0;
  for (const item of Array.isArray(history) ? history : []) {
    const receipt = normalizeDrawReceipt(item);
    if (receipt.source !== 'manual' || receipt.recordState !== 'server') continue;
    if (excluded && receipt.id === excluded) continue;
    if (Number.isSafeInteger(receipt.drawNumber) && receipt.drawNumber > maximum) {
      maximum = receipt.drawNumber;
    }
  }
  return maximum >= Number.MAX_SAFE_INTEGER ? null : maximum + 1;
}

export function normalizeDrawReceipt(input = {}) {
  const audit = input.audit && typeof input.audit === 'object' ? input.audit : {};
  const results = normalizeResults(input.results);
  const candidateCount = finiteNonNegative(input.candidateCount ?? input.totalCount);
  const eligibleCount = finiteNonNegative(input.eligibleCount ?? audit.eligibleCount);
  const parsedDrawNumber = Number(input.drawNumber);
  const drawNumber = input.drawNumber === null
    || input.drawNumber === undefined
    || !Number.isSafeInteger(parsedDrawNumber)
    || parsedDrawNumber < 1
    ? null
    : parsedDrawNumber;
  const drawnAt = String(input.drawnAt || audit.drawnAt || input.time || '');
  const summary = String(input.summary || receiptSummary(results));
  const auditHash = String(input.auditHash || '');
  const winnerCount = results.reduce((sum, group) => sum + group.winners.length, 0);

  return {
    id: String(input.id || auditHash || localReceiptId(input, drawnAt, summary)),
    source: String(input.source || 'manual'),
    statusId: String(input.statusId || audit.statusId || input.sourceMeta?.statusId || ''),
    statusUrl: safeWeiboUrl(input.statusUrl || audit.statusUrl || input.sourceMeta?.statusUrl),
    drawNumber,
    drawnAt,
    savedAt: String(input.savedAt || ''),
    time: String(input.time || drawnAt),
    results,
    total: winnerCount,
    summary,
    candidateCount,
    eligibleCount,
    excludedCount: finiteNonNegative(
      input.excludedCount,
      Math.max(0, candidateCount - eligibleCount),
    ),
    rules: input.rules && typeof input.rules === 'object'
      ? input.rules
      : audit.rules && typeof audit.rules === 'object'
        ? audit.rules
        : null,
    sourceMeta: input.sourceMeta && typeof input.sourceMeta === 'object'
      ? input.sourceMeta
      : {},
    seed: String(input.seed || audit.seed || ''),
    candidateDigest: String(input.candidateDigest || audit.candidateDigest || ''),
    auditHash,
    recordState: input.recordState === 'practice'
      ? 'practice'
      : input.recordState === 'server' || auditHash
        ? 'server'
        : 'local',
  };
}

export function upsertDrawReceipt(history, receipt) {
  const normalized = normalizeDrawReceipt(receipt);
  const items = Array.isArray(history) ? history : [];
  return [
    normalized,
    ...items
      .map(normalizeDrawReceipt)
      .filter((item) => item.id !== normalized.id),
  ]
    .sort((left, right) => String(right.drawnAt).localeCompare(String(left.drawnAt)))
    .slice(0, DRAW_HISTORY_LIMIT);
}

export function readDrawHistory(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(DRAW_HISTORY_KEY) || '[]');
    const items = Array.isArray(parsed)
      ? parsed
      : parsed?.version === DRAW_HISTORY_VERSION && Array.isArray(parsed.items)
        ? parsed.items
        : [];
    return items.map(normalizeDrawReceipt).slice(0, DRAW_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function writeDrawHistory(storage = globalThis.localStorage, history = [], options = {}) {
  const normalized = (Array.isArray(history) ? history : [])
    .map(normalizeDrawReceipt)
    .slice(0, DRAW_HISTORY_LIMIT);
  const serialize = (items) => JSON.stringify({
    version: DRAW_HISTORY_VERSION,
    items,
  });
  const maxBytes = positiveLimit(options.maxBytes, DRAW_HISTORY_MAX_BYTES);
  let items = normalized;
  let serialized;
  try {
    serialized = serialize(items);
  } catch {
    return {
      ok: false,
      items: [],
      stored: 0,
      dropped: normalized.length,
      bytes: 0,
      reason: 'serialize',
      attempts: 0,
    };
  }

  while (items.length > 1 && utf8ByteLength(serialized) > maxBytes) {
    items = items.slice(0, -1);
    serialized = serialize(items);
  }

  const tryStore = () => {
    if (typeof storage?.setItem !== 'function') {
      return { ok: false, reason: 'unavailable' };
    }
    try {
      storage.setItem(DRAW_HISTORY_KEY, serialized);
    } catch (error) {
      return { ok: false, reason: isQuotaError(error) ? 'quota' : 'unavailable' };
    }
    if (typeof storage.getItem === 'function') {
      try {
        if (storage.getItem(DRAW_HISTORY_KEY) !== serialized) {
          return { ok: false, reason: 'verify' };
        }
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    }
    return { ok: true, reason: '' };
  };

  let attempts = 0;
  let attempt = tryStore();
  attempts += 1;
  while (!attempt.ok && attempt.reason === 'quota' && items.length > 1) {
    items = items.slice(0, -1);
    serialized = serialize(items);
    attempt = tryStore();
    attempts += 1;
  }

  return {
    ok: attempt.ok,
    items,
    stored: attempt.ok ? items.length : 0,
    dropped: normalized.length - items.length,
    bytes: utf8ByteLength(serialized),
    reason: attempt.reason,
    attempts,
  };
}

export function serializeDrawHistoryBackup(history, createdAt = new Date().toISOString(), options = {}) {
  const normalized = (Array.isArray(history) ? history : [])
    .map(normalizeDrawReceipt)
    .filter((item) => item.drawnAt && item.results.some((group) => group.winners.length))
    .slice(0, DRAW_HISTORY_LIMIT);
  const maxBytes = Math.max(0, Number(options.maxBytes || 0));
  let items = normalized;
  let output = '';
  const serialize = (list) => JSON.stringify({
    kind: DRAW_HISTORY_BACKUP_KIND,
    version: DRAW_HISTORY_BACKUP_VERSION,
    createdAt,
    truncated: normalized.length > list.length,
    omittedCount: Math.max(0, normalized.length - list.length),
    items: list,
  }, null, 2);
  do {
    output = serialize(items);
    if (!maxBytes || utf8ByteLength(output) <= maxBytes || items.length <= 1) break;
    items = items.slice(0, -1);
  } while (items.length);
  if (maxBytes && utf8ByteLength(output) > maxBytes) {
    throw new Error('开奖记录备份超过浏览器可处理的大小，请先清理较早记录');
  }
  return output;
}

export function parseDrawHistoryBackup(content) {
  let parsed;
  try {
    parsed = JSON.parse(String(content || ''));
  } catch {
    throw new Error('备份文件不是有效的 JSON');
  }
  if (
    !parsed
    || parsed.kind !== DRAW_HISTORY_BACKUP_KIND
    || parsed.version !== DRAW_HISTORY_BACKUP_VERSION
    || !Array.isArray(parsed.items)
  ) {
    throw new Error('请选择由本应用导出的开奖记录备份');
  }
  const items = parsed.items
    .map(normalizeDrawReceipt)
    .filter((item) => item.drawnAt && item.results.some((group) => group.winners.length))
    .slice(0, DRAW_HISTORY_LIMIT);
  if (!items.length) throw new Error('备份中没有可恢复的开奖记录');
  return items;
}

export function mergeDrawHistory(currentHistory, importedHistory) {
  const records = new Map();
  for (const item of [...(currentHistory || []), ...(importedHistory || [])]) {
    const normalized = normalizeDrawReceipt(item);
    if (!normalized.drawnAt || !normalized.results.some((group) => group.winners.length)) continue;
    const existing = records.get(normalized.id);
    if (!existing || normalized.recordState === 'server' || existing.recordState !== 'server') {
      records.set(normalized.id, normalized);
    }
  }
  return [...records.values()]
    .sort((left, right) => String(right.drawnAt).localeCompare(String(left.drawnAt)))
    .slice(0, DRAW_HISTORY_LIMIT);
}

export function buildFairnessSummary(receiptInput) {
  const receipt = normalizeDrawReceipt(receiptInput);
  const lines = [];
  if (receipt.drawNumber) {
    lines.push(drawCountCopy({
      source: receipt.source,
      count: receipt.drawNumber,
      completed: true,
    }));
  }
  if (receipt.drawnAt) lines.push(`时间：${receipt.drawnAt}`);
  lines.push(
    `载入 ${receipt.candidateCount} 人 · 可抽 ${receipt.eligibleCount} 人 · 排除 ${receipt.excludedCount} 人`,
  );
  lines.push(`筛选规则：${
    receipt.rules?.filters
      ? buildFilterSummary(receipt.rules.filters)
      : '未记录'
  }`);
  lines.push(`随机规则：${DRAW_RANDOM_ALGORITHM}`);
  if (receipt.seed) lines.push(`随机种子：${receipt.seed}`);
  if (receipt.auditHash) lines.push(`过程哈希：${receipt.auditHash}`);
  if (receipt.candidateDigest) lines.push(`名单指纹：${receipt.candidateDigest}`);
  return lines.join('\n');
}

export function receiptWinnerRows(receiptInput) {
  const receipt = normalizeDrawReceipt(receiptInput);
  return receipt.results.flatMap((group) => group.winners.map((winner, index) => ({
    prize: group.prize.name,
    rank: index + 1,
    uid: winner.uid,
    screenName: winner.screenName,
  })));
}

export function receiptWinnerText(receiptInput) {
  const receipt = normalizeDrawReceipt(receiptInput);
  return receipt.results
    .filter((group) => group.winners.length)
    .map((group) => {
      const names = group.winners.map((winner, index) => {
        const name = winner.screenName || winner.uid || `中奖用户 ${index + 1}`;
        const uid = winner.uid && winner.uid !== name ? `（UID ${winner.uid}）` : '';
        return `${index + 1}. ${name}${uid}`;
      });
      return `${group.prize.name}\n${names.join('\n')}`;
    })
    .join('\n\n');
}

export function winnerIdsForStatus(history, statusId) {
  const target = String(statusId || '');
  const identities = new Set();
  for (const item of Array.isArray(history) ? history : []) {
    const receipt = normalizeDrawReceipt(item);
    if (!target || receipt.statusId !== target) continue;
    for (const group of receipt.results) {
      for (const winner of group.winners) {
        const identity = String(winner.uid || winner.screenName || winner.id || '').toLowerCase();
        if (identity) identities.add(identity);
      }
    }
  }
  return identities;
}
