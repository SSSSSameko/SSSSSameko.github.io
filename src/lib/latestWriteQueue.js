export function createLatestWriteQueue(write) {
  if (typeof write !== 'function') throw new TypeError('write must be a function');

  let active = false;
  let pending = false;
  let latestValue;
  let drainPromise = null;
  let writeCount = 0;
  let coalescedCount = 0;
  let failureCount = 0;
  let lastFailureAt = '';
  let lastSuccessAt = '';

  async function drain() {
    active = true;
    let lastError = null;
    try {
      while (pending) {
        pending = false;
        const value = latestValue;
        try {
          await write(value);
          writeCount += 1;
          lastSuccessAt = new Date().toISOString();
          lastError = null;
        } catch (error) {
          failureCount += 1;
          lastFailureAt = new Date().toISOString();
          lastError = error;
        }
      }
    } finally {
      active = false;
      drainPromise = null;
    }
    if (lastError) throw lastError;
  }

  return {
    enqueue(value) {
      if (active || pending) coalescedCount += 1;
      latestValue = value;
      pending = true;
      if (!drainPromise) drainPromise = drain();
      return drainPromise;
    },
    get active() {
      return active;
    },
    get pending() {
      return pending;
    },
    get writeCount() {
      return writeCount;
    },
    get coalescedCount() {
      return coalescedCount;
    },
    get failureCount() {
      return failureCount;
    },
    get lastFailureAt() {
      return lastFailureAt;
    },
    get lastSuccessAt() {
      return lastSuccessAt;
    },
  };
}
