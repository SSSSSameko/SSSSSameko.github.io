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
