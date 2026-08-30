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
    .fill('https://weibo.com/1/CandidateLoadTest');
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
    .fill('https://weibo.com/1/CandidateLongTaskTest');
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
} finally {
  await browser.close();
}

console.log('CANDIDATE_LOAD_UI_OK');
