const WEIBO_AVATAR_HOSTS = ['sinaimg.cn', 'weibo.cn', 'weibo.com', 'sina.com.cn'];

function allowedAvatarHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return WEIBO_AVATAR_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function safeAvatarUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || !allowedAvatarHost(url.hostname)) return '';
    url.protocol = 'https:';
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return '';
  }
}

export function avatarFallback(value) {
  return Array.from(String(value || '').trim())[0] || '候';
}
