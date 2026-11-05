import { isWeiboThrottleStatus } from '../../src/lib/weiboPacing.js';
import { mobileTimelineList } from './timeline-parsers.mjs';

function responseError(message, status = 502, code = 'WEIBO_RESPONSE_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

function isLoginLocation(location, url) {
  if (!location) return false;
  try {
    const target = new URL(location, url || undefined);
    return ['https:', 'http:'].includes(target.protocol) && [
      'passport.weibo.com', 'passport.weibo.cn', 'passport.sina.cn',
      'passport.sina.com.cn', 'login.sina.com.cn', 'login.sina.cn',
      'visitor.passport.weibo.cn', 'visitor.passport.weibo.com',
    ].includes(target.hostname);
  } catch {
    return false;
  }
}

// A generic HTML error page is not evidence that a credential has expired.
function isLoginHtml(text) {
  return /^\s*</u.test(text) && (
    /<title[^>]*>\s*(?:Sina Visitor System|微博(?:通行证)?[\s-]*登录|登录[\s-]*微博)\s*<\/title>/iu.test(text)
    || /<form\b[^>]*\baction\s*=\s*["']https?:\/\/(?:passport\.weibo\.(?:com|cn)|login\.sina\.com\.cn)\//iu.test(text)
  );
}

export function assertWeiboHttpResponse({ status = 200, location = '', url = '' } = {}) {
  if (status >= 300 && status < 400) {
    if (isLoginLocation(location, url)) {
      throw responseError('微博要求重新登录，当前 Cookie 已失效', 401, 'WEIBO_AUTH');
    }
    throw responseError('微博接口返回了未跟随的重定向', 502, 'WEIBO_REDIRECT');
  }
  if (status === 401) throw responseError('微博要求重新登录，当前 Cookie 已失效', 401, 'WEIBO_AUTH');
  if (isWeiboThrottleStatus(status)) {
    throw responseError(`微博访问频繁或暂不可用（HTTP ${status}），请稍后重试`, status, 'WEIBO_THROTTLED');
  }
  if (status < 200 || status >= 400) {
    // A 403 can be permissions or a challenge; do not invalidate the Cookie.
    throw responseError(`微博接口返回 HTTP ${status}`, status >= 400 && status <= 599 ? status : 502, 'WEIBO_HTTP');
  }
}

export function parseWeiboResponse(text, { format = 'json', allowEmptyReposts = false } = {}) {
  if (isLoginHtml(text)) {
    throw responseError('微博返回登录或访客系统页面，当前 Cookie 已失效', 401, 'WEIBO_AUTH');
  }
  if (format === 'text') return text;

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Never echo the response body: it may contain account details or tokens.
    throw responseError('微博接口返回非 JSON 内容，无法读取当前页');
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw responseError('微博接口返回的数据结构无效');
  }

  const businessFailed = [0, false, '0'].includes(json.ok);
  if (allowEmptyReposts && businessFailed && !json.error && !json.error_code
    && /^还没有人转发过[。！!]?$/u.test(String(json.msg || '').trim())
    && mobileTimelineList(json).length === 0) {
    return { ...json, ok: 1, data: { ...json.data, data: [] } };
  }
  if (businessFailed || json.error || json.error_code) {
    const message = String(json.error || json.msg || json.message || '微博接口返回业务错误').slice(0, 1200);
    const throttled = /频繁|风控|too many/i.test(message);
    const authFailed = /未登录|登录已失效|登录过期|请先登录|重新登录/i.test(message);
    const error = responseError(message, throttled ? 429 : authFailed ? 401 : 502,
      throttled ? 'WEIBO_THROTTLED' : authFailed ? 'WEIBO_AUTH' : 'WEIBO_BUSINESS');
    error.weibo = { errorCode: String(json.error_code || '').slice(0, 120) };
    throw error;
  }
  return json;
}

export function assertTimelineShape(json, provider) {
  let known;
  if (provider === 'official') known = Array.isArray(json?.reposts);
  else if (provider === 'desktop') known = Array.isArray(json?.data)
    || Array.isArray(json?.data?.data) || Array.isArray(json?.reposts);
  else if (provider === 'mobile') known = Array.isArray(json?.data?.data)
    || Array.isArray(json?.data?.reposts) || Array.isArray(json?.data?.cards) || Array.isArray(json?.reposts);
  else throw new TypeError(`Unknown timeline provider: ${provider}`);
  if (!known) throw responseError('微博转发列表响应结构已变化，无法将其视为空名单', 502, 'WEIBO_TIMELINE_SHAPE');
}
