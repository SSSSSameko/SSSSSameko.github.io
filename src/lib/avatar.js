const WEIBO_AVATAR_HOSTS = ['sinaimg.cn', 'weibo.cn', 'weibo.com', 'sina.com.cn'];

function allowedAvatarHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return WEIBO_AVATAR_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function safeAvatarUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || !allowedAvatarHost(url.hostname)) return '';
    if (url.port && !((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443'))) return '';
    url.protocol = 'https:';
    url.port = '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

export function avatarProxyUrl(value, apiBase = '') {
  const avatar = safeAvatarUrl(value);
  if (!avatar) return '';
  const base = String(apiBase || '').trim().replace(/\/+$/, '');
  return `${base}/api/weibo/avatar?url=${encodeURIComponent(avatar)}`;
}

export function avatarFallback(value) {
  return Array.from(String(value || '').trim())[0] || '候';
}
