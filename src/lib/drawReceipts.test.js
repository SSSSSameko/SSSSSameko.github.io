import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFairnessSummary,
  clearDrawHistoryStorage,
  completedDrawStats,
  DRAW_HISTORY_KEY,
  DRAW_HISTORY_LOCK_NAME,
  DRAW_HISTORY_MIGRATION_KEY,
  DRAW_HISTORY_VERSION,
  drawCountCopy,
  mergeDrawHistory,
  mutateDrawHistory,
  nextManualDrawNumber,
  normalizeDrawReceipt,
  receiptWinnerRows,
  receiptWinnerText,
  parseDrawHistoryBackup,
  readDrawHistory,
  readDrawHistoryState,
  serializeDrawHistoryBackup,
  upsertDrawReceipt,
  withDrawHistoryLock,
  winnerIdsForStatus,
  writeDrawHistory,
} from './drawReceipts.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function serializedLockManager() {
  let tail = Promise.resolve();
  return {
    request(name, options, task) {
      assert.equal(name, DRAW_HISTORY_LOCK_NAME);
      assert.deepEqual(options, { mode: 'exclusive' });
      const operation = tail.then(() => task({ name, mode: 'exclusive' }));
      tail = operation.catch(() => {});
      return operation;
    },
  };
}

test('mutateDrawHistory serializes cross-tab read/merge/write transactions', async () => {
  const storage = memoryStorage();
  const locks = serializedLockManager();
  let signalFirstStarted;
  let releaseFirst;
  let secondEntered = false;
  const firstStarted = new Promise((resolve) => { signalFirstStarted = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  const receipt = (id, drawnAt) => ({
    id,
    source: 'manual',
    drawnAt,
    results: [{ id: `prize-${id}`, name: '测试奖项', winners: [{ uid: id, screenName: id }] }],
  });

  const first = mutateDrawHistory(storage, async (history) => {
    signalFirstStarted();
    await firstRelease;
    return upsertDrawReceipt(history, receipt('first', '2026-09-07T01:00:00.000Z'));
  }, locks);
  await firstStarted;
  const second = mutateDrawHistory(storage, (history) => {
    secondEntered = true;
    return upsertDrawReceipt(history, receipt('second', '2026-09-07T02:00:00.000Z'));
  }, locks);

  await Promise.resolve();
  assert.equal(secondEntered, false);
  releaseFirst();
  const results = await Promise.all([first, second]);

  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(readDrawHistory(storage).map((item) => item.id), ['second', 'first']);
});

test('withDrawHistoryLock falls back when the Web Locks API is unavailable', async () => {
  assert.equal(await withDrawHistoryLock(async (lock) => lock === null ? 'fallback' : 'locked', null), 'fallback');
});

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

test('history storage migrates the legacy key when the current key is empty', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  values.set('weibo-lottery-history', JSON.stringify([
    normalizeDrawReceipt({ id: 'legacy-old', drawnAt: '2026-07-24T01:00:00.000Z' }),
    normalizeDrawReceipt({ id: 'legacy-new', drawnAt: '2026-07-24T02:00:00.000Z' }),
  ]));

  assert.deepEqual(readDrawHistory(storage).map((item) => item.id), ['legacy-new', 'legacy-old']);
});

test('history storage persists a successful legacy migration back to the current key', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  values.set('weibo-lottery-history', JSON.stringify([
    normalizeDrawReceipt({ id: 'legacy-persist', drawnAt: '2026-07-24T01:00:00.000Z' }),
  ]));

  assert.deepEqual(readDrawHistory(storage).map((item) => item.id), ['legacy-persist']);
  assert.deepEqual(JSON.parse(values.get(DRAW_HISTORY_KEY)).items.map((item) => item.id), ['legacy-persist']);
});

test('history storage migrates the legacy winner and backup shape without losing audit fields', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  values.set('weibo-lottery-history', JSON.stringify([{
    time: '2026-08-27T03:04:05.000Z',
    seed: 'legacy-seed',
    hash: 'legacy-hash',
    total: 42,
    winners: ['甲', '乙'],
    backups: ['丙'],
  }]));

  const state = readDrawHistoryState(storage);
  const receipt = state.items[0];

  assert.equal(state.safeToPersist, true);
  assert.equal(receipt.drawnAt, '2026-08-27T03:04:05.000Z');
  assert.equal(receipt.seed, 'legacy-seed');
  assert.equal(receipt.auditHash, 'legacy-hash');
  assert.equal(receipt.candidateCount, 42);
  assert.equal(receipt.eligibleCount, 42);
  assert.equal(receipt.sourceMeta.legacyCountsIncomplete, true);
  assert.equal(receipt.recordState, 'local');
  assert.deepEqual(receipt.results[0].winners.map((winner) => winner.screenName), ['甲', '乙']);
  assert.deepEqual(receipt.backups.map((winner) => winner.screenName), ['丙']);
});

