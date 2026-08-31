function normalizedUserId(entry) {
  return String(entry?.user?.id || '').trim();
}

function accountKey(entry) {
  const userId = normalizedUserId(entry);
  return userId ? `user:${userId}` : `cookie:${entry?.id || ''}`;
}

export function compactCookieEntriesByAccount(entries) {
  const seen = new Set();
  const compacted = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = accountKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    compacted.push(entry);
  }
  return compacted;
}

export function cookiePoolCounts(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const accountKeys = new Set(list.map((entry) => accountKey(entry)));
  return {
    cookieCount: list.length,
    accountCount: accountKeys.size,
  };
}

export function cookiePoolStatusCounts(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const quarantinedIds = new Set(options.quarantinedIds || []);
  const countsFor = (predicate) => cookiePoolCounts(list.filter(predicate));
  const tryable = countsFor((entry) => !quarantinedIds.has(entry?.id));
  const verified = countsFor((entry) => (
    !quarantinedIds.has(entry?.id) && Boolean(entry?.lastValidAt) && !entry?.lastError
  ));
  const pending = countsFor((entry) => !entry?.lastCheckedAt);
  const checkFailed = countsFor((entry) => Boolean(entry?.lastCheckedAt) && Boolean(entry?.lastError));
  const quarantined = countsFor((entry) => quarantinedIds.has(entry?.id));

  return {
    tryableCookieCount: tryable.cookieCount,
    tryableAccountCount: tryable.accountCount,
    verifiedCookieCount: verified.cookieCount,
    verifiedAccountCount: verified.accountCount,
    pendingCookieCount: pending.cookieCount,
    pendingAccountCount: pending.accountCount,
    checkFailedCookieCount: checkFailed.cookieCount,
    checkFailedAccountCount: checkFailed.accountCount,
    quarantinedCookieCount: quarantined.cookieCount,
    quarantinedAccountCount: quarantined.accountCount,
  };
}

export function cookieCandidatesWithFallback(entries, fallback) {
  const stored = Array.isArray(entries) ? [...entries] : [];
  if (!fallback?.cookie || stored.some((entry) => entry?.id === fallback.id)) return stored;
  return [...stored, { ...fallback, transient: true }];
}
