import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { hashAdminPassword } from '../src/lib/adminAuth.js';
import { stopChildProcess } from './child-process.mjs';
import { serverTestEnv } from './server-test-env.mjs';

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitUntil(check, timeoutMs, failure) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(typeof failure === 'function' ? failure() : failure);
}

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const mockFetch = new URL('./mock-weibo-fetch.mjs', import.meta.url).href;
const playwrightModule = import.meta.resolve('playwright');
const outputDir = await mkdtemp(path.join(os.tmpdir(), 'sameko-lifecycle-'));
const fetchGuardFile = path.join(outputDir, 'fetch-guard.mjs');
const retiredRmFailureMarker = path.join(outputDir, 'retired-rm-failure.marker');
const browserLaunchReadyFile = path.join(outputDir, 'browser-launch-ready.marker');
const browserLaunchReleaseFile = path.join(outputDir, 'browser-launch-release.marker');
const browserContextClosedFile = path.join(outputDir, 'browser-context-closed.marker');
const browserScreenshotReadyFile = path.join(outputDir, 'browser-screenshot-ready.marker');
const browserScreenshotReleaseFile = path.join(outputDir, 'browser-screenshot-release.marker');
const browserProfileOwnerFile = path.join(
  outputDir,
  'auth',
  'weibo-login-profile',
  '.sameko-profile-owner.json',
);
const adminUsername = 'lifecycle-admin';
const adminPassword = 'lifecycle-test-password';
const adminPasswordHash = await hashAdminPassword(adminPassword, {
  salt: Buffer.from('lifecycle-test-salt'),
});
await writeFile(fetchGuardFile, `
import fs from 'node:fs/promises';
await import(${JSON.stringify(mockFetch)});
const delegatedFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = input instanceof URL
    ? input
    : new URL(typeof input === 'string' ? input : input.url);
  if (
    url.hostname === 'weibo.com'
    || url.hostname.endsWith('.weibo.com')
    || url.hostname === 'weibo.cn'
    || url.hostname.endsWith('.weibo.cn')
  ) {
    if (options.redirect !== 'error') {
      process.stdout.write('MOCK_REDIRECT_POLICY_FAILED\\n');
      throw new Error('微博请求未禁止重定向');
    }
  }
  return await delegatedFetch(input, options);
};

const waitForFile = async (filePath) => {
  while (true) {
    try {
      await fs.access(filePath);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};

const startupReadReadyFile = process.env.MOCK_STARTUP_READ_READY_FILE;
const startupReadReleaseFile = process.env.MOCK_STARTUP_READ_RELEASE_FILE;
if (startupReadReadyFile && startupReadReleaseFile) {
  const originalOpen = fs.open.bind(fs);
  let heldStartupRead = false;
  fs.open = async (target, ...args) => {
    if (!heldStartupRead && String(target).endsWith('system-metrics.json')) {
      heldStartupRead = true;
      await fs.writeFile(startupReadReadyFile, 'startup-read', 'utf8');
      await waitForFile(startupReadReleaseFile);
    }
    return await originalOpen(target, ...args);
  };
}

const originalRm = fs.rm.bind(fs);
const rmFailureMarker = process.env.MOCK_RETIRED_RM_FAIL_ONCE_FILE;
if (rmFailureMarker) {
  fs.rm = async (target, options) => {
    const name = String(target).split(/[\\/]/).at(-1) || '';
    try {
      await fs.access(rmFailureMarker);
    } catch (error) {
      if (error.code === 'ENOENT' && name.includes('.retired-')) {
        await fs.writeFile(rmFailureMarker, 'failed-once', 'utf8');
        const failure = new Error('injected retired cache cleanup failure');
        failure.code = 'EACCES';
        throw failure;
      }
    }
    return await originalRm(target, options);
  };
}

const launchReadyFile = process.env.MOCK_BROWSER_LAUNCH_READY_FILE;
const launchReleaseFile = process.env.MOCK_BROWSER_LAUNCH_RELEASE_FILE;
const contextClosedFile = process.env.MOCK_BROWSER_CONTEXT_CLOSED_FILE;
const screenshotReadyFile = process.env.MOCK_BROWSER_SCREENSHOT_READY_FILE;
const screenshotReleaseFile = process.env.MOCK_BROWSER_SCREENSHOT_RELEASE_FILE;
if (launchReadyFile && launchReleaseFile && contextClosedFile) {
  const { chromium } = await import(${JSON.stringify(playwrightModule)});
  chromium.launchPersistentContext = async () => {
    await fs.writeFile(launchReadyFile, 'launch-started', 'utf8');
    await waitForFile(launchReleaseFile);
    let closeContext;
    const contextClosed = new Promise((resolve) => { closeContext = resolve; });
    return {
      pages: () => [],
      newPage: async () => ({
        url: () => 'https://passport.weibo.com/sso/signin',
        goto: async () => {},
        waitForTimeout: async () => {},
        evaluate: async () => true,
        screenshot: async () => {
          if (screenshotReadyFile && screenshotReleaseFile) {
            await fs.appendFile(screenshotReadyFile, 'screenshot-started\\n', 'utf8');
            await Promise.race([waitForFile(screenshotReleaseFile), contextClosed]);
          }
          return Buffer.from('mock-screenshot');
        },
      }),
      close: async () => {
        await fs.writeFile(contextClosedFile, 'closed', 'utf8');
        closeContext();
      },
      cookies: async () => [],
    };
  };
}
`, 'utf8');
const fetchGuard = pathToFileURL(fetchGuardFile).href;
const cacheBulkDir = path.join(outputDir, 'runtime-cache', 'bulk');
const cacheMarker = path.join(cacheBulkDir, 'entry-0000.cache');
await mkdir(cacheBulkDir, { recursive: true });
await Promise.all(Array.from({ length: 1001 }, (_, index) => (
  writeFile(path.join(cacheBulkDir, `entry-${String(index).padStart(4, '0')}.cache`), 'x')
)));

