export function createRollingStore() {
  let snapshot = { candidate: null };
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    set(candidate) {
      if (snapshot.candidate === candidate) return;
      snapshot = { candidate };
      for (const listener of listeners) listener();
    },
  };
}
export const rollingStore = createRollingStore();
