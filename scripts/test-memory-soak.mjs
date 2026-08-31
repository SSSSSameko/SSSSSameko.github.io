import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { stopChildProcess } from './child-process.mjs';
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

const port = process.env.MEMORY_TEST_PORT
  ? Number(process.env.MEMORY_TEST_PORT)
  : await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const adminKey = 'local-memory-test-key';
const REQUEST_TIMEOUT_MS = 5000;
const output = [];
const runtimeDir = await mkdtemp(path.join(tmpdir(), 'sameko-memory-test-'));

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: serverTestEnv(runtimeDir, {
    PORT: String(port),
    HOST: '127.0.0.1',
    ADMIN_KEY: adminKey,
    DISABLE_COOKIE_STORE: '1',
    WEIBO_KEEPALIVE_ENABLED: '0',
    RATE_LIMIT_WINDOW_MS: '600000',
    RATE_LIMIT_MAX_BUCKETS: '120',
    NODE_ENV: 'test',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stdout.on('data', (chunk) => output.push(chunk.toString()));
server.stderr.on('data', (chunk) => output.push(chunk.toString()));

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`内存测试服务启动超时\n${output.join('')}`);
}

async function summary() {
  const response = await fetch(`${baseUrl}/api/admin/summary`, {
    headers: { 'x-api-key': adminKey },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert.equal(response.status, 200);
  return (await response.json()).system;
}

async function requestBatch(round, count = 1000) {
  const concurrency = 50;
  for (let start = 0; start < count; start += concurrency) {
    await Promise.all(Array.from({ length: Math.min(concurrency, count - start) }, async (_, index) => {
      const id = round * count + start + index + 1;
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { 'x-forwarded-for': `198.51.${Math.floor(id / 250) % 255}.${id % 250 + 1}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      assert.equal(response.status, 200);
    }));
  }
}

try {
  await waitForServer();
  await summary();
  await requestBatch(0, 500);
  const baseline = await summary();
  const samples = [];

  for (let round = 1; round <= 6; round += 1) {
    await requestBatch(round);
    await new Promise((resolve) => setTimeout(resolve, 150));
    samples.push(await summary());
  }

  const final = samples.at(-1);
  assert.ok(samples.every((sample) => sample.runtime.rateLimitBuckets <= 120));
  assert.ok(final.runtime.rateLimitEvictions > 0);
  assert.equal(final.browser.processCount, 0);
  assert.ok(final.memory.heapUsedMb <= baseline.memory.heapUsedMb + 48);
  assert.ok(final.memory.rssMb <= baseline.memory.rssMb + 96);

  console.log(JSON.stringify({
    baselineRssMb: baseline.memory.rssMb,
    finalRssMb: final.memory.rssMb,
    baselineHeapMb: baseline.memory.heapUsedMb,
    finalHeapMb: final.memory.heapUsedMb,
    rateLimitBuckets: final.runtime.rateLimitBuckets,
    rateLimitEvictions: final.runtime.rateLimitEvictions,
    chromiumProcesses: final.browser.processCount,
  }));
} finally {
  try {
    await stopChildProcess(server);
  } finally {
    await rm(runtimeDir, { force: true, recursive: true });
  }
}

console.log('MEMORY_SOAK_OK');
