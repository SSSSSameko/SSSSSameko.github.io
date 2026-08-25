export function repostTaskKey(statusId, request = {}) {
  const id = String(statusId || '').trim();
  if (!id) return '';

  const source = String(request.source || 'mobile').trim().toLowerCase();
  if (source === 'mobile') {
    const scope = String(request.authScope || '').trim();
    const authMode = scope ? `user-cookie:${scope}` : 'server-session';
    return `${source}:${authMode}:${id}`;
  }
  if (source === 'official') {
    const scope = String(request.authScope || '').trim();
    return `${source}:access-token:${scope || 'isolated'}:${id}`;
  }
  return `${source}:public:${id}`;
}

export function createSnapshotCache({ ttlMs = 15_000, maxEntries = 2, now = Date.now } = {}) {
  const entries = new Map();
  const lifetime = Math.max(1, Number(ttlMs) || 1);
  const limit = Math.max(1, Math.floor(Number(maxEntries) || 1));

  function remove(key, entry = entries.get(key)) {
    if (!entry || entries.get(key) !== entry) return false;
    clearTimeout(entry.timer);
    return entries.delete(key);
  }

  function pruneExpired() {
    const currentTime = now();
    for (const [key, entry] of entries) {
      if (currentTime - entry.storedAt >= lifetime) remove(key, entry);
    }
  }

  return {
    get(key) {
      if (!key) return null;
      pruneExpired();
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      entries.set(key, entry);
      return {
        result: entry.result,
        storedAt: entry.storedAt,
        ageMs: Math.max(0, now() - entry.storedAt),
      };
    },

    set(key, result) {
      if (!key || !result) return;
      pruneExpired();
      remove(key);
      const entry = { result, storedAt: now(), timer: null };
      entry.timer = setTimeout(() => remove(key, entry), lifetime);
      entry.timer.unref?.();
      entries.set(key, entry);
      while (entries.size > limit) remove(entries.keys().next().value);
    },

    delete(key) {
      remove(key);
    },

    get size() {
      pruneExpired();
      return entries.size;
    },
  };
}
