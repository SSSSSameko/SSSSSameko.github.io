function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', cancel);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(signal.reason);
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

// Keep the export sequential to respect server limits. Cancellation also covers
// Retry-After delays, so a previous session cannot resume work after logout.
export async function collectDrawRecords({ items, cached, load, remember, progress, signal }) {
  const records = [];
  for (let index = 0; index < items.length; index += 1) {
    signal.throwIfAborted();
    const item = items[index];
    progress(`正在准备 ${index + 1} / ${items.length} 条`);
    let detail = cached(item.file);
    if (!detail) {
      try {
        detail = await load(item.file, signal);
      } catch (error) {
        signal.throwIfAborted();
        const retryAfter = String(error.retryAfter ?? '').trim();
        const seconds = retryAfter ? Number(retryAfter) : NaN;
        if (error.status !== 429 || !Number.isFinite(seconds) || seconds < 0 || seconds > 60)
          throw error;
        const delay = Math.max(1, Math.ceil(seconds));
        progress(`请求较频繁，${delay} 秒后继续 · ${index + 1} / ${items.length}`);
        await abortableDelay(delay * 1000, signal);
        detail = await load(item.file, signal);
      }
      signal.throwIfAborted();
      if (!detail || detail.file !== item.file || !Array.isArray(detail.winners)) {
        throw new Error('开奖记录返回格式异常，导出已停止，请刷新后重试');
      }
      remember(detail);
    }
    records.push(detail);
  }
  signal.throwIfAborted();
  return records;
}
