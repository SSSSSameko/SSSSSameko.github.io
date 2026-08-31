import assert from 'node:assert/strict';

import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const browser = await launchUiBrowser();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  reducedMotion: 'reduce',
});
let postCount = 0;
let pollCount = 0;
let deleteCount = 0;
const errors = [];

page.on('pageerror', (error) => errors.push(error.message));
await page.route(/\/api\/weibo\/reposts\/jobs(?:\/[^?]+)?(?:\?.*)?$/, async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (request.method() === 'POST' && url.pathname.endsWith('/jobs')) {
    postCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 120));
    await route.fulfill({
      status: 200,
      json: {
        ok: true,
        jobId: 'candidate-load-ui-test',
        cancelToken: 'candidate-load-cancel-token',
        status: 'running',
        progress: { phase: 'fetching', percent: 10, message: '正在载入' },
      },
    });
    return;
  }
  if (request.method() === 'GET') {
    pollCount += 1;
    if (pollCount === 1) {
      await route.fulfill({ status: 503, json: { ok: false, error: '模拟短暂断网' } });
      return;
    }
    if (pollCount === 2) {
      await route.fulfill({
        status: 200,
        json: {
          ok: true,
          status: 'running',
          progress: { phase: 'mobile', percent: 60, message: '正在继续载入' },
        },
      });
      return;
    }
    await route.fulfill({
      status: 200,
      json: {
        ok: true,
        status: 'done',
        result: {
          ok: true,
          statusId: 'candidate-load-ui-test',
          statusUrl: 'https://weibo.com/1/CandidateLoadTest',
          drawCount: 0,
          candidates: [{ id: 'candidate-1', uid: '1001', screenName: '续载候选' }],
          meta: { provider: 'mobile', complete: true, pages: [{ page: 1, count: 1 }] },
        },
      },
    });
    return;
  }
  if (request.method() === 'DELETE') {
    deleteCount += 1;
    await route.fulfill({ status: 200, json: { ok: true, status: 'cancelled' } });
    return;
  }
  await route.fallback();
});

