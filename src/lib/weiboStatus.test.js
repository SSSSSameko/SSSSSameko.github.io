import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isWeiboStatusReference,
  normalizeStoredStatusId,
  statusTokenFromReference,
} from './weiboStatus.js';

test('recognizes supported Weibo status references', () => {
  assert.equal(statusTokenFromReference('https://weibo.com/2715025067/PAbC12345'), 'PAbC12345');
  assert.equal(statusTokenFromReference('https://m.weibo.cn/status/AbC12345'), 'AbC12345');
  assert.equal(statusTokenFromReference('https://weibo.com/detail/123456789'), '123456789');
  assert.equal(statusTokenFromReference('123456789'), '123456789');
  assert.equal(isWeiboStatusReference('PAbC12345'), true);
});

test('does not treat profile pages as status posts', () => {
  assert.equal(statusTokenFromReference('https://weibo.com/u/2715025067'), '');
  assert.equal(statusTokenFromReference('https://weibo.com/n/sameko'), '');
  assert.equal(statusTokenFromReference('https://m.weibo.cn/profile/2715025067'), '');
  assert.equal(statusTokenFromReference('https://example.com/2715025067/PAbC12345'), '');
});

test('accepts status identifiers from query parameters', () => {
  assert.equal(statusTokenFromReference('https://weibo.com/?id=123456789'), '123456789');
  assert.equal(statusTokenFromReference('https://m.weibo.cn/?mblogid=AbC12345'), 'AbC12345');
});

test('extracts a status URL from shared text', () => {
  assert.equal(
    statusTokenFromReference('转发抽奖链接：https://weibo.com/2715025067/PAbC12345，欢迎参加'),
    'PAbC12345',
  );
  assert.equal(
    statusTokenFromReference('复制这条微博 weibo.com/2715025067/PAbC12345 即可载入'),
    'PAbC12345',
  );
});

test('keeps strict host and route checks for shared text', () => {
  assert.equal(statusTokenFromReference('链接 https://weibo.com.evil.example/2715025067/PAbC12345'), '');
  assert.equal(statusTokenFromReference('链接 evilweibo.com/2715025067/PAbC12345'), '');
  assert.equal(statusTokenFromReference('个人主页 https://weibo.com/u/2715025067'), '');
  assert.equal(statusTokenFromReference('链接 https://user@weibo.com/2715025067/PAbC12345'), '');
});

test('normalizes stored status identifiers before using them in record links', () => {
  assert.equal(normalizeStoredStatusId(' 900000000001 '), '900000000001');
  assert.equal(normalizeStoredStatusId('PAbC12345'), 'PAbC12345');
  assert.equal(normalizeStoredStatusId('900000/001'), '');
  assert.equal(normalizeStoredStatusId('900000\r\n/001'), '');
  assert.equal(normalizeStoredStatusId('x'.repeat(65)), '');
});
