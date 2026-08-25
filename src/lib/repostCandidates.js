function normalizedLimit(value) {
  const limit = Number(value);
  return Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Number.POSITIVE_INFINITY;
}

export function repostIdentity(candidate = {}) {
  const repostId = String(candidate.repostId || '').trim();
  if (repostId && !repostId.startsWith('weibo-cn-')) return `repost:${repostId}`;

  const fallback = [
    candidate.uid,
    candidate.screenName,
    candidate.text,
    candidate.createdAt,
  ].map((value) => String(value || '').trim()).join('|');
  return fallback ? `fallback:${fallback}` : '';
}

export function uniqueReposts(candidates, maxEntries = Number.POSITIVE_INFINITY) {
  const limit = normalizedLimit(maxEntries);
  const seen = new Set();
  const result = [];

  for (const candidate of candidates || []) {
    const key = repostIdentity(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
    if (result.length >= limit) break;
  }
  return result;
}

export function mergeRepostHead(candidates, latestCandidates, maxEntries = Number.POSITIVE_INFINITY) {
  const limit = normalizedLimit(maxEntries);
  const current = uniqueReposts(candidates, limit);
  const known = new Set(current.map(repostIdentity));
  const additions = uniqueReposts(latestCandidates, maxEntries)
    .filter((candidate) => !known.has(repostIdentity(candidate)));
  const available = Number.isFinite(limit) ? Math.max(0, limit - current.length) : additions.length;
  const accepted = additions.slice(0, available);

  return {
    candidates: [...accepted, ...current],
    addedCount: accepted.length,
    truncatedCount: additions.length - accepted.length,
  };
}
