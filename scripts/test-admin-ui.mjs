import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const baseUrl = process.env.ADMIN_UI_URL || 'http://127.0.0.1:4173/admin';
const executablePath = process.env.PLAYWRIGHT_CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const outputDir = new URL('../output/ui-checks/', import.meta.url);

const draws = Array.from({ length: 18 }, (_, index) => {
  const number = index + 1;
  const winner = { uid: `1000${number}`, screenName: `中奖用户 ${number}`, text: `测试转发 ${number}` };
  return {
    file: `draw-preview-${number}.json`,
    source: '微博转发',
    statusId: `P${number}`,
    statusUrl: `https://weibo.com/123/P${number}`,
    drawnAt: new Date(Date.now() - index * 3_600_000).toISOString(),
    savedAt: new Date().toISOString(),
    winnerCount: 1,
    winners: [winner],
    totalCount: 128 + index,
    eligibleCount: 120 + index,
    auditHash: `${number}`.padStart(64, '0'),
    results: [{ prize: { name: '一等奖', count: 1 }, winners: [winner] }],
  };
});

draws[0].statusUrl = 'javascript:alert(1)';
draws[0].winners[0].screenName = '<img src=x onerror="window.__adminXss=1">';

const samples = Array.from({ length: 24 }, (_, index) => ({
  cgroupCurrentMb: 210 + index * 4,
  cgroupAnonMb: 120 + index * 2,
}));

const summary = {
  ok: true,
  adminEnabled: true,
  savedDrawCount: 18,
  winnerCount: 18,
  recentAttempts: [],
  cookie: { accountCount: 1, cookieCount: 1, hasCookie: true },
  queue: { active: 1, queued: 0, maxActive: 2, maxQueued: 8, sameStatusLocks: 0 },
  weiboLogin: { status: 'idle', history: [] },
  system: {
    now: new Date().toISOString(),
    startedAt: new Date(Date.now() - 86_400_000).toISOString(),
    uptimeText: '1 天',
    nodeVersion: 'v24.0.0',
    platform: 'win32/x64',
    pid: 1234,
    hostname: 'preview',
    cpus: 2,
    loadAverage: [0.12, 0.2, 0.18],
    memory: {
      rssMb: 92,
      heapUsedMb: 42,
      heapTotalMb: 84,
      hostTotalMb: 2048,
      hostAvailableMb: 1320,
      hostUsedMb: 728,
      hostUsedPercent: 35.5,
      hostCachedMb: 340,
      hostSlabMb: 86,
      hostSlabReclaimableMb: 52,
      hostSlabUnreclaimableMb: 34,
      cgroupAvailable: true,
      cgroupCurrentMb: 300,
      cgroupPeakMb: 420,
      cgroupAnonMb: 166,
      cgroupReclaimableMb: 72,
      trend: { status: 'stable', perHourMb: 1.5 },
      samples,
    },
    browser: { processCount: 0 },
    runtime: {
      eventLoopP99Ms: 18,
      eventLoopMeanMs: 7,
      rateLimitBuckets: 3,
      adminLoginBuckets: 1,
      requests: { total: 240, clientErrors: 2, serverErrors: 1, slowestMs: 86 },
    },
    service: {
      memoryHighMb: 700,
      memoryMaxMb: 850,
      nextRecycleAt: new Date(Date.now() + 43_200_000).toISOString(),
      recycleIntervalText: '12 小时',
    },
    disk: { available: true, usedPercent: 38, usedMb: 3800, availableMb: 6200 },
    config: {},
    events: [],
    storage: [],
  },
};