test('history storage skips malformed records inside valid JSON without crashing', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  values.set(DRAW_HISTORY_KEY, JSON.stringify([
    null,
    'not-an-object',
    normalizeDrawReceipt({ id: 'valid-record', drawnAt: '2026-07-24T01:00:00.000Z' }),
  ]));

  assert.deepEqual(readDrawHistory(storage).map((item) => item.id), ['valid-record']);
});

test('history storage treats valid empty current wrappers as missing instead of corrupt', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  values.set(DRAW_HISTORY_KEY, JSON.stringify({}));
  values.set('weibo-lottery-history', JSON.stringify([
    normalizeDrawReceipt({ id: 'legacy-empty-wrapper', drawnAt: '2026-07-24T01:00:00.000Z' }),
  ]));

  assert.deepEqual(readDrawHistory(storage).map((item) => item.id), ['legacy-empty-wrapper']);
  assert.equal(values.has(`${DRAW_HISTORY_KEY}.corrupt`), false);
});

test('history storage isolates unknown current object shapes before legacy migration', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  values.set(DRAW_HISTORY_KEY, JSON.stringify({ version: 2, unexpected: 'shape' }));
  values.set('weibo-lottery-history', JSON.stringify([
    normalizeDrawReceipt({ id: 'legacy-after-shape', drawnAt: '2026-07-24T01:00:00.000Z' }),
  ]));

  assert.deepEqual(readDrawHistory(storage).map((item) => item.id), ['legacy-after-shape']);
  assert.equal(values.has(`${DRAW_HISTORY_KEY}.corrupt`), true);
});

test('history storage protects an oversized current payload from migration and overwrite', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  values.set(DRAW_HISTORY_KEY, `[${'0'.repeat(4_000_100)}]`);
  values.set('weibo-lottery-history', JSON.stringify([
    normalizeDrawReceipt({ id: 'legacy-after-oversized', drawnAt: '2026-07-24T01:00:00.000Z' }),
  ]));

  const state = readDrawHistoryState(storage);
  assert.deepEqual(state.items, []);
  assert.equal(state.recoveryProtected, true);
  assert.equal(state.safeToPersist, false);
  assert.equal(state.reason, 'oversized-current');
  assert.equal(values.has(`${DRAW_HISTORY_KEY}.corrupt`), true);
  assert.equal(values.has('weibo-lottery-history'), true);
  assert.equal(values.has(DRAW_HISTORY_MIGRATION_KEY), false);
});

test('history storage preserves corrupt current data and still migrates legacy data', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  values.set(DRAW_HISTORY_KEY, '{not-json');
  values.set('weibo-lottery-history', JSON.stringify([
    normalizeDrawReceipt({ id: 'legacy-record', drawnAt: '2026-07-24T01:00:00.000Z' }),
  ]));

  assert.equal(readDrawHistory(storage)[0].id, 'legacy-record');
  assert.equal(values.get(`${DRAW_HISTORY_KEY}.corrupt`), '{not-json');
});

test('history storage never overwrites corrupt current data when recovery backup fails', () => {
  const corruptValue = '{not-json';
  const recoveryKey = `${DRAW_HISTORY_KEY}.corrupt`;
  const values = new Map([[DRAW_HISTORY_KEY, corruptValue]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (key === recoveryKey) {
        const error = new Error('Quota exceeded');
        error.name = 'QuotaExceededError';
        throw error;
      }
      values.set(key, String(value));
    },
  };

  const state = readDrawHistoryState(storage);
  assert.equal(state.recoveryProtected, true);
  assert.equal(state.safeToPersist, false);
  assert.equal(values.get(DRAW_HISTORY_KEY), corruptValue);

  const result = writeDrawHistory(storage, []);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'recovery');
  assert.equal(result.attempts, 0);
  assert.equal(values.get(DRAW_HISTORY_KEY), corruptValue);
});

