import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { stopChildProcess } from './child-process.mjs';
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
      ADMIN_KEY: apiKey,
      NODE_ENV: 'test',
      WEIBO_KEEPALIVE_ENABLED: '0',
      WEIBO_PROVIDER_MOCK_SCENARIO: scenario,
      WEIBO_PROVIDER_MOCK_LOG: requestLog,
      FETCH_TIMEOUT_MS: '2000',
      PAGE_DELAY_JITTER_MS: '0',
      PROVIDER_SWITCH_DELAY_MS: '0',
      OFFICIAL_PAGE_DELAY_MS: '0',
      DESKTOP_PAGE_DELAY_MS: '0',
      DESKTOP_PAGE_DELAY_JITTER_MS: '0',
      MOBILE_PAGE_DELAY_MS: '0',
      MOBILE_PAGE_DELAY_JITTER_MS: '0',
      LEGACY_PAGE_DELAY_MS: '0',
      LEGACY_PAGE_DELAY_JITTER_MS: '0',
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

  async function runJob(statusId, expectedStatus = 'done') {
    const started = await api('/api/weibo/reposts/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: options?.source || 'mobile',
        ...(options?.source === 'official' ? { accessToken: 'fixture-official-token' } : {}),
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
      expectedStatus,
      `任务 ${startedBody.jobId} 失败：${JSON.stringify(finished)}\n${output.join('')}`,
    );
    return expectedStatus === 'done' ? finished.result : finished;
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
    await run({ runJob, requests, output, api, outputDir });
  } finally {
    await stopChildProcess(server);
    await rm(outputDir, { recursive: true, force: true });
  }
}

test('official source preserves partial lists and never equates tolerance with completeness', async (t) => {
  await withServer('official-boundaries', { source: 'official' }, async ({ runJob, requests }) => {
    for (const [id, count, total, complete] of [
      ['992001', 4, 5, false], ['992002', 201, null, false],
      ['992003', 200, 250, false], ['992004', 1, 1, false], ['992005', 200, 200, true],
    ]) {
      await t.test(id, async () => {
        const result = await runJob(id);
        assert.equal(result.candidates.length, count);
        assert.equal(result.meta.totalNumber, total);
        assert.equal(result.meta.complete, complete);
        assert.equal(result.meta.visibleNumber, count);
        assert.equal(result.meta.missingCount, total === null ? null : Math.max(0, total - count));
        if (id === '992003') {
          assert.equal(result.meta.paginationError.page, 2);
          assert.equal(result.meta.stopReason, 'pagination-error');
        }
      });
    }
    for (const id of ['992006', '992007']) {
      await t.test(`official ${id} still stops on authentication or throttling`, async () => {
        await runJob(id, 'error');
        const calls = (await requests()).filter(call => call.statusId === id);
        assert.deepEqual(calls.map(call => call.page), [1, 2]);
      });
    }
  });
});