const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const apiKey = 'lifecycle-test-key';
const adminKey = 'lifecycle-admin-key-at-least-32-bytes';
const output = [];
function spawnServer({
  targetPort = port,
  targetOutputDir = outputDir,
  targetOutput = output,
  extraEnv = {},
} = {}) {
  const child = spawn(process.execPath, ['--import', fetchGuard, 'server.mjs'], {
    cwd: rootDir,
    env: serverTestEnv(targetOutputDir, {
      PORT: String(targetPort),
      HOST: '127.0.0.1',
      API_KEY: apiKey,
      ADMIN_KEY: adminKey,
      ADMIN_USERNAME: adminUsername,
      ADMIN_PASSWORD_HASH: adminPasswordHash,
      ADMIN_SESSION_SECRET: 'lifecycle-session-secret-at-least-32-bytes',
      DISABLE_COOKIE_STORE: '1',
      WEIBO_KEEPALIVE_ENABLED: '0',
      MAX_ACTIVE_JOBS: '1',
      MAX_QUEUED_JOBS: '4',
      MAX_CLIENT_REPOST_JOBS: '2',
      MAX_RETAINED_JOBS: '2',
      MAX_JOB_SUBSCRIBERS: '4',
      COMPLETED_JOB_RELEASE_MS: '60000',
      RUNTIME_CACHE_SCAN_MAX_ENTRIES: '1000',
      WEIBO_BROWSER_ABORT_CLEANUP_MS: '1000',
      WEIBO_LOGIN_SCREENSHOT_TIMEOUT_MS: '1000',
      MOCK_RETIRED_RM_FAIL_ONCE_FILE: retiredRmFailureMarker,
      MOCK_BROWSER_LAUNCH_READY_FILE: browserLaunchReadyFile,
      MOCK_BROWSER_LAUNCH_RELEASE_FILE: browserLaunchReleaseFile,
      MOCK_BROWSER_CONTEXT_CLOSED_FILE: browserContextClosedFile,
      MOCK_BROWSER_SCREENSHOT_READY_FILE: browserScreenshotReadyFile,
      MOCK_BROWSER_SCREENSHOT_RELEASE_FILE: browserScreenshotReleaseFile,
      NODE_ENV: 'test',
      ...extraEnv,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => targetOutput.push(chunk.toString()));
  child.stderr.on('data', (chunk) => targetOutput.push(chunk.toString()));
  return child;
}

let server = spawnServer();

async function stopServer(child, signal = 'SIGTERM') {
  await stopChildProcess(child, { gracefulSignal: signal });
  assert.ok(child.exitCode === 0 || child.signalCode === signal);
}

async function verifyShutdownBeforeListen() {
  const targetPort = await availablePort();
  const targetOutputDir = path.join(outputDir, 'startup-stop');
  const readyFile = path.join(targetOutputDir, 'startup-read-ready.marker');
  const releaseFile = path.join(targetOutputDir, 'startup-read-release.marker');
  const targetOutput = [];
  await mkdir(targetOutputDir, { recursive: true });
  await writeFile(path.join(targetOutputDir, 'system-metrics.json'), '[]', 'utf8');
  const child = spawnServer({
    targetPort,
    targetOutputDir,
    targetOutput,
    extraEnv: {
      MOCK_STARTUP_READ_READY_FILE: readyFile,
      MOCK_STARTUP_READ_RELEASE_FILE: releaseFile,
    },
  });

  try {
    await waitUntil(
      () => access(readyFile).then(() => true).catch(() => false),
      5000,
      () => `测试服务没有进入启动等待点\n${targetOutput.join('')}`,
    );
    child.kill('SIGTERM');
    await writeFile(releaseFile, 'release', 'utf8');
    const exit = await Promise.race([
      new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
      new Promise((_, reject) => setTimeout(() => reject(new Error('启动阶段停止测试未在 5 秒内退出')), 5000)),
    ]);
    assert.ok(exit.code === 0 || exit.signal === 'SIGTERM', targetOutput.join(''));
    assert.doesNotMatch(targetOutput.join(''), /Sameko Weibo Lottery running at/);
  } finally {
    await writeFile(releaseFile, 'release', 'utf8').catch(() => {});
    await stopChildProcess(child);
  }
}

async function api(pathname, options = {}) {
  return await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { 'x-api-key': apiKey, ...(options.headers || {}) },
  });
}

async function adminApi(pathname, options = {}) {
  return await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { 'x-api-key': adminKey, ...(options.headers || {}) },
  });
}

