import assert from 'node:assert/strict';
import test from 'node:test';

import {
  digestCandidates,
  friendlyProviderText,
  parseManualInput,
  seededShuffle,
  toCsv,
} from './appCore.js';

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
  assert.equal(friendlyProviderText('mobile/mobile,cookie'), 'H5 可见转发 / 服务器 Cookie 池');
});
