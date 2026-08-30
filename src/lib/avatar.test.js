import assert from 'node:assert/strict';
import test from 'node:test';
import { avatarFallback, avatarProxyUrl, safeAvatarUrl } from './avatar.js';

test('safeAvatarUrl accepts Weibo image hosts and upgrades http', () => {
  assert.equal(
    safeAvatarUrl('http://tvax3.sinaimg.cn/crop.0.0.180.180/avatar.jpg'),
    'https://tvax3.sinaimg.cn/crop.0.0.180.180/avatar.jpg',
  );
});

test('safeAvatarUrl rejects untrusted schemes and hosts', () => {
  assert.equal(safeAvatarUrl('javascript:alert(1)'), '');
  assert.equal(safeAvatarUrl('https://example.com/avatar.jpg'), '');
  assert.equal(safeAvatarUrl('https://tvax3.sinaimg.cn:8443/avatar.jpg'), '');
});

test('safeAvatarUrl removes volatile query parameters and fragments', () => {
  assert.equal(
    safeAvatarUrl('https://tvax3.sinaimg.cn/avatar.jpg?KID=imgbed#preview'),
    'https://tvax3.sinaimg.cn/avatar.jpg',
  );
});

test('avatarProxyUrl uses the selected API base', () => {
  const avatar = 'https://tvax3.sinaimg.cn/avatar.jpg';
  assert.equal(
    avatarProxyUrl(avatar, 'https://111.228.11.206/'),
    `https://111.228.11.206/api/weibo/avatar?url=${encodeURIComponent(avatar)}`,
  );
  assert.equal(
    avatarProxyUrl(avatar),
    `/api/weibo/avatar?url=${encodeURIComponent(avatar)}`,
  );
});

test('avatarFallback handles Chinese and emoji names', () => {
  assert.equal(avatarFallback(' 小柚子 '), '小');
  assert.equal(avatarFallback('🌸花花'), '🌸');
  assert.equal(avatarFallback(''), '候');
});
