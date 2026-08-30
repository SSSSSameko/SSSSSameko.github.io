export function createAsyncGate(options = {}) {
  const concurrency = Math.max(1, Math.floor(Number(options.concurrency) || 1));
  const maxQueue = Math.max(0, Math.floor(Number(options.maxQueue) || 0));
  const queue = [];
  let active = 0;

  function abortError(signal) {
    if (signal?.reason instanceof Error) return signal.reason;
    const error = new Error('操作已取消');
    error.name = 'AbortError';
    return error;
  }

  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (active < concurrency) {
      active += 1;
      return Promise.resolve();
    }
    if (queue.length >= maxQueue) {
      return Promise.reject(options.busyError?.() || new Error('服务正忙'));
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        signal,
        cancelled: false,
        onAbort: null,
      };
      const remove = () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
      };
      entry.onAbort = () => {
        if (entry.cancelled) return;
        entry.cancelled = true;
        remove();
        reject(abortError(signal));
      };
      if (signal) {
        signal.addEventListener('abort', entry.onAbort, { once: true });
        if (signal.aborted) {
          entry.onAbort();
          return;
        }
      }
      queue.push(entry);
    });
  }

  function release() {
    while (queue.length) {
      const next = queue.shift();
      if (next.cancelled || next.signal?.aborted) {
        next.onAbort?.();
        continue;
      }
      next.signal?.removeEventListener('abort', next.onAbort);
      next.resolve();
      return;
    }
    active = Math.max(0, active - 1);
  }

  return {
    async run(task, { signal } = {}) {
      await acquire(signal);
      try {
        return await task(signal);
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
  };
}
