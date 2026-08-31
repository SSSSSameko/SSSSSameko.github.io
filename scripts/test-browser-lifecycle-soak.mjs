import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

import {
  closePersistentBrowserContext,
  ensureBrowserRuntimeDirs,
  findProfileBrowserPids,
  preparePersistentProfile,
} from '../src/lib/weiboBrowserLifecycle.js';

const outputDir = await mkdtemp(path.join(tmpdir(), 'sameko-browser-soak-'));
const profileDir = path.join(outputDir, 'weibo-profile');
const runtime = await ensureBrowserRuntimeDirs(outputDir);
const samples = [];
const requestedRounds = Number(process.env.SAMEKO_BROWSER_SOAK_ROUNDS || 4);
const rounds = Number.isSafeInteger(requestedRounds) && requestedRounds >= 1 && requestedRounds <= 8
  ? requestedRounds
  : 4;
const browserSandbox = !/^(0|false|no)$/i.test(String(
  process.env.WEIBO_BROWSER_SANDBOX ?? '0',
).trim());

async function waitForNoBrowserProcesses() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const pids = await findProfileBrowserPids(profileDir);
    if (!pids.length) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(await findProfileBrowserPids(profileDir), []);
}

try {
  for (let round = 0; round < rounds; round += 1) {
    const prepared = await preparePersistentProfile(profileDir);
    let context;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        chromiumSandbox: browserSandbox,
        viewport: { width: 430, height: 760 },
        env: process.platform === 'linux'
          ? { ...process.env, HOME: runtime.runtimeHome, XDG_CACHE_HOME: runtime.runtimeCache }
          : process.env,
        args: [
          ...(!browserSandbox ? ['--no-sandbox'] : []),
          '--disable-dev-shm-usage',
          '--disable-gpu',
          `--disk-cache-dir=${runtime.chromiumCache}`,
          '--disk-cache-size=8388608',
          '--media-cache-size=4194304',
        ],
      });
      const page = context.pages()[0] || await context.newPage();
      await page.setContent('<!doctype html><title>lifecycle soak</title><p>ready</p>');
      await context.cookies();
    } finally {
      const cleanup = await closePersistentBrowserContext(context, profileDir, {
        ownerToken: prepared.ownerToken,
      });
      assert.equal(cleanup.ownerReleased, true);
    }

    await waitForNoBrowserProcesses();
    global.gc?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const memory = process.memoryUsage();
    samples.push({
      round: round + 1,
      rssMb: Number((memory.rss / 1024 / 1024).toFixed(1)),
      heapMb: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
    });
  }

  const warmed = samples[0];
  const final = samples.at(-1);
  if (samples.length > 1) {
    assert.ok(final.rssMb - warmed.rssMb < 64, `Chromium lifecycle RSS kept growing: ${JSON.stringify(samples)}`);
    assert.ok(final.heapMb - warmed.heapMb < 24, `Chromium lifecycle heap kept growing: ${JSON.stringify(samples)}`);
  }
  assert.deepEqual(await findProfileBrowserPids(profileDir), []);
  console.log(JSON.stringify({
    mode: samples.length > 1 ? 'soak' : 'smoke',
    samples,
    chromiumProcesses: 0,
  }));
  console.log('BROWSER_LIFECYCLE_SOAK_OK');
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
