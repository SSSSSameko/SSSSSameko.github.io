function compareNewest(left, right) {
  const mtimeDifference = Number(right?.mtimeMs || 0) - Number(left?.mtimeMs || 0);
  if (mtimeDifference) return mtimeDifference;
  return String(right?.file || '').localeCompare(String(left?.file || ''));
}

export function selectNewestFiles(files, limit = 0) {
  const maxFiles = Math.max(0, Math.floor(Number(limit) || 0));
  if (!maxFiles) return [];
  return (Array.isArray(files) ? files : [])
    .filter(Boolean)
    .slice()
    .sort(compareNewest)
    .slice(0, maxFiles);
}

export function selectFilesToPrune(files, options = {}) {
  const maxFiles = Math.max(1, Number(options.maxFiles || 1));
  const maxBytes = Math.max(1, Number(options.maxBytes || 1));
  const maxAgeMs = Math.max(0, Number(options.maxAgeMs || 0));
  const now = Number(options.now || Date.now());
  let retainedBytes = files.reduce((sum, item) => sum + Number(item.size || 0), 0);
  const removals = [];

  for (let index = files.length - 1; index >= 0; index -= 1) {
    const item = files[index];
    const expired = maxAgeMs > 0
      && Number.isFinite(Number(item.mtimeMs))
      && Number(item.mtimeMs) < now - maxAgeMs;
    if (!expired && index < maxFiles && retainedBytes <= maxBytes) continue;
    removals.push(item);
    retainedBytes -= Number(item.size || 0);
  }
  return { removals, retainedBytes };
}

export async function removeFilesBestEffort(files, removeFile, options = {}) {
  const items = Array.isArray(files) ? files : [];
  const concurrency = Math.min(
    items.length,
    Math.max(1, Math.floor(Number(options.concurrency || 8))),
  );
  const maxFailures = Math.max(0, Math.floor(Number(options.maxFailures ?? 20)));
  const summary = {
    removedCount: 0,
    missingCount: 0,
    failedCount: 0,
    freedBytes: 0,
    failures: [],
  };
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      try {
        await removeFile(item);
        summary.removedCount += 1;
        summary.freedBytes += Math.max(0, Number(item?.size || 0));
      } catch (error) {
        if (error?.code === 'ENOENT') {
          summary.missingCount += 1;
          summary.freedBytes += Math.max(0, Number(item?.size || 0));
          continue;
        }
        summary.failedCount += 1;
        if (summary.failures.length < maxFailures) {
          summary.failures.push({ item, status: 'failed', error });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return summary;
}

export function retainRecentEntries(entries, options = {}) {
  const maxEntries = Math.max(1, Number(options.maxEntries || 1));
  const maxAgeMs = Math.max(0, Number(options.maxAgeMs || 0));
  const now = Number(options.now || Date.now());
  const dateField = String(options.dateField || 'createdAt');
  return (Array.isArray(entries) ? entries : [])
    .filter((item) => {
      if (!maxAgeMs) return true;
      const timestamp = Date.parse(item?.[dateField] || '');
      return Number.isFinite(timestamp) && timestamp >= now - maxAgeMs;
    })
    .slice(-maxEntries);
}

export function retainLatestLines(lines, options = {}) {
  const maxLines = Math.max(1, Math.floor(Number(options.maxLines || 1)));
  const maxBytes = Math.max(1, Math.floor(Number(options.maxBytes ?? Number.MAX_SAFE_INTEGER)));
  const source = Array.isArray(lines) ? lines : [];
  const retained = [];
  let retainedBytes = 0;

  for (let index = source.length - 1; index >= 0 && retained.length < maxLines; index -= 1) {
    const line = String(source[index] || '').trim();
    if (!line) continue;
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (lineBytes > maxBytes) continue;
    if (retainedBytes + lineBytes > maxBytes) break;
    retained.unshift(line);
    retainedBytes += lineBytes;
  }
  return retained;
}
