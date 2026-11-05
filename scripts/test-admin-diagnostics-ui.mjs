import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright';
import { launchUiBrowser, gotoUiPage } from './playwright-browser.mjs';
import { summary, draws, feedback, crawlMeta } from './fixtures/admin-preview.mjs';

const baseUrl = process.env.ADMIN_UI_URL || 'http://127.0.0.1:4173/admin';
const engine = process.env.ADMIN_UI_ENGINE || 'chromium';
const browser = engine === 'webkit' ? await webkit.launch() : await launchUiBrowser();
const output = new URL('../output/ui-checks/', import.meta.url);
await mkdir(output, { recursive: true });
const data = structuredClone(summary);
for (let index = 0; index < 35; index += 1) data.system.events.push({ at: new Date(Date.now() - index * 1000).toISOString(), action: 'sample', category: 'system', level: 'info', message: `模拟运行事件 ${index + 1}` });
let requests = 0;
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.clock.install();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.__copied = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => {
      if (window.__copyFail) throw new Error('denied');
      window.__copied = text;
    } } });
  });
  await page.route('**/api/admin/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/admin/session') return route.fulfill({ json: { username: 'preview', csrfToken: 'preview' } });
    if (url.pathname === '/api/admin/summary') { requests += 1; return route.fulfill({ json: data }); }
    if (url.pathname === '/api/admin/draws') return route.fulfill({ json: { items: draws } });
    if (url.pathname.startsWith('/api/admin/draws/')) return route.fulfill({ json: { item: draws[0] } });
    if (url.pathname === '/api/admin/feedback') return route.fulfill({ json: { items: feedback } });
    return route.fulfill({ json: { ok: true } });
  });
  await gotoUiPage(page, baseUrl);
  await page.locator('.metric-value').first().getByText('35.3%', { exact: true }).waitFor();
  await page.locator('#autoRefreshBtn').click();
  const baseline = requests;
  await page.clock.fastForward(61_000);
  assert.equal(requests, baseline, '暂停后不应自动刷新');
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => !document.querySelector('#refreshBtn').disabled);
  assert.equal(requests, baseline + 1, '暂停时仍可手动刷新');
  await page.locator('#autoRefreshBtn').click();
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/admin/summary');
  await page.clock.fastForward(61_000);
  await refreshed;
  assert.equal(requests, baseline + 2, '恢复后应自动刷新');
  await page.locator('#autoRefreshBtn').click();
  await page.clock.resume();
  const originalSamples = structuredClone(data.system.memory.samples);
  data.system.memory.samples[10].cgroupCurrentMb = null;
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => !document.querySelector('#refreshBtn').disabled);
  assert.equal(await page.locator('#memoryChart polyline.chart-line-current').count(), 2, '缺失服务内存只打断对应曲线');
  assert.equal(await page.locator('#memoryChart polyline.chart-line-anon').count(), 1, '另一条有效曲线应完整保留');
  assert.match(await page.locator('#memoryChart .chart-caption').innerText(), /断点/);
  data.system.memory.samples = [originalSamples[0]];
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => !document.querySelector('#refreshBtn').disabled);
  assert.equal(await page.locator('#memoryChart circle').count(), 2, '只有一个有效样本时仍可查看真实测量');
  assert.match(await page.locator('#memoryChart .chart-caption').innerText(), /一个有效采样/);
  data.system.memory.samples = originalSamples.map((sample) => ({ ...sample, cgroupCurrentMb: null, cgroupAnonMb: null }));
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => !document.querySelector('#refreshBtn').disabled);
  assert.equal(await page.locator('#memoryChart svg').count(), 0, '无有效测量时不应伪造零值曲线');
  assert.match(await page.locator('#memoryChart').innerText(), /等待有效内存采样/);
  data.system.memory.samples = originalSamples;
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => !document.querySelector('#refreshBtn').disabled);
  await page.getByRole('tab', { name: '系统', exact: true }).click();
  assert.equal(await page.locator('#diagnostic-events').isVisible(), true);
  assert.equal(await page.locator('#systemEventPanel > .event-row').count(), 30);
  await page.locator('#moreEventsBtn').click();
  assert.equal(await page.locator('#systemEventPanel > .event-row').count(), 40);
  await page.locator('#eventSearch').fill('不存在的任务');
  assert.match(await page.locator('#systemEventPanel').innerText(), /没有匹配/);
  await page.locator('#eventSearch').fill(crawlMeta.crawlId);
  await page.locator('#eventCategory').selectOption('weibo');
  await page.locator('#eventHours').selectOption('24');
  await page.locator('#copyDiagnosticsBtn').click();
  const report = JSON.parse(await page.evaluate(() => window.__copied));
  assert.equal(report.eventCount, 3);
  assert.equal(report.crawls[0].missing, 20);
  assert.equal(report.crawls[0].channels[1].added, 0);
  assert.equal(report.crawls[0].channels[1].duplicates, 180);
  await page.evaluate(() => { window.__copyFail = true; });
  await page.locator('#copyDiagnosticsBtn').click();
  assert.match(await page.locator('#toast').textContent(), /复制失败/);
  assert.equal(await page.locator('#copyDiagnosticsBtn').isEnabled(), true);
  await page.locator('#eventSearch').focus();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 420 });
    Object.defineProperty(window.visualViewport, 'scale', { configurable: true, value: 1 });
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.tabbar')).visibility === 'hidden');
  assert.equal(await page.locator('.tabbar').isVisible(), false, '键盘展开后底栏应让出输入空间');
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 844 });
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.tabbar')).visibility === 'visible');
  assert.equal(await page.locator('.tabbar').isVisible(), true);
  await page.locator('#clearEventFilters').click();
  await page.getByRole('tab', { name: '事件排查', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: '抓取过程', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.locator('.record-row').first().click();
  await page.locator('.source-evidence').waitFor();
  assert.match(await page.locator('.source-evidence').innerText(), /数量缺口\n20 · 10.0%/);
  assert.match(await page.locator('.source-evidence').innerText(), /载入时间/);
  await page.getByRole('button', { name: '查看关联抓取过程', exact: true }).click();
  assert.equal(await page.locator('#detailPanel').getAttribute('aria-modal'), null);
  assert.equal(await page.locator('#crawlSearch').inputValue(), crawlMeta.crawlId);
  assert.equal(await page.locator('#crawlList > details[open]').count(), 1);
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => !document.querySelector('#refreshBtn').disabled);
  assert.equal(await page.locator('#crawlList > details[open]').count(), 1);
  await page.waitForTimeout(3000);
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const name of ['抓取过程', '服务资源', '安全与 HTTP', '事件排查']) {
        await page.getByRole('tab', { name, exact: true }).click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${engine} ${scheme} ${width} ${name}`);
      }
      if (width === 390) {
        await page.waitForTimeout(150);
        await page.screenshot({ path: fileURLToPath(new URL(`admin-events-${engine}-${scheme}-mobile.png`, output)) });
        await page.getByRole('tab', { name: '抓取过程', exact: true }).click();
        await page.waitForTimeout(150);
        await page.screenshot({ path: fileURLToPath(new URL(`admin-crawl-${engine}-${scheme}-mobile.png`, output)) });
      }
    }
  }
  await page.locator('#logoutBtn').click();
  await page.locator('#loginPanel:not(.hidden)').waitFor();
  assert.equal(await page.locator('#crawlList').textContent(), '');
  assert.equal(await page.locator('#systemEventPanel').textContent(), '');
  assert.equal(await page.locator('#crawlSearch').inputValue(), '');
  assert.deepEqual(errors, []);
  await context.close();
} finally { await browser.close(); }
console.log(`ADMIN_DIAGNOSTICS_UI_OK (${engine})`);
