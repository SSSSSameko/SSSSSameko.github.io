import { appendFileSync } from 'node:fs';

const nativeFetch = globalThis.fetch;
const scenario = String(process.env.WEIBO_PROVIDER_MOCK_SCENARIO || '').trim();
const logFile = String(process.env.WEIBO_PROVIDER_MOCK_LOG || '').trim();
const largeCandidateCache = new Map();
let clockOffsetMs = 0;

if (scenario === 'head-meta' || scenario === 'all') {
  const nativeNow = Date.now.bind(Date);
  Date.now = () => nativeNow() + clockOffsetMs;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function html(payload, status = 200) {
  return new Response(payload, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function candidate(repostId, uid = `u-${repostId}`, screenName = `用户${repostId}`) {
  return {
    idstr: String(repostId),
    text: '',
    user: {
      idstr: String(uid),
      screen_name: screenName,
    },
  };
}

function largeCandidates(statusId, count) {
  const key = `${statusId}:${count}`;
  if (!largeCandidateCache.has(key)) {
    largeCandidateCache.set(key, Array.from(
      { length: count },
      (_, index) => candidate(`${statusId}-${index}`, `${index}`, `用户${index}`),
    ));
  }
  return largeCandidateCache.get(key);
}

function requestHeaders(input, options) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(options?.headers || {}).forEach((value, name) => headers.set(name, value));
  return headers;
}

function cookieLabel(cookie) {
  if (cookie.includes('POOL_BAD=1')) return 'bad';
  if (cookie.includes('POOL_GOOD=1')) return 'good';
  return cookie ? 'other' : 'none';
}

function recordRequest(url, headers) {
  if (!logFile) return;
  appendFileSync(logFile, `${JSON.stringify({
    scenario,
    host: url.hostname,
    pathname: url.pathname,
    statusId: statusIdFromUrl(url),
    page: Number(url.searchParams.get('page') || 0),
    count: Number(url.searchParams.get('count') || 0),
    cookie: cookieLabel(headers.get('cookie') || ''),
  })}\n`, 'utf8');
}

function statusIdFromUrl(url) {
  return url.searchParams.get('id')
    || url.pathname.match(/bid-(\d+)/)?.[1]
    || '';
}

function statusInfo(statusId, totalNumber) {
  return json({
    idstr: statusId,
    mid: statusId,
    mblogid: `bid-${statusId}`,
    reposts_count: totalNumber,
    user: { idstr: `owner-${statusId}` },
  });
}

function mobileTimeline(items, totalNumber, max = 1) {
  return json({
    ok: 1,
    data: {
      data: items,
      max,
      total_number: totalNumber,
    },
  });
}

function desktopTimeline(items, totalNumber, maxPage = 1) {
  return json({
    data: items,
    max_page: maxPage,
    total_number: totalNumber,
  });
}

function legacyEmpty() {
  return html('<html><body><input name="mp" value="1"></body></html>');
}

function partialMobile(url) {
  const statusId = statusIdFromUrl(url);
  if (url.pathname === '/ajax/statuses/show') return statusInfo(statusId, 3);
  if (url.pathname === '/ajax/statuses/repostTimeline') {
    if (Number(url.searchParams.get('page') || 1) > 1) return desktopTimeline([], 3, 50);
    return desktopTimeline([
      candidate('partial-shared', 'user-shared', '共同候选'),
      candidate('partial-desktop', 'user-desktop', '桌面候选'),
    ], 3, 50);
  }
  if (url.pathname === '/api/statuses/repostTimeline') {
    return mobileTimeline([
      candidate('partial-shared', 'user-shared', '共同候选'),
      candidate('partial-mobile', 'user-mobile', '移动候选'),
    ], 3);
  }
  return null;
}

function cookieRotation(url, headers) {
  const statusId = statusIdFromUrl(url);
  const badCookie = cookieLabel(headers.get('cookie') || '') === 'bad';
  if (url.pathname === '/ajax/statuses/show') return statusInfo(statusId, 1);
  if (badCookie && [
    '/ajax/statuses/repostTimeline',
    '/api/statuses/repostTimeline',
  ].includes(url.pathname)) {
    return json({ ok: 0, msg: '请先登录' }, 401);
  }
  if (badCookie && url.hostname === 'weibo.cn' && url.pathname.startsWith('/repost/')) {
    return html('请先登录', 401);
  }
  if (url.pathname === '/ajax/statuses/repostTimeline') {
    return desktopTimeline([candidate('rotation-valid', 'rotation-user', '有效账号候选')], 1);
  }
  return null;
}

function emptyPages(url) {
  const statusId = statusIdFromUrl(url);
  if (url.pathname === '/ajax/statuses/show') return statusInfo(statusId, 1);
  if (url.pathname === '/ajax/statuses/repostTimeline') return desktopTimeline([], 1, 50);
  if (url.pathname === '/api/statuses/repostTimeline') {
    return mobileTimeline([candidate('empty-pages-mobile', 'empty-pages-user', '移动入口候选')], 1);
  }
  return null;
}

function candidateCap(url) {
  const statusId = statusIdFromUrl(url);
  const totalNumber = statusId === '940001' ? 20_001 : 20_000;
  if (url.pathname === '/ajax/statuses/show') return statusInfo(statusId, totalNumber);
  if (url.pathname === '/ajax/statuses/repostTimeline') {
    return desktopTimeline(largeCandidates(statusId, totalNumber), totalNumber);
  }
  if (url.pathname === '/api/statuses/repostTimeline') return mobileTimeline([], totalNumber);
  if (url.hostname === 'weibo.cn' && url.pathname.startsWith('/repost/')) return legacyEmpty();
  return null;
}

function legacyId(url) {
  const statusId = statusIdFromUrl(url);
  if (url.pathname === '/ajax/statuses/show') return statusInfo(statusId, 1);
  if (url.pathname === '/ajax/statuses/repostTimeline') return desktopTimeline([], 1);
  if (url.pathname === '/api/statuses/repostTimeline') return mobileTimeline([], 1);
  if (url.hostname === 'weibo.cn' && url.pathname.startsWith('/repost/')) {
    return html([
      '<html><body>',
      '<input name="mp" value="1">',
      '<div class="c" id="M_987654321">',
      '<a href="/u/710001">旧版候选</a>: 转发测试 ',
      '<a href="/attitude/987654321">赞[1]</a>',
      '</div>',
      '</body></html>',
    ].join(''));
  }
  return null;
}

function headMeta(url) {
  const statusId = statusIdFromUrl(url);
  if (url.pathname === '/ajax/statuses/show') return statusInfo(statusId, 3);
  if (url.pathname !== '/ajax/statuses/repostTimeline') return null;

  const page = Number(url.searchParams.get('page') || 1);
  const count = Number(url.searchParams.get('count') || 0);
  if (page === 1 && count === 20) {
    return desktopTimeline([
      candidate('head-new', 'head-new-user', '刚新增的候选'),
      candidate('head-old-1', 'head-old-user-1', '原候选一'),
    ], 3, 2);
  }
  if (page === 1) {
    return desktopTimeline([candidate('head-old-1', 'head-old-user-1', '原候选一')], 3, 2);
  }
  if (page === 2) {
    clockOffsetMs = 6_000;
    return desktopTimeline([candidate('head-old-2', 'head-old-user-2', '原候选二')], 3, 2);
  }
  return null;
}

function unknownDesktop(url) {
  const statusId = statusIdFromUrl(url);
  if (url.pathname === '/ajax/statuses/show') return json({ ok: 0, msg: '正文信息暂不可用' }, 502);
  if (url.pathname === '/ajax/statuses/repostTimeline') return desktopTimeline([], undefined, undefined);
  if (url.pathname === '/api/statuses/repostTimeline') {
    if (statusId === '970002') return mobileTimeline([], 0);
    return mobileTimeline([candidate('unknown-desktop-mobile', 'unknown-desktop-user', 'H5 候选')], 1);
  }
  if (url.hostname === 'weibo.cn' && url.pathname.startsWith('/repost/')) return legacyEmpty();
  return null;
}

function allScenarios(url, headers) {
  const handlersByStatus = {
    910001: partialMobile,
    920001: cookieRotation,
    930001: emptyPages,
    940001: candidateCap,
    940002: candidateCap,
    950001: legacyId,
    960001: headMeta,
    970001: unknownDesktop,
    970002: unknownDesktop,
  };
  return handlersByStatus[statusIdFromUrl(url)]?.(url, headers) || null;
}

const handlers = {
  'partial-mobile': partialMobile,
  'cookie-rotation': cookieRotation,
  'empty-pages': emptyPages,
  'candidate-cap': candidateCap,
  'legacy-id': legacyId,
  'head-meta': headMeta,
  'unknown-desktop': unknownDesktop,
  all: allScenarios,
};

globalThis.fetch = async (input, options = {}) => {
  const url = input instanceof URL
    ? input
    : new URL(typeof input === 'string' ? input : input.url);
  const isWeibo = url.hostname === 'weibo.com'
    || url.hostname.endsWith('.weibo.com')
    || url.hostname === 'weibo.cn'
    || url.hostname.endsWith('.weibo.cn');
  if (!isWeibo) {
    if (['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      return await nativeFetch(input, options);
    }
    throw new Error(`离线测试禁止外部请求：${url}`);
  }

  if (options.redirect !== 'error') {
    throw new Error(`微博请求没有禁用重定向：${url}`);
  }
  const headers = requestHeaders(input, options);
  recordRequest(url, headers);
  const handler = handlers[scenario];
  if (!handler) throw new Error(`未知微博 mock 场景：${scenario || '(empty)'}`);
  const response = handler(url, headers);
  if (!response) throw new Error(`场景 ${scenario} 未处理微博请求：${url}`);
  return response;
};
