export function formatDurationMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '-';

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (ms % day === 0) return `${ms / day} 天`;
  if (ms % hour === 0) return `${ms / hour} 小时`;
  if (ms % minute === 0) return `${ms / minute} 分钟`;
  return `${Math.round(ms / 1000)} 秒`;
}

export function normalizeKeepaliveHistory(history, limit = 12) {
  const items = Array.isArray(history) ? history : [];
  return items
    .map((item) => ({
      at: String(item?.at || item?.updatedAt || '').trim(),
      status: String(item?.status || '').trim(),
      reason: String(item?.reason || '').trim(),
      message: String(item?.message || '').trim(),
      durationMs: Number.isFinite(Number(item?.durationMs)) ? Number(item.durationMs) : undefined,
    }))
    .filter((item) => item.at || item.status || item.message)
    .slice(0, limit)
    .map((item) => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined && value !== '')));
}

export function appendKeepaliveEvent(state, event, limit = 12) {
  const current = state && typeof state === 'object' ? state : {};
  const entry = Object.fromEntries(Object.entries({
    at: String(event?.at || new Date().toISOString()).trim(),
    status: String(event?.status || '').trim(),
    reason: String(event?.reason || '').trim(),
    message: String(event?.message || '').trim(),
    durationMs: Number.isFinite(Number(event?.durationMs)) ? Number(event.durationMs) : undefined,
  }).filter(([, value]) => value !== undefined && value !== ''));

  return {
    ...current,
    history: normalizeKeepaliveHistory([entry, ...(Array.isArray(current.history) ? current.history : [])], limit),
  };
}

// Keep unavailable measurements and long sampling interruptions visible as gaps.
// The server samples every five minutes; three missed intervals break the line.
export function memoryChartSeries(samples, memoryLimit, maxGapMs = 15 * 60_000) {
  const empty = { current: [], anonymous: [], from: null, to: null, hasGaps: false };
  if (typeof memoryLimit !== 'number' || !Number.isFinite(memoryLimit) || memoryLimit <= 0) return empty;
  const byTime = new Map();
  for (const sample of Array.isArray(samples) ? samples : []) {
    const at = Date.parse(sample?.at || '');
    if (Number.isFinite(at)) byTime.set(at, sample);
  }
  const ordered = [...byTime].sort(([a], [b]) => a - b);
  if (!ordered.length) return empty;
  const from = ordered[0][0];
  const to = ordered.at(-1)[0];
  let hasGaps = false;
  const series = (field) => {
    const segments = [];
    let segment = [];
    let previousAt = null;
    for (const [at, sample] of ordered) {
      const value = sample[field];
      const valid = typeof value === 'number' && Number.isFinite(value) && value >= 0;
      const interrupted = previousAt !== null && at - previousAt > maxGapMs;
      if (!valid || interrupted) {
        hasGaps = true;
        if (segment.length) segments.push(segment);
        segment = [];
      }
      if (valid) segment.push({ x: to === from ? 0.5 : (at - from) / (to - from), percent: value / memoryLimit * 100 });
      previousAt = at;
    }
    if (segment.length) segments.push(segment);
    return segments;
  };
  const current = series('cgroupCurrentMb');
  const anonymous = series('cgroupAnonMb');
  return { current, anonymous, from, to, hasGaps };
}
