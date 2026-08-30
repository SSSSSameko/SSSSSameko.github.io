import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { serverTestEnv } from './server-test-env.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const mockModule = pathToFileURL(path.join(rootDir, 'scripts', 'mock-weibo-provider-fallback.mjs')).href;
const apiKey = 'provider-fallback-test-key';

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

async function waitUntil(check, timeoutMs, failureMessage) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(typeof failureMessage === 'function' ? failureMessage() : failureMessage);
}

function cookieEntry(id, cookie, savedAt) {
  return {
    id,
    cookie,
    savedAt,
    updatedAt: savedAt,
    lastCheckedAt: savedAt,
    lastValidAt: savedAt,
    lastError: '',
  };
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 500)),
  ]);
  if (!stopped && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
}

async function withServer(scenario, options, run) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), `sameko-provider-${scenario}-`));
  const authDir = path.join(outputDir, 'auth');
  const requestLog = path.join(outputDir, 'weibo-requests.jsonl');
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  await mkdir(authDir, { recursive: true });
  await writeFile(requestLog, '', 'utf8');

  const savedAt = '2026-08-27T00:00:00.000Z';
  const cookies = options?.cookies || [
    cookieEntry('good-cookie', 'POOL_GOOD=1; XSRF-TOKEN=good', savedAt),
  ];
  await writeFile(path.join(authDir, 'weibo-cookie.json'), JSON.stringify({
    version: 2,
    activeId: options?.activeId || cookies[0]?.id || '',
    updatedAt: savedAt,
    cookies,
  }), 'utf8');

  const server = spawn(process.execPath, ['--import', mockModule, 'server.mjs'], {
    cwd: rootDir,
    env: serverTestEnv(outputDir, {
      PORT: String(port),
      HOST: '127.0.0.1',
      API_KEY: apiKey,
      NODE_ENV: 'test',
      WEIBO_KEEPALIVE_ENABLED: '0',
      WEIBO_PROVIDER_MOCK_SCENARIO: scenario,
      WEIBO_PROVIDER_MOCK_LOG: requestLog,
      FETCH_TIMEOUT_MS: '2000',
      PAGE_DELAY_JITTER_MS: '0',
      DESKTOP_PAGE_DELAY_MS: '0',
      MOBILE_PAGE_DELAY_MS: '0',
      LEGACY_PAGE_DELAY_MS: '0',
      PAGE_COOLDOWN_MS: '0',
      WEIBO_THROTTLE_RETRY_MAX: '0',
      SAME_STATUS_REQUEST_GAP_MS: '0',
      JOB_CREATE_RATE_LIMIT_MAX: '100',
      JOB_POLL_RATE_LIMIT_MAX: '2000',
      MAX_ACTIVE_JOBS: '1',
      MAX_QUEUED_JOBS: '2',
      MAX_RETAINED_JOBS: '2',
      COMPLETED_JOB_RELEASE_MS: '10000',
      DESKTOP_MAX_PAGES: '20',
      ...options?.env,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));

  async function api(pathname, requestOptions = {}) {
    return await fetch(`${baseUrl}${pathname}`, {
      ...requestOptions,
      headers: {
        'x-api-key': apiKey,
        ...(requestOptions.headers || {}),
      },
    });
  }

  async function runJob(statusId) {
    const started = await api('/api/weibo/reposts/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'mobile',
        statusId,
        forceRefresh: true,
      }),
    });
    if (started.status !== 202) {
      assert.fail(`创建任务失败（${started.status}）：${await started.text()}\n${output.join('')}`);
    }
    const startedBody = await started.json();

    const finished = await waitUntil(async () => {
      const response = await api(`/api/weibo/reposts/jobs/${startedBody.jobId}`, {
        headers: { 'x-job-read-token': startedBody.readToken },
      });
      if (response.status !== 200) {
        assert.fail(`轮询任务失败（${response.status}）：${await response.text()}`);
      }
      const body = await response.json();
      return ['done', 'error', 'cancelled'].includes(body.status) ? body : null;
    }, 15_000, () => `任务 ${startedBody.jobId} 未完成\n${output.join('')}`);
    assert.equal(
      finished.status,
      'done',
      `任务 ${startedBody.jobId} 失败：${JSON.stringify(finished)}\n${output.join('')}`,
    );
    return finished.result;
  }

  async function requests() {
    const text = await readFile(requestLog, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }

  try {
    await waitUntil(async () => {
      try {
        return (await fetch(`${baseUrl}/api/health`)).ok;
      } catch {
        return false;
      }
    }, 10_000, () => `测试服务启动超时\n${output.join('')}`);
    await run({ runJob, requests, output });
  } finally {
    await stopServer(server);
    await rm(outputDir, { recursive: true, force: true });
  }
}

