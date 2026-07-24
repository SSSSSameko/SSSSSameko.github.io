import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFairnessSummary,
  completedDrawStats,
  drawCountCopy,
  normalizeDrawReceipt,
  readDrawHistory,
  upsertDrawReceipt,
  winnerIdsForStatus,
  writeDrawHistory,
} from './drawReceipts.js';

test('completedDrawStats counts unique saved records for one status', () => {
  const records = [
    { statusId: '100', auditHash: 'a', drawnAt: '2026-07-24T01:00:00.000Z' },
    { statusId: '100', auditHash: 'a', drawnAt: '2026-07-24T01:00:00.000Z' },
    { statusId: '100', auditHash: 'b', drawnAt: '2026-07-24T02:00:00.000Z' },
    { statusId: '200', auditHash: 'c', drawnAt: '2026-07-24T03:00:00.000Z' },
  ];

  assert.deepEqual(completedDrawStats(records, '100', 'b'), {
    count: 2,
    drawNumber: 2,
    lastDrawnAt: '2026-07-24T02:00:00.000Z',
  });
});

test('completedDrawStats ignores records without a persisted audit hash', () => {
  const records = [
    { statusId: '100', auditHash: '', drawnAt: '2026-07-24T01:00:00.000Z' },
    { statusId: '100', auditHash: 'saved', drawnAt: '2026-07-24T02:00:00.000Z' },
  ];

  assert.equal(completedDrawStats(records, '100').count, 1);
});

test('drawCountCopy uses completed draw wording', () => {
  assert.equal(drawCountCopy({ source: 'mobile', count: 0, completed: false }), '本链接尚无开奖记录');
  assert.equal(drawCountCopy({ source: 'mobile', count: 3, completed: false }), '此前已完成 3 次');
  assert.equal(drawCountCopy({ source: 'mobile', count: 3, completed: true }), '本链接第 3 次开奖');
  assert.equal(drawCountCopy({ source: 'manual', count: 2, completed: true }), '手动名单 · 本机第 2 次开奖');
});

test('normalizeDrawReceipt preserves complete prize groups and audit fields', () => {
  const receipt = normalizeDrawReceipt({
    id: 'hash-1',
    drawNumber: 2,
    drawnAt: '2026-07-24T02:00:00.000Z',
    results: [{
      prize: { name: '幸运奖', count: 1 },
      winners: [{ uid: '1', screenName: 'sameko' }],
    }],
    candidateCount: 20,
    eligibleCount: 18,
    auditHash: 'hash-1',
  });

  assert.equal(receipt.results[0].winners[0].screenName, 'sameko');
  assert.equal(receipt.excludedCount, 2);
  assert.equal(receipt.drawNumber, 2);
});

test('normalizeDrawReceipt discards an invalid draw number', () => {
  assert.equal(normalizeDrawReceipt({ drawNumber: 'invalid' }).drawNumber, null);
});

test('history storage rejects malformed data and caps records at 50', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };

  assert.deepEqual(readDrawHistory(storage), []);
  const list = Array.from({ length: 55 }, (_, index) => normalizeDrawReceipt({
    id: `id-${index}`,
    drawnAt: new Date(2026, 6, 24, 0, index).toISOString(),
    results: [{
      prize: { name: '奖项', count: 1 },
      winners: [{ uid: String(index) }],
    }],
  }));
  writeDrawHistory(storage, list);

  assert.equal(readDrawHistory(storage).length, 50);
});

test('upsertDrawReceipt replaces the same audit record', () => {
  const first = normalizeDrawReceipt({ id: 'same', recordState: 'local', results: [] });
  const saved = normalizeDrawReceipt({
    id: 'same',
    recordState: 'server',
    drawNumber: 1,
    results: [],
  });
  const result = upsertDrawReceipt([first], saved);

  assert.equal(result.length, 1);
  assert.equal(result[0].recordState, 'server');
});

test('buildFairnessSummary includes the filters and actual random method', () => {
  const text = buildFairnessSummary(normalizeDrawReceipt({
    source: 'mobile',
    drawNumber: 2,
    drawnAt: '2026-07-24T02:00:00.000Z',
    candidateCount: 20,
    eligibleCount: 18,
    rules: {
      filters: {
        keyword: '',
        mentionMin: 0,
        uniqueByUser: true,
        excludePrevious: true,
      },
    },
    seed: 'seed-1',
    auditHash: 'audit-1',
    candidateDigest: 'digest-1',
    results: [],
  }));

  assert.match(text, /本链接第 2 次开奖/);
  assert.match(text, /载入 20 人 · 可抽 18 人/);
  assert.match(text, /筛选规则：同一用户只保留一次 \/ 排除本轮已中奖用户/);
  assert.match(text, /随机规则：SHA-256 · Fisher–Yates/);
  assert.match(text, /随机种子：seed-1/);
  assert.match(text, /审计哈希：audit-1/);
  assert.match(text, /名单指纹：digest-1/);
});

test('winnerIdsForStatus restores winners only for the same Weibo post', () => {
  const history = [
    normalizeDrawReceipt({
      id: 'one',
      statusId: '100',
      results: [{
        prize: { name: '幸运奖', count: 2 },
        winners: [
          { uid: 'u1', screenName: 'sameko' },
          { uid: 'u2', screenName: 'alice' },
        ],
      }],
    }),
    normalizeDrawReceipt({
      id: 'two',
      statusId: '200',
      results: [{
        prize: { name: '幸运奖', count: 1 },
        winners: [{ uid: 'u3', screenName: 'bob' }],
      }],
    }),
  ];

  assert.deepEqual([...winnerIdsForStatus(history, '100')].sort(), ['u1', 'u2']);
});
