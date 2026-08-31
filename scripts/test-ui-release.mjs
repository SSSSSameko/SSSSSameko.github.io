import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stopChildProcess } from './child-process.mjs';
import { serverTestEnv } from './server-test-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = [
  'test-ui-console.mjs',
  'test-candidate-load-ui.mjs',
  'test-candidate-tools-ui.mjs',
  'test-main-flow-guards-ui.mjs',
  'test-draw-receipt-ui.mjs',
  'test-draw-animation-ui.mjs',
  'test-draw-practice-ui.mjs',
  'test-sheet-motion-ui.mjs',
  'test-feedback-ui.mjs',
  'test-admin-ui.mjs',
];
const SCRIPT_TIMEOUT_MS = 120_000;

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`UI 测试服务提前退出：${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) return;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('UI 测试服务启动超时');
}

async function verifyProcessGroupCleanup() {
  if (process.platform === 'win32') return;
  const descendantSource = `
process.on('SIGTERM', () => {});
process.stdout.write(String(process.pid) + '\\n');
setInterval(() => {}, 1000);
`;
  const parentSource = `
const { spawn } = require('node:child_process');
const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
descendant.stdout.once('data', (chunk) => {
  process.stdout.write(chunk);
  process.exit(1);
});
`;
  const child = spawn(process.execPath, ['-e', parentSource], {
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: true,
  });
  let output = '';
  try {
    const descendantPid = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('进程组清理测试启动超时')), 5000);
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        const value = Number.parseInt(output, 10);
        if (!Number.isInteger(value)) return;
        clearTimeout(timer);
        resolve(value);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`进程组清理测试提前退出（${signal || code}）`));
      });
    });
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await stopChildProcess(child, {
      processGroup: true,
      gracefulTimeoutMs: 150,
      killTimeoutMs: 5000,
    });
    assert.throws(
      () => process.kill(descendantPid, 0),
      (error) => error?.code === 'ESRCH',
      '父进程退出后仍残留后代进程',
    );
  } finally {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

async function runScript(file, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', file)], {
      cwd: root,
      env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    let settled = false;
    let timedOut = false;
    let cleanupPromise = null;
    const cleanup = () => {
      cleanupPromise ||= stopChildProcess(child, { processGroup: process.platform !== 'win32' });
      return cleanupPromise;
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      cleanup()
        .then(() => finish(new Error(`${file} 超过 ${SCRIPT_TIMEOUT_MS / 1000} 秒，已停止`)))
        .catch(finish);
    }, SCRIPT_TIMEOUT_MS);
    child.once('error', finish);
    child.once('exit', (code, signal) => {
      if (timedOut) return;
      if (code === 0) finish();
      else {
        cleanup()
          .then(() => finish(new Error(`${file} 失败（${signal || code}）`)))
          .catch(finish);
      }
    });
  });
}

const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const runtimeDir = await mkdtemp(path.join(tmpdir(), 'sameko-ui-test-'));
const env = serverTestEnv(runtimeDir, {
  HOST: '127.0.0.1',
  PORT: String(port),
  WEIBO_KEEPALIVE_ENABLED: '0',
  DRAW_UI_URL: `${baseUrl}/`,
  UI_CONSOLE_URL: `${baseUrl}/`,
  FEEDBACK_UI_URL: `${baseUrl}/`,
  ADMIN_UI_URL: `${baseUrl}/admin`,
});
const server = spawn(process.execPath, [path.join(root, 'server.mjs')], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  await verifyProcessGroupCleanup();
  await waitForServer(baseUrl, server);
  for (const file of scripts) await runScript(file, env);
} finally {
  try {
    await stopChildProcess(server);
  } finally {
    await rm(runtimeDir, { force: true, recursive: true });
  }
}
