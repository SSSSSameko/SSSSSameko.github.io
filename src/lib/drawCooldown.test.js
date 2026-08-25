import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquireDrawGuard,
  completeDrawGuard,
  drawCooldownScope,
  drawCooldownStatus,
  DRAW_COOLDOWN_MS,
  releaseDrawGuard,
} from './drawCooldown.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test('draw cooldown uses the loaded Weibo id and skips manual lists', () => {
  assert.equal(drawCooldownScope({ source: 'manual', statusId: '123' }), '');
  assert.equal(drawCooldownScope({ source: 'mobile', statusId: '123' }), 'weibo:123');
  assert.equal(
    drawCooldownScope({ source: 'mobile', statusUrl: 'http://m.weibo.cn/detail/123' }),
    'weibo-url:https://m.weibo.cn/detail/123',
  );
});

test('only a completed draw starts the one-minute cooldown', () => {
  const storage = memoryStorage();
  const scope = 'weibo:123';
  const first = acquireDrawGuard(storage, scope, 1_000);
  assert.equal(first.ok, true);
  assert.equal(drawCooldownStatus(storage, scope, 1_100).reason, 'running');

  releaseDrawGuard(storage, scope, first.token, 1_200);
  assert.equal(drawCooldownStatus(storage, scope, 1_300).blocked, false);

  const second = acquireDrawGuard(storage, scope, 2_000);
  completeDrawGuard(storage, scope, second.token, 3_000);
  const blocked = drawCooldownStatus(storage, scope, 3_500);
  assert.equal(blocked.reason, 'cooldown');
  assert.equal(blocked.remainingMs, DRAW_COOLDOWN_MS - 500);
  assert.equal(drawCooldownStatus(storage, scope, 3_000 + DRAW_COOLDOWN_MS).blocked, false);
});

test('a different link can draw while another link is cooling down', () => {
  const storage = memoryStorage();
  const first = acquireDrawGuard(storage, 'weibo:123', 1_000);
  completeDrawGuard(storage, 'weibo:123', first.token, 2_000);
  assert.equal(acquireDrawGuard(storage, 'weibo:456', 2_100).ok, true);
});
