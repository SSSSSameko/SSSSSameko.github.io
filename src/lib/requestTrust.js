export function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] || '' : String(value || '');
}

export function isLoopbackAddress(value) {
  const rawAddress = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  let address = rawAddress;
  if (rawAddress.includes(':')) {
    try {
      address = new URL(`http://[${rawAddress}]/`).hostname.replace(/^\[|\]$/g, '');
    } catch {
      return false;
    }
  }
  return address === '::1'
    || address.startsWith('127.')
    || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(address);
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
