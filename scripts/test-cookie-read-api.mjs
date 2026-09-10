import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stopChildProcess } from './child-process.mjs';
import { serverTestEnv } from './server-test-env.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const testOutputDir = await mkdtemp(path.join(os.tmpdir(), 'sameko-cookie-read-api-'));
const authDir = path.join(testOutputDir, 'auth');
const cookieStoreFile = path.join(authDir, 'weibo-cookie.json');
const adminEventsFile = path.join(testOutputDir, 'admin-events.json');
const cookiePath = '/v1/cookie/current';
const readKey = 'c'.repeat(64);
const apiKey = 'cookie-read-test-api-key-at-least-32-bytes';
const storedCookie = 'SUB=read-api-test-cookie; SUBP=read-api-test-token';
const savedAt = '2026-09-10T00:00:00.000Z';

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

async function rawGet(baseUrl, pathname, headers) {
  const target = new URL(baseUrl);
  return await new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: pathname,
      method: 'GET',
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function writeCookieStore(cookie) {
  await mkdir(authDir, { recursive: true });
  const cookies = cookie
    ? [{
        id: 'read-api-cookie',
        cookie,
        savedAt,
        updatedAt: savedAt,
        lastCheckedAt: savedAt,
        lastValidAt: savedAt,
        lastError: '',
      }]
    : [];
  await writeFile(cookieStoreFile, JSON.stringify({
    version: 2,
    activeId: cookies[0]?.id || '',
    updatedAt: savedAt,
    cookies,
  }), 'utf8');
}

async function startServer(overrides) {
  const port = await availablePort();
  const output = [];
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: rootDir,
    env: serverTestEnv(testOutputDir, {
      PORT: String(port),
      HOST: '127.0.0.1',
      WEIBO_KEEPALIVE_ENABLED: '0',
      ENABLE_COOKIE_READ_API: '',
      COOKIE_READ_KEY: '',
      ...overrides,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`测试服务提前退出\n${output.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { child, baseUrl };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stopChildProcess(child, { gracefulSignal: 'SIGINT' }).catch(() => {});
  throw new Error(`测试服务启动超时\n${output.join('')}`);
}

async function stopServer(server) {
  if (server?.child && server.child.exitCode === null && server.child.signalCode === null) {
    await stopChildProcess(server.child, { gracefulSignal: 'SIGINT' });
  }
}

async function waitForAdminEvent(action, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const events = JSON.parse(await readFile(adminEventsFile, 'utf8'));
      const match = events.find((event) => event.action === action);
      if (match) return match;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

async function countCookieReadEvents(status) {
  try {
    const events = JSON.parse(await readFile(adminEventsFile, 'utf8'));
    return events.filter((event) => event.action === 'read-current' && event.status === status).length;
  } catch {
    return 0;
  }
}

await rm(testOutputDir, { recursive: true, force: true });
let active = null;
try {
  await writeCookieStore(storedCookie);
  active = await startServer({ NODE_ENV: 'production', API_KEY: apiKey });
  const disabled = await fetch(`${active.baseUrl}${cookiePath}`, {
    headers: { 'x-cookie-read-key': readKey },
  });
  assert.equal(disabled.status, 404);
  assert.equal((await disabled.json()).error, '接口不存在');
  await stopServer(active);
  active = null;

  await writeCookieStore(storedCookie);
  active = await startServer({
    NODE_ENV: 'production',
    API_KEY: apiKey,
    ENABLE_COOKIE_READ_API: '1',
    COOKIE_READ_KEY: readKey,
  });
  const noKey = await fetch(`${active.baseUrl}${cookiePath}`);
  assert.equal(noKey.status, 401);
  const wrongKey = await fetch(`${active.baseUrl}${cookiePath}`, {
    headers: { 'x-cookie-read-key': 'wrong-key' },
  });
  assert.equal(wrongKey.status, 401);
  const sharedKey = await fetch(`${active.baseUrl}${cookiePath}`, {
    headers: { 'x-api-key': apiKey },
  });
  assert.equal(sharedKey.status, 401, '共享 API_KEY 不得读取微博登录态');
  const readKeyViaSharedHeader = await fetch(`${active.baseUrl}${cookiePath}`, {
    headers: { 'x-api-key': readKey },
  });
  assert.equal(readKeyViaSharedHeader.status, 401, '只读密钥不得通过共享 x-api-key 请求头传递');
  const allowed = await fetch(`${active.baseUrl}${cookiePath}`, {
    headers: { 'x-cookie-read-key': readKey },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('cache-control'), 'no-store');
  assert.equal(allowed.headers.get('x-robots-tag'), 'noindex, nofollow');
  const payload = await allowed.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.cookie, storedCookie);
  assert.equal(payload.savedAt, savedAt);
  assert.equal(payload.quarantined, false);
  const bearer = await fetch(`${active.baseUrl}${cookiePath}`, {
    headers: { authorization: `Bearer ${readKey}` },
  });
  assert.equal(bearer.status, 200);
  assert.equal((await bearer.json()).cookie, storedCookie);
  const insecureRemote = await fetch(`${active.baseUrl}${cookiePath}`, {
    headers: { 'x-cookie-read-key': readKey, 'x-forwarded-for': '203.0.113.7' },
  });
  assert.equal(insecureRemote.status, 403, '非回环来源必须拒绝明文 HTTP');
  const secureRemote = await fetch(`${active.baseUrl}${cookiePath}`, {
    headers: {
      'x-cookie-read-key': readKey,
      'x-forwarded-for': '203.0.113.7',
      'x-forwarded-proto': 'https',
    },
  });
  assert.equal(secureRemote.status, 200);
  const rejectedMethod = await fetch(`${active.baseUrl}${cookiePath}`, {
    method: 'POST',
    headers: { 'x-cookie-read-key': readKey },
  });
  assert.equal(rejectedMethod.status, 405);
  const audit = await waitForAdminEvent('read-current');
  assert.ok(audit, '只读 Cookie 接口应写入审计事件');
  assert.equal(audit.category, 'cookie');
  assert.equal(audit.status, 'ok');
  const auditCount = await countCookieReadEvents('ok');
  await fetch(`${active.baseUrl}${cookiePath}`, { headers: { 'x-cookie-read-key': readKey } });
  await fetch(`${active.baseUrl}${cookiePath}`, { headers: { 'x-cookie-read-key': readKey } });
  assert.equal(
    await countCookieReadEvents('ok'),
    auditCount,
    '同一来源的重复读取应在审计间隔内合并，避免挤掉其他安全事件',
  );
  await stopServer(active);
  active = null;

  await writeCookieStore(storedCookie);
  active = await startServer({
    NODE_ENV: 'development',
    API_KEY: '',
    ENABLE_COOKIE_READ_API: '1',
  });
  const loopback = await fetch(`${active.baseUrl}${cookiePath}`);
  assert.equal(loopback.status, 200);
  assert.equal((await loopback.json()).cookie, storedCookie);
  const remoteWithoutKey = await fetch(`${active.baseUrl}${cookiePath}`, {
    headers: { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' },
  });
  assert.equal(remoteWithoutKey.status, 403, '未配置专用密钥时非回环来源必须拒绝');
  const proxiedWithoutForwardedFor = await rawGet(active.baseUrl, cookiePath, {
    host: 'lottery.example.com',
  });
  assert.equal(
    proxiedWithoutForwardedFor.status,
    403,
    '反向代理未写 X-Forwarded-For 时不得按回环来源放行',
  );
  await stopServer(active);
  active = null;

  await writeCookieStore('');
  active = await startServer({
    NODE_ENV: 'production',
    API_KEY: apiKey,
    ENABLE_COOKIE_READ_API: '1',
    COOKIE_READ_KEY: readKey,
  });
  const emptyStore = await fetch(`${active.baseUrl}${cookiePath}`, {
    headers: { 'x-cookie-read-key': readKey },
  });
  assert.equal(emptyStore.status, 503);
  assert.equal((await emptyStore.json()).error, '服务器暂无可用 Cookie');
} finally {
  await stopServer(active);
  await rm(testOutputDir, { recursive: true, force: true });
}

console.log('COOKIE_READ_API_OK');
