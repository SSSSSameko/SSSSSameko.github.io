import { repostCompletenessTolerance, repostCountIsComplete, repostCountLooksComplete } from './candidate-collection.mjs';

export function repostScanStopReason({ paginationError, hitCandidateCap, hitPageCap, repeatedPages, stoppedOnEmptyPages, pages, maxPage }) {
  if (paginationError) return 'pagination-error';
  if (hitCandidateCap) return 'candidate-limit';
  if (hitPageCap) return 'page-limit';
  if (repeatedPages) return 'repeated-pages';
  if (stoppedOnEmptyPages) return 'empty-pages';
  const last = pages.at(-1);
  if (!last) return 'skipped';
  if (maxPage && last.page >= maxPage) return 'declared-end';
  if (!maxPage && last.count === 0) return 'empty-end';
  return 'unknown';
}

// Stopping fallback is a request-budget decision, never a claim that missing
// entries were recovered. A second clean, identical set permits only a small
// additional gap, bounded by BOTH 20% and ten reposts.
export function decideRepostFallback({ count, total, attempts = [], limitReason = '' }) {
  const knownTotal = Number.isSafeInteger(total) && total >= 0;
  const missingCount = knownTotal ? Math.max(0, total - count) : null;
  const tolerance = knownTotal ? repostCompletenessTolerance(total) : null;
  const identityUncertain = attempts.some(item => item.identityUncertainCount > 0);
  const paginationFailed = attempts.some(item => item.paginationError);
  const result = { stop: false, stopReason: 'continue', complete: false, missingCount, tolerance };
  const cleanScan = item => item.status === 'ok' && !item.headRefreshFailed
    && ['declared-end', 'empty-end'].includes(item.scanStopReason);
  if (limitReason) return { ...result, stop: true, stopReason: 'candidate-limit' };
  if (repostCountIsComplete(count, total) && !identityUncertain) {
    return { ...result, stop: true, stopReason: 'count-reached', complete: true };
  }
  const usesLargeTolerance = knownTotal && total >= 200 && missingCount > Math.max(2, Math.ceil(total * 0.10));
  if (!identityUncertain && !paginationFailed && repostCountLooksComplete(count, total)
    && (!usesLargeTolerance || (attempts.length > 0 && attempts.every(cleanScan)))) {
    return { ...result, stop: true, stopReason: usesLargeTolerance ? 'large-list-tolerance' : knownTotal ? 'within-tolerance' : 'unknown-total' };
  }
  if (!knownTotal || count <= 0 || identityUncertain || paginationFailed || attempts.length !== 2) return result;
  const [desktop, mobile] = attempts;
  const confirmed = desktop.provider === 'desktop-cookie' && mobile.provider === 'mobile'
    && mobile.addedCount === 0 && mobile.visibleNumber === count
    && attempts.every(item => cleanScan(item)
      && item.totalNumber === total && !item.totalChanged && !item.headRefreshFailed
    );
  const extendedTolerance = Math.min(10, Math.floor(total * 0.20));
  if (confirmed && missingCount <= extendedTolerance) {
    return { ...result, stop: true, stopReason: 'stable-small-gap', tolerance: extendedTolerance };
  }
  return result;
}
