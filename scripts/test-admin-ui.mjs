import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';
import { readReleaseInfo } from './release-info.mjs';

const baseUrl = process.env.ADMIN_UI_URL || 'http://127.0.0.1:4173/admin';
const outputDir = new URL('../output/ui-checks/', import.meta.url);
const releaseInfo = readReleaseInfo(fileURLToPath(new URL('../', import.meta.url)));

import { draws, summary, feedback, crawlMeta } from './fixtures/admin-preview.mjs';

await mkdir(outputDir, { recursive: true });
const browser = await launchUiBrowser();
try {
  {
    let authenticated = false;
    let malformedSummaryOnce = false;
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
        if (malformedSummaryOnce) {
          malformedSummaryOnce = false;
          await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>proxy error</title>' });
          return;
        }
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
    malformedSummaryOnce = true;
    await loginPage.getByRole('button', { name: '刷新数据' }).click();
    await loginPage.locator('#adminAlert:not(.hidden)').getByText('服务器返回格式异常', { exact: false }).waitFor();
    assert.equal(await loginPage.locator('#dashboard:not(.hidden)').isVisible(), true);
    await loginContext.close();
  }

  {
    const logoutContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const logoutPage = await logoutContext.newPage();
    let summaryRequests = 0;
    let failLogoutOnce = true;
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
      if (url.pathname === '/api/admin/logout' && failLogoutOnce) {
        failLogoutOnce = false;
        await route.fulfill({ status: 503, json: { ok: false, error: '退出接口暂时不可用' } });
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
    await logoutPage.locator('#adminAlert:not(.hidden)').getByText('退出接口暂时不可用', { exact: true }).waitFor();
    assert.equal(await logoutPage.locator('#dashboard:not(.hidden)').isVisible(), true);
    await logoutPage.locator('#logoutBtn').click();
    await logoutPage.locator('#loginPanel:not(.hidden)').waitFor();
    assert.equal(await logoutPage.locator('#crawlList').textContent(), '');
    assert.equal(await logoutPage.locator('#systemEventPanel').textContent(), '');
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

  {
    const exportContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const exportPage = await exportContext.newPage();
    let detailCalls = 0;
    let downloads = 0;
    exportPage.on('download', () => { downloads += 1; });
    await exportPage.route('**/api/admin/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/admin/session') return route.fulfill({ json: { username: 'preview', csrfToken: 'preview' } });
      if (pathname === '/api/admin/summary') return route.fulfill({ json: summary });
      if (pathname === '/api/admin/draws') return route.fulfill({ json: { ok: true, items: draws.slice(0, 1) } });
      if (pathname === '/api/admin/feedback') return route.fulfill({ json: { ok: true, items: [] } });
      if (pathname.startsWith('/api/admin/draws/')) {
        detailCalls += 1;
        return route.fulfill({ status: 429, headers: { 'retry-after': '1' }, json: { ok: false, error: '请求过于频繁' } });
      }
      return route.fulfill({ json: { ok: true } });
    });
    await gotoUiPage(exportPage, baseUrl);
    await exportPage.getByRole('tab', { name: '记录', exact: true }).click();
    await exportPage.locator('.record-row').waitFor();
    await exportPage.getByRole('button', { name: '导出已载入记录' }).click();
    await exportPage.locator('#exportStatus').getByText(/秒后继续/).waitFor();
    await exportPage.locator('#logoutBtn').click();
    await exportPage.locator('#loginPanel:not(.hidden)').waitFor();
    await exportPage.waitForTimeout(1200);
    assert.equal(detailCalls, 1, '退出后不得继续导出重试');
    assert.equal(downloads, 0, '退出后不得触发下载');
    assert.equal(await exportPage.locator('#exportStatus').innerText(), '');
    assert.equal(await exportPage.locator('#adminAlert').isVisible(), false);
    await exportContext.close();
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__drawRequestAborts = [];
    window.__detailRequestAborts = [];
    window.fetch = (input, options = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const signal = options.signal;
      if (url.includes('/api/admin/draws?') && signal) {
        const recordAbort = () => window.__drawRequestAborts.push(url);
        if (signal.aborted) recordAbort();
        else signal.addEventListener('abort', recordAbort, { once: true });
      }
      if (/\/api\/admin\/draws\/[^?]+$/.test(new URL(url, window.location.href).pathname) && signal) {
        const recordAbort = () => window.__detailRequestAborts.push(url);
        if (signal.aborted) recordAbort();
        else signal.addEventListener('abort', recordAbort, { once: true });
      }
      return nativeFetch(input, options);
    };
  });
  let activeDetailRequests = 0;
  let maxDetailRequests = 0;
  let activeLoginPolls = 0;
  let maxLoginPolls = 0;
  let weiboLoginActive = false;
  let failingDetailFile = '';
  let failingDeleteFile = '';
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
      const search = url.searchParams.get('search') || '';
      const offset = Number(url.searchParams.get('offset') || 0);
      if (search === '分页') {
        const items = offset ? draws.slice(2, 4) : draws.slice(0, 2);
        await route.fulfill({
          json: {
            ok: true,
            items,
            hasMore: offset === 0,
            nextOffset: offset + items.length,
            nextCursor: offset === 0 ? 'draws-page-2' : '',
          },
        });
        return;
      }
      if (search === '分页取消') {
        const items = offset ? draws.slice(2, 4) : draws.slice(0, 2);
        if (offset) await new Promise((resolve) => setTimeout(resolve, 1200));
        await route.fulfill({
          json: {
            ok: true,
            items,
            hasMore: offset === 0,
            nextOffset: offset + items.length,
            nextCursor: offset === 0 ? 'cancel-page-2' : '',
          },
        }).catch(() => {});
        return;
      }
      if (search === '旧请求') {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await route.fulfill({ json: { ok: true, items: draws.slice(0, 2) } }).catch(() => {});
        return;
      }
      if (search === '最新请求') {
        await new Promise((resolve) => setTimeout(resolve, 500));
        await route.fulfill({ json: { ok: true, items: draws.slice(0, 1) } });
        return;
      }
      if (search === '错误请求') {
        await route.fulfill({ status: 503, json: { ok: false, error: '记录搜索暂时不可用' } });
        return;
      }
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
    if (route.request().method() === 'DELETE' && file === failingDeleteFile) {
      await route.fulfill({ status: 503, json: { ok: false, error: '记录删除暂时不可用' } });
      return;
    }
    activeDetailRequests += 1;
    maxDetailRequests = Math.max(maxDetailRequests, activeDetailRequests);
    await new Promise((resolve) => setTimeout(resolve, detailDelayMs));
    activeDetailRequests -= 1;
    if (file === failingDetailFile) {
      await route.fulfill({ status: 503, json: { ok: false, error: '记录服务暂时不可用' } }).catch(() => {});
      return;
    }
    await route.fulfill({ json: { ok: true, item: draws.find((item) => item.file === file) } }).catch(() => {});
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
  assert.equal(await page.locator('#systemPanel').isVisible(), false);
  await page.locator('#eventSearch').fill(crawlMeta.crawlId);
  assert.equal(await page.locator('#systemEventPanel > .event-row').count(), 3);
  await page.locator('#eventLevel').selectOption('warning');
  assert.equal(await page.locator('#systemEventPanel > .event-row').count(), 1);
  await page.locator('#systemEventPanel summary').click();
  await page.locator('#refreshBtn').click();
  await page.waitForFunction(() => !document.querySelector('#refreshBtn').disabled);
  assert.equal(await page.locator('#eventSearch').inputValue(), crawlMeta.crawlId);
  assert.equal(await page.locator('#systemEventPanel details').getAttribute('open') !== null, true);
  await page.locator('#autoRefreshBtn').click();
  assert.equal(await page.locator('#autoRefreshBtn').getAttribute('aria-pressed'), 'false');
  await page.locator('#autoRefreshBtn').click();
  await page.locator('#clearEventFilters').click();
  await page.getByRole('tab', { name: '抓取过程', exact: true }).click();
  assert.equal(await page.locator('.crawl-card').count(), 2);
  await page.locator('#crawlSearch').fill('preview-crawl-001');
  await page.locator('.crawl-card > summary').click();
  assert.match(await page.locator('#crawlList').innerText(), /大名单缺口在容差内/);
  assert.match(await page.locator('#crawlList').innerText(), /真实新增\n0/);
  assert.match(await page.locator('#crawlList').innerText(), /20 · 10.0%/);
  await page.screenshot({ path: fileURLToPath(new URL('admin-crawls-desktop.png', outputDir)), fullPage: true });
  await page.locator('#crawlSearch').fill('preview-crawl-002');
  await page.locator('.crawl-card > summary').click();
  assert.match(await page.locator('#crawlList').innerText(), /缺少最终结果/);
  assert.match(await page.locator('#crawlList').innerText(), /未记录/);
  assert.equal(await page.locator('#crawlList img').count(), 0);
  await page.locator('#crawlSearch').fill('');
  await page.getByRole('tab', { name: '服务资源', exact: true }).click();
  assert.equal(
    await page.locator('#appVersion').getByText(`Sameko Control · v${releaseInfo.version}`, { exact: true }).isVisible(),
    true,
  );
  assert.equal(await page.locator('#systemPanel').getByText('35.3%', { exact: true }).isVisible(), true);
  assert.equal(await page.locator('#systemPanel').getByText('3 / 24 个', { exact: true }).isVisible(), true);
  const systemText = await page.locator('#systemPanel').innerText();
  assert.match(systemText, /累计开奖\n1,288 次/);
  assert.match(systemText, /当前保留 18 条 · 累计中奖 3,512 人次 · 历史序号与保留记录 · 更新于/);
  await page.getByRole('tab', { name: '事件排查', exact: true }).click();
  assert.equal(await page.locator('#systemEventPanel details').first().getByText('技术详情', { exact: true }).isVisible(), true);
  await page.getByRole('tab', { name: '安全与 HTTP', exact: true }).click();
  assert.equal(await page.locator('#requestErrorPanel').getByText('GET /api/missing', { exact: true }).isVisible(), true);
  assert.equal(await page.locator('#requestErrorPanel').getByText(/weibo\.com\/ajax\/statuses\/repostTimeline · 429/).isVisible(), true);
  const taxonomyText = await page.locator('#errorTaxonomyPanel').innerText();
  assert.match(taxonomyText, /微博抓取/);
  assert.match(taxonomyText, /错误码 scanner-probe/);
  assert.match(taxonomyText, /路由缺失/);
  const securityText = await page.locator('#securityPanel').innerText();
  assert.match(securityText, /疑似漏洞扫描/);
  assert.match(securityText, /21 次扫描/);
  await page.screenshot({
    path: fileURLToPath(new URL('admin-system-desktop.png', outputDir)),
    fullPage: true,
  });
  assert.match(systemText, /API 3 · 后台登录 1 · 已退出会话 2/);
  assert.match(systemText, /应用异常 1 · 路由缺失 1 · 扫描 0/);
  assert.match(systemText, /订阅页面 5 个 · 单任务上限 12 个/);
  assert.match(systemText, /最近清理 4 个旧缓存目录 · 新缓存上限 64 MB \+ 16 MB/);
  await page.getByRole('tab', { name: 'Cookie', exact: true }).click();
  assert.equal(await page.getByRole('heading', { name: 'Cookie 与保活' }).isVisible(), true);
  const cookieText = await page.locator('#cookieBox').innerText();
  assert.match(cookieText, /已验证账号 1 个 · 可尝试 2 个/);
  assert.match(cookieText, /保存记录：3 条/);
  assert.match(cookieText, /待验证：1 个账号/);
  assert.match(cookieText, /校验异常：1 个账号/);
  await page.getByRole('button', { name: '扫码登录微博' }).click();
  assert.equal(await page.locator('#weiboLoginText').getAttribute('role'), 'status');
  await page.waitForTimeout(6000);
  assert.equal(maxLoginPolls, 1);
  await page.getByRole('button', { name: '关闭扫码' }).click();
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await page.waitForTimeout(320);
  const searchInput = page.getByRole('searchbox', { name: '搜索开奖记录' });
  assert.equal(await searchInput.isVisible(), true);
  assert.equal(await page.locator('.record-row').count(), draws.length);

  const slowSearch = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/admin/draws' && url.searchParams.get('search') === '旧请求';
  });
  await searchInput.fill('旧请求');
  await slowSearch;
  const latestSearch = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/draws' && url.searchParams.get('search') === '最新请求';
  });
  await searchInput.fill('最新请求');
  await page.waitForFunction(() => window.__drawRequestAborts.some((value) => (
    new URL(value, window.location.href).searchParams.get('search') === '旧请求'
  )));
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#adminAlert').isVisible(), false);
  await latestSearch;
  await page.waitForFunction(() => document.querySelectorAll('.record-row').length === 1);

  await page.locator('#toast:not(.show)').waitFor();
  await searchInput.fill('错误请求');
  await page.locator('#adminAlert:not(.hidden)').getByText('记录搜索暂时不可用', { exact: true }).waitFor();
  assert.equal(await page.locator('#toast.show').count(), 0);
  assert.notEqual(await page.locator('#toast').innerText(), '记录搜索暂时不可用');
  await page.locator('#adminAlertClose').click();
  await searchInput.fill('分页');
  await page.waitForFunction(() => document.querySelectorAll('.record-row').length === 2);
  const appendRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/admin/draws'
      && url.searchParams.get('search') === '分页'
      && url.searchParams.get('cursor') === 'draws-page-2';
  });
  const loadMoreButton = page.getByRole('button', { name: '载入更多记录' });
  await loadMoreButton.focus();
  await loadMoreButton.press('Enter');
  await appendRequest;
  await page.waitForFunction(() => document.querySelectorAll('.record-row').length === 4);
  await page.waitForFunction(() => document.querySelector('.record-row[data-index="2"]') === document.activeElement);
  assert.equal(await page.getByText('4 条', { exact: false }).first().isVisible(), true);
  await searchInput.fill('分页取消');
  await page.waitForFunction(() => document.querySelectorAll('.record-row').length === 2);
  const delayedAppend = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/admin/draws'
      && url.searchParams.get('search') === '分页取消'
      && url.searchParams.get('offset') === '2'
      && url.searchParams.get('cursor') === 'cancel-page-2';
  });
  await page.getByRole('button', { name: '载入更多记录' }).click();
  await delayedAppend;
  await searchInput.fill('最新请求');
  await page.waitForFunction(() => window.__drawRequestAborts.some((value) => {
    const url = new URL(value, window.location.href);
    return url.searchParams.get('search') === '分页取消'
      && url.searchParams.get('offset') === '2';
  }));
  await page.waitForFunction(() => document.querySelectorAll('.record-row').length === 1);
  await searchInput.fill('分页');
  await page.waitForFunction(() => document.querySelectorAll('.record-row').length === 2);
  assert.equal(await page.getByRole('button', { name: '载入更多记录' }).isEnabled(), true);
  await searchInput.fill('');
  await page.waitForFunction((count) => document.querySelectorAll('.record-row').length === count, draws.length);

  maxDetailRequests = 0;
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出已载入记录' }).click();
  await download;
  await page.locator('#exportStatus').getByText(`已导出 ${draws.length} 条记录`, { exact: true }).waitFor();
  assert.equal(maxDetailRequests, 1);
  await page.locator('.record-list-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const before = await page.evaluate(() => ({ pageY: window.scrollY, detailTop: document.querySelector('#detailPanel').getBoundingClientRect().top }));
  await page.locator('.record-row').last().click();
  await page.locator('#detailContent').getByText('中奖用户 18', { exact: true }).waitFor();
  await page.evaluate(() => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText = async () => { throw new Error('clipboard denied'); };
    } else {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw new Error('clipboard denied'); } },
      });
    }
    document.execCommand = () => true;
  });
  await page.getByRole('button', { name: '复制名单', exact: true }).click();
  await page.locator('#toast.show').getByText('中奖名单已复制', { exact: true }).waitFor();
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
  failingDeleteFile = draws.at(-1).file;
  await deleteDialog.getByRole('button', { name: '删除', exact: true }).click();
  await deleteDialog.getByText('记录删除暂时不可用', { exact: true }).waitFor();
  assert.equal(await page.locator('#adminAlert').isVisible(), false);
  failingDeleteFile = '';
  await page.waitForTimeout(320);
  await page.screenshot({ path: fileURLToPath(new URL('admin-delete-confirm-desktop.png', outputDir)) });
  await deleteDialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await deleteDialog.isVisible(), false);
  await page.screenshot({ path: fileURLToPath(new URL('admin-records-desktop.png', outputDir)) });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '关闭开奖记录详情' }).click();
  detailDelayMs = 1200;
  await page.locator('.record-row').first().click();
  await page.locator('#detailContent .detail-state').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '关闭开奖记录详情' }).click();
  await page.waitForFunction((file) => window.__detailRequestAborts.some((value) => (
    decodeURIComponent(new URL(value, window.location.href).pathname).endsWith(`/${file}`)
  )), draws[0].file);
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
  await page.locator('#detailContent[aria-busy="false"]').waitFor();
  await page.locator('#detailContent').getByText('记录载入失败', { exact: true }).waitFor();
  await page.locator('#adminAlert:not(.hidden)').getByText('记录载入失败', { exact: false }).waitFor();
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
  await page.getByRole('tab', { name: '系统', exact: true }).click();
  await page.waitForTimeout(320);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    '手机端系统页不应出现横向滚动',
  );
  assert.equal(await page.locator('#errorTaxonomyPanel').isVisible(), true);
  assert.equal(await page.locator('#securityPanel').isVisible(), true);
  await page.screenshot({
    path: fileURLToPath(new URL('admin-system-mobile.png', outputDir)),
    fullPage: true,
  });
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const tab of ['总览', '记录', '反馈', 'Cookie', '系统']) {
        await page.getByRole('tab', { name: tab, exact: true }).click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${scheme} ${width}px ${tab} 横向溢出`);
      }
    }
    await page.getByRole('tab', { name: '总览', exact: true }).click();
    await page.waitForFunction(() => {
      const selected = document.querySelector('.tab-button.active').getBoundingClientRect();
      const indicator = document.querySelector('.tab-indicator').getBoundingClientRect();
      return Math.abs(selected.left - indicator.left) < 3;
    });
    const colors = await page.locator('body').evaluate((element) => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
    assert.equal(colors.background, scheme === 'dark' ? 'rgb(16, 16, 17)' : 'rgb(250, 251, 253)');
    await page.screenshot({ path: fileURLToPath(new URL(`admin-overview-${scheme}.png`, outputDir)), fullPage: true });
  }
  assert.deepEqual(pageErrors, []);
  await context.close();
} finally {
  await browser.close();
}

console.log('ADMIN_UI_OK');
