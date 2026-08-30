import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const port = await availablePort();
const root = fileURLToPath(new URL('..', import.meta.url));
const outputDir = path.join(root, `output/test-retention-${port}`);
const drawsDir = path.join(outputDir, 'draws');
const output = [];
await rm(outputDir, { recursive: true, force: true });
await mkdir(drawsDir, { recursive: true });

for (let index = 0; index < 130; index += 1) {
  const file = path.join(drawsDir, `draw-202608270${String(index).padStart(3, '0')}-recovery.json`);
  await writeFile(file, JSON.stringify({
    source: 'manual',
    savedAt: '2026-08-27T00:00:00.000Z',
    winners: [{ uid: `user-${index}`, screenName: `用户${index}` }],
  }), 'utf8');
}

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: serverTestEnv(outputDir, {
    HOST: '127.0.0.1',
    PORT: String(port),
    NODE_ENV: 'production',
    WEIBO_KEEPALIVE_ENABLED: '0',
    MAX_SAVED_DRAWS: '20',
    DRAW_FILE_SCAN_MAX_ENTRIES: '100',
    DRAW_CLEANUP_BATCH_SIZE: '256',
    MAX_SAVED_DRAW_BYTES: String(100 * 1024 * 1024),
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => output.push(chunk.toString()));
child.stderr.on('data', (chunk) => output.push(chunk.toString()));

try {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(child.exitCode, null, `测试服务提前退出\n${output.join('')}`);
  const remaining = (await readdir(drawsDir)).filter((name) => /^draw-.*\.json$/.test(name));
  assert.ok(remaining.length <= 20, `回收后仍有 ${remaining.length} 条记录\n${output.join('')}`);
  assert.ok(remaining.length > 0);
  console.log('DRAW_RETENTION_RECOVERY_OK');
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await rm(outputDir, { recursive: true, force: true });
}
