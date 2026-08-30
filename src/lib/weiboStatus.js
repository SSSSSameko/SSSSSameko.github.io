const WEIBO_HOSTS = new Set([
  'weibo.com',
  'www.weibo.com',
  'm.weibo.cn',
  'weibo.cn',
  'www.weibo.cn',
]);

const PROFILE_ROUTES = new Set(['u', 'n', 'profile', 'home', 'my', 'settings']);
const STATUS_ROUTES = new Set(['status', 'detail', 'mblog']);
const SHARED_URL_PATTERN = /(?:https?:\/\/)?(?:www\.|m\.)?weibo\.(?:com|cn)(?:[/?#][^\s<>"'，。！？；：、…（）【】]*)?/gi;
const TRAILING_URL_PUNCTUATION = /[)\]}>，。！？；：、…]+$/u;

function validToken(value, { minLength = 1 } = {}) {
  const token = String(value || '').trim();
  return /^[0-9A-Za-z]{1,64}$/.test(token) && token.length >= minLength ? token : '';
}

function statusTokenFromUrl(reference) {
  const candidate = String(reference || '')
    .trim()
    .replace(TRAILING_URL_PUNCTUATION, '');
  if (!candidate) return '';

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.port
    || !WEIBO_HOSTS.has(url.hostname.toLowerCase())) return '';

  for (const key of ['id', 'mid', 'mblogid']) {
    const queryToken = validToken(url.searchParams.get(key));
    if (queryToken) return queryToken;
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return '';
  const first = parts[0].toLowerCase();
  if (PROFILE_ROUTES.has(first)) return '';
  if (STATUS_ROUTES.has(first)) return validToken(parts[1], { minLength: 5 });
  if (!/^\d{5,20}$/.test(parts[0])) return '';
  return validToken(parts.at(-1), { minLength: 5 });
}

export function statusTokenFromReference(value) {
  const input = String(value || '').trim();
  if (!input || input.length > 2048) return '';

  const raw = validToken(input, { minLength: 5 });
  if (raw) return raw;

  const direct = statusTokenFromUrl(input);
  if (direct) return direct;

  for (const match of input.matchAll(SHARED_URL_PATTERN)) {
    const previous = match.index > 0 ? input[match.index - 1] : '';
    if (previous && /[0-9A-Za-z_.@-]/.test(previous)) continue;
    const token = statusTokenFromUrl(match[0]);
    if (token) return token;
  }
  return '';
}

export function isWeiboStatusReference(value) {
  return Boolean(statusTokenFromReference(value));
}

export function isWeiboHost(hostname) {
  return WEIBO_HOSTS.has(String(hostname || '').trim().toLowerCase());
}
