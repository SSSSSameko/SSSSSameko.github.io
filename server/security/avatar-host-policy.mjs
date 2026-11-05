import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function isPrivateIpv4(address) {
  const parts = String(address || '').split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0)
    || (first === 192 && second === 168)
    || (first === 192 && second === 88 && parts[2] === '99')
    || (first === 198 && second >= 18 && second <= 19)
    || (first === 198 && second === 51 && parts[2] === '100')
    || (first === 203 && second === 0 && parts[2] === '113')
    || first >= 224;
}

function isPrivateIpv6(address) {
  let value = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!value) return false;
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':');
    if (separator < 0) return false;
    const dottedPart = value.slice(separator + 1);
    const octets = dottedPart.split('.');
    if (octets.length !== 4 || octets.some((item) => !/^\d{1,3}$/.test(item) || Number(item) > 255)) return false;
    const high = ((Number(octets[0]) << 8) | Number(octets[1])).toString(16);
    const low = ((Number(octets[2]) << 8) | Number(octets[3])).toString(16);
    value = `${value.slice(0, separator + 1)}${high}:${low}`;
  }
  const parts = value.split('::');
  if (parts.length > 2) return false;
  const parsePart = (part) => part
    .split(':')
    .filter(Boolean)
    .map((item) => /^[0-9a-f]{1,4}$/.test(item) ? Number.parseInt(item, 16) : null);
  let left = parsePart(parts[0]);
  let right = parts.length === 2 ? parsePart(parts[1]) : [];
  if (left.includes(null) || right.includes(null)) return false;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (parts.length === 1 && missing !== 0)) return false;
  const hextets = parts.length === 2
    ? [...left, ...Array(missing).fill(0), ...right]
    : left;
  if (hextets.length !== 8) return false;
  const first = hextets[0];
  const mappedIpv4 = hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff;
  const compatibleIpv4 = hextets.slice(0, 6).every((part) => part === 0);
  if (mappedIpv4 || compatibleIpv4) {
    const ipv4 = [hextets[6] >> 8, hextets[6] & 255, hextets[7] >> 8, hextets[7] & 255].join('.');
    return isPrivateIpv4(ipv4);
  }
  return first === 0
    || (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xff00) === 0xff00
    || (first === 0x2001 && hextets[1] === 0x0db8);
}

export function isPrivateAddress(address) {
  const value = String(address || '').trim().replace(/^\[|\]$/g, '');
  const version = isIP(value);
  if (version === 4) return isPrivateIpv4(value);
  if (version === 6) return isPrivateIpv6(value.split('%')[0]);
  return false;
}

function avatarDnsOverridesForTests(env) {
  if (env.SERVER_TEST_MODE !== '1') return null;
  const raw = String(env.AVATAR_DNS_OVERRIDES || '').trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AVATAR_DNS_OVERRIDES must be a JSON object');
  }
  const overrides = new Map();
  for (const [hostname, records] of Object.entries(parsed)) {
    if (!Array.isArray(records) || !records.length) {
      throw new Error(`AVATAR_DNS_OVERRIDES.${hostname} must be a non-empty array`);
    }
    const normalized = records.map((record) => ({
      address: String(record?.address || '').trim(),
      family: Number(record?.family),
    }));
    if (normalized.some((record) => ![4, 6].includes(record.family) || isIP(record.address) !== record.family)) {
      throw new Error(`AVATAR_DNS_OVERRIDES.${hostname} contains an invalid address record`);
    }
    overrides.set(String(hostname).toLowerCase(), normalized);
  }
  return overrides;
}

export function createAvatarHostPolicy({ lookup = dnsLookup, env = process.env } = {}) {
  const avatarDnsOverrides = avatarDnsOverridesForTests(env);
  return async function avatarHostIsPublic(avatar) {
    let url;
    try {
      url = new URL(avatar);
    } catch {
      return false;
    }
    const hostname = url.hostname;
    if (isIP(hostname)) return !isPrivateAddress(hostname);
    try {
      const records = avatarDnsOverrides?.get(hostname.toLowerCase())
        || await lookup(hostname, { all: true, verbatim: true });
      if (!records.length) return false;
      return records.every((record) => {
        const family = isIP(record?.address || '');
        return family !== 0 && family === record.family && !isPrivateAddress(record.address);
      });
    } catch {
      return false;
    }
  };
}
