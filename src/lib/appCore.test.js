import assert from 'node:assert/strict';
import test from 'node:test';

import {
  candidateCutoffInfo,
  digestCandidates,
  friendlyProviderText,
  parseManualInput,
  safeWeiboUrl,
  seededShuffle,
  toCsv,
} from './appCore.js';

test('candidate cutoff keeps an explicit draw-list boundary', () => {
  const loadedAt = new Date(2026, 7, 25, 10, 20).toISOString();
  const now = new Date(2026, 7, 25, 10, 23).getTime();
  const info = candidateCutoffInfo(loadedAt, now);

  assert.match(info.label, /10:20.*截止/);
  assert.equal(info.ageMs, 3 * 60_000);
  assert.deepEqual(candidateCutoffInfo('', now), { label: '本次载入', ageMs: 0 });
});

test('safeWeiboUrl only keeps links to Weibo', () => {
  assert.equal(safeWeiboUrl('javascript:alert(1)'), '');
  assert.equal(safeWeiboUrl('https://evil.example/post'), '');
  assert.equal(safeWeiboUrl('http://m.weibo.cn/detail/123'), 'https://m.weibo.cn/detail/123');
});

test('parseManualInput accepts one screen name per line', () => {
  const rows = parseManualInput('sameko\nalice');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].screenName, 'sameko');
  assert.equal(rows[0].uid, '');
  assert.equal(rows[1].source, 'manual');
});

test('parseManualInput reads csv headers and quoted values', () => {
  const rows = parseManualInput('uid,screenName,text\n1001,"sameko,chan","转发内容"');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].uid, '1001');
  assert.equal(rows[0].screenName, 'sameko,chan');
  assert.equal(rows[0].text, '转发内容');
});

test('parseManualInput treats two columns without a header as uid then nickname', () => {
  const rows = parseManualInput('1001,sameko');
  assert.equal(rows[0].uid, '1001');
  assert.equal(rows[0].screenName, 'sameko');
});

test('parseManualInput keeps JSON string names intact', () => {
  const rows = parseManualInput('["sameko", "alice"]');
  assert.deepEqual(rows.map((row) => row.screenName), ['sameko', 'alice']);
  assert.deepEqual(rows.map((row) => row.uid), ['', '']);
});

test('seededShuffle is deterministic and keeps every item', async () => {
  const rows = [{ uid: '1' }, { uid: '2' }, { uid: '3' }, { uid: '4' }];
  const first = await seededShuffle(rows, 'seed-1');
  const second = await seededShuffle(rows, 'seed-1');
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((item) => item.uid).sort(), ['1', '2', '3', '4']);
});

test('digestCandidates returns a stable sha-256 hex digest', async () => {
  const rows = [{ uid: '1', screenName: 'sameko', repostId: 'r1', text: 'hi', createdAt: '2026-06-03' }];
  const first = await digestCandidates(rows);
  const second = await digestCandidates(rows);
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test('toCsv escapes formula-like values before export', () => {
  const csv = toCsv([{ tier: '一等奖', uid: '=1+1', screenName: '@sameko', text: 'ok', createdAt: '', source: 'manual' }]);
  assert.match(csv, /"'=1\+1"/);
  assert.match(csv, /"'@sameko"/);
});

test('friendlyProviderText deduplicates provider labels', () => {
  assert.equal(friendlyProviderText('mobile/mobile,cookie'), '微博公开转发 / 服务器登录态');
});
