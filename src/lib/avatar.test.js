import assert from 'node:assert/strict';
import test from 'node:test';
import { avatarFallback, safeAvatarUrl } from './avatar.js';

test('safeAvatarUrl accepts Weibo image hosts and upgrades http', () => {
  assert.equal(
    safeAvatarUrl('http://tvax3.sinaimg.cn/crop.0.0.180.180/avatar.jpg'),
    'https://tvax3.sinaimg.cn/crop.0.0.180.180/avatar.jpg',
  );
});

test('safeAvatarUrl rejects untrusted schemes and hosts', () => {
  assert.equal(safeAvatarUrl('javascript:alert(1)'), '');
  assert.equal(safeAvatarUrl('https://example.com/avatar.jpg'), '');
});

test('avatarFallback handles Chinese and emoji names', () => {
  assert.equal(avatarFallback(' 小柚子 '), '小');
  assert.equal(avatarFallback('🌸花花'), '🌸');
  assert.equal(avatarFallback(''), '候');
});
