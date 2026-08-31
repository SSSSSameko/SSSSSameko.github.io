import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stopChildProcess } from './child-process.mjs';
import { serverTestEnv } from './server-test-env.mjs';

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const selected = listener.address().port;
      listener.close((error) => error ? reject(error) : resolve(selected));
    });
  });
}

async function waitForHealth(url, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`测试服务提前退出\n${output.join('')}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`测试服务启动超时\n${output.join('')}`);
}

async function seedDraws(drawsDir, count) {
  await mkdir(drawsDir, { recursive: true });
  await Promise.all(Array.from({ length: count }, (_, index) => {
    const suffix = String(index).padStart(4, '0');
    const file = path.join(drawsDir, `draw-202608270${suffix}-recovery.json`);
    return writeFile(file, JSON.stringify({
      source: 'manual',
      savedAt: '2026-08-27T00:00:00.000Z',
      winners: [{ uid: `user-${index}`, screenName: `用户${index}` }],
    }), 'utf8');
  }));
}

async function runScenario({ recoveryScanLimit, expectedFiles }) {
  const port = await availablePort();
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'sameko-draw-retention-'));
  const drawsDir = path.join(outputDir, 'draws');
  const output = [];
  let child;

  try {
    await seedDraws(drawsDir, 130);
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: root,
      env: serverTestEnv(outputDir, {
        HOST: '127.0.0.1',
        PORT: String(port),
        NODE_ENV: 'production',
        WEIBO_KEEPALIVE_ENABLED: '0',
        MAX_SAVED_DRAWS: '20',
        DRAW_FILE_SCAN_MAX_ENTRIES: '100',
        DRAW_RECOVERY_SCAN_MAX_ENTRIES: String(recoveryScanLimit),
        DRAW_CLEANUP_BATCH_SIZE: '256',
        MAX_SAVED_DRAW_BYTES: String(100 * 1024 * 1024),
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));

    await waitForHealth(`http://127.0.0.1:${port}/api/health`, child, output);
    const remaining = (await readdir(drawsDir)).filter((name) => /^draw-.*\.json$/.test(name));
    assert.equal(
      remaining.length,
      expectedFiles,
      `恢复扫描上限 ${recoveryScanLimit} 时剩余 ${remaining.length} 条\n${output.join('')}`,
    );
  } finally {
    await stopChildProcess(child).catch((error) => {
      output.push(`${error.message}\n`);
    });
    await rm(outputDir, { recursive: true, force: true });
  }
}

const root = fileURLToPath(new URL('..', import.meta.url));

await runScenario({ recoveryScanLimit: 200, expectedFiles: 20 });
await runScenario({ recoveryScanLimit: 100, expectedFiles: 130 });
console.log('DRAW_RETENTION_RECOVERY_OK');
