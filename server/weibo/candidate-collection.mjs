import { hasStableRepostId, repostIdentity } from '../../src/lib/repostCandidates.js';
import { normalizeCandidate } from './timeline-parsers.mjs';

/** A bounded, ordered collection shared by pagination and provider fallback. */
export class CandidateCollection {
  #seen = new Set();
  #bytes = 2;
  #maxCandidates;
  #maxPayloadBytes;
  #identityUncertainCount = 0;

  constructor({ candidates = [], maxCandidates, maxPayloadBytes }) {
    this.candidates = candidates;
    this.limitReason = '';
    this.discardedCount = 0;
    this.#maxCandidates = maxCandidates;
    this.#maxPayloadBytes = maxPayloadBytes;

    for (const [index, candidate] of candidates.entries()) {
      const key = repostIdentity(candidate);
      if (key) this.#seen.add(key);
      if (!hasStableRepostId(candidate)) this.#identityUncertainCount += 1;
      this.#bytes += Buffer.byteLength(JSON.stringify(candidate), 'utf8') + (index ? 1 : 0);
    }
  }

  #addCandidate(candidate, target) {
    const key = repostIdentity(candidate);
    if (!key || this.#seen.has(key)) return true;

    const count = this.candidates.length + (target === this.candidates ? 0 : target.length);
    if (count >= this.#maxCandidates) {
      this.limitReason ||= 'count';
      this.discardedCount += 1;
      return false;
    }

    const bytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8') + (count ? 1 : 0);
    if (this.#bytes + bytes > this.#maxPayloadBytes) {
      this.limitReason ||= 'bytes';
      this.discardedCount += 1;
      return false;
    }

    this.#seen.add(key);
    if (!hasStableRepostId(candidate)) this.#identityUncertainCount += 1;
    this.#bytes += bytes;
    target.push(candidate);
    return true;
  }

  append(items, source = '') {
    for (const item of items || []) {
      const candidate = source ? normalizeCandidate(item, source) : item;
      if (!this.#addCandidate(candidate, this.candidates)) return true;
    }
    return false;
  }

  prepend(items) {
    const additions = [];
    for (const candidate of items || []) {
      if (!this.#addCandidate(candidate, additions)) break;
    }
    if (additions.length) this.candidates.unshift(...additions);
    return { addedCount: additions.length, truncatedCount: this.discardedCount };
  }

  metadata() {
    return {
      candidatePayloadBytes: this.#bytes,
      candidatePayloadLimitBytes: this.#maxPayloadBytes,
      candidateLimitReason: this.limitReason,
      identityUncertainCount: this.#identityUncertainCount,
    };
  }

  warnings() {
    if (this.limitReason === 'count') {
      return [`为控制服务器资源，本次最多载入 ${this.#maxCandidates} 位候选。`];
    }
    if (this.limitReason === 'bytes') {
      return [`候选数据体积已达到 ${Math.round(this.#maxPayloadBytes / 1024 / 1024)} MB，本次载入 ${this.candidates.length} 位候选后停止。`];
    }
    return [];
  }
}

export function repostCompletenessTolerance(totalNumber) {
  const total = Math.max(0, Number(totalNumber) || 0);
  return Math.max(2, Math.ceil(total * (total >= 200 ? 0.20 : 0.10)));
}

export function repostCountIsComplete(candidateCount, totalNumber) {
  return Number.isSafeInteger(totalNumber) && totalNumber >= 0
    && Number.isSafeInteger(candidateCount) && candidateCount >= totalNumber;
}

export function repostCountLooksComplete(candidateCount, totalNumber) {
  const count = Math.max(0, Number(candidateCount) || 0);
  if (totalNumber === null || totalNumber === undefined) return count > 0;
  const missingCount = Math.max(0, Number(totalNumber) || 0) - count;
  return missingCount <= 0 || (count > 0 && missingCount <= repostCompletenessTolerance(totalNumber));
}

export function repostResultsLookComplete(candidateCount, totalNumber, results) {
  // A failed page is positive evidence of an unfinished scan. Count tolerance
  // applies only to otherwise successful scans; fallback can fill the full total.
  if (results.some((result) => result.meta?.paginationError)) {
    return totalNumber !== null && totalNumber !== undefined && candidateCount >= totalNumber;
  }
  return repostCountLooksComplete(candidateCount, totalNumber);
}
