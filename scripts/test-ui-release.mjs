import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('UI 测试服务启动超时');
}

async function runScript(file, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', file)], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${file} 失败（${signal || code}）`));
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
  await waitForServer(baseUrl, server);
  for (const file of scripts) await runScript(file, env);
} finally {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (server.exitCode === null) server.kill('SIGKILL');
        resolve();
      }, 5000);
      server.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await rm(runtimeDir, { force: true, recursive: true });
}
