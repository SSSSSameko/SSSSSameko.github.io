function normalizedLimit(value) {
  const limit = Number(value);
  return Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Number.POSITIVE_INFINITY;
}

// Weibo encodes each seven decimal MID digits as four base62 BID characters.
// Only decode identifiers from the legacy source; arbitrary/manual IDs and
// ambiguous all-numeric tokens must not be reinterpreted.
export function canonicalRepostId(value, source = '') {
  const id = String(value || '').trim();
  if (source !== 'weibo-cn' || !/^[0-9A-Za-z]{9,12}$/.test(id) || !/[A-Za-z]/.test(id) || id.startsWith('0')) return id;
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const groups = [];
  for (let end = id.length; end > 0; end -= 4) groups.unshift(id.slice(Math.max(0, end - 4), end));
  const decoded = [];
  for (const [index, group] of groups.entries()) {
    const number = [...group].reduce((total, character) => total * 62 + alphabet.indexOf(character), 0);
    if (number > 9_999_999) return id;
    decoded.push(index ? String(number).padStart(7, '0') : String(number));
  }
  const mid = decoded.join('');
  return /^[1-9]\d{13,20}$/.test(mid) ? mid : id;
}

export function hasStableRepostId(candidate = {}) {
  const id = String(candidate.repostId || '').trim();
  if (!id || id.startsWith('weibo-cn-')) return false;
  // Legacy tokens that cannot be unambiguously mapped to a decimal MID may
  // still be displayed, but must not certify an aggregate as deduplicated.
  if (candidate.source === 'weibo-cn') return /^[1-9]\d{13,20}$/.test(canonicalRepostId(id, candidate.source));
  return true;
}

export function repostIdentity(candidate = {}) {
  const repostId = canonicalRepostId(candidate.repostId, candidate.source);
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

export function createRepeatedPageGuard(limit = 3) {
  const threshold = Math.max(1, Math.floor(Number(limit) || 1));
  let repeated = 0;

  return {
    observe(itemCount, addedCount) {
      if (Number(itemCount) > 0 && Number(addedCount) === 0) repeated += 1;
      else repeated = 0;
      return repeated >= threshold;
    },
    get count() {
      return repeated;
    },
  };
}

export function createEmptyPageGuard(limit = 3) {
  const threshold = Math.max(1, Math.floor(Number(limit) || 1));
  let empty = 0;

  return {
    observe(itemCount) {
      if (Number(itemCount) === 0) empty += 1;
      else empty = 0;
      return empty >= threshold;
    },
    get count() {
      return empty;
    },
  };
}