try {
  await gotoUiPage(page, baseUrl);
  await page.getByRole('textbox', { name: '微博链接、mid 或 bid' })
    .fill('https://weibo.com/2715025067/CandidateLoadTest');
  const loadButton = page.getByRole('button', { name: /载入候选/ });
  await loadButton.evaluate((button) => {
    button.click();
    button.click();
  });
  const manualShortcut = page.getByRole('button', { name: '或手动导入候选名单', exact: true });
  await page.waitForFunction(() => document.querySelector('.v3-text-action')?.disabled === true);
  assert.equal(await manualShortcut.isDisabled(), true);
  await manualShortcut.evaluate((button) => button.click());
  assert.equal(await page.getByRole('dialog', { name: '候选来源' }).count(), 0);

  await page.locator('[data-root-view="home"] .v3-progress [role="status"]')
    .getByText(/连接暂时中断，正在重新读取任务/)
    .waitFor({ state: 'visible' });
  await page.getByText('1 名候选 · 1 个奖项 · 1 个名额', { exact: true }).waitFor();

  assert.equal(postCount, 1, '重复点击不应创建第二个候选任务');
  assert.equal(pollCount, 3, '短暂断网后应继续轮询原任务');
  assert.equal(deleteCount, 0, '恢复成功时不应取消服务器任务');
  assert.deepEqual(errors, []);

  const clipboardPage = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  await clipboardPage.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: () => window.__candidateClipboardValue,
      },
    });
    window.__candidateClipboardValue = '';
  });
  await clipboardPage.route(/\/api\/weibo\/reposts\/jobs(?:\/[^?]+)?(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    postCount += 1;
    await route.fulfill({
      status: 200,
      json: {
        ok: true,
        jobId: '',
        status: 'done',
        result: {
          ok: true,
          statusId: 'candidate-clipboard-ui-test',
          statusUrl: 'https://weibo.com/2715025067/CandidateClipboardTest',
          drawCount: 0,
          candidates: [{ id: 'candidate-clipboard', uid: '1002', screenName: '剪贴板候选' }],
          meta: { provider: 'mobile', complete: true, pages: [{ page: 1, count: 1 }] },
        },
      },
    });
  });
  await gotoUiPage(clipboardPage, baseUrl);
  await clipboardPage.getByRole('textbox', { name: '微博链接、mid 或 bid' }).fill('');
  const clipboardLoadButton = clipboardPage.locator('[data-root-view="home"]')
    .getByRole('button', { name: /粘贴链接并载入/ });
  await clipboardLoadButton.click();
  const emptyClipboardNotice = clipboardPage.locator('.flow-notice').filter({ hasText: '剪贴板为空' });
  await emptyClipboardNotice.waitFor({ state: 'visible' });
  assert.equal(
    await emptyClipboardNotice.getByText('剪贴板中没有内容，请先复制微博正文链接、mid 或 bid。', { exact: true }).isVisible(),
    true,
  );
  await emptyClipboardNotice.getByRole('button', { name: '关闭提示' }).evaluate((button) => button.click());
  await emptyClipboardNotice.waitFor({ state: 'detached' });

  await clipboardPage.evaluate(() => {
    window.__candidateClipboardValue = '这不是微博链接';
  });
  await clipboardLoadButton.click();
  const invalidClipboardNotice = clipboardPage.locator('.flow-notice').filter({ hasText: '微博链接格式不正确' });
  await invalidClipboardNotice.waitFor({ state: 'visible' });
  assert.equal(
    await invalidClipboardNotice.getByText('请粘贴微博正文链接、mid 或 bid。', { exact: true }).isVisible(),
    true,
  );
  await invalidClipboardNotice.getByRole('button', { name: '关闭提示' }).evaluate((button) => button.click());
  await invalidClipboardNotice.waitFor({ state: 'detached' });

  const clipboardInput = clipboardPage.getByRole('textbox', { name: '微博链接、mid 或 bid' });
  const pasteState = await clipboardInput.evaluate((input) => {
    let prevented = false;
    input.addEventListener('paste', (event) => {
      prevented = event.defaultPrevented;
    }, true);
    const transfer = new DataTransfer();
    transfer.setData('text/plain', '普通文本');
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
    input.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, capturePrevented: prevented };
  });
  assert.deepEqual(pasteState, { defaultPrevented: false, capturePrevented: false }, '普通文本粘贴应保留浏览器默认行为');

  await clipboardPage.evaluate(() => {
    window.__candidateClipboardValue = 'https://weibo.com/2715025067/CandidateClipboardTest';
  });
  const validPasteState = await clipboardInput.evaluate((input) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'https://weibo.com/2715025067/CandidateClipboardTest');
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(validPasteState, true, '合法微博链接粘贴应由应用接管并自动载入');
  await clipboardPage.waitForTimeout(220);
  assert.equal(postCount, 2, '合法链接粘贴应只创建一个候选任务');
  await clipboardPage.close();

  const longTaskPage = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  let longTaskPostCount = 0;
  let longTaskDeleteCount = 0;
  const longTaskErrors = [];
  longTaskPage.on('pageerror', (error) => longTaskErrors.push(error.message));
  await longTaskPage.route(/\/api\/weibo\/reposts\/jobs(?:\/[^?]+)?(?:\?.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.endsWith('/jobs')) {
      longTaskPostCount += 1;
      await route.fulfill({
        status: 200,
        json: {
          ok: true,
          jobId: 'candidate-long-task-ui-test',
          cancelToken: 'candidate-long-task-cancel-token',
          status: 'running',
          progress: { phase: 'fetching', percent: 12, message: '正在扫描转发页面' },
        },
      });
      return;
    }
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        json: {
          ok: true,
          status: 'running',
          progress: { phase: 'fetching', percent: 64, message: '已扫描 32 页，继续载入' },
        },
      });
      return;
    }
    if (request.method() === 'DELETE') {
      longTaskDeleteCount += 1;
      await route.fulfill({ status: 200, json: { ok: true, status: 'cancelled' } });
      return;
    }
    await route.fallback();
  });

  await gotoUiPage(longTaskPage, baseUrl);
  await longTaskPage.locator('.root-tabbar button').filter({ hasText: '名单' }).click();
  await longTaskPage.getByRole('textbox', { name: '微博链接、mid 或 bid' })
    .fill('https://weibo.com/2715025067/CandidateLongTaskTest');
  await longTaskPage.getByRole('button', { name: '载入候选', exact: true }).click();

  const progressStatus = longTaskPage.locator('[data-root-view="candidates"] .v3-progress');
  await progressStatus.getByText('已扫描 32 页，继续载入', { exact: true }).waitFor();
  assert.equal(await progressStatus.getByText('64%', { exact: true }).isVisible(), true);
  const cancelButton = progressStatus.getByRole('button', { name: '取消载入' });
  const progressbar = progressStatus.getByRole('progressbar', { name: '候选载入进度' });
  assert.equal(await progressbar.getAttribute('aria-valuenow'), '64');
  assert.equal(await progressbar.evaluate((meter) => Boolean(meter.querySelector('button'))), false);
  assert.equal(await cancelButton.isVisible(), true);

  const cancelRequestPromise = longTaskPage.waitForRequest((request) => (
    request.method() === 'DELETE'
    && new URL(request.url()).pathname.endsWith('/candidate-long-task-ui-test')
  ));
  await cancelButton.click();
  const cancelRequest = await cancelRequestPromise;
  assert.equal(cancelRequest.headers()['x-job-cancel-token'], 'candidate-long-task-cancel-token');
  await longTaskPage.waitForFunction(() => (
    document.querySelector('[data-app-status]')?.textContent?.includes('候选载入已取消')
  ));
  await cancelButton.waitFor({ state: 'detached' });
  assert.equal(longTaskPostCount, 1, '长任务只应创建一次');
  assert.equal(longTaskDeleteCount, 1, '取消入口应停止服务器长任务');
  assert.deepEqual(longTaskErrors, []);
  await longTaskPage.close();

  const earlyCancelPage = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  let resolveCreateRequest;
  const createRequestSeen = new Promise((resolve) => { resolveCreateRequest = resolve; });
  let earlyDeleteCount = 0;
  let earlyPollCount = 0;
  const earlyCancelErrors = [];
  earlyCancelPage.on('pageerror', (error) => earlyCancelErrors.push(error.message));
  await earlyCancelPage.route(/\/api\/weibo\/reposts\/jobs(?:\/[^?]+)?(?:\?.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.endsWith('/jobs')) {
      resolveCreateRequest();
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.fulfill({
        status: 202,
        json: {
          ok: true,
          jobId: 'candidate-early-cancel-test',
          cancelToken: 'candidate-early-cancel-token',
          status: 'running',
          progress: { phase: 'fetching', percent: 8, message: '正在读取第一页' },
        },
      });
      return;
    }
    if (request.method() === 'DELETE') {
      earlyDeleteCount += 1;
      await route.fulfill({ status: 200, json: { ok: true, status: 'cancelled' } });
      return;
    }
    if (request.method() === 'GET') {
      earlyPollCount += 1;
      await route.fulfill({ status: 200, json: { ok: true, status: 'running' } });
      return;
    }
    await route.fallback();
  });

  await gotoUiPage(earlyCancelPage, baseUrl);
  await earlyCancelPage.getByRole('textbox', { name: '微博链接、mid 或 bid' })
    .fill('https://weibo.com/2715025067/CandidateEarlyCancelTest');
  await earlyCancelPage.getByRole('button', { name: /载入候选/ }).click();
  await createRequestSeen;
  const earlyCancelRequest = earlyCancelPage.waitForRequest((request) => (
    request.method() === 'DELETE'
    && new URL(request.url()).pathname.endsWith('/candidate-early-cancel-test')
  ));
  await earlyCancelPage.getByRole('button', { name: '取消载入' }).click();
  const cancelledRequest = await earlyCancelRequest;
  assert.equal(cancelledRequest.headers()['x-job-cancel-token'], 'candidate-early-cancel-token');
  await earlyCancelPage.waitForFunction(() => document.querySelector('[data-app-status]')?.textContent?.includes('候选载入已取消'));
  await earlyCancelPage.getByRole('button', { name: '取消载入' }).waitFor({ state: 'detached' });
  assert.equal(earlyDeleteCount, 1, '创建响应返回前取消也必须停止服务器任务');
  assert.equal(earlyPollCount, 0, '已取消的创建请求不应进入轮询');
  assert.deepEqual(earlyCancelErrors, []);
  await earlyCancelPage.close();
} finally {
  await browser.close();
}

console.log('CANDIDATE_LOAD_UI_OK');
