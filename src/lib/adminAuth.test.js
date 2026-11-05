import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adminSessionCookie,
  createAdminSession,
  createAdminSessionRegistry,
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

test('logged-out sessions stay invalid after revocation capacity is exhausted', () => {
  const sessions = createAdminSessionRegistry({ username: 'operator', secret: 'test-secret' });
  const oldest = sessions.create({ now: 1000 });
  const active = sessions.create({ now: 1000 });
  sessions.revoke(oldest.payload, 2000);
  assert.equal(sessions.verify(oldest.token, 2000), null);
  assert.ok(sessions.verify(active.token, 2000), 'ordinary logout must preserve other sessions');
  for (let index = 0; index < 1000; index += 1) {
    sessions.revoke(sessions.create({ now: 1000 }).payload, 2000);
  }
  assert.equal(sessions.verify(oldest.token, 2000), null, 'overflow must not reauthorize a logged-out cookie');
  assert.equal(sessions.verify(active.token, 2000), null, 'overflow invalidates the previous signing generation');
  assert.ok(sessions.revokedCount <= 1000);
  assert.ok(sessions.verify(sessions.create({ now: 2000 }).token, 2000), 'new logins must still work');
});

test('expired revocations are reclaimed without invalidating active sessions', () => {
  const sessions = createAdminSessionRegistry({ username: 'operator', secret: 'test-secret', maxRevokedSessions: 1 });
  const expiring = sessions.create({ now: 1000, ttlMs: 60_000 });
  const active = sessions.create({ now: 2000 });
  sessions.revoke(expiring.payload, 2000);
  sessions.revoke(sessions.create({ now: 62_000 }).payload, 62_000);
  assert.equal(sessions.revokedCount, 1);
  assert.ok(sessions.verify(active.token, 62_000));
  assert.equal(sessions.verify(expiring.token, 62_000), null);
  const restarted = createAdminSessionRegistry({ username: 'operator', secret: 'test-secret' });
  assert.equal(restarted.verify(active.token, 62_000), null, 'a new process must invalidate previous sessions');
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

test('login limiter evicts old entries at its memory cap', () => {
  const limiter = createLoginLimiter({ maxAttempts: 1, windowMs: 60_000, maxEntries: 2 });

  limiter.fail('first', 1000);
  limiter.fail('second', 1000);
  limiter.fail('third', 1000);

  assert.equal(limiter.check('first', 1001).allowed, true);
  assert.equal(limiter.check('third', 1001).allowed, false);
});
