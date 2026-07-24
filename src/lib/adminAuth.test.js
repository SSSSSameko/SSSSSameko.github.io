import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adminSessionCookie,
  createAdminSession,
  createLoginLimiter,
  hashAdminPassword,
  parseCookieHeader,
  verifyAdminPassword,
  verifyAdminSession,
} from './adminAuth.js';

test('admin password hashes verify without storing the password', async () => {
  const encoded = await hashAdminPassword('correct horse battery staple', {
    salt: Buffer.from('0123456789abcdef'),
  });

  assert.equal(await verifyAdminPassword('correct horse battery staple', encoded), true);
  assert.equal(await verifyAdminPassword('wrong password', encoded), false);
  assert.doesNotMatch(encoded, /correct horse/);
});

test('admin sessions are signed, scoped and expire', () => {
  const created = createAdminSession({
    username: 'operator',
    secret: 'test-session-secret',
    ttlMs: 60_000,
    now: 1000,
    sessionId: 'session-1',
    csrfToken: 'csrf-1',
  });

  assert.equal(verifyAdminSession(created.token, {
    username: 'operator',
    secret: 'test-session-secret',
    now: 2000,
  })?.csrf, 'csrf-1');
  assert.equal(verifyAdminSession(created.token, {
    username: 'operator',
    secret: 'different-secret',
    now: 2000,
  }), null);
  assert.equal(verifyAdminSession(created.token, {
    username: 'operator',
    secret: 'test-session-secret',
    now: 62_000,
  }), null);
});

test('session cookies use secure browser defaults', () => {
  const value = adminSessionCookie('sameko_admin_session', 'signed-token', {
    secure: true,
    maxAgeSeconds: 3600,
  });

  assert.match(value, /HttpOnly/);
  assert.match(value, /SameSite=Strict/);
  assert.match(value, /Secure/);
  assert.equal(parseCookieHeader('one=1; sameko_admin_session=signed-token').sameko_admin_session, 'signed-token');
});

test('login limiter blocks repeated failures and clears after success', () => {
  const limiter = createLoginLimiter({ maxAttempts: 3, windowMs: 60_000 });
  limiter.fail('127.0.0.1', 1000);
  limiter.fail('127.0.0.1', 1000);
  assert.equal(limiter.check('127.0.0.1', 1000).allowed, true);
  limiter.fail('127.0.0.1', 1000);
  assert.equal(limiter.check('127.0.0.1', 1000).allowed, false);
  limiter.clear('127.0.0.1');
  assert.equal(limiter.check('127.0.0.1', 1000).allowed, true);
});
