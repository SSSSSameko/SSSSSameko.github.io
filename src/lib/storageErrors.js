export function isQuotaError(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.name === 'QuotaExceededError'
    || error?.code === 22
    || error?.code === 1014
    || message.includes('quota');
}
