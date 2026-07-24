import { buildFilterSummary, DRAW_RANDOM_ALGORITHM } from './appCore.js';

export const DRAW_HISTORY_KEY = 'weibo-draw-history-v2';
export const DRAW_HISTORY_LIMIT = 50;
export const DRAW_HISTORY_VERSION = 2;

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function normalizeWinner(winner = {}) {
  return {
    id: String(winner.id || winner.repostId || winner.uid || winner.screenName || ''),
    uid: String(winner.uid || ''),
    screenName: String(winner.screenName || winner.name || ''),
    avatar: String(winner.avatar || ''),
    verified: Boolean(winner.verified),
    followers: finiteNonNegative(winner.followers),
    text: String(winner.text || ''),
    createdAt: String(winner.createdAt || ''),
    repostId: String(winner.repostId || ''),
    source: String(winner.source || ''),
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

export function completedDrawStats(records, statusId, targetAuditHash = '') {
  const unique = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (String(record?.statusId || '') !== String(statusId || '')) continue;
    const hash = String(record?.auditHash || '').trim();
    if (!hash || unique.has(hash)) continue;
    unique.set(hash, record);
  }

  const ordered = [...unique.values()].sort((left, right) => (
    String(left.drawnAt || left.savedAt || '').localeCompare(
      String(right.drawnAt || right.savedAt || ''),
    )
  ));
  const targetIndex = ordered.findIndex((record) => (
    String(record.auditHash || '') === String(targetAuditHash || '')
  ));

  return {
    count: ordered.length,
    drawNumber: targetIndex >= 0 ? targetIndex + 1 : null,
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

export function normalizeDrawReceipt(input = {}) {
  const audit = input.audit && typeof input.audit === 'object' ? input.audit : {};
  const results = normalizeResults(input.results);
  const candidateCount = finiteNonNegative(input.candidateCount ?? input.totalCount);
  const eligibleCount = finiteNonNegative(input.eligibleCount ?? audit.eligibleCount);
  const parsedDrawNumber = Number(input.drawNumber);
  const drawNumber = input.drawNumber === null
    || input.drawNumber === undefined
    || !Number.isFinite(parsedDrawNumber)
    ? null
    : Math.max(1, Math.floor(parsedDrawNumber));
  const drawnAt = String(input.drawnAt || audit.drawnAt || input.time || '');
  const summary = String(input.summary || receiptSummary(results));
  const auditHash = String(input.auditHash || '');
  const winnerCount = results.reduce((sum, group) => sum + group.winners.length, 0);

  return {
    id: String(input.id || auditHash || localReceiptId(input, drawnAt, summary)),
    source: String(input.source || 'manual'),
    statusId: String(input.statusId || audit.statusId || input.sourceMeta?.statusId || ''),
    statusUrl: String(input.statusUrl || audit.statusUrl || input.sourceMeta?.statusUrl || ''),
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
    recordState: input.recordState === 'server' || auditHash ? 'server' : 'local',
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

export function writeDrawHistory(storage = globalThis.localStorage, history = []) {
  const items = (Array.isArray(history) ? history : [])
    .map(normalizeDrawReceipt)
    .slice(0, DRAW_HISTORY_LIMIT);
  storage?.setItem(DRAW_HISTORY_KEY, JSON.stringify({
    version: DRAW_HISTORY_VERSION,
    items,
  }));
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
  if (receipt.auditHash) lines.push(`审计哈希：${receipt.auditHash}`);
  if (receipt.candidateDigest) lines.push(`名单指纹：${receipt.candidateDigest}`);
  return lines.join('\n');
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