const feedback = [
  {
    id: 'feedback-1',
    category: 'problem',
    content: '<img src=x onerror="window.__feedbackXss=1">\n点击载入后没有反应。',
    createdAt: new Date().toISOString(),
    source: 'a1b2c3d4e5',
  },
  {
    id: 'feedback-2',
    category: 'suggestion',
    content: '希望增加开奖前的名单确认。',
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    source: 'f6e7d8c9b0',
  },
];

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
try {
  {
    let authenticated = false;
    const loginContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const loginPage = await loginContext.newPage();
    await loginPage.route('**/api/admin/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/admin/session') {
        await route.fulfill(authenticated
          ? { json: { username: 'preview', csrfToken: 'preview', expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }
          : { status: 401, json: { ok: false, error: '登录已失效' } });
        return;
      }
      if (url.pathname === '/api/admin/login') {
        const body = route.request().postDataJSON();
        assert.deepEqual(body, { username: 'preview', password: 'release-test-password' });
        authenticated = true;
        await route.fulfill({ json: { ok: true, username: 'preview', csrfToken: 'preview', expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
        return;
      }
      if (url.pathname === '/api/admin/summary') {
        await route.fulfill({ json: summary });
        return;
      }
      if (url.pathname === '/api/admin/draws') {
        await route.fulfill({ json: { ok: true, items: draws } });
        return;
      }
      if (url.pathname === '/api/admin/feedback') {
        await route.fulfill({ json: { ok: true, items: feedback } });
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });
    await loginPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await loginPage.locator('#loginPanel:not(.hidden)').waitFor();
    assert.equal(await loginPage.locator('#topbarActions').isVisible(), false);
    await loginPage.screenshot({ path: fileURLToPath(new URL('admin-login-mobile.png', outputDir)) });
    await loginPage.getByLabel('账号').fill('preview');
    await loginPage.locator('#passwordInput').fill('release-test-password');
    await loginPage.getByRole('button', { name: '进入后台' }).click();
    await loginPage.locator('#dashboard:not(.hidden)').waitFor();
    assert.equal(await loginPage.locator('#topbarActions').isVisible(), true);
    assert.equal(await loginPage.locator('#passwordInput').inputValue(), '');
    await loginContext.close();
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.route('**/api/admin/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/admin/session') {
      await route.fulfill({ json: { username: 'preview', csrfToken: 'preview', expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
      return;
    }
    if (url.pathname === '/api/admin/summary') {
      await route.fulfill({ json: summary });
      return;
    }
    if (url.pathname === '/api/admin/draws') {
      await route.fulfill({ json: { ok: true, items: draws } });
      return;
    }
    if (url.pathname === '/api/admin/feedback') {
      await route.fulfill({ json: { ok: true, items: feedback } });
      return;
    }
    const file = decodeURIComponent(url.pathname.replace('/api/admin/draws/', ''));
    await route.fulfill({ json: { ok: true, item: draws.find((item) => item.file === file) } });
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#dashboard:not(.hidden)').waitFor();
  await page.waitForTimeout(360);
  assert.equal(await page.locator('.metric-value').first().innerText(), '35.3%');
  assert.equal(await page.locator('.chart-scale').isVisible(), true);
  await page.screenshot({ path: fileURLToPath(new URL('admin-overview-desktop.png', outputDir)) });

  await page.getByRole('button', { name: '反馈', exact: true }).click();
  await page.waitForTimeout(320);
  assert.equal(await page.locator('.feedback-row').count(), feedback.length);
  assert.equal(await page.locator('.feedback-row img').count(), 0);
  assert.equal(await page.evaluate(() => window.__feedbackXss), undefined);
  await page.getByRole('button', { name: '建议', exact: true }).click();
  assert.equal(await page.locator('.feedback-row').count(), 1);
  assert.equal(await page.getByText('希望增加开奖前的名单确认。', { exact: true }).isVisible(), true);
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.screenshot({ path: fileURLToPath(new URL('admin-feedback-desktop.png', outputDir)) });

  await page.getByRole('button', { name: '系统', exact: true }).click();
  assert.equal(await page.locator('#systemPanel').getByText('35.3%', { exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Cookie', exact: true }).click();
  assert.equal(await page.getByRole('heading', { name: 'Cookie 与保活' }).isVisible(), true);
  await page.getByRole('button', { name: '记录', exact: true }).click();
  await page.waitForTimeout(320);
  assert.equal(await page.locator('.record-row').count(), draws.length);
  await page.locator('.record-list-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const before = await page.evaluate(() => ({ pageY: window.scrollY, detailTop: document.querySelector('#detailPanel').getBoundingClientRect().top }));
  await page.locator('.record-row').last().click();
  await page.locator('#detailContent').getByText('中奖用户 18', { exact: true }).waitFor();
  const after = await page.evaluate(() => ({
    pageY: window.scrollY,
    detailTop: document.querySelector('#detailPanel').getBoundingClientRect().top,
    listScroll: document.querySelector('.record-list-scroll').scrollTop,
  }));
  assert.ok(after.listScroll > 0);
  assert.ok(Math.abs(after.pageY - before.pageY) < 3);
  assert.ok(Math.abs(after.detailTop - before.detailTop) < 3);
  await page.screenshot({ path: fileURLToPath(new URL('admin-records-desktop.png', outputDir)) });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '关闭开奖记录详情' }).click();
  await page.locator('.record-row').first().click();
  await page.locator('#detailPanel.has-selection').waitFor({ state: 'visible' });
  assert.equal(await page.locator('body.record-detail-open').count(), 1);
  assert.equal(await page.locator('#detailContent img').count(), 0);
  assert.equal(await page.locator('#detailContent a[href^="javascript:"]').count(), 0);
  assert.equal(await page.evaluate(() => window.__adminXss), undefined);
  await page.waitForTimeout(450);
  await page.screenshot({ path: fileURLToPath(new URL('admin-records-mobile-detail.png', outputDir)) });
  await page.getByRole('button', { name: '关闭开奖记录详情' }).click();
  assert.equal(await page.locator('#detailPanel.has-selection').count(), 0);
  await page.waitForTimeout(450);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.file), draws[0].file);
  await page.getByRole('button', { name: '反馈', exact: true }).click();
  await page.waitForTimeout(320);
  assert.equal(await page.locator('.feedback-row').count(), feedback.length);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: fileURLToPath(new URL('admin-feedback-mobile.png', outputDir)) });
  await page.getByRole('button', { name: '记录', exact: true }).click();
  await page.screenshot({ path: fileURLToPath(new URL('admin-records-mobile.png', outputDir)) });
  await context.close();
} finally {
  await browser.close();
}

console.log('ADMIN_UI_OK');
