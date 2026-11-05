import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  desktopTimelineList,
  legacyMaxPage,
  legacyTimelineList,
  mobileTimelineList,
  normalizeCandidate,
} from './timeline-parsers.mjs';

test('desktop and H5 response envelopes resolve to their timeline entries', () => {
  const entries = [{ idstr: 'one' }];
  assert.equal(desktopTimelineList({ data: entries }), entries);
  assert.equal(desktopTimelineList({ data: { data: entries } }), entries);
  assert.equal(desktopTimelineList({ reposts: entries }), entries);
  assert.equal(mobileTimelineList({ data: { data: entries } }), entries);
  assert.equal(mobileTimelineList({ data: { reposts: entries } }), entries);
  assert.deepEqual(mobileTimelineList({ data: { cards: [{ card_group: entries }] } }), entries);
  assert.deepEqual(mobileTimelineList({ ok: 0, msg: '还没有人转发过' }), []);
});

test('normalization produces stable identities and bounded display fields', () => {
  const item = { idstr: 'entry', text: '正文', user: { idstr: 'user', screen_name: '用'.repeat(200) } };
  const normalized = normalizeCandidate(item, 'desktop-cookie');
  assert.equal(normalized.id, normalizeCandidate(item, 'mobile').id);
  assert.equal(normalized.screenName.length, 120);
  assert.equal(normalized.repostId, 'entry');
});

test('legacy parser preserves the real repost identity and excludes unrelated page blocks', () => {
  const html = '<div class="c">页眉</div><div class="c" id="M_real123"><a href="/u/123">昵称</a>: 正文 <a href="/attitude/real123">赞[1]</a></div>';
  const entries = legacyTimelineList(html, 2);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].idstr, 'real123');
  assert.equal(entries[0].user.idstr, '123');
  assert.equal(entries[0].user.screen_name, '昵称');
  assert.equal(entries[0].text.startsWith('正文'), true);
});

test('legacy page counts use a declared maximum or the largest available page link', () => {
  assert.equal(legacyMaxPage('<input name="mp" value="42">'), 42);
  assert.equal(legacyMaxPage('<a href="?page=2">2</a><a href="?page=3">3</a>'), 3);
  assert.equal(legacyMaxPage(''), null);
  assert.equal(legacyMaxPage(`<input name="mp" value="${'9'.repeat(400)}">`), null);
});
