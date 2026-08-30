import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { hashAdminPassword } from '../src/lib/adminAuth.js';
import { serverTestEnv } from './server-test-env.mjs';

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const selected = server.address().port;
      server.close((error) => error ? reject(error) : resolve(selected));
    });
  });
}

const port = process.env.SERVER_TEST_PORT
  ? Number(process.env.SERVER_TEST_PORT)
  : await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const apiKey = 'local-release-test-key';
const adminUsername = 'release-admin';
const adminPassword = 'release-test-password';
const adminPasswordHash = await hashAdminPassword(adminPassword, {
  salt: Buffer.from('release-test-salt'),
});
const testOutputDir = fileURLToPath(new URL(`../output/test-runtime-${port}/`, import.meta.url));
const feedbackFile = path.join(testOutputDir, 'feedback.json');
const drawsDir = path.join(testOutputDir, 'draws');
const runtimeCacheDir = path.join(testOutputDir, 'runtime-cache', 'fontconfig');
const drawAttemptsFile = path.join(testOutputDir, 'draw-attempts.jsonl');
const authDir = path.join(testOutputDir, 'auth');
const cookieStoreFile = path.join(authDir, 'weibo-cookie.json');
const loginStateFile = path.join(authDir, 'weibo-login-state.json');
const drawSequenceFile = path.join(testOutputDir, 'draw-sequences.json');
const jsonRecoveryGuardFile = path.join(testOutputDir, 'json-recovery-guard.mjs');
const jsonRecoveryArmFile = path.join(testOutputDir, 'json-recovery-arm.marker');
const jsonRecoveryReadyFile = path.join(testOutputDir, 'json-recovery-ready.marker');
const jsonRecoveryReleaseFile = path.join(testOutputDir, 'json-recovery-release.marker');
await rm(testOutputDir, { force: true, recursive: true });
await Promise.all([
  mkdir(drawsDir, { recursive: true }),
  mkdir(runtimeCacheDir, { recursive: true }),
  mkdir(authDir, { recursive: true }),
]);
const staleCacheFile = path.join(runtimeCacheDir, 'stale.cache');
const freshCacheFile = path.join(runtimeCacheDir, 'fresh.cache');
await Promise.all([
  writeFile(staleCacheFile, 'stale', 'utf8'),
  writeFile(freshCacheFile, 'fresh', 'utf8'),
]);
const staleDate = new Date(Date.now() - 31 * 24 * 60 * 60_000);
await utimes(staleCacheFile, staleDate, staleDate);
const legacyDrawFile = path.join(drawsDir, 'draw-20260825000000-legacy01.json');
const damagedDrawFile = path.join(drawsDir, 'draw-20260825000001-deadbeef.json');
const highSequenceDrawFile = path.join(drawsDir, 'draw-20260825000002-sequence.json');
await writeFile(legacyDrawFile, JSON.stringify({
  source: 'manual',
  savedAt: '2026-08-25T00:00:00.000Z',
  winners: [{
    uid: 'legacy-user',
    screenName: '旧记录用户',
    avatar: '',
    profileUrl: 'https://weibo.com/u/legacy-user',
    text: '旧记录中的转发正文',
    source: 'mobile',
  }],
}), 'utf8');
await writeFile(damagedDrawFile, '{not-json', 'utf8');
await writeFile(highSequenceDrawFile, JSON.stringify({
  source: 'mobile',
  statusId: 'high-sequence-status',
  statusUrl: 'https://weibo.com/detail/high-sequence-status',
  drawNumber: 101,
  auditHash: 'high-sequence-audit',
  savedAt: '2026-08-25T00:00:02.000Z',
  drawnAt: '2026-08-25T00:00:02.000Z',
  results: [{
    prize: { name: '幸运奖', count: 1 },
    winners: [{ uid: 'high-sequence-user', screenName: '高序号记录' }],
  }],
}), 'utf8');
await writeFile(cookieStoreFile, '{not-json', 'utf8');
await writeFile(loginStateFile, '[]', 'utf8');
await writeFile(feedbackFile, '{not-json', 'utf8');
await Promise.all([
  '20260820000000-a0000001',
  '20260821000000-a0000002',
  '20260822000000-a0000003',
  '20260823000000-a0000004',
].map((suffix) => writeFile(`${feedbackFile}.corrupt-${suffix}`, '{old-corrupt', 'utf8')));
await writeFile(jsonRecoveryGuardFile, `
import fs from 'node:fs/promises';
import path from 'node:path';

const targetFile = path.resolve(process.env.JSON_RECOVERY_TARGET_FILE || '');
const armFile = process.env.JSON_RECOVERY_ARM_FILE || '';
const readyFile = process.env.JSON_RECOVERY_READY_FILE || '';
const releaseFile = process.env.JSON_RECOVERY_RELEASE_FILE || '';
const originalReadFile = fs.readFile.bind(fs);
let held = false;

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function waitForRelease() {
  while (!(await fileExists(releaseFile))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

fs.readFile = async (filePath, ...args) => {
  const value = await originalReadFile(filePath, ...args);
  if (!held && path.resolve(String(filePath)) === targetFile && await fileExists(armFile)) {
    held = true;
    await fs.writeFile(readyFile, 'ready', 'utf8');
    await waitForRelease();
  }
  return value;
};
`, 'utf8');
const output = [];

