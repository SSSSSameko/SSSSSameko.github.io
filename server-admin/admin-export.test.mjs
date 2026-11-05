import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectDrawRecords } from './admin-export.js';

test('logout cancels an export during rate-limit backoff without retrying or caching', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = collectDrawRecords({
    items: [{ file: 'record.json' }],
    cached: () => null,
    load: async () => {
      calls += 1;
      throw Object.assign(new Error('busy'), { status: 429, retryAfter: '30' });
    },
    remember: () => assert.fail('must not cache after logout'),
    progress: (text) => {
      if (text.includes('秒后继续')) controller.abort();
    },
    signal: controller.signal,
  });
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('an aborted detail response is discarded even if the transport ignores cancellation', async () => {
  const controller = new AbortController();
  await assert.rejects(
    collectDrawRecords({
      items: [{ file: 'record.json' }],
      cached: () => null,
      load: async () => {
        controller.abort();
        return { file: 'record.json', winners: [] };
      },
      remember: () => assert.fail('must not cache'),
      progress: () => {},
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
});

test('exports preserve order and stop on missing records instead of silently exporting incomplete data', async () => {
  const args = {
    items: [{ file: 'a' }, { file: 'b' }],
    cached: () => null,
    load: async (file) => ({ file, winners: [] }),
    remember: () => {},
    progress: () => {},
    signal: new AbortController().signal,
  };
  assert.deepEqual(
    (await collectDrawRecords(args)).map((record) => record.file),
    ['a', 'b'],
  );
  await assert.rejects(collectDrawRecords({ ...args, load: async () => null }), /返回格式异常/);
});
