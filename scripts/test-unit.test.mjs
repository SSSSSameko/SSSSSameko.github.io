import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverUnitTests } from './test-unit.mjs';
import { stopChildProcess, waitForChildExit } from './child-process.mjs';

test('discovers colocated unit tests without running integration scripts or runtime data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sameko-unit-discovery-'));
  const expected = [
    'src/hooks/example.test.js',
    'server/weibo/example.test.mjs',
    'server-admin/example.test.js',
    'scripts/process.test.mjs',
  ];
  const excluded = ['scripts/test-server-http.mjs', 'src/App.jsx', 'output/private.test.js'];
  try {
    for (const file of [...expected, ...excluded]) {
      const target = path.join(root, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, '', 'utf8');
    }
    assert.deepEqual(await discoverUnitTests(root), expected.map((file) => path.join(root, file)).sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('allows optional source directories to be absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sameko-unit-empty-'));
  try {
    assert.deepEqual(await discoverUnitTests(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function verifyWrapperStop({ stopTests, expectedCode, expectedError, signal = 'SIGTERM' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sameko-unit-stop-'));
  const marker = path.join(root, 'worker.pid');
  const stopMarker = path.join(root, 'stop');
  const finishMarker = path.join(root, 'finish');
  const output = [];
  let wrapper;
  let workerPid;
  try {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'hang.test.mjs'), `
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, String(process.pid));
const running = setInterval(() => {
  if (existsSync(${JSON.stringify(finishMarker)})) clearInterval(running);
}, 20);
`, 'utf8');
    await writeFile(path.join(root, 'wrapper.mjs'), `
import { existsSync, writeFileSync } from 'node:fs';
import { runUnitTests } from ${JSON.stringify(new URL('./test-unit.mjs', import.meta.url).href)};
import { waitForChildExit } from ${JSON.stringify(new URL('./child-process.mjs', import.meta.url).href)};
const finishMarker = ${JSON.stringify(finishMarker)};
const stopWatch = setInterval(() => {
  if (existsSync(${JSON.stringify(stopMarker)})) {
    clearInterval(stopWatch);
    process.emit(${JSON.stringify(signal)});
  }
}, 20);
try {
  await runUnitTests({
    root: ${JSON.stringify(root)},
    args: [],
    ${stopTests ? `stopTests: ${stopTests},` : ''}
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearInterval(stopWatch);
}
`, 'utf8');
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    wrapper = spawn(process.execPath, [path.join(root, 'wrapper.mjs')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    wrapper.stdout.on('data', (chunk) => output.push(chunk.toString()));
    wrapper.stderr.on('data', (chunk) => output.push(chunk.toString()));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (wrapper.exitCode !== null) throw new Error(`Test wrapper exited early: ${output.join('')}`);
      if (await access(marker).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    workerPid = Number(await readFile(marker, 'utf8'));
    const exited = waitForChildExit(wrapper, { timeoutMs: 10_000 });
    await writeFile(stopMarker, 'stop', 'utf8');
    assert.equal((await exited).code, expectedCode, output.join(''));
    if (expectedError) assert.match(output.join(''), expectedError);
    assert.throws(() => process.kill(workerPid, 0), (error) => error.code === 'ESRCH');
  } finally {
    if (workerPid) {
      try {
        process.kill(workerPid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    await stopChildProcess(wrapper);
    await rm(root, { recursive: true, force: true });
  }
}

test('stopping the test wrapper also stops its running test workers', async () => {
  await verifyWrapperStop({ expectedCode: 143 });
});

test('interrupting the test wrapper stops its workers and preserves exit code 130', async () => {
  await verifyWrapperStop({ expectedCode: 130, signal: 'SIGINT' });
});

test('a failed stop rejects the wrapper and reclaims its running test workers', async () => {
  await verifyWrapperStop({
    stopTests: "async () => { throw new Error('injected tree stop failure'); }",
    expectedCode: 1,
    expectedError: /injected tree stop failure/,
  });
});

test('a stop failure reported after the child exits cannot be overwritten by the signal exit code', async () => {
  await verifyWrapperStop({
    stopTests: `async (child) => {
      writeFileSync(finishMarker, 'finish');
      await waitForChildExit(child);
      throw new Error('injected failure after child exit');
    }`,
    expectedCode: 1,
    expectedError: /injected failure after child exit/,
  });
});
