import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertTimelineShape, assertWeiboHttpResponse, parseWeiboResponse } from './response-policy.mjs';

test('HTTP classification keeps authentication, throttling and permission errors separate', () => {
  for (const status of [401, 403, 418, 429, 500, 503]) {
    assert.throws(() => assertWeiboHttpResponse({ status }), (error) => error.status === status);
  }
  assert.doesNotThrow(() => assertWeiboHttpResponse({ status: 200 }));
});

test('only known login redirect hosts invalidate credentials and targets are not reflected', () => {
  assert.throws(() => assertWeiboHttpResponse({ status: 302, location: 'https://passport.weibo.com/sso?token=private' }),
    (error) => error.status === 401 && !error.message.includes('private'));
  for (const location of ['https://passport.weibo.com.evil.test/', 'https://elsewhere.test/login', '/other', 'https://weibo.com/?next=passport.weibo.com']) {
    assert.throws(() => assertWeiboHttpResponse({ status: 302, location, url: 'https://weibo.com/' }),
      (error) => error.status === 502 && error.code === 'WEIBO_REDIRECT');
  }
});

test('login HTML is rejected for JSON and legacy pages without classifying all HTML as expired login', () => {
  for (const format of ['json', 'text']) {
    for (const title of ['微博登录', 'Sina Visitor System']) {
      assert.throws(() => parseWeiboResponse(`<html><title>${title}</title></html>`, { format }), { status: 401 });
    }
  }
  assert.throws(() => parseWeiboResponse('<html>temporary failure secret</html>'),
    (error) => error.status === 502 && !error.message.includes('secret'));
  assert.equal(parseWeiboResponse('<html>ordinary legacy timeline</html>', { format: 'text' }), '<html>ordinary legacy timeline</html>');
  assert.deepEqual(parseWeiboResponse('{"data":[{"text":"Sina Visitor System"}]}'), { data: [{ text: 'Sina Visitor System' }] });
});

test('invalid JSON envelopes cannot silently become empty timelines', () => {
  for (const body of ['null', '[]', 'true', '12', '"text"', '{']) {
    assert.throws(() => parseWeiboResponse(body), { status: 502 });
  }
  for (const provider of ['desktop', 'mobile', 'official']) {
    assert.throws(() => assertTimelineShape({ ok: 1, data: {} }, provider), { code: 'WEIBO_TIMELINE_SHAPE' });
  }
  assert.doesNotThrow(() => assertTimelineShape({ data: [] }, 'desktop'));
  assert.doesNotThrow(() => assertTimelineShape({ data: { data: [] } }, 'mobile'));
  assert.doesNotThrow(() => assertTimelineShape({ reposts: [] }, 'official'));
});

test('business failures recognize both message fields and string status without swallowing empty H5 results', () => {
  assert.throws(() => parseWeiboResponse('{"ok":"0","message":"访问频繁"}'), { status: 429 });
  assert.throws(() => parseWeiboResponse('{"ok":0,"message":"请先登录"}'), { status: 401 });
  assert.throws(() => parseWeiboResponse('{"ok":false,"msg":"未知错误"}'), { status: 502 });
  const empty = parseWeiboResponse('{"ok":0,"msg":"还没有人转发过"}', { allowEmptyReposts: true });
  assert.doesNotThrow(() => assertTimelineShape(empty, 'mobile'));
  assert.equal(empty.data.total_number, undefined);
  assert.throws(() => parseWeiboResponse('{"ok":0,"msg":"还没有人转发过","error_code":123}', { allowEmptyReposts: true }), { status: 502 });
});
