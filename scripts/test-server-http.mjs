import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { hashAdminPassword } from '../src/lib/adminAuth.js';

const port = Number(process.env.SERVER_TEST_PORT || 5197);
const baseUrl = `http://127.0.0.1:${port}`;
const apiKey = 'local-release-test-key';
const adminUsername = 'release-admin';
const adminPassword = 'release-test-password';
const adminPasswordHash = await hashAdminPassword(adminPassword, {
  salt: Buffer.from('release-test-salt'),
});
const feedbackFile = fileURLToPath(new URL(`../output/test-feedback-${port}.json`, import.meta.url));
const drawsDir = fileURLToPath(new URL(`../output/test-draws-${port}/`, import.meta.url));
await rm(feedbackFile, { force: true });
await rm(drawsDir, { force: true, recursive: true });
const output = [];

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    API_KEY: apiKey,
    ADMIN_USERNAME: adminUsername,
    ADMIN_PASSWORD_HASH: adminPasswordHash,
    ADMIN_SESSION_SECRET: 'release-test-session-secret-at-least-32-bytes',
    ADMIN_SESSION_SECURE: '1',
    DISABLE_COOKIE_STORE: '1',
    WEIBO_KEEPALIVE_ENABLED: '0',
    FEEDBACK_FILE: feedbackFile,
    FEEDBACK_RATE_LIMIT_MAX: '6',
    DRAWS_DIR: drawsDir,
    NODE_ENV: 'production',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.on('data', (chunk) => output.push(chunk.toString()));
server.stderr.on('data', (chunk) => output.push(chunk.toString()));

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`测试服务启动超时\n${output.join('')}`);
}

