import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFairnessSummary,
  completedDrawStats,
  DRAW_HISTORY_KEY,
  DRAW_HISTORY_VERSION,
  drawCountCopy,
  mergeDrawHistory,
  nextManualDrawNumber,
  normalizeDrawReceipt,
  receiptWinnerRows,
  receiptWinnerText,
  parseDrawHistoryBackup,
  readDrawHistory,
  serializeDrawHistoryBackup,
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

test('completedDrawStats keeps persisted order when client clocks disagree', () => {
  const records = [
    {
      statusId: '100',
      auditHash: 'first',
      drawNumber: 1,
      drawnAt: '2026-07-25T02:00:00.000Z',
      savedAt: '2026-07-24T01:00:00.000Z',
    },
    {
      statusId: '100',
      auditHash: 'second',
      drawNumber: 2,
      drawnAt: '2026-07-23T02:00:00.000Z',
      savedAt: '2026-07-24T02:00:00.000Z',
    },
  ];

  assert.deepEqual(completedDrawStats(records, '100', 'second'), {
    count: 2,
    drawNumber: 2,
    lastDrawnAt: '2026-07-23T02:00:00.000Z',
  });
});

test('completedDrawStats ignores unsafe or fractional persisted sequence values', () => {
  const records = [
    { statusId: '100', auditHash: 'first', drawNumber: 1.5, savedAt: '2026-07-24T01:00:00.000Z' },
    { statusId: '100', auditHash: 'second', drawNumber: Number.MAX_SAFE_INTEGER + 1, savedAt: '2026-07-24T02:00:00.000Z' },
  ];

  assert.equal(completedDrawStats(records, '100', 'second').drawNumber, 2);
});

test('completedDrawStats keeps a deterministic order across legacy and numbered records', () => {
  const records = [
    {
      statusId: '100',
      auditHash: 'numbered',
      drawNumber: 2,
      drawnAt: '2026-08-01T02:00:00.000Z',
      savedAt: '2026-08-01T02:00:01.000Z',
    },
    {
      statusId: '100',
      auditHash: 'legacy-late',
      drawnAt: '2026-08-01T01:00:00.000Z',
      savedAt: '2026-08-01T01:00:01.000Z',
    },
    {
      statusId: '100',
      auditHash: 'numbered-one',
      drawNumber: 1,
      drawnAt: '2026-07-01T01:00:00.000Z',
      savedAt: '2026-07-01T01:00:01.000Z',
    },
    {
      statusId: '100',
      auditHash: 'legacy-early',
      drawnAt: '2026-07-01T00:00:00.000Z',
      savedAt: '2026-07-01T00:00:01.000Z',
    },
  ];
  const expected = completedDrawStats(records, '100', 'legacy-late');
  const reversed = completedDrawStats([...records].reverse(), '100', 'legacy-late');

  assert.deepEqual(expected, reversed);
  assert.equal(expected.count, 4);
  assert.equal(expected.drawNumber, 2);
  assert.equal(expected.lastDrawnAt, '2026-08-01T02:00:00.000Z');
});

test('completedDrawStats prefers the server copy of a duplicate hash', () => {
  const local = {
    statusId: '100',
    auditHash: 'same',
    recordState: 'local',
    drawnAt: '2026-08-01T00:00:00.000Z',
  };
  const server = {
    ...local,
    recordState: 'server',
    drawNumber: 7,
    savedAt: '2026-08-01T00:00:01.000Z',
  };
  assert.equal(completedDrawStats([local, server], '100', 'same').drawNumber, 7);
  assert.equal(completedDrawStats([server, local], '100', 'same').drawNumber, 7);
});

test('drawCountCopy uses completed draw wording', () => {
  assert.equal(drawCountCopy({ source: 'mobile', count: 0, completed: false }), '本链接尚无开奖记录');
  assert.equal(drawCountCopy({ source: 'mobile', count: 3, completed: false }), '此前已完成 3 次');
  assert.equal(drawCountCopy({ source: 'mobile', count: 3, completed: true }), '本链接第 3 次开奖');
  assert.equal(drawCountCopy({ source: 'manual', count: 2, completed: true }), '手动名单 · 本机第 2 次开奖');
});

test('nextManualDrawNumber uses the highest saved manual sequence', () => {
  const history = [
    { id: 'manual-1', source: 'manual', recordState: 'server', drawNumber: 1 },
    { id: 'manual-7', source: 'manual', recordState: 'server', drawNumber: 7 },
    { id: 'local-9', source: 'manual', recordState: 'local', drawNumber: 9 },
    { id: 'weibo-12', source: 'mobile', recordState: 'server', drawNumber: 12 },
    { id: 'invalid', source: 'manual', recordState: 'server', drawNumber: 1.5 },
  ];

  assert.equal(nextManualDrawNumber(history), 8);
  assert.equal(nextManualDrawNumber(history, 'manual-7'), 2);
  assert.equal(nextManualDrawNumber([], 'missing'), 1);
});

test('nextManualDrawNumber stops before an unsafe sequence value', () => {
  assert.equal(nextManualDrawNumber([
    {
      id: 'manual-max',
      source: 'manual',
      recordState: 'server',
      drawNumber: Number.MAX_SAFE_INTEGER,
    },
  ]), null);
});

