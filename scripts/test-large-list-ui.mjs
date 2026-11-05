import assert from 'node:assert/strict';
import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const cpuRate = Number(process.env.UI_CPU_RATE || 1);
assert.ok(Number.isFinite(cpuRate) && cpuRate >= 1 && cpuRate <= 6);
const candidates = Array.from({ length: 20_000 }, (_, index) => ({
  uid: String(1_000_000 + index),
  screenName: `候选 ${index + 1}`,
  text: index % 2 ? '普通转发' : '参与抽奖',
  source: 'desktop-cookie',
}));
const browser = await launchUiBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    localStorage.setItem('weibo-draw-motion', 'system');
    window.uiMetrics = { longTasks: [], lcp: 0, cls: 0 };
    for (const type of ['longtask', 'largest-contentful-paint', 'layout-shift']) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (type === 'longtask') window.uiMetrics.longTasks.push({ start: entry.startTime, duration: entry.duration });
          if (type === 'largest-contentful-paint') window.uiMetrics.lcp = entry.startTime;
          if (type === 'layout-shift' && !entry.hadRecentInput) window.uiMetrics.cls += entry.value;
        }
      }).observe({ type, buffered: true });
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const session = await context.newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  await session.send('Network.enable');
  await session.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/weibo/reposts/jobs') return route.fulfill({ json: {
      ok: true, status: 'done', result: {
        ok: true, statusId: '5360541620244396', drawCount: 0, candidates,
        meta: { complete: true, totalNumber: candidates.length, provider: 'desktop-cookie', loadedAt: new Date().toISOString() },
      },
    } });
    assert.notEqual(path, '/api/draws', '大名单检查不能保存正式结果');
    return route.fulfill({ json: { ok: true, hasCookie: true, drawCount: 0 } });
  });
  await gotoUiPage(page, baseUrl);
  await page.getByRole('tab', { name: '抽奖', exact: true }).waitFor();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => window.uiMetrics.lcp > 0);
  const initial = await page.evaluate(() => ({
    ...window.uiMetrics,
    resources: performance.getEntriesByType('resource').filter((entry) => !entry.name.includes('/api/')).map((entry) => ({
      name: new URL(entry.name).pathname, encodedBytes: entry.encodedBodySize, decodedBytes: entry.decodedBodySize,
    })),
  }));
  await page.getByRole('textbox', { name: '微博链接、mid 或 bid' }).fill('5360541620244396');
  const loadStart = await page.evaluate(() => performance.now());
  await page.getByRole('button', { name: /载入候选/ }).click();
  await page.getByText('20,000 名候选 · 1 个奖项 · 1 个名额', { exact: true }).waitFor();
  const loadMs = await page.evaluate((start) => performance.now() - start, loadStart);
  await page.getByRole('tab', { name: '名单', exact: true }).click();
  assert.equal(await page.locator('.people-list > button').count(), 20, '首批只渲染当前可浏览的条目');
  const search = page.getByRole('searchbox', { name: '搜索候选' });
  const searchStart = await page.evaluate(() => performance.now());
  await search.fill('1019999');
  await page.locator('.people-list > button').getByText('候选 20000', { exact: true }).waitFor();
  assert.equal(await page.locator('.people-list > button').count(), 1, '搜索必须包含首批之外的最后一位候选');
  const searchMs = await page.evaluate((start) => performance.now() - start, searchStart);
  await search.fill('');
  await page.getByRole('button', { name: '筛选候选', exact: true }).click();
  const filter = page.getByRole('dialog', { name: '筛选规则' });
  await filter.getByRole('textbox', { name: '转发关键词', exact: true }).fill('抽奖');
  const filterStart = await page.evaluate(() => performance.now());
  await filter.getByRole('button', { name: '应用筛选' }).click();
  await filter.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '可抽 10000', exact: true }).waitFor();
  const filterMs = await page.evaluate((start) => performance.now() - start, filterStart);
  await page.getByRole('button', { name: '已排除 10000', exact: true }).click();
  await page.locator('.people-list > button').getByText('候选 2', { exact: true }).waitFor();
  assert.equal(await page.locator('.people-list > button').count(), 20);
  assert.equal(await page.getByRole('button', { name: '全部 20000', exact: true }).count(), 1);
  const final = await page.evaluate(() => ({
    longTaskCount: window.uiMetrics.longTasks.length,
    maxLongTaskMs: Math.max(0, ...window.uiMetrics.longTasks.map((entry) => entry.duration)),
    nodes: document.getElementsByTagName('*').length,
    heapMb: performance.memory ? performance.memory.usedJSHeapSize / 1024 / 1024 : null,
  }));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cpuRate, candidateCount: candidates.length, initial, loadMs, searchMs, filterMs, final }));
  await context.close();
} finally {
  await browser.close();
}
console.log('LARGE_LIST_UI_OK');
