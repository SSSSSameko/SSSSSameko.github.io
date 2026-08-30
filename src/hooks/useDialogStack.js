import { useCallback, useEffect, useRef } from 'react';

const dialogStack = [];
let insertionOrder = 0;

export default function useDialogStack(enabled = true, priority = 0) {
  const tokenRef = useRef({});

  useEffect(() => {
    if (!enabled) return undefined;
    const token = tokenRef.current;
    dialogStack.push({ token, priority: Number(priority) || 0, order: insertionOrder += 1 });
    return () => {
      const index = dialogStack.findLastIndex((entry) => entry.token === token);
      if (index >= 0) dialogStack.splice(index, 1);
    };
  }, [enabled, priority]);

  return useCallback(() => {
    const top = dialogStack.reduce((current, entry) => {
      if (!current || entry.priority > current.priority
        || (entry.priority === current.priority && entry.order > current.order)) return entry;
      return current;
    }, null);
    return top?.token === tokenRef.current;
  }, []);
}