test('winner exports keep prize order, rank and identity', () => {
  const receipt = {
    results: [{
      prize: { name: '一等奖' },
      winners: [
        { uid: '100', screenName: '小花' },
        { uid: '', screenName: '小蓝' },
      ],
    }],
  };

  assert.deepEqual(receiptWinnerRows(receipt), [
    { prize: '一等奖', rank: 1, uid: '100', screenName: '小花' },
    { prize: '一等奖', rank: 2, uid: '', screenName: '小蓝' },
  ]);
  assert.equal(receiptWinnerText(receipt), '一等奖\n1. 小花（UID 100）\n2. 小蓝');
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
  assert.equal(normalizeDrawReceipt({ drawNumber: -1 }).drawNumber, null);
  assert.equal(normalizeDrawReceipt({ drawNumber: 1.5 }).drawNumber, null);
  assert.equal(normalizeDrawReceipt({ drawNumber: Number.MAX_SAFE_INTEGER + 1 }).drawNumber, null);
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

test('history storage trims oldest records to stay below the byte budget', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  const list = Array.from({ length: 8 }, (_, index) => normalizeDrawReceipt({
    id: `large-${index}`,
    drawnAt: new Date(2026, 7, 27, 0, index).toISOString(),
    results: [{
      prize: { name: '奖项' },
      winners: [{ uid: `${index}-${'x'.repeat(900)}` }],
    }],
  }));
  const result = writeDrawHistory(storage, list, { maxBytes: 700 });

  assert.equal(result.ok, true);
  assert.ok(result.dropped > 0);
  assert.equal(readDrawHistory(storage)[0].id, 'large-0');
  assert.equal(readDrawHistory(storage).length, result.stored);
});

test('a successful history write calls setItem once and verifies the stored payload', () => {
  const values = new Map();
  let writes = 0;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      writes += 1;
      values.set(key, String(value));
    },
  };
  const result = writeDrawHistory(storage, [{ id: 'single-write' }]);

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(writes, 1);
  assert.equal(JSON.parse(values.get(DRAW_HISTORY_KEY)).version, DRAW_HISTORY_VERSION);
});

test('history writes retry trimming only for quota errors', () => {
  const values = new Map();
  let quotaWrites = 0;
  const quotaStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      quotaWrites += 1;
      if (JSON.parse(value).items.length > 1) {
        const error = new Error('Quota exceeded');
        error.name = 'QuotaExceededError';
        throw error;
      }
      values.set(key, String(value));
    },
  };
  const history = [{ id: 'newest' }, { id: 'middle' }, { id: 'oldest' }];
  const degraded = writeDrawHistory(quotaStorage, history);

  assert.equal(degraded.ok, true);
  assert.equal(degraded.stored, 1);
  assert.equal(degraded.dropped, 2);
  assert.equal(degraded.attempts, 3);
  assert.equal(quotaWrites, 3);
  assert.equal(degraded.items[0].id, 'newest');

  let deniedWrites = 0;
  const denied = writeDrawHistory({
    getItem: () => null,
    setItem() {
      deniedWrites += 1;
      throw new Error('storage denied');
    },
  }, history);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'unavailable');
  assert.equal(denied.attempts, 1);
  assert.equal(deniedWrites, 1);
});

test('history backup records when older records were omitted for the byte limit', () => {
  const history = Array.from({ length: 3 }, (_, index) => normalizeDrawReceipt({
    id: `backup-large-${index}`,
    drawnAt: new Date(2026, 7, 27, 0, index).toISOString(),
    results: [{ prize: { name: '奖项' }, winners: [{ uid: 'x'.repeat(400) }] }],
  }));
  const backup = serializeDrawHistoryBackup(history, '2026-08-27T03:00:00.000Z', { maxBytes: 1500 });
  const parsed = JSON.parse(backup);

  assert.equal(parsed.truncated, true);
  assert.ok(parsed.omittedCount > 0);
  assert.ok(parsed.items.length >= 1);
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

test('history backup round-trips valid records', () => {
  const history = [normalizeDrawReceipt({
    id: 'backup-1',
    drawnAt: '2026-08-27T02:00:00.000Z',
    results: [{
      prize: { name: '幸运奖', count: 1 },
      winners: [{ uid: '100', screenName: 'sameko' }],
    }],
  })];
  const backup = serializeDrawHistoryBackup(history, '2026-08-27T03:00:00.000Z');
  const restored = parseDrawHistoryBackup(backup);

  assert.equal(restored.length, 1);
  assert.equal(restored[0].results[0].winners[0].screenName, 'sameko');
  assert.match(backup, /sameko-weibo-draw-history/);
});

test('history backup rejects unrelated json', () => {
  assert.throws(
    () => parseDrawHistoryBackup('{"items":[]}'),
    /请选择由本应用导出的开奖记录备份/,
  );
});

test('history merge deduplicates records and keeps server state', () => {
  const local = normalizeDrawReceipt({
    id: 'same',
    drawnAt: '2026-08-27T02:00:00.000Z',
    results: [{ prize: { name: '奖项' }, winners: [{ uid: '1' }] }],
  });
  const server = normalizeDrawReceipt({
    ...local,
    auditHash: 'same',
    recordState: 'server',
  });
  const merged = mergeDrawHistory([local], [server]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].recordState, 'server');
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
  assert.match(text, /筛选规则：同一用户只保留一次 \/ 排除当前任务已中奖用户/);
  assert.match(text, /随机规则：SHA-256 · Fisher–Yates/);
  assert.match(text, /随机种子：seed-1/);
  assert.match(text, /过程哈希：audit-1/);
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
