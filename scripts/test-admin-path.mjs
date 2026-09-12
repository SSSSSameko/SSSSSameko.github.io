import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stopChildProcess } from './child-process.mjs';
import { serverTestEnv } from './server-test-env.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const testOutputDir = await mkdtemp(path.join(os.tmpdir(), 'sameko-admin-path-'));
const customPath = '/ops-9d2c';

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

function spawnServer({ port, extraEnv }) {
  return spawn(process.execPath, ['server.mjs'], {
    cwd: rootDir,
    env: serverTestEnv(testOutputDir, {
      PORT: String(port),
      HOST: '127.0.0.1',
      WEIBO_KEEPALIVE_ENABLED: '0',
      ENABLE_COOKIE_READ_API: '',
      COOKIE_READ_KEY: '',
      ...extraEnv,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function startServer(extraEnv) {
  const port = await availablePort();
  const output = [];
  const child = spawnServer({ port, extraEnv });
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
  await stopChildProcess(child).catch(() => {});
  throw new Error(`测试服务启动超时\n${output.join('')}`);
}

let running = null;

try {
  running = await startServer({ ADMIN_BASE_PATH: customPath });

  const admin = await fetch(`${running.baseUrl}${customPath}`);
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /id="loginPanel"/);
  assert.equal(admin.headers.get('x-robots-tag'), 'noindex, nofollow');

  for (const asset of ['admin.js', 'admin.css', 'api-response.js', 'admin-status.js']) {
    const response = await fetch(`${running.baseUrl}${customPath}/${asset}`);
    assert.equal(response.status, 200, `自定义后台路径应能加载 ${asset}`);
  }

  const defaultAdmin = await fetch(`${running.baseUrl}/admin`);
  assert.doesNotMatch(
    await defaultAdmin.text(),
    /id="loginPanel"/,
    '改过后台路径后，默认 /admin 不应再返回后台页面',
  );
  const defaultAdminAsset = await fetch(`${running.baseUrl}/admin/admin.js`);
  assert.equal(defaultAdminAsset.status, 404, '默认后台路径下的资源脚本必须不可访问');

  await stopChildProcess(running.child);
  running = null;

  const failingPort = await availablePort();
  const failingOutput = [];
  const failingChild = spawnServer({
    port: failingPort,
    extraEnv: { ADMIN_BASE_PATH: '/api/backdoor' },
  });
  failingChild.stdout.on('data', (chunk) => failingOutput.push(chunk.toString()));
  failingChild.stderr.on('data', (chunk) => failingOutput.push(chunk.toString()));
  try {
    const exit = await Promise.race([
      new Promise((resolve) => failingChild.once('exit', (code, signal) => resolve({ code, signal }))),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('非法 ADMIN_BASE_PATH 启动测试超时')),
        15_000,
      )),
    ]);
    assert.equal(exit.code, 1, failingOutput.join(''));
    assert.match(failingOutput.join(''), /ADMIN_BASE_PATH must be a path/);
  } finally {
    await stopChildProcess(failingChild).catch(() => {});
  }
} finally {
  if (running?.child) await stopChildProcess(running.child).catch(() => {});
  await rm(testOutputDir, { recursive: true, force: true });
}

console.log('ADMIN_PATH_OK');
