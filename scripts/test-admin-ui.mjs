import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.ADMIN_UI_URL || 'http://127.0.0.1:4173/admin';
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
  queue: {
    active: 1,
    queued: 0,
    maxActive: 2,
    maxQueued: 8,
    retained: 3,
    maxRetained: 24,
    subscribers: 5,
    maxSubscribersPerTask: 12,
    sameStatusLocks: 0,
    sharedTasks: 1,
    recentSnapshots: 1,
    snapshotTtlMs: 15_000,
    maxSnapshots: 2,
    deliveries: { fresh: 8, sharedRunning: 3, recentSnapshot: 2 },
  },
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
    browser: {
      processCount: 0,
      profileCacheCleanup: {
        lastRunAt: new Date(Date.now() - 7_200_000).toISOString(),
        removedCount: 4,
      },
    },
    runtime: {
      eventLoopP99Ms: 18,
      eventLoopMeanMs: 7,
      rateLimitBuckets: 3,
      adminLoginBuckets: 1,
      revokedAdminSessions: 2,
      requests: { total: 240, clientErrors: 2, serverErrors: 1, slowestMs: 86 },
    },
    service: {
      memoryHighMb: 700,
      memoryMaxMb: 850,
      nextRecycleAt: new Date(Date.now() + 43_200_000).toISOString(),
      recycleIntervalText: '12 小时',
    },
    disk: { available: true, usedPercent: 38, usedMb: 3800, availableMb: 6200 },
    config: {
      browserDiskCacheBytes: 64 * 1024 * 1024,
      browserMediaCacheBytes: 16 * 1024 * 1024,
    },
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
const browser = await launchUiBrowser();
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

  {
    const logoutContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const logoutPage = await logoutContext.newPage();
    let summaryRequests = 0;
    let releaseLoginStart;
    const loginStartGate = new Promise((resolve) => {
      releaseLoginStart = resolve;
    });

    await logoutPage.route('**/api/admin/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/admin/session') {
        await route.fulfill({ json: { username: 'preview', csrfToken: 'preview', expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
        return;
      }
      if (url.pathname === '/api/admin/summary') {
        summaryRequests += 1;
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
      if (url.pathname === '/api/admin/weibo-login/start') {
        await loginStartGate;
        await route.fulfill({ json: { ok: true, status: 'waiting_scan', active: true } }).catch(() => {});
        return;
      }
      await route.fulfill({ json: { ok: true } });
    });

    await gotoUiPage(logoutPage, baseUrl);
    await logoutPage.locator('#dashboard:not(.hidden)').waitFor();
    await logoutPage.locator('.metric-value').first().getByText('35.3%', { exact: true }).waitFor();
    const summaryBaseline = summaryRequests;
    await logoutPage.getByRole('tab', { name: 'Cookie', exact: true }).click();
    const loginRequest = logoutPage.waitForRequest((request) => (
      new URL(request.url()).pathname === '/api/admin/weibo-login/start'
    ));
    await logoutPage.getByRole('button', { name: '扫码登录微博' }).click();
    await loginRequest;
    await logoutPage.locator('#logoutBtn').click();
    await logoutPage.locator('#loginPanel:not(.hidden)').waitFor();
    await logoutPage.locator('#toast.show').getByText('已退出后台', { exact: true }).waitFor();
    await logoutPage.waitForTimeout(250);
    assert.equal(summaryRequests, summaryBaseline);
    assert.equal(await logoutPage.locator('#adminAlert').isVisible(), false);
    releaseLoginStart();
    await logoutPage.waitForTimeout(80);
    assert.equal(summaryRequests, summaryBaseline);
    assert.equal(await logoutPage.locator('#toast').innerText(), '已退出后台');
    await logoutContext.close();
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  let activeDetailRequests = 0;
  let maxDetailRequests = 0;
  let activeLoginPolls = 0;
  let maxLoginPolls = 0;
  let weiboLoginActive = false;
  let failingDetailFile = '';
  let detailDelayMs = 20;
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
    if (url.pathname.startsWith('/api/admin/feedback/')) {
      const id = decodeURIComponent(url.pathname.replace('/api/admin/feedback/', ''));
      const item = feedback.find((entry) => entry.id === id);
      if (route.request().method() === 'PATCH' && item) {
        const body = route.request().postDataJSON();
        item.status = body.handled ? 'handled' : 'open';
        item.handledAt = body.handled ? new Date().toISOString() : '';
      }
      await route.fulfill({ json: { ok: true, item } });
      return;
    }
    if (url.pathname === '/api/admin/weibo-login/start') {
      weiboLoginActive = true;
      await route.fulfill({ json: { ok: true, status: 'waiting_scan', active: true, message: '等待扫码' } });
      return;
    }
    if (url.pathname === '/api/admin/weibo-login/status') {
      activeLoginPolls += 1;
      maxLoginPolls = Math.max(maxLoginPolls, activeLoginPolls);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      activeLoginPolls -= 1;
      await route.fulfill({ json: { ok: true, status: weiboLoginActive ? 'waiting_scan' : 'idle', active: weiboLoginActive } });
      return;
    }
    if (url.pathname === '/api/admin/weibo-login/stop') {
      weiboLoginActive = false;
      await route.fulfill({ json: { ok: true, status: 'idle', active: false, message: '扫码窗口已关闭' } });
      return;
    }
    const file = decodeURIComponent(url.pathname.replace('/api/admin/draws/', ''));
    activeDetailRequests += 1;
    maxDetailRequests = Math.max(maxDetailRequests, activeDetailRequests);
    await new Promise((resolve) => setTimeout(resolve, detailDelayMs));
    activeDetailRequests -= 1;
    if (file === failingDetailFile) {
      await route.fulfill({ status: 503, json: { ok: false, error: '记录服务暂时不可用' } });
      return;
    }
    await route.fulfill({ json: { ok: true, item: draws.find((item) => item.file === file) } });
  });

  await gotoUiPage(page, baseUrl);
  await page.locator('#dashboard:not(.hidden)').waitFor();
  await page.waitForTimeout(360);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', {
    media: '',
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
  });
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await page.locator('#toast.show').waitFor();
  const toastStyle = await page.locator('#toast').evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  });
  assert.equal(toastStyle.color, 'rgb(255, 255, 255)');
  assert.notEqual(toastStyle.background, 'rgb(255, 255, 255)');
  await cdp.send('Emulation.setEmulatedMedia', { media: '', features: [] });
  assert.equal(await page.locator('.metric-value').first().innerText(), '35.3%');
  assert.equal(await page.locator('.chart-scale').isVisible(), true);
  assert.equal(await page.locator('#requestPanel').getByText('1 个共享任务', { exact: true }).isVisible(), true);
  assert.equal(await page.locator('#requestPanel').getByText(/1 \/ 2 个快照 · 时效 15 秒 · 累计合并 3 次/).isVisible(), true);
  assert.equal(await page.locator('#requestPanel').getByText(/1 运行 · 0 排队 · 3 暂存/).isVisible(), true);
  assert.equal(await page.locator('#requestPanel').getByText('5 个页面', { exact: true }).isVisible(), true);
  await page.screenshot({ path: fileURLToPath(new URL('admin-overview-desktop.png', outputDir)) });

  const overviewTab = page.getByRole('tab', { name: '总览', exact: true });
  await overviewTab.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: '记录', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#view-overview').getAttribute('hidden'), '');
  await page.keyboard.press('Home');
  assert.equal(await overviewTab.getAttribute('aria-selected'), 'true');

  await page.getByRole('tab', { name: '反馈', exact: true }).click();
  await page.waitForTimeout(320);
  assert.equal(await page.locator('.feedback-row').count(), feedback.length);
  assert.equal(await page.locator('.feedback-row img').count(), 0);
  assert.equal(await page.evaluate(() => window.__feedbackXss), undefined);
  await page.getByRole('button', { name: '建议', exact: true }).click();
  assert.equal(await page.locator('.feedback-row').count(), 1);
  assert.equal(await page.getByText('希望增加开奖前的名单确认。', { exact: true }).isVisible(), true);
  await page.getByRole('button', { name: '全部', exact: true }).click();
  const feedbackToggle = page.locator('[data-feedback-action="toggle"][data-feedback-id="feedback-1"]');
  await feedbackToggle.click();
  await page.waitForFunction(() => (
    document.activeElement?.dataset.feedbackId === 'feedback-1'
    && document.activeElement?.dataset.feedbackAction === 'toggle'
  ));
  assert.match(await page.locator('.feedback-row').filter({ hasText: '点击载入后没有反应。' }).innerText(), /已处理/);
  await page.screenshot({ path: fileURLToPath(new URL('admin-feedback-desktop.png', outputDir)) });

  await page.getByRole('tab', { name: '系统', exact: true }).click();
  assert.equal(await page.locator('#systemPanel').getByText('35.3%', { exact: true }).isVisible(), true);
  assert.equal(await page.locator('#systemPanel').getByText('3 / 24 个', { exact: true }).isVisible(), true);
  const systemText = await page.locator('#systemPanel').innerText();
  assert.match(systemText, /API 3 · 后台登录 1 · 已退出会话 2/);
  assert.match(systemText, /订阅页面 5 个 · 单任务上限 12 个/);
  assert.match(systemText, /最近清理 4 个旧缓存目录 · 新缓存上限 64 MB \+ 16 MB/);
  await page.getByRole('tab', { name: 'Cookie', exact: true }).click();
  assert.equal(await page.getByRole('heading', { name: 'Cookie 与保活' }).isVisible(), true);
  await page.getByRole('button', { name: '扫码登录微博' }).click();
  assert.equal(await page.locator('#weiboLoginText').getAttribute('role'), 'status');
  await page.waitForTimeout(6000);
  assert.equal(maxLoginPolls, 1);
  await page.getByRole('button', { name: '关闭扫码' }).click();
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.waitForTimeout(320);
  assert.equal(await page.getByRole('searchbox', { name: '搜索开奖记录' }).isVisible(), true);
  assert.equal(await page.locator('.record-row').count(), draws.length);
  maxDetailRequests = 0;
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出当前列表' }).click();
  await download;
  await page.locator('#exportStatus').getByText(`已导出 ${draws.length} 条记录`, { exact: true }).waitFor();
  assert.equal(maxDetailRequests, 1);
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
  await page.getByRole('button', { name: '删除', exact: true }).click();
  const deleteDialog = page.getByRole('dialog', { name: '删除开奖记录' });
  assert.equal(await deleteDialog.isVisible(), true);
  assert.equal(await deleteDialog.getByText('删除后无法恢复', { exact: false }).isVisible(), true);
  await page.waitForTimeout(320);
  await page.screenshot({ path: fileURLToPath(new URL('admin-delete-confirm-desktop.png', outputDir)) });
  await deleteDialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await deleteDialog.isVisible(), false);
  await page.screenshot({ path: fileURLToPath(new URL('admin-records-desktop.png', outputDir)) });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '关闭开奖记录详情' }).click();
  detailDelayMs = 300;
  await page.locator('.record-row').first().click();
  await page.locator('#detailPanel.has-selection').waitFor({ state: 'visible' });
  await page.locator('#detailContent .detail-state').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'detailClose');
  await page.locator('#detailContent').getByText(draws[0].winners[0].screenName, { exact: true }).waitFor();
  detailDelayMs = 20;
  const mobileDetail = page.getByRole('dialog', { name: '开奖记录详情' });
  assert.equal(await mobileDetail.getAttribute('aria-modal'), 'true');
  assert.equal(await page.locator('.topbar').evaluate((element) => element.hasAttribute('inert')), true);
  assert.equal(await page.locator('body.record-detail-open').count(), 1);
  assert.equal(await page.locator('#detailContent img').count(), 0);
  assert.equal(await page.locator('#detailContent a[href^="javascript:"]').count(), 0);
  assert.equal(await page.evaluate(() => window.__adminXss), undefined);
  await mobileDetail.locator('button').last().focus();
  await page.keyboard.press('Tab');
  const trappedFocus = await page.evaluate(() => ({
    id: document.activeElement?.id || '',
    tag: document.activeElement?.tagName || '',
    text: document.activeElement?.textContent?.trim() || '',
  }));
  assert.equal(trappedFocus.id, 'detailClose', JSON.stringify(trappedFocus));
  await page.waitForTimeout(450);
  await page.screenshot({ path: fileURLToPath(new URL('admin-records-mobile-detail.png', outputDir)) });
  await page.getByRole('button', { name: '关闭开奖记录详情' }).click();
  assert.equal(await page.locator('#detailPanel.has-selection').count(), 0);
  await page.waitForTimeout(450);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.file), draws[0].file);
  failingDetailFile = draws[1].file;
  await page.locator('.record-row').nth(1).click();
  await page.getByRole('alert').getByText('记录载入失败', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '重新加载' }).isVisible(), true);
  failingDetailFile = '';
  await page.getByRole('button', { name: '重新加载' }).click();
  await page.locator('#detailContent').getByText('中奖用户 2', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭开奖记录详情' }).click();
  await page.getByRole('tab', { name: '反馈', exact: true }).click();
  await page.waitForTimeout(320);
  assert.equal(await page.locator('.feedback-row').count(), feedback.length);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const touchTargets = await page.locator('.tab-button, .feedback-toolbar button, .feedback-actions button, #refreshBtn').evaluateAll((items) => (
    items.filter((item) => !item.hidden && getComputedStyle(item).display !== 'none').map((item) => {
      const box = item.getBoundingClientRect();
      return { width: box.width, height: box.height, text: item.textContent?.trim() || item.id };
    })
  ));
  assert.equal(touchTargets.every((item) => item.width >= 43 && item.height >= 43), true, JSON.stringify(touchTargets));
  await page.screenshot({ path: fileURLToPath(new URL('admin-feedback-mobile.png', outputDir)) });
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.waitForTimeout(320);
  await page.screenshot({ path: fileURLToPath(new URL('admin-records-mobile.png', outputDir)) });
  await context.close();
} finally {
  await browser.close();
}

console.log('ADMIN_UI_OK');
