const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function knownDrawCount(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean')
    return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function validateRepostResult(result) {
  const invalid = () => {
    throw new Error('候选名单格式异常，请重新载入；当前名单尚未替换。');
  };
  if (!isRecord(result) || result.ok !== true || !Array.isArray(result.candidates)) invalid();
  if (result.candidates.length > 20_000) invalid();
  for (const candidate of result.candidates) {
    if (!isRecord(candidate)) invalid();
    for (const key of [
      'id',
      'uid',
      'screenName',
      'text',
      'avatar',
      'repostId',
      'createdAt',
      'source',
    ]) {
      if (candidate[key] != null && typeof candidate[key] !== 'string') invalid();
    }
    if (![candidate.uid, candidate.screenName, candidate.id].some((value) => value?.trim()))
      invalid();
  }
  if (result.meta != null && !isRecord(result.meta)) invalid();
  for (const key of ['statusId', 'statusUrl']) {
    if (result[key] != null && typeof result[key] !== 'string') invalid();
  }
  return result;
}
