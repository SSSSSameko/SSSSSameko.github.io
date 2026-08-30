import { normalizeMentionMin } from './appCore.js';

const EXCLUSION_COPY = {
  duplicate: ['重复转发', '同一用户已有一条转发进入候选'],
  previousWinner: ['已中奖', '该用户已在当前任务的历史开奖中中奖'],
  blocklist: ['排除名单', 'UID 或昵称命中排除名单'],
  keyword: ['关键词不符', '转发内容没有包含设置的关键词'],
  mention: ['@ 人数不足', '转发内容中的 @ 人数没有达到设置要求'],
};

export function candidateIdentity(candidate) {
  return String(candidate?.uid || candidate?.screenName || candidate?.id || '').trim().toLowerCase();
}

function normalizedBlockedSet(value) {
  if (value instanceof Set) {
    return new Set([...value].map((item) => String(item || '').trim().toLowerCase()).filter(Boolean));
  }
  const items = Array.isArray(value)
    ? value
    : String(value || '').split(/\r?\n|,/);
  return new Set(items.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean));
}

function exclusionEntry(candidate, reason = '') {
  const [reasonLabel = '', reasonDetail = ''] = EXCLUSION_COPY[reason] || [];
  return {
    candidate,
    eligible: !reason,
    reason,
    reasonLabel,
    reasonDetail,
  };
}

export function evaluateCandidateEligibility(candidates, filters = {}, previousWinnerIds = new Set()) {
  const eligibleUsers = new Set();
  const blocked = normalizedBlockedSet(filters.blocked ?? filters.blocklist);
  const previousWinners = new Set(
    [...(previousWinnerIds instanceof Set ? previousWinnerIds : [])]
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const keyword = String(filters.keyword || '').trim().toLowerCase();
  const mentionMin = normalizeMentionMin(filters.mentionMin);

  return (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const identity = candidateIdentity(candidate);
    const name = String(candidate?.screenName || '').trim().toLowerCase();
    let reason = '';

    if (filters.excludePrevious && identity && previousWinners.has(identity)) {
      reason = 'previousWinner';
    }
    if (!reason && (blocked.has(identity) || blocked.has(name))) {
      reason = 'blocklist';
    }
    if (!reason && keyword && !String(candidate?.text || '').toLowerCase().includes(keyword)) {
      reason = 'keyword';
    }
    if (!reason && mentionMin > 0) {
      const mentions = String(candidate?.text || '').match(/@[\p{L}\p{N}_\-\u4e00-\u9fa5]+/gu) || [];
      const mentionCount = new Set(mentions.map((mention) => mention.toLowerCase())).size;
      if (mentionCount < mentionMin) reason = 'mention';
    }
    if (!reason && filters.uniqueByUser && identity) {
      if (eligibleUsers.has(identity)) reason = 'duplicate';
      else eligibleUsers.add(identity);
    }

    return exclusionEntry(candidate, reason);
  });
}

export function eligibleCandidates(candidates, filters, previousWinnerIds) {
  return evaluateCandidateEligibility(candidates, filters, previousWinnerIds)
    .filter((entry) => entry.eligible)
    .map((entry) => entry.candidate);
}

export function summarizeCandidateEligibility(evaluations, limit = 3) {
  const entries = Array.isArray(evaluations) ? evaluations : [];
  const counts = new Map();
  let eligible = 0;

  for (const entry of entries) {
    if (entry?.eligible) {
      eligible += 1;
      continue;
    }
    const reason = String(entry?.reason || 'other');
    const current = counts.get(reason) || {
      reason,
      label: String(entry?.reasonLabel || '其他'),
      detail: String(entry?.reasonDetail || ''),
      count: 0,
    };
    current.count += 1;
    counts.set(reason, current);
  }

  const safeLimit = Math.max(1, Math.floor(Number(limit) || 3));
  const reasons = [...counts.values()]
    .map((item, index) => ({ item, index }))
    .sort((left, right) => right.item.count - left.item.count || left.index - right.index)
    .map(({ item }) => item)
    .slice(0, safeLimit);

  return {
    total: entries.length,
    eligible,
    excluded: entries.length - eligible,
    reasons,
    reasonText: reasons.map((item) => `${item.label} ${item.count}`).join(' · '),
  };
}
