import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFilterSummary,
  candidateCutoffInfo,
  candidateLoadWarning,
  digestCandidates,
  friendlyProviderText,
  MAX_MANUAL_CANDIDATES,
  MAX_MANUAL_FILE_BYTES,
  normalizeMentionMin,
  parseManualInput,
  safeWeiboUrl,
  seededShuffle,
  toCsv,
} from './appCore.js';

test('mention minimum is normalized once at the business boundary', () => {
  assert.equal(normalizeMentionMin(''), 0);
  assert.equal(normalizeMentionMin('', 2), 2);
  assert.equal(normalizeMentionMin('-3'), 0);
  assert.equal(normalizeMentionMin('2.9'), 2);
  assert.equal(normalizeMentionMin('99'), 10);
  assert.equal(normalizeMentionMin('invalid', 1), 1);
  assert.equal(normalizeMentionMin(Number.NaN, 3), 3);
  assert.equal(normalizeMentionMin({ value: 2 }, 4), 4);
});

test('filter summary uses the normalized mention minimum', () => {
  assert.equal(buildFilterSummary({ mentionMin: '2.9' }), '至少 @2');
  assert.equal(buildFilterSummary({ mentionMin: 'invalid' }), '未启用额外筛选');
});

test('filter summary records the size of the exclusion list without exposing names', () => {
  assert.equal(buildFilterSummary({ blocklistCount: 3 }), '排除名单 3 人');
});

test('candidate load warning keeps the useful incomplete-range reason', () => {
  assert.match(candidateLoadWarning({
    complete: false,
    warnings: [
      '已优先使用桌面端可见转发入口。',
      '为控制服务器资源，本次最多载入 20000 位候选。',
    ],
  }), /最多载入 20000/);
  assert.equal(candidateLoadWarning({ complete: true, warnings: ['忽略'] }), '');
});

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

test('parseManualInput normalizes csv header spacing, bom and common aliases', () => {
  const rows = parseManualInput('\uFEFF User_ID , nickname , Created_At\n1001, sameko, 2026-08-31');
  assert.equal(rows[0].uid, '1001');
  assert.equal(rows[0].screenName, 'sameko');
  assert.equal(rows[0].createdAt, '2026-08-31');
});

test('parseManualInput rejects an unclosed csv quote', () => {
  assert.throws(
    () => parseManualInput('uid,screenName\n1001,"sameko'),
    /未闭合的引号/,
  );
});

test('parseManualInput keeps line breaks inside quoted csv values', () => {
  const rows = parseManualInput('uid,screenName,text\n1001,sameko,"第一行\n第二行"');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '第一行\n第二行');
});

test('parseManualInput ignores null JSON entries', () => {
  const rows = parseManualInput('[null, "sameko"]');
  assert.deepEqual(rows.map((row) => row.screenName), ['sameko']);
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

test('parseManualInput does not infer JSON fields from object order', () => {
  assert.throws(
    () => parseManualInput('[{"first":"1001","second":"sameko"}]'),
    /第 1 项缺少 uid 或昵称/,
  );
});

test('parseManualInput reports malformed JSON without exposing parser details', () => {
  assert.throws(
    () => parseManualInput('[{"uid":"1001"}'),
    { message: '名单 JSON 格式不正确，请检查文件内容' },
  );
});

test('parseManualInput applies the paste limit to UTF-8 bytes', () => {
  const oversized = '名'.repeat(Math.floor(MAX_MANUAL_FILE_BYTES / 3) + 1);
  assert.throws(() => parseManualInput(oversized), /不能超过 5 MB/);
});

test('parseManualInput rejects oversized manual lists before normalizing them', () => {
  const items = Array.from({ length: MAX_MANUAL_CANDIDATES + 1 }, (_, index) => `候选人${index}`);
  assert.throws(() => parseManualInput(JSON.stringify(items)), /最多支持 20,000 人/);
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

test('toCsv accepts a focused set of export columns', () => {
  const csv = toCsv([{ index: 1, status: '可抽', exclusionReason: '' }], ['index', 'status', 'exclusionReason']);
  assert.equal(csv.split('\n')[0], '"index","status","exclusionReason"');
  assert.match(csv, /"1","可抽",""/);
});

test('friendlyProviderText deduplicates provider labels', () => {
  assert.equal(friendlyProviderText('mobile/mobile,cookie'), '微博公开转发 / 服务器登录态');
});