test('evidence-based fallback policy and identity regressions', async (t) => {
  await withServer('fallback-policy', {}, async ({ runJob, requests, outputDir }) => {
    for (const [id,count,total,reason,providers] of [
      ['991001',24,29,'stable-small-gap',2], ['991002',40,50,'stable-small-gap',2],
      ['991003',12,18,'providers-exhausted',3], ['991004',160,200,'large-list-tolerance',1],
      ['991005',159,200,'providers-exhausted',3], ['991006',160,199,'providers-exhausted',3],
      ['991007',160,200,'providers-exhausted',3], ['991008',160,200,'providers-exhausted',3],
      ['991009',25,29,'providers-exhausted',3], ['991012',0,164,'providers-exhausted',3],
    ]) {
      await t.test(`${id}: ${count}/${total} stops as ${reason}`, async () => {
        const result = await runJob(id);
        assert.equal(result.candidates.length,count);
        assert.equal(result.meta.totalNumber,total);
        assert.equal(result.meta.missingCount,total-count);
        assert.equal(result.meta.complete,false);
        assert.equal(result.meta.stopReason,reason);
        assert.equal(result.meta.providerAttempts.length,providers, JSON.stringify({ attempts: result.meta.providerAttempts, warnings: result.meta.warnings }));
        assert.equal(result.meta.providers.length,providers);
        const calls = (await requests()).filter(call => call.statusId === id);
        assert.equal(calls.some(call => call.host === 'weibo.cn'),providers === 3);
        assert.equal(calls.some(call => call.pathname === '/api/statuses/repostTimeline'),providers >= 2);
        if (reason === 'stable-small-gap') assert.equal(result.meta.providerAttempts[1].addedCount,0);
        if (id === '991009') assert.equal(result.meta.providerAttempts[1].addedCount,1);
      });
    }
    await t.test('MID/BID alias adds no duplicate while another repost by the same user survives', async () => {
      const result = await runJob('991010');
      assert.deepEqual(result.candidates.map(c => c.repostId),['5000000123456789','5000000123456790']);
      assert.equal(result.meta.rawVisibleNumber,4);
      assert.equal(result.meta.providerAttempts[1].addedCount,0);
      assert.equal(result.meta.providerAttempts[2].addedCount,1);
      assert.equal(result.meta.providerAttempts[2].duplicateCount,1);
    });
    await t.test('a genuinely useful fallback still fills the entire list', async () => {
      const result = await runJob('991011');
      assert.equal(result.candidates.length,200);
      assert.equal(result.meta.complete,true);
      assert.equal(result.meta.stopReason,'count-reached');
      assert.equal(result.meta.providerAttempts[1].addedCount,199);
      assert.equal(result.meta.providers.length,2);
    });
    await t.test('unidentified legacy entries are reported instead of silently merged by user', async () => {
      const result = await runJob('991013');
      assert.equal(result.candidates.length,2);
      assert.equal(result.meta.identityUncertainCount,1);
      assert.equal(result.meta.complete,false);
    });
    await t.test('successful and partial channels retain actual gain, reasons and a shared trace without credentials', async () => {
      await waitUntil(async () => {
        const events=JSON.parse(await readFile(path.join(outputDir,'admin-events.json'),'utf8'));
        return events.some(e => e.action === 'load-result' && e.details?.statusId === '991013');
      },2000,'Missing final trace');
      const events=JSON.parse(await readFile(path.join(outputDir,'admin-events.json'),'utf8'));
      for (const id of ['991001','991004','991010','991011']) {
        const final=events.find(e => e.action === 'load-result' && e.details?.statusId === id);
        const channels=events.filter(e => e.action === 'provider-result' && e.details?.crawlId === final.details.crawlId);
        assert.equal(channels.length,final.details.attemptCount);
        assert.ok(channels.every(e => Number.isInteger(e.details.addedCount)));
        assert.equal(channels.at(-1).details.aggregateNumber,final.details.visibleNumber);
        assert.doesNotMatch(JSON.stringify([final,...channels]), /POOL_GOOD|XSRF|repostId|screenName|readToken|cancelToken/);
      }
    });
  });
});