function spawnServer() {
  const child = spawn(process.execPath, ['--import', pathToFileURL(jsonRecoveryGuardFile).href, 'server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: serverTestEnv(testOutputDir, {
      PORT: String(port),
      HOST: '127.0.0.1',
      API_KEY: apiKey,
      ADMIN_USERNAME: adminUsername,
      ADMIN_PASSWORD_HASH: adminPasswordHash,
      ADMIN_SESSION_SECRET: 'release-test-session-secret-at-least-32-bytes',
      ADMIN_SESSION_SECURE: '1',
      WEIBO_KEEPALIVE_ENABLED: '0',
      FEEDBACK_RATE_LIMIT_MAX: '6',
      DRAW_SAVE_RATE_LIMIT_MAX: '30',
      DRAW_BODY_READ_CONCURRENCY: '2',
      MAX_QUEUED_DRAW_BODY_READS: '0',
      MAX_CORRUPT_JSON_BACKUPS: '2',
      JOB_POLL_RATE_LIMIT_MAX: '2',
      MAX_DRAW_SEQUENCES: '100',
      JSON_RECOVERY_TARGET_FILE: feedbackFile,
      JSON_RECOVERY_ARM_FILE: jsonRecoveryArmFile,
      JSON_RECOVERY_READY_FILE: jsonRecoveryReadyFile,
      JSON_RECOVERY_RELEASE_FILE: jsonRecoveryReleaseFile,
      NODE_ENV: 'production',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  return child;
}

let server = spawnServer();

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

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待测试文件超时：${path.basename(filePath)}`);
}

async function postSplitJson(pathname, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const marker = Buffer.from('中', 'utf8');
  const markerAt = body.indexOf(marker);
  assert.ok(markerAt >= 0);
  const splitAt = markerAt + 1;

  return await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.flushHeaders();
    request.write(body.subarray(0, splitAt));
    setTimeout(() => request.end(body.subarray(splitAt)), 15);
  });
}

async function requestWithAgent(pathname, {
  method = 'GET',
  headers = {},
  chunks = [],
  agent,
} = {}) {
  return await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      agent,
      headers,
    }, (response) => {
      const socket = response.socket;
      const responseChunks = [];
      response.on('data', (chunk) => responseChunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(responseChunks).toString('utf8'),
        socket,
      }));
    });
    request.once('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

function openPendingJsonRequest(pathname, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const prefixLength = Math.max(1, body.length - 1);
  let resolveResponse;
  let rejectResponse;
  const response = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const request = http.request({
    host: '127.0.0.1',
    port,
    path: pathname,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': body.length,
      'x-api-key': apiKey,
    },
  }, (incoming) => {
    const chunks = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => resolveResponse({
      status: incoming.statusCode,
      body: Buffer.concat(chunks).toString('utf8'),
    }));
  });
  request.once('error', rejectResponse);
  request.flushHeaders();
  request.write(body.subarray(0, prefixLength));
  return {
    request,
    response,
    remaining: body.subarray(prefixLength),
  };
}

try {
  await waitForServer();

  const outputFiles = await readdir(testOutputDir);
  assert.equal(outputFiles.filter((name) => name.startsWith('feedback.json.corrupt-')).length, 2);

  await assert.rejects(access(staleCacheFile), { code: 'ENOENT' });
  await access(freshCacheFile);

  const preservedLegacyRecord = JSON.parse(await readFile(legacyDrawFile, 'utf8'));
  assert.equal(preservedLegacyRecord.winners[0].profileUrl, 'https://weibo.com/u/legacy-user');
  assert.equal(preservedLegacyRecord.winners[0].text, '旧记录中的转发正文');
  assert.equal(preservedLegacyRecord.winners[0].source, 'mobile');

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  const healthText = await health.text();
  assert.equal(Number(health.headers.get('content-length')), Buffer.byteLength(healthText, 'utf8'));
  assert.match(health.headers.get('content-security-policy') || '', /script-src 'self'/);
  assert.match(health.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  assert.equal(health.headers.get('referrer-policy'), 'no-referrer');

  const app = await fetch(`${baseUrl}/`);
  assert.equal(app.status, 200);
  assert.doesNotMatch(await app.text(), /@vite\/client/);

  const brandAvatar = await fetch(`${baseUrl}/avatar-96.webp`);
  assert.equal(brandAvatar.status, 200);
  assert.equal(brandAvatar.headers.get('content-type'), 'image/webp');
  assert.equal(brandAvatar.headers.get('cache-control'), 'public, max-age=2592000');

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
  const cookieStatusBody = JSON.parse(cookieStatus);
  assert.equal(cookieStatusBody.availableCookieCount, 0);
  assert.equal(cookieStatusBody.availableAccountCount, 0);
  assert.ok((await readdir(authDir)).some((name) => name.startsWith('weibo-cookie.json.corrupt-')));

  const retiredSyncEndpoint = await fetch(`${baseUrl}/api/weibo/reposts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ statusId: 'test' }),
  });
  assert.equal(retiredSyncEndpoint.status, 404);
  assert.match(retiredSyncEndpoint.headers.get('content-type') || '', /^application\/json\b/);

  const retiredAttemptEndpoint = await fetch(`${baseUrl}/api/weibo/draw-attempts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ statusId: 'test' }),
  });
  assert.equal(retiredAttemptEndpoint.status, 404);

  const invalidSourceJob = await fetch(`${baseUrl}/api/weibo/reposts/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ source: 'unexpected', statusId: 'test' }),
  });
  assert.equal(invalidSourceJob.status, 400);

  const oversizedJob = await fetch(`${baseUrl}/api/weibo/reposts/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ statusId: 'test', padding: 'x'.repeat(70_000) }),
  });
  assert.equal(oversizedJob.status, 413);

  for (const body of ['[]', 'null', '"text"']) {
    const nonObjectJson = await fetch(`${baseUrl}/api/weibo/reposts/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body,
    });
    assert.equal(nonObjectJson.status, 400);
    assert.match((await nonObjectJson.json()).error, /JSON 对象/);
  }

  const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const oversizedChunkedBody = Buffer.from(JSON.stringify({
      source: 'mobile',
      statusId: 'chunked-drain-test',
      padding: 'x'.repeat(70_000),
    }), 'utf8');
    const oversizedChunked = await requestWithAgent('/api/weibo/reposts/jobs', {
      method: 'POST',
      agent: keepAliveAgent,
      headers: {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
        'x-api-key': apiKey,
      },
      chunks: [
        oversizedChunkedBody.subarray(0, 16_384),
        oversizedChunkedBody.subarray(16_384),
      ],
    });
    assert.equal(oversizedChunked.status, 413);
    assert.equal(oversizedChunked.headers.connection, 'close');
    const reusedConnection = await requestWithAgent('/api/health', { agent: keepAliveAgent });
    assert.equal(reusedConnection.status, 200);
    assert.notEqual(reusedConnection.socket, oversizedChunked.socket);
  } finally {
    keepAliveAgent.destroy();
  }

  const recoveryLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: adminUsername, password: adminPassword }),
  });
  assert.equal(recoveryLogin.status, 200);
  const recoveryCookie = (recoveryLogin.headers.get('set-cookie') || '').split(';')[0];

  await writeFile(feedbackFile, '{not-json', 'utf8');
  await writeFile(jsonRecoveryArmFile, 'armed', 'utf8');
  const delayedFeedbackRead = fetch(`${baseUrl}/api/admin/feedback`, {
    headers: { cookie: recoveryCookie },
  });
  await waitForFile(jsonRecoveryReadyFile);

  let feedback;
  try {
    feedback = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'suggestion', content: '希望增加开奖前的名单确认。' }),
    });
  } finally {
    await writeFile(jsonRecoveryReleaseFile, 'released', 'utf8');
  }
  assert.equal((await delayedFeedbackRead).status, 200);
  assert.equal(feedback.status, 201);
  const feedbackBody = await feedback.json();
  assert.ok(feedbackBody.id);
  assert.equal('source' in feedbackBody, false);
  const recoveredFeedback = JSON.parse(await readFile(feedbackFile, 'utf8'));
  assert.ok(recoveredFeedback.some((item) => item.id === feedbackBody.id));

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

  const secondFeedback = await postSplitJson('/api/feedback', {
    category: 'problem',
    content: '第二条用于测试的中文反馈。',
  });
  assert.equal(secondFeedback.status, 201, secondFeedback.body);

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

  const patchPreflight = await fetch(`${baseUrl}/api/admin/feedback/test`, {
    method: 'OPTIONS',
    headers: {
      origin: baseUrl,
      'access-control-request-method': 'PATCH',
      'access-control-request-headers': 'content-type,x-admin-csrf',
    },
  });
  assert.equal(patchPreflight.status, 204);
  assert.match(patchPreflight.headers.get('access-control-allow-methods') || '', /(?:^|,)PATCH(?:,|$)/);

  const notice = await fetch(`${baseUrl}/third-party-notices.txt`);
  assert.equal(notice.status, 200);
  assert.match(notice.headers.get('content-type') || '', /^text\/plain\b/);

  const manifest = await fetch(`${baseUrl}/site.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get('content-type') || '', /^application\/manifest\+json\b/);

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

  const summary = await fetch(`${baseUrl}/api/admin/summary`, {
    headers: { cookie: sessionCookie },
  });
  assert.equal(summary.status, 200, `${await summary.clone().text()}\n${output.join('')}`);
  const summaryBody = await summary.json();
  assert.ok((await readdir(authDir)).some((name) => name.startsWith('weibo-login-state.json.corrupt-')));
  assert.equal(summaryBody.system.runtime.avatarFetches, 0);
  assert.equal(summaryBody.system.runtime.runtimeCacheCleanup.removedCount, 1);
  assert.equal(summaryBody.system.config.runtimeCacheMaxAgeDays, 30);
  assert.equal(summaryBody.system.config.maxDrawSequences, 100);
  assert.equal(summaryBody.savedDrawCount, 2);
  assert.equal(summaryBody.winnerCount, 2);
  assert.ok(summaryBody.system.events.some((item) => /损坏的开奖记录已隔离/.test(item.message || '')));
  assert.ok((await readdir(drawsDir)).some((name) => name.startsWith(`${path.basename(damagedDrawFile)}.corrupt-`)));
  const drawsDiagnostic = summaryBody.system.storage.find((item) => item.label === '开奖记录目录');
  assert.ok(drawsDiagnostic.size > 0);
  assert.ok(drawsDiagnostic.itemCount >= 2);

  const initialDrawList = await fetch(`${baseUrl}/api/admin/draws`, {
    headers: { cookie: sessionCookie },
  });
  assert.equal(initialDrawList.status, 200);
  const initialDrawItems = (await initialDrawList.json()).items;
  assert.equal(initialDrawItems.length, summaryBody.savedDrawCount);
  assert.ok(initialDrawItems.some((item) => item.file === path.basename(legacyDrawFile)));

  const rateBucketCount = summaryBody.system.runtime.rateLimitBuckets;
  const unknownApiResponses = await Promise.all(Array.from({ length: 25 }, (_, index) => (
    fetch(`${baseUrl}/api/not-a-route-${index}`, { headers: { 'x-api-key': apiKey } })
  )));
  assert.ok(unknownApiResponses.every((response) => response.status === 404));
  assert.ok(unknownApiResponses.every((response) => /^application\/json\b/.test(response.headers.get('content-type') || '')));
  const summaryAfterUnknownPaths = await fetch(`${baseUrl}/api/admin/summary`, {
    headers: { cookie: sessionCookie },
  });
  assert.equal(summaryAfterUnknownPaths.status, 200);
  const bucketCountAfterUnknownPaths = (await summaryAfterUnknownPaths.json()).system.runtime.rateLimitBuckets;
  assert.ok(bucketCountAfterUnknownPaths - rateBucketCount <= 2);

  const pollStatuses = [];
  for (let index = 0; index < 3; index += 1) {
    pollStatuses.push((await fetch(`${baseUrl}/api/weibo/reposts/jobs/rate-limit-test`, {
      headers: { 'x-api-key': apiKey },
    })).status);
  }
  assert.deepEqual(pollStatuses, [404, 404, 429]);
  const cancelAfterPollLimit = await fetch(`${baseUrl}/api/weibo/reposts/jobs/rate-limit-test`, {
    method: 'DELETE',
    headers: { 'x-api-key': apiKey, 'x-job-cancel-token': 'not-a-real-token' },
  });
  assert.equal(cancelAfterPollLimit.status, 404);

  const malformedPath = await fetch(`${baseUrl}/api/weibo/reposts/jobs/%E0%A4%A`, {
    headers: { 'x-api-key': apiKey, 'x-forwarded-for': '192.0.2.99' },
  });
  assert.equal(malformedPath.status, 400);
  assert.match((await malformedPath.json()).error, /路径编码/);

  const adminFeedback = await fetch(`${baseUrl}/api/admin/feedback`, {
    headers: { cookie: sessionCookie },
  });
  assert.equal(adminFeedback.status, 200);
  const adminFeedbackBody = await adminFeedback.json();
  assert.equal(adminFeedbackBody.items.length, 2);
  assert.equal(adminFeedbackBody.items[1].content, '希望增加开奖前的名单确认。');
  assert.match(adminFeedbackBody.items[0].source, /^[a-f0-9]{12}$/);
  assert.equal(adminFeedbackBody.items[0].status, 'open');

  const highSequenceDraw = await fetch(
    `${baseUrl}/api/admin/draws/${encodeURIComponent(path.basename(highSequenceDrawFile))}`,
    { headers: { cookie: sessionCookie } },
  );
  assert.equal(highSequenceDraw.status, 200);
  assert.equal((await highSequenceDraw.json()).item.drawNumber, 101);

  const feedbackWithoutCsrf = await fetch(`${baseUrl}/api/admin/feedback/${adminFeedbackBody.items[0].id}`, {
    method: 'PATCH',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ handled: true }),
  });
  assert.equal(feedbackWithoutCsrf.status, 403);

  const handledFeedback = await fetch(`${baseUrl}/api/admin/feedback/${adminFeedbackBody.items[0].id}`, {
    method: 'PATCH',
    headers: {
      cookie: sessionCookie,
      'content-type': 'application/json',
      'x-admin-csrf': loginBody.csrfToken,
    },
    body: JSON.stringify({ handled: true }),
  });
  assert.equal(handledFeedback.status, 200);
  assert.equal((await handledFeedback.json()).item.status, 'handled');

  const deletedFeedback = await fetch(`${baseUrl}/api/admin/feedback/${adminFeedbackBody.items[1].id}`, {
    method: 'DELETE',
    headers: { cookie: sessionCookie, 'x-admin-csrf': loginBody.csrfToken },
  });
  assert.equal(deletedFeedback.status, 200);

  const saveDraw = (payload) => fetch(`${baseUrl}/api/draws`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(payload),
  });
  const pendingDraw = openPendingJsonRequest('/api/draws', {
    source: 'manual',
    winners: [{ uid: 'pending-body', screenName: '慢请求' }],
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  let fastDraw = null;
  let fastDrawTimedOut = false;
  const fastDrawResult = saveDraw({
    source: 'manual',
    winners: [{ uid: 'fast-while-body-pending', screenName: '先完成的写入' }],
  });
  fastDraw = await Promise.race([
    fastDrawResult,
    new Promise((resolve) => setTimeout(() => {
      fastDrawTimedOut = true;
      resolve(null);
    }, 1500)),
  ]);
  pendingDraw.request.end(pendingDraw.remaining);
  const pendingDrawResult = await pendingDraw.response;
  if (fastDrawTimedOut) await fastDrawResult;
  assert.equal(fastDrawTimedOut, false, '慢请求体不应占住单写 gate');
  assert.equal(fastDraw.status, 200);
  assert.equal(pendingDrawResult.status, 200, `${pendingDrawResult.body}\n${output.join('')}`);

  const blockingDraws = [
    openPendingJsonRequest('/api/draws', {
      source: 'manual',
      winners: [{ uid: 'body-gate-a', screenName: '慢请求 A' }],
    }),
    openPendingJsonRequest('/api/draws', {
      source: 'manual',
      winners: [{ uid: 'body-gate-b', screenName: '慢请求 B' }],
    }),
  ];
  await new Promise((resolve) => setTimeout(resolve, 80));
  const saturatedAgent = new http.Agent({ keepAlive: true });
  try {
    const overflowBody = Buffer.from(JSON.stringify({
      source: 'manual',
      winners: [{ uid: 'body-gate-overflow', screenName: '过载请求' }],
    }));
    const saturated = await requestWithAgent('/api/draws', {
      method: 'POST',
      agent: saturatedAgent,
      headers: {
        'content-type': 'application/json',
        'content-length': overflowBody.length,
        'x-api-key': apiKey,
      },
      chunks: [overflowBody],
    });
    assert.equal(saturated.status, 503);
    assert.equal(saturated.headers.connection, 'close');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(saturated.socket.destroyed, true);
  } finally {
    for (const pending of blockingDraws) pending.request.end(pending.remaining);
    await Promise.all(blockingDraws.map((pending) => pending.response));
    saturatedAgent.destroy();
  }

  const savedDraw = await saveDraw({
      source: 'manual',
      drawnAt: '../../../../../tmp/injected',
      audit: { rules: { filters: { blocklistCount: 3 } } },
      winners: [{
        uid: '1',
        screenName: '<img src=x onerror=alert(1)>',
        profileUrl: 'https://weibo.com/u/1',
        text: '不需要长期保存的转发正文',
        source: 'mobile',
      }],
  });
  assert.equal(savedDraw.status, 200);
  const savedDrawBody = await savedDraw.json();
  assert.match(savedDrawBody.file, /^draw-\d{14}-[a-f0-9]{8}\.json$/);
  assert.doesNotMatch(savedDrawBody.file, /\.\./);

  const drawDetail = await fetch(`${baseUrl}/api/admin/draws/${encodeURIComponent(savedDrawBody.file)}`, {
    headers: { cookie: sessionCookie },
  });
  assert.equal(drawDetail.status, 200);
  const storedDraw = (await drawDetail.json()).item;
  const storedWinner = storedDraw.winners[0];
  assert.deepEqual(Object.keys(storedWinner).sort(), ['avatar', 'prizeName', 'screenName', 'uid']);
  assert.equal(storedDraw.audit.rules.filters.blocklistCount, 3);

  const invalidTotalCount = await saveDraw({
    source: 'manual',
    statusUrl: 'https://weibo.com/123456/InvalidTotalCount',
    totalCount: -1,
    winners: [{ uid: 'invalid-total-winner', screenName: '边界测试' }],
  });
  assert.equal(invalidTotalCount.status, 400);
  assert.match((await invalidTotalCount.json()).error, /候选总数/);

  const invalidEligibleCount = await saveDraw({
    source: 'manual',
    statusUrl: 'https://weibo.com/123456/InvalidEligibleCount',
    totalCount: 2,
    eligibleCount: 1.5,
    winners: [{ uid: 'invalid-eligible-winner', screenName: '边界测试' }],
  });
  assert.equal(invalidEligibleCount.status, 400);
  assert.match((await invalidEligibleCount.json()).error, /可抽人数/);

  const inconsistentCounts = await saveDraw({
    source: 'manual',
    statusUrl: 'https://weibo.com/123456/InconsistentCounts',
    totalCount: 1,
    eligibleCount: 0,
    winners: [{ uid: 'inconsistent-winner', screenName: '边界测试' }],
  });
  assert.equal(inconsistentCounts.status, 400);
  assert.match((await inconsistentCounts.json()).error, /中奖人数不能超过可抽人数/);

  const mismatchedPrizeCount = await saveDraw({
    source: 'manual',
    statusUrl: 'https://weibo.com/123456/MismatchedPrizeCount',
    results: [{
      prize: { name: '一等奖', count: 2 },
      winners: [{ uid: 'mismatched-winner', screenName: '边界测试' }],
    }],
  });
  assert.equal(mismatchedPrizeCount.status, 400);
  assert.match((await mismatchedPrizeCount.json()).error, /奖项人数与中奖名单数量不一致/);

  const invalidSourceCounts = await saveDraw({
    source: 'manual',
    statusUrl: 'https://weibo.com/123456/InvalidSourceCounts',
    sourceMeta: { totalNumber: 1, visibleNumber: 2 },
    winners: [{ uid: 'invalid-source-winner', screenName: '边界测试' }],
  });
  assert.equal(invalidSourceCounts.status, 400);
  assert.match((await invalidSourceCounts.json()).error, /来源可见数不能超过来源总数/);

  const malformedWinner = await saveDraw({
    source: 'manual',
    winners: [null, { uid: 'valid-after-null', screenName: '有效用户' }],
  });
  assert.equal(malformedWinner.status, 200);

  const firstLinkedPayload = {
    source: 'mobile',
    statusUrl: 'https://weibo.com/123456/LinkedDraw',
    drawnAt: '2026-08-26T02:00:00.000Z',
    audit: { seed: 'linked-seed-1', candidateDigest: 'candidate-list-v1' },
    results: [{ prize: { name: '一等奖', count: 1 }, winners: [{ uid: 'linked-1', screenName: '甲' }] }],
  };
  const firstLinkedDraw = await saveDraw(firstLinkedPayload);
  assert.equal(firstLinkedDraw.status, 200);
  const firstLinkedBody = await firstLinkedDraw.json();
  assert.equal(firstLinkedBody.drawNumber, 1);
  assert.equal(firstLinkedBody.drawCount, 1);

  const duplicateLinkedDraw = await saveDraw(firstLinkedPayload);
  assert.equal(duplicateLinkedDraw.status, 200);
  const duplicateLinkedBody = await duplicateLinkedDraw.json();
  assert.equal(duplicateLinkedBody.duplicate, true);
  assert.equal(duplicateLinkedBody.file, firstLinkedBody.file);
  assert.equal(duplicateLinkedBody.drawNumber, 1);
  assert.equal(duplicateLinkedBody.drawCount, 1);

  const concurrentPayload = (suffix) => ({
    ...firstLinkedPayload,
    drawnAt: `2026-08-26T02:00:0${suffix}.000Z`,
    audit: { seed: `linked-seed-${suffix + 1}`, candidateDigest: 'candidate-list-v1' },
    results: [{
      prize: { name: '一等奖', count: 1 },
      winners: [{ uid: `linked-${suffix + 1}`, screenName: `并发用户${suffix}` }],
    }],
  });
  const concurrentResponses = await Promise.all([saveDraw(concurrentPayload(1)), saveDraw(concurrentPayload(2))]);
  assert.deepEqual(concurrentResponses.map((response) => response.status), [200, 200]);
  const concurrentBodies = await Promise.all(concurrentResponses.map((response) => response.json()));
  assert.deepEqual(concurrentBodies.map((item) => item.drawNumber).sort((a, b) => a - b), [2, 3]);
  const sequenceStore = JSON.parse(await readFile(drawSequenceFile, 'utf8'));
  assert.deepEqual(Object.values(sequenceStore.sequences), [3]);

  const drawCount = await fetch(`${baseUrl}/api/weibo/draw-count?statusUrl=${encodeURIComponent(firstLinkedPayload.statusUrl)}`, {
    headers: { 'x-api-key': apiKey },
  });
  assert.equal(drawCount.status, 200);
  assert.equal((await drawCount.json()).drawCount, 3);

  const highestDraw = concurrentBodies.find((item) => item.drawNumber === 3);
  assert.ok(highestDraw?.file);
  const deletedDraw = await fetch(`${baseUrl}/api/admin/draws/${encodeURIComponent(highestDraw.file)}`, {
    method: 'DELETE',
    headers: { cookie: sessionCookie, 'x-admin-csrf': loginBody.csrfToken },
  });
  assert.equal(deletedDraw.status, 200);
  const fourthLinkedDraw = await saveDraw(concurrentPayload(3));
  assert.equal(fourthLinkedDraw.status, 200);
  const fourthLinkedBody = await fourthLinkedDraw.json();
  assert.equal(fourthLinkedBody.drawNumber, 4);
  assert.equal(fourthLinkedBody.drawCount, 3);

  const searchableWinners = Array.from({ length: 10 }, (_, index) => ({
    uid: `search-${index + 1}`,
    screenName: index === 8 ? '第九位可搜索用户' : `搜索候选${index + 1}`,
  }));
  const searchableDraw = await saveDraw({
    source: 'manual',
    statusUrl: 'https://weibo.com/123456/SearchableDraw',
    results: [{ prize: { name: '参与奖', count: 10 }, winners: searchableWinners }],
  });
  assert.equal(searchableDraw.status, 200);
  const searchableDrawBody = await searchableDraw.json();
  const drawSearch = await fetch(`${baseUrl}/api/admin/draws?search=${encodeURIComponent('第九位可搜索用户')}`, {
    headers: { cookie: sessionCookie },
  });
  assert.equal(drawSearch.status, 200);
  const drawSearchBody = await drawSearch.json();
  assert.ok(drawSearchBody.items.some((item) => item.file === searchableDrawBody.file));

  const tooManyWinners = Array.from({ length: 501 }, (_, index) => ({
    uid: `bulk-${index}`,
    screenName: `候选${index}`,
  }));
  const oversizedDraw = await saveDraw({
    source: 'mobile',
    statusUrl: 'https://weibo.com/123456/TooManyWinners',
    results: [
      { prize: { name: '一等奖', count: 300 }, winners: tooManyWinners.slice(0, 300) },
      { prize: { name: '二等奖', count: 201 }, winners: tooManyWinners.slice(300) },
    ],
  });
  assert.equal(oversizedDraw.status, 400);
  assert.match((await oversizedDraw.json()).error, /最多保存 500 位/);

  const oversizedFallbackDraw = await saveDraw({
    source: 'manual',
    results: [{ prize: { name: '空奖项', count: 0 }, winners: [] }],
    winners: tooManyWinners,
  });
  assert.equal(oversizedFallbackDraw.status, 400);
  assert.match((await oversizedFallbackDraw.json()).error, /最多保存 500 位/);

  const seededSequences = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
    `sequence-${String(index).padStart(3, '0')}`,
    index + 1,
  ]));
  await writeFile(drawSequenceFile, JSON.stringify({ version: 1, sequences: seededSequences }), 'utf8');
  const cappedSequenceDraw = await saveDraw({
    ...concurrentPayload(4),
    statusId: '980001',
    statusUrl: 'https://weibo.com/detail/980001',
  });
  assert.equal(cappedSequenceDraw.status, 200);
  const cappedSequenceStore = JSON.parse(await readFile(drawSequenceFile, 'utf8'));
  assert.equal(Object.keys(cappedSequenceStore.sequences).length, 100);
  assert.equal(cappedSequenceStore.sequences['980001'], 1);
  assert.equal(cappedSequenceStore.sequences['sequence-000'], undefined);

  await writeFile(drawSequenceFile, '{not-json', 'utf8');
  const corruptSequenceDraw = await saveDraw(concurrentPayload(5));
  assert.equal(corruptSequenceDraw.status, 500);
  const blockedSequenceDraw = await saveDraw(concurrentPayload(6));
  assert.equal(blockedSequenceDraw.status, 500);
  assert.ok((await readdir(testOutputDir)).some((name) => name.startsWith('draw-sequences.json.corrupt-')));

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

  const preRestartLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: adminUsername, password: adminPassword }),
  });
  assert.equal(preRestartLogin.status, 200);
  const preRestartLoginCookie = (preRestartLogin.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(preRestartLoginCookie);

  const stopServer = (child, signal = 'SIGINT') => new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('测试服务未在 5 秒内退出')), 5000);
    child.once('exit', (code, exitSignal) => {
      clearTimeout(timer);
      assert.ok(code === 0 || exitSignal === signal);
      resolve();
    });
    child.kill(signal);
  });
  await stopServer(server);
  server = spawnServer();
  await waitForServer();
  const staleSessionAfterRestart = await fetch(`${baseUrl}/api/admin/session`, {
    headers: { cookie: preRestartLoginCookie },
  });
  assert.equal(staleSessionAfterRestart.status, 401);
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGINT');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  await rm(testOutputDir, { force: true, recursive: true });
}

console.log('SERVER_HTTP_OK');