test('history storage can replace corrupt current data after a verified recovery backup', () => {
  const corruptValue = '{not-json';
  const recoveryKey = `${DRAW_HISTORY_KEY}.corrupt`;
  const values = new Map([[DRAW_HISTORY_KEY, corruptValue]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };

  const state = readDrawHistoryState(storage);
  assert.equal(state.recoveryProtected, false);
  assert.equal(state.safeToPersist, true);
  assert.equal(values.get(recoveryKey), corruptValue);

  const result = writeDrawHistory(storage, [{ id: 'replacement' }]);
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(values.get(DRAW_HISTORY_KEY)).items[0].id, 'replacement');
  assert.equal(values.get(recoveryKey), corruptValue);
});

test('history storage preserves corrupt legacy data instead of silently discarding it', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  values.set('weibo-lottery-history', '{legacy-not-json');

  assert.deepEqual(readDrawHistory(storage), []);
  assert.equal(values.get('weibo-lottery-history.corrupt'), '{legacy-not-json');
});

test('history storage survives a storage read error', () => {
  const storage = {
    getItem() {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(readDrawHistory(storage), []);
  assert.deepEqual(readDrawHistoryState(storage), {
    items: [],
    recoveryProtected: true,
    safeToPersist: false,
    reason: 'unavailable',
  });
});

test('history cleanup removes current, legacy, migration and recovery copies', () => {
  const keys = [
    DRAW_HISTORY_KEY,
    'weibo-lottery-history',
    `${DRAW_HISTORY_KEY}.corrupt`,
    'weibo-lottery-history.corrupt',
    DRAW_HISTORY_MIGRATION_KEY,
  ];
  const values = new Map(keys.map((key) => [key, 'stored']));
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
  };

  assert.deepEqual(clearDrawHistoryStorage(storage), { ok: true, reason: '', remaining: [] });
  assert.deepEqual(keys.map((key) => storage.getItem(key)), keys.map(() => null));
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
  const result = writeDrawHistory(storage, list, { maxBytes: 1000 });

  assert.equal(result.ok, true);
  assert.ok(result.dropped > 0);
  assert.equal(readDrawHistory(storage)[0].id, 'large-0');
  assert.equal(readDrawHistory(storage).length, result.stored);
});

test('history storage rejects one oversized record without replacing the previous value', () => {
  const values = new Map([[DRAW_HISTORY_KEY, '{previous-value']]);
  let writes = 0;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      writes += 1;
      values.set(key, String(value));
    },
  };
  const oversized = normalizeDrawReceipt({
    id: 'oversized-single-record',
    results: [{
      prize: { name: '超'.repeat(600_000), count: 0 },
      winners: [],
    }],
  });
  const result = writeDrawHistory(storage, [oversized]);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'size');
  assert.equal(result.attempts, 0);
  assert.equal(result.stored, 0);
  assert.equal(writes, 0);
  assert.equal(values.get(DRAW_HISTORY_KEY), '{previous-value');
});

test('a successful history write verifies the payload and records migration completion', () => {
  const values = new Map();
  let historyWrites = 0;
  let migrationWrites = 0;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (key === DRAW_HISTORY_KEY) historyWrites += 1;
      if (key === DRAW_HISTORY_MIGRATION_KEY) migrationWrites += 1;
      values.set(key, String(value));
    },
  };
  const result = writeDrawHistory(storage, [{ id: 'single-write' }]);

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(historyWrites, 1);
  assert.equal(migrationWrites, 1);
  assert.equal(JSON.parse(values.get(DRAW_HISTORY_KEY)).version, DRAW_HISTORY_VERSION);
});

test('history writes retry trimming only for quota errors', () => {
  const values = new Map();
  let quotaWrites = 0;
  const quotaStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (key === DRAW_HISTORY_KEY) {
        quotaWrites += 1;
        if (JSON.parse(value).items.length > 1) {
          const error = new Error('Quota exceeded');
          error.name = 'QuotaExceededError';
          throw error;
        }
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

test('normalizeDrawReceipt tolerates non-object input', () => {
  for (const value of [null, undefined, 0, 'text', []]) {
    const receipt = normalizeDrawReceipt(value);
    assert.equal(typeof receipt.id, 'string');
    assert.ok(receipt.id.length > 0);
    assert.equal(receipt.drawnAt, '');
    assert.deepEqual(receipt.results, []);
  }
});

test('history backup skips null entries instead of throwing', () => {
  const restored = parseDrawHistoryBackup(JSON.stringify({
    kind: 'sameko-weibo-draw-history',
    version: 1,
    exportedAt: '2026-08-27T03:00:00.000Z',
    items: [
      null,
      {
        id: 'backup-ok',
        drawnAt: '2026-08-27T02:00:00.000Z',
        results: [{ prize: { name: '奖项' }, winners: [{ uid: '1' }] }],
      },
    ],
  }));
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, 'backup-ok');
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