test('Weibo response boundary regressions', async (t) => {
  await withServer('response-boundaries', { env: { MAX_WEIBO_RESPONSE_BYTES: '65536' } }, async ({ runJob, requests }) => {
    for (const [statusId, reason] of [
      ['990101', 'HTTP 200 non-JSON'], ['990102', 'interrupted response body'],
      ['990110', 'changed page schema'], ['990111', 'oversized declared body'], ['990112', 'oversized streamed body'],
    ]) {
      await t.test(`retains earlier candidates after ${reason}`, async () => {
        const result = await runJob(statusId);
        assert.equal(result.candidates.length, 1);
        assert.equal(result.meta.complete, false);
        assert.ok(result.meta.warnings.some((warning) => /第 2 页.*失败.*保留/.test(warning)));
      });
    }
    await t.test('does not let count tolerance hide an interrupted page sequence', async () => {
      const result = await runJob('990103');
      assert.equal(result.candidates.length, 90);
      assert.equal(result.meta.complete, false);
      assert.ok((await requests()).some((item) => item.statusId === '990103' && item.pathname === '/api/statuses/repostTimeline'));
    });
    await t.test('can finish when a backup really fills all missing candidates after an interrupted scan', async () => {
      const result = await runJob('990109');
      assert.equal(result.candidates.length, 100);
      assert.equal(result.meta.complete, true);
      assert.deepEqual(result.meta.providers, ['desktop-cookie', 'mobile']);
    });
    await t.test('rejects a changed timeline schema instead of accepting an empty list', async () => {
      const result = await runJob('990104');
      assert.ok(!result.meta.providers.includes('desktop-cookie'));
      assert.ok(result.meta.warnings.some((warning) => /转发列表.*结构/.test(warning)));
    });
    await t.test('recognizes rate limiting in a string ok and message envelope', async () => {
      const result = await runJob('990107', 'error');
      assert.match(result.error, /频繁/);
      assert.ok(!(await requests()).some((item) => item.statusId === '990107' && item.pathname === '/api/statuses/repostTimeline'));
    });
  });
  for (const [statusId, reason] of [['990105', 'HTML login page'], ['990106', 'login redirect']]) {
    await t.test(`rotates an expired Cookie after ${reason} without following redirects`, async () => {
      await withServer('response-boundaries', {
        cookies: [
          cookieEntry('bad-cookie', 'POOL_BAD=1', '2026-08-27T00:00:00.000Z'),
          cookieEntry('good-cookie', 'POOL_GOOD=1', '2026-08-27T00:00:00.000Z'),
        ],
      }, async ({ runJob }) => {
        const result = await runJob(statusId);
        assert.equal(result.candidates[0]?.repostId, 'auth-recovered');
        assert.equal(result.meta.cookiePool.usedId, 'good-cookie');
      });
    });
  }
});

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
  }, async ({ runJob, requests, outputDir, api }) => {
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

    await t.test('accepts a one-record shortfall without loading the mobile provider', async () => {
      const result = await runJob('910001');
      assert.deepEqual(
        result.candidates.map((item) => item.repostId).sort(),
        ['partial-desktop', 'partial-shared'],
      );
      assert.deepEqual(result.meta.providers, ['desktop-cookie']);
      assert.equal(result.meta.visibleNumber, 2);
      assert.equal(result.meta.rawVisibleNumber, 2);
      const calls = await requests();
      assert.ok(!calls.some((item) => item.statusId === '910001' && item.pathname === '/api/statuses/repostTimeline'));
    });

    await t.test('accepts a declared desktop end page when the advertised total is off by one', async () => {
      const result = await runJob('910002');
      assert.deepEqual(result.meta.providers, ['desktop-cookie']);
      assert.equal(result.candidates.length, 3);
      assert.equal(result.meta.complete, false);
      assert.equal(result.meta.stopReason, 'within-tolerance');
      const calls = await requests();
      assert.ok(!calls.some((item) => item.statusId === '910002' && item.pathname === '/api/statuses/repostTimeline'));
    });

    await t.test('continues to the next provider when a short page is not the declared end', async () => {
      const result = await runJob('910003');
      assert.ok(result.meta.providers.includes('desktop-cookie'));
      assert.ok(result.meta.providers.includes('mobile'));
      assert.equal(result.meta.complete, false);
      assert.equal(result.meta.visibleNumber, 2);
      assert.equal(result.meta.totalNumber, 100);
    });

    await t.test('does not mark the aggregate complete when one provider total is smaller', async () => {
      const result = await runJob('910004');
      assert.deepEqual(result.meta.providers, ['desktop-cookie', 'mobile', 'weibo-cn']);
      assert.equal(result.meta.complete, false);
      assert.equal(result.meta.visibleNumber, 2);
      assert.equal(result.meta.totalNumber, 100);
      const calls = await requests();
      assert.ok(calls.some((item) => item.statusId === '910004' && item.host === 'weibo.cn'));
    });

    for (const [statusId, repostId, provider] of [
      ['980001', 'interrupted-desktop', 'desktop-cookie'],
      ['980002', 'interrupted-mobile', 'mobile'],
      ['980004', 'interrupted-legacy', 'weibo-cn'],
    ]) {
      await t.test(`retains ${provider} candidates when a later page fails`, async () => {
        const result = await runJob(statusId);
        assert.ok(result.candidates.some((item) => item.repostId === repostId));
        assert.equal(result.meta.complete, false);
        assert.equal(result.meta.totalNumber, 20);
        assert.ok(result.meta.warnings.some((warning) => /第 2 页.*失败.*保留/.test(warning)));
      });
    }

    await t.test('treats the H5 no-reposts response as an empty result without inventing a total', async () => {
      const result = await runJob('980003');
      assert.equal(result.candidates.length, 0);
      assert.equal(result.meta.totalNumber, 20);
      assert.equal(result.meta.complete, false);
      assert.ok(result.meta.providers.includes('mobile'));
      assert.ok(!result.meta.warnings.some((warning) => /H5抓取失败/.test(warning)));
    });

    await t.test('retains the original status total when desktop fails and H5 reports a smaller total', async () => {
      const result = await runJob('980005');
      assert.equal(result.meta.totalNumber, 20);
      assert.equal(result.meta.complete, false);
      assert.ok(result.meta.providers.includes('weibo-cn'));
    });

    await t.test('still stops on throttling after a successful page', async () => {
      const result = await runJob('980006', 'error');
      assert.match(result.error, /频繁/);
      const calls = await requests();
      assert.ok(!calls.some((item) => item.statusId === '980006' && item.host === 'weibo.cn'));
    });

    await t.test('does not hide an authentication failure behind partial pagination', async () => {
      const result = await runJob('980007');
      assert.equal(result.candidates.length, 0);
      assert.ok(!result.meta.providers.includes('mobile'));
      assert.ok(result.meta.warnings.some((warning) => /重新登录/.test(warning)));
    });

    await t.test('does not accept an HTTP failure as an empty H5 timeline', async () => {
      const result = await runJob('980008');
      assert.ok(!result.meta.providers.includes('mobile'));
      assert.equal(result.meta.complete, false);
    });

    await t.test('persists final complete and incomplete outcomes without candidates or credentials', async () => {
      await waitUntil(async () => {
        const events = JSON.parse(await readFile(path.join(outputDir, 'admin-events.json'), 'utf8'));
        return events.some((event) => event.action === 'load-result' && event.details?.statusId === '980008');
      }, 2000, '任务最终结果未写入后台事件').catch(async (error) => {
        const summary = await (await api('/api/admin/summary')).json();
        const system = summary.system || {};
        const diagnostic = {
          pending: system.runtime?.adminEventQueue,
          dropped: system.runtime?.adminEventDropped,
          failures: system.events?.filter((event) => event.action === 'event-write'),
        };
        throw new Error(`${error.message}：${JSON.stringify(diagnostic)}`, { cause: error });
      });
      const events = JSON.parse(await readFile(path.join(outputDir, 'admin-events.json'), 'utf8'));
      const complete = events.find((event) => event.action === 'load-result' && event.details?.statusId === '920001');
      const incomplete = events.find((event) => event.action === 'load-result' && event.details?.statusId === '980001');
      assert.equal(complete.status, 'ok');
      assert.equal(complete.details.complete, true);
      assert.equal(incomplete.status, 'warning');
      assert.equal(incomplete.details.complete, false);
      assert.equal(incomplete.details.visibleNumber, 1);
      assert.ok(Number.isFinite(incomplete.details.durationMs));
      assert.doesNotMatch(JSON.stringify([complete, incomplete]), /POOL_GOOD|XSRF|repostId|screen_name|screenName|readToken|cancelToken/);
    });

    await t.test('accepts a ten-percent difference without loading a backup provider', async () => {
      const result = await runJob('910006');
      assert.deepEqual(result.meta.providers, ['desktop-cookie']);
      assert.equal(result.meta.complete, false);
      assert.equal(result.meta.missingCount, 10);
      assert.equal(result.meta.visibleNumber, 90);
      assert.equal(result.meta.totalNumber, 100);
      const calls = await requests();
      assert.ok(!calls.some((item) => item.statusId === '910006' && item.pathname === '/api/statuses/repostTimeline'));
    });

    await t.test('loads a backup provider when the difference exceeds ten percent', async () => {
      const result = await runJob('910009');
      assert.deepEqual(result.meta.providers, ['desktop-cookie', 'mobile']);
      assert.equal(result.meta.complete, false);
      assert.equal(result.meta.stopReason, 'within-tolerance');
      assert.equal(result.meta.visibleNumber, 90);
      assert.equal(result.meta.totalNumber, 100);
      const calls = await requests();
      assert.ok(calls.some((item) => item.statusId === '910009' && item.pathname === '/api/statuses/repostTimeline'));
      assert.ok(!calls.some((item) => item.statusId === '910009' && item.host === 'weibo.cn'));
    });

    await t.test('finishes a declared desktop crawl when the optional head refresh fails', async () => {
      const result = await runJob('910007');
      assert.deepEqual(result.meta.providers, ['desktop-cookie']);
      assert.equal(result.meta.complete, false);
      assert.equal(result.meta.headReconciled, false);
      assert.ok(result.meta.warnings.some((warning) => warning.includes('最新转发复核失败')));
      const calls = await requests();
      assert.ok(!calls.some((item) => item.statusId === '910007' && item.pathname === '/api/statuses/repostTimeline'));
    });

    await t.test('does not report legacy success when bid or uid is unavailable', async () => {
      const result = await runJob('910005');
      assert.ok(result.meta.providers.includes('weibo-cn'));
      assert.equal(result.meta.complete, false);
      assert.ok(result.meta.warnings.some((warning) => warning.includes('缺少 bid')));
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

    await t.test('keeps the real repost id from the legacy attitude link', async () => {
      const result = await runJob('950002');
      assert.equal(result.candidates.length, 1);
      assert.equal(result.candidates[0].repostId, '987654322');
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
      assert.equal(result.candidates.length, 1, JSON.stringify(result.meta));
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