try {
  await waitForServer();

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-security-policy') || '', /script-src 'self'/);
  assert.match(health.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  assert.equal(health.headers.get('referrer-policy'), 'no-referrer');

  const app = await fetch(`${baseUrl}/`);
  assert.equal(app.status, 200);
  assert.doesNotMatch(await app.text(), /@vite\/client/);

  const admin = await fetch(`${baseUrl}/admin`);
  assert.equal(admin.status, 200);
  assert.equal(admin.headers.get('cache-control'), 'no-store');
  assert.equal(admin.headers.get('x-robots-tag'), 'noindex, nofollow');

  const unauthorized = await fetch(`${baseUrl}/api/weibo/cookie-status`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${baseUrl}/api/weibo/cookie-status`, {
    headers: { 'x-api-key': apiKey },
  });
  assert.equal(authorized.status, 200);
  const cookieStatus = await authorized.text();
  assert.doesNotMatch(cookieStatus, /SUB=|SUBP=|SCF=/);

  const retiredSyncEndpoint = await fetch(`${baseUrl}/api/weibo/reposts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ statusId: 'test' }),
  });
  assert.equal(retiredSyncEndpoint.status, 405);

  const retiredAttemptEndpoint = await fetch(`${baseUrl}/api/weibo/draw-attempts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ statusId: 'test' }),
  });
  assert.equal(retiredAttemptEndpoint.status, 405);

  const oversizedJob = await fetch(`${baseUrl}/api/weibo/reposts/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ statusId: 'test', padding: 'x'.repeat(70_000) }),
  });
  assert.equal(oversizedJob.status, 413);

  const feedback = await fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: 'suggestion', content: '希望增加开奖前的名单确认。' }),
  });
  assert.equal(feedback.status, 201);
  const feedbackBody = await feedback.json();
  assert.ok(feedbackBody.id);
  assert.equal('source' in feedbackBody, false);

  const duplicateFeedback = await fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: 'suggestion', content: '希望增加开奖前的名单确认。' }),
  });
  assert.equal(duplicateFeedback.status, 409);

  const feedbackWithoutJsonType = await fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    body: JSON.stringify({ category: 'other', content: '测试反馈' }),
  });
  assert.equal(feedbackWithoutJsonType.status, 415);

  const invalidFeedback = await fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: 'unknown', content: '测试反馈' }),
  });
  assert.equal(invalidFeedback.status, 400);

  const oversizedFeedback = await fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: 'other', content: 'x'.repeat(17_000) }),
  });
  assert.equal(oversizedFeedback.status, 413);

  const secondFeedback = await fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: 'problem', content: '第二条用于测试的反馈。' }),
  });
  assert.equal(secondFeedback.status, 201);

  const limitedFeedback = await fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: 'other', content: '第三条用于测试的反馈。' }),
  });
  assert.equal(limitedFeedback.status, 429);

  const feedbackWithoutLogin = await fetch(`${baseUrl}/api/admin/feedback`);
  assert.equal(feedbackWithoutLogin.status, 401);

  const rejectedOrigin = await fetch(`${baseUrl}/api/health`, {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(rejectedOrigin.status, 403);

  const rejectedLocalOrigin = await fetch(`${baseUrl}/api/health`, {
    headers: { origin: 'http://127.0.0.1:65530' },
  });
  assert.equal(rejectedLocalOrigin.status, 403);

  const acceptedOrigin = await fetch(`${baseUrl}/api/health`, {
    headers: { origin: baseUrl },
  });
  assert.equal(acceptedOrigin.status, 200);
  assert.equal(acceptedOrigin.headers.get('access-control-allow-origin'), baseUrl);

  const protectedCookieCheck = await fetch(`${baseUrl}/api/weibo/cookie-status?check=1`, {
    headers: { 'x-api-key': apiKey },
  });
  assert.equal(protectedCookieCheck.status, 200);
  assert.equal((await protectedCookieCheck.json()).checkSkipped, true);

  const wrongLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: adminUsername, password: 'wrong-password' }),
  });
  assert.equal(wrongLogin.status, 401);

  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: adminUsername, password: adminPassword }),
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  const setCookie = login.headers.get('set-cookie') || '';
  const sessionCookie = setCookie.split(';')[0];
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Secure/i);
  assert.ok(loginBody.csrfToken);

  const session = await fetch(`${baseUrl}/api/admin/session`, {
    headers: { cookie: sessionCookie },
  });
  assert.equal(session.status, 200);

  const adminFeedback = await fetch(`${baseUrl}/api/admin/feedback`, {
    headers: { cookie: sessionCookie },
  });
  assert.equal(adminFeedback.status, 200);
  const adminFeedbackBody = await adminFeedback.json();
  assert.equal(adminFeedbackBody.items.length, 2);
  assert.equal(adminFeedbackBody.items[1].content, '希望增加开奖前的名单确认。');
  assert.match(adminFeedbackBody.items[0].source, /^[a-f0-9]{12}$/);

  const savedDraw = await fetch(`${baseUrl}/api/draws`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      source: 'manual',
      drawnAt: '../../../../../tmp/injected',
      winners: [{ uid: '1', screenName: '<img src=x onerror=alert(1)>' }],
    }),
  });
  assert.equal(savedDraw.status, 200);
  const savedDrawBody = await savedDraw.json();
  assert.match(savedDrawBody.file, /^draw-\d{14}-[a-f0-9]{8}\.json$/);
  assert.doesNotMatch(savedDrawBody.file, /\.\./);

  const missingCsrf = await fetch(`${baseUrl}/api/admin/logout`, {
    method: 'POST',
    headers: { cookie: sessionCookie },
  });
  assert.equal(missingCsrf.status, 403);

  const logout = await fetch(`${baseUrl}/api/admin/logout`, {
    method: 'POST',
    headers: { cookie: sessionCookie, 'x-admin-csrf': loginBody.csrfToken },
  });
  assert.equal(logout.status, 200);

  const revokedSession = await fetch(`${baseUrl}/api/admin/session`, {
    headers: { cookie: sessionCookie },
  });
  assert.equal(revokedSession.status, 401);
} finally {
  server.kill('SIGINT');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  await rm(feedbackFile, { force: true });
  await rm(drawsDir, { force: true, recursive: true });
}

console.log('SERVER_HTTP_OK');
