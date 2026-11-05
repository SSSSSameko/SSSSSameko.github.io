import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stopChildProcess, waitForChildExit } from './child-process.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const unitTestDirectories = ['src', 'server', 'server-admin', 'scripts'];

export async function discoverUnitTests(root = projectRoot) {
  const files = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && /\.test\.(?:js|mjs)$/.test(entry.name)) files.push(target);
    }
  }

  for (const directory of unitTestDirectories) await visit(path.join(root, directory));
  return files.sort();
}

async function stopOwnedTests(child, signal) {
  if (process.platform !== 'win32') {
    return await stopChildProcess(child, { gracefulSignal: signal, processGroup: true });
  }
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

  // Windows signals terminate Node immediately; taskkill also stops its test workers.
  const treeStop = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    const exit = await waitForChildExit(treeStop);
    if (exit.code !== 0 && child.exitCode === null && child.signalCode === null) {
      throw new Error('Unable to stop the unit test process tree.');
    }
  } finally {
    await stopChildProcess(treeStop);
  }
}

export async function runUnitTests({
  root = projectRoot,
  args = process.argv.slice(2),
  stopTests = stopOwnedTests,
} = {}) {
  const files = await discoverUnitTests(root);
  if (!files.length) throw new Error('No unit tests found in the source directories.');

  const child = spawn(process.execPath, ['--test', ...args, ...files], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let rejectExit;
  const exited = new Promise((resolve, reject) => {
    rejectExit = reject;
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let requestedSignal = '';
  let stopFailure;
  let stopping;
  const stop = (signal) => {
    if (stopping) return;
    requestedSignal = signal;
    stopping = Promise.resolve().then(() => stopTests(child, signal)).catch((error) => {
      stopFailure = { error };
      process.exitCode = 1;
      rejectExit(error);
    });
  };
  const onInterrupt = () => stop('SIGINT');
  const onTerminate = () => stop('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    const exit = await exited;
    await stopping;
    if (stopFailure) throw stopFailure.error;
    process.exitCode = requestedSignal ? (requestedSignal === 'SIGINT' ? 130 : 143) : exit.code ?? 1;
  } catch (error) {
    process.exitCode = 1;
    try {
      await stopOwnedTests(child, 'SIGTERM');
    } catch (cleanupError) {
      console.error(cleanupError);
      // If the tree command is unavailable, still reclaim the owned runner.
      await stopChildProcess(child, { gracefulSignal: 'SIGKILL' }).catch((fallbackError) => {
        console.error(fallbackError);
      });
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runUnitTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