async function startJob(statusId, clientAddress = '', accessToken = 'test-token') {
  return await api('/api/weibo/reposts/jobs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(clientAddress ? { 'x-forwarded-for': clientAddress } : {}),
    },
    body: JSON.stringify({ source: 'official', statusId, accessToken }),
  });
}

async function waitForJob(jobId, readToken) {
  let body;
  await waitUntil(async () => {
    const response = await api(`/api/weibo/reposts/jobs/${jobId}`, {
      headers: { 'x-job-read-token': readToken },
    });
    body = await response.json();
    return body.status === 'done' || body.status === 'error' || body.status === 'cancelled';
  }, 5000, `任务 ${jobId} 未完成`);
  return body;
}

try {
  await verifyShutdownBeforeListen();

  await waitUntil(async () => {
    try {
      return (await fetch(`${baseUrl}/api/health`)).ok;
    } catch {
      return false;
    }
  }, 15_000, () => `测试服务启动超时\n${output.join('')}`);

  await assert.rejects(access(cacheMarker), { code: 'ENOENT' });
  await access(path.join(outputDir, 'runtime-cache', 'chromium'));
  await access(retiredRmFailureMarker);
  const firstCycleEntries = await readdir(outputDir, { withFileTypes: true });
  const retiredCacheName = firstCycleEntries.find(
    (entry) => entry.isDirectory() && entry.name.startsWith('runtime-cache.retired-'),
  )?.name;
  assert.ok(retiredCacheName, '第一次回收失败后应保留待重试的 retired cache');

  const preRestartLogin = await adminApi('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: adminUsername, password: adminPassword }),
  });
  assert.equal(preRestartLogin.status, 200);
  const preRestartCookie = (preRestartLogin.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(preRestartCookie);
  await stopServer(server);
  server = spawnServer();
  await waitUntil(async () => {
    try {
      return (await fetch(`${baseUrl}/api/health`)).ok;
    } catch {
      return false;
    }
  }, 15_000, () => `重启后的测试服务启动超时\n${output.join('')}`);
  await assert.rejects(access(path.join(outputDir, retiredCacheName)), { code: 'ENOENT' });
  const staleSessionAfterRestart = await api('/api/admin/session', {
    headers: { cookie: preRestartCookie },
  });
  assert.equal(staleSessionAfterRestart.status, 401);

  await Promise.all([
    rm(browserLaunchReadyFile, { force: true }),
    rm(browserLaunchReleaseFile, { force: true }),
    rm(browserContextClosedFile, { force: true }),
    rm(browserScreenshotReadyFile, { force: true }),
    rm(browserScreenshotReleaseFile, { force: true }),
  ]);
  const qrStartPromise = adminApi('/api/admin/weibo-login/start', { method: 'POST' });
  await waitUntil(
    () => access(browserLaunchReadyFile).then(() => true).catch(() => false),
    5000,
    '扫码浏览器启动没有进入可控等待点',
  );
  const qrStop = await adminApi('/api/admin/weibo-login/stop', { method: 'POST' });
  assert.equal(qrStop.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const overlappingQrStart = await adminApi('/api/admin/weibo-login/start', {
    method: 'POST',
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(overlappingQrStart.status, 409);
  await writeFile(browserLaunchReleaseFile, 'release', 'utf8');
  const qrStart = await qrStartPromise;
  assert.equal(qrStart.status, 200);
  const qrStartBody = await qrStart.json();
  assert.equal(qrStartBody.active, false);
  assert.match(qrStartBody.message, /扫码窗口已关闭/);
  await access(browserContextClosedFile);
  await waitUntil(
    () => access(browserProfileOwnerFile).then(() => false).catch((error) => error.code === 'ENOENT'),
    5000,
    '迟到的浏览器 context 关闭后没有释放 Profile 所有权',
  );

  await Promise.all([
    rm(browserContextClosedFile, { force: true }),
    rm(browserScreenshotReadyFile, { force: true }),
    rm(browserScreenshotReleaseFile, { force: true }),
  ]);
  const hangingScreenshotStart = adminApi('/api/admin/weibo-login/start', { method: 'POST' });
  await waitUntil(
    () => access(browserScreenshotReadyFile).then(() => true).catch(() => false),
    5000,
    '扫码会话没有进入可控截图等待点',
  );
  const stopHangingScreenshot = adminApi('/api/admin/weibo-login/stop', { method: 'POST' });
  try {
    await waitUntil(
      () => access(browserContextClosedFile).then(() => true).catch(() => false),
      1500,
      '停止扫码应先关闭浏览器 context，再等待挂起的页面操作',
    );
  } finally {
    await writeFile(browserScreenshotReleaseFile, 'release', 'utf8');
  }
  const stoppedHangingScreenshot = await stopHangingScreenshot;
  assert.equal(stoppedHangingScreenshot.status, 200);
  const hangingScreenshotResponse = await hangingScreenshotStart;
  assert.equal(hangingScreenshotResponse.status, 200);
  assert.equal((await hangingScreenshotResponse.json()).active, false);

  await Promise.all([
    rm(browserContextClosedFile, { force: true }),
    rm(browserScreenshotReadyFile, { force: true }),
    rm(browserScreenshotReleaseFile, { force: true }),
  ]);
  const timedOutScreenshotStart = adminApi('/api/admin/weibo-login/start', { method: 'POST' });
  await waitUntil(
    () => access(browserScreenshotReadyFile).then(() => true).catch(() => false),
    5000,
    '扫码会话没有进入截图超时测试点',
  );
  const timedOutScreenshotResponse = await timedOutScreenshotStart;
  assert.equal(timedOutScreenshotResponse.status, 200);
  const timedOutScreenshotBody = await timedOutScreenshotResponse.json();
  assert.equal(timedOutScreenshotBody.active, false);
  assert.match(timedOutScreenshotBody.message, /截图生成超时/);
  await access(browserContextClosedFile);
  const screenshotCalls = (await readFile(browserScreenshotReadyFile, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean).length;
  const statusAfterScreenshotTimeout = await adminApi('/api/admin/weibo-login/status');
  assert.equal(statusAfterScreenshotTimeout.status, 200);
  assert.equal((await statusAfterScreenshotTimeout.json()).active, false);
  assert.equal(
    (await readFile(browserScreenshotReadyFile, 'utf8')).split(/\r?\n/).filter(Boolean).length,
    screenshotCalls,
    '超时清理后不应继续向旧 context 发起截图命令',
  );

  for (const statusId of ['100001', '100002', '100003', '100004']) {
    const response = await startJob(statusId);
    assert.equal(response.status, 202);
    const body = await response.json();
    const finished = await waitForJob(body.jobId, body.readToken);
    assert.equal(finished.status, 'done', `${JSON.stringify(finished)}\n${output.join('')}`);
  }

  const retainedSummary = await (await adminApi('/api/admin/summary')).json();
  assert.equal(retainedSummary.queue.retained, 2);
  assert.equal(retainedSummary.queue.maxRetained, 2);

  const hanging = await startJob('999999');
  assert.equal(hanging.status, 202);
  const hangingBody = await hanging.json();
  const unauthorizedHangingPoll = await api(`/api/weibo/reposts/jobs/${hangingBody.jobId}`);
  assert.equal(unauthorizedHangingPoll.status, 403);
  assert.ok(hangingBody.readToken);
  assert.ok(hangingBody.cancelToken);
  await waitUntil(
    () => output.join('').includes('MOCK_FETCH_STARTED'),
    3000,
    '挂起抓取没有开始',
  );

  const sameClientShared = await startJob('999999');
  assert.equal(sameClientShared.status, 202);
  assert.ok((await sameClientShared.json()).cancelToken);
  const sameClientOverflow = await startJob('999999');
  assert.equal(sameClientOverflow.status, 429);

  const shared = await startJob('999999', '203.0.113.10');
  assert.equal(shared.status, 202);
  assert.ok((await shared.json()).cancelToken);
  const repeatedSharedClient = await startJob('999999', '203.0.113.10');
  assert.equal(repeatedSharedClient.status, 202);
  assert.ok((await repeatedSharedClient.json()).cancelToken);
  const repeatedSharedOverflow = await startJob('999999', '203.0.113.10');
  assert.equal(repeatedSharedOverflow.status, 429);
  const overSubscribed = await startJob('999999', '203.0.113.11');
  assert.equal(overSubscribed.status, 429);

  const startedShutdownAt = Date.now();
  server.kill('SIGTERM');
  const exit = await Promise.race([
    new Promise((resolve) => server.once('exit', (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error('服务未在 5 秒内退出')), 5000)),
  ]);
  assert.ok(exit.code === 0 || exit.signal === 'SIGTERM');
  assert.ok(Date.now() - startedShutdownAt < 5000);
  if (process.platform !== 'win32') assert.match(output.join(''), /MOCK_FETCH_ABORTED/);
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    await stopServer(server);
  }
  await rm(outputDir, { recursive: true, force: true });
}

console.log('SERVER_LIFECYCLE_OK');
