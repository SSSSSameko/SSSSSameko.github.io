export function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] || '' : String(value || '');
}

export function isLoopbackAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  return address === '::1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.');
}

export function trustedForwardedHeader(req, name) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return '';
  return firstHeaderValue(req?.headers?.[name]);
}

export function clientAddress(req) {
  const forwarded = trustedForwardedHeader(req, 'x-forwarded-for')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1) || '';
  return forwarded || String(req?.socket?.remoteAddress || 'unknown');
}
