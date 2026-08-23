function nonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

export function isWeiboThrottleStatus(status) {
  return [418, 429, 503].includes(Number(status));
}

export function parseRetryAfterMs(value, now = Date.now()) {
  const text = String(value || '').trim();
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Number(text) * 1000);
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

export function throttleRetryDelayMs({
  retryAfter,
  attempt = 0,
  baseMs = 15_000,
  maxMs = 120_000,
  now = Date.now(),
} = {}) {
  const base = nonNegativeNumber(baseMs, 15_000);
  const ceiling = Math.max(base, nonNegativeNumber(maxMs, 120_000));
  const exponential = base * (2 ** Math.max(0, Math.floor(Number(attempt) || 0)));
  return Math.min(ceiling, Math.max(exponential, parseRetryAfterMs(retryAfter, now)));
}

export function pageWaitPlan({
  page = 0,
  baseMs = 0,
  jitterMs = 0,
  cooldownEvery = 0,
  cooldownMs = 0,
  random = Math.random,
} = {}) {
  const currentPage = Math.max(0, Math.floor(Number(page) || 0));
  const every = Math.max(0, Math.floor(Number(cooldownEvery) || 0));
  const jitterLimit = nonNegativeNumber(jitterMs);
  const jitter = jitterLimit ? Math.floor(random() * (jitterLimit + 1)) : 0;
  const cooldown = every > 0 && currentPage > 0 && currentPage % every === 0
    ? nonNegativeNumber(cooldownMs)
    : 0;
  return {
    delayMs: nonNegativeNumber(baseMs) + jitter + cooldown,
    jitterMs: jitter,
    cooldownMs: cooldown,
  };
}
