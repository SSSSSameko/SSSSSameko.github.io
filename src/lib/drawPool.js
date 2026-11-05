import { candidateIdentity } from './candidateEligibility.js';

export function countEligibleUsers(candidates) {
  return new Set(candidates.map(candidateIdentity).filter(Boolean)).size;
}

// Shuffle the full entry list first: repeated reposts retain their weight when
// candidate deduplication is off. A user can still win only once in this round.
export function uniqueWinnerPool(shuffledEntries) {
  const seen = new Set();
  return shuffledEntries.filter((candidate) => {
    const identity = candidateIdentity(candidate);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