test('Weibo Cookie provider fallback service regressions', async (t) => {
  const savedAt = '2026-08-27T00:00:00.000Z';
  await withServer('all', {
    activeId: 'bad-cookie',
    cookies: [
      cookieEntry('bad-cookie', 'POOL_BAD=1; XSRF-TOKEN=bad', savedAt),
      cookieEntry('good-cookie', 'POOL_GOOD=1; XSRF-TOKEN=good', savedAt),
    ],
    env: {
      MAX_CANDIDATES: '25000',
      MAX_CANDIDATE_PAYLOAD_BYTES: String(32 * 1024 * 1024),
      MAX_RETAINED_JOB_RESPONSE_BYTES: String(64 * 1024 * 1024),
    },
  }, async ({ runJob, requests }) => {
    await t.test('rotates to the next stored Cookie after every provider returns 401', async () => {
      const result = await runJob('920001');
      assert.equal(result.candidates[0]?.repostId, 'rotation-valid');
      assert.equal(result.meta.cookiePool?.usedId, 'good-cookie');
      const calls = await requests();
      assert.ok(calls.some((item) => item.cookie === 'bad' && item.pathname === '/ajax/statuses/repostTimeline'));
      assert.ok(calls.some((item) => item.cookie === 'bad' && item.pathname === '/api/statuses/repostTimeline'));
      assert.ok(calls.some((item) => item.cookie === 'bad' && item.host === 'weibo.cn' && item.pathname.startsWith('/repost/')));
      assert.ok(calls.some((item) => item.cookie === 'good' && item.pathname === '/ajax/statuses/repostTimeline'));
    });

    await t.test('merges incomplete desktop results with mobile by repostId', async () => {
      const result = await runJob('910001');
      assert.deepEqual(
        result.candidates.map((item) => item.repostId).sort(),
        ['partial-desktop', 'partial-mobile', 'partial-shared'],
      );
      assert.deepEqual(result.meta.providers, ['desktop-cookie', 'mobile']);
      assert.equal(result.meta.visibleNumber, 3);
      assert.equal(result.meta.rawVisibleNumber, 4);
      const calls = await requests();
      assert.ok(calls.some((item) => item.statusId === '910001' && item.pathname === '/api/statuses/repostTimeline'));
    });

    await t.test('stops known-maxPage pagination after consecutive empty pages', async () => {
      const result = await runJob('930001');
      assert.equal(result.candidates[0]?.repostId, 'empty-pages-mobile');
      assert.ok(result.meta.providers.includes('mobile'));
      const desktopPages = (await requests())
        .filter((item) => item.statusId === '930001' && item.pathname === '/ajax/statuses/repostTimeline')
        .map((item) => item.page);
      assert.deepEqual(desktopPages, [1, 2, 3]);
    });

    await t.test('clamps candidate count at 20000 without flagging an exact complete result', async () => {
      const overLimit = await runJob('940001');
      assert.equal(overLimit.candidates.length, 20_000);
      assert.equal(overLimit.meta.complete, false);
      assert.ok(overLimit.meta.warnings.some((warning) => /最多载入\s*20000\s*位候选/.test(warning)));

      const exact = await runJob('940002');
      assert.equal(exact.candidates.length, 20_000);
      assert.equal(exact.meta.candidateLimitReason || '', '');
      assert.equal(exact.meta.complete, true);
      assert.ok(!exact.meta.warnings.some((warning) => /最多载入\s*20000\s*位候选/.test(warning)));
    });

    await t.test('keeps the real repost id from legacy M_ markup', async () => {
      const result = await runJob('950001');
      assert.equal(result.candidates.length, 1);
      assert.equal(result.candidates[0].repostId, '987654321');
      assert.equal(result.candidates[0].source, 'weibo-cn');
    });

    await t.test('passes combined head reconciliation metadata through the service response', async () => {
      const result = await runJob('960001');
      assert.equal(result.candidates.length, 3);
      assert.equal(result.meta.headReconciled, true);
      assert.equal(result.meta.headAddedCount, 1);
      assert.equal(result.candidates[0].repostId, 'head-new');
    });

    await t.test('continues to H5 when desktop status metadata and candidates are unavailable', async () => {
      const result = await runJob('970001');
      assert.equal(result.candidates.length, 1);
      assert.equal(result.candidates[0].repostId, 'unknown-desktop-mobile');
      assert.ok(result.meta.providers.includes('mobile'));
      const calls = await requests();
      assert.ok(calls.some((item) => item.statusId === '970001' && item.pathname === '/api/statuses/repostTimeline'));
    });

    await t.test('preserves a numeric H5 total of zero', async () => {
      const result = await runJob('970002');
      assert.equal(result.candidates.length, 0);
      assert.equal(result.meta.totalNumber, 0);
      assert.ok(result.meta.providers.includes('mobile'));
    });
  });
});
