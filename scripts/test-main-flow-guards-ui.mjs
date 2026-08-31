import assert from 'node:assert/strict';

import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const historyKey = 'weibo-draw-history-v2';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const localReceipt = {
  id: 'local-history-a',
  source: 'mobile',
  statusId: '1111111111',
  statusUrl: 'https://weibo.com/2715025067/HistoryA',
  drawnAt: '2026-08-27T02:00:00.000Z',
  results: [{
    prize: { name: '历史奖', count: 1, color: '#ee8fa1' },
    winners: [{ id: 'history-winner', uid: '1001', screenName: '历史中奖用户', avatar: '' }],
  }],
  candidateCount: 3,
  eligibleCount: 3,
  rules: {
    filters: { keyword: '', mentionMin: 0, uniqueByUser: true, excludePrevious: true },
    prizes: [{ name: '历史奖', count: 1, color: '#ee8fa1' }],
  },
  sourceMeta: { provider: 'mobile', complete: true, loadedAt: '2026-08-27T01:59:00.000Z' },
  seed: 'history-seed',
  candidateDigest: 'history-candidate-digest',
  recordState: 'local',
};

const browser = await launchUiBrowser();
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  await context.addInitScript(({ key, receipt }) => {
    localStorage.setItem(key, JSON.stringify({ version: 2, items: [receipt] }));
    localStorage.setItem('weibo-draw-motion', 'system');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    document.execCommand = () => false;
  }, { key: historyKey, receipt: localReceipt });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  let saveCount = 0;

  await page.route('**/api/weibo/draw-count**', (route) => route.fulfill({
    status: 200,
    json: { ok: true, statusId: '2222222222', drawCount: 7, lastDrawnAt: '' },
  }));
  await page.route('**/api/weibo/reposts/jobs', (route) => route.fulfill({
    status: 200,
    json: {
      ok: true,
      jobId: '',
      status: 'done',
      delivery: 'fresh',
      progress: { phase: 'done', percent: 100, message: '载入完成' },
      result: {
        ok: true,
        statusId: '2222222222',
        statusUrl: 'https://weibo.com/2715025067/CurrentB',
        drawCount: 7,
        candidates: [{
          id: 'current-candidate',
          uid: '2001',
          screenName: '当前候选',
          text: '转发微博',
          source: 'desktop-cookie',
        }],
        meta: {
          provider: 'desktop-cookie',
          complete: true,
          loadedAt: new Date().toISOString(),
          pages: [{ page: 1, count: 1 }],
        },
      },
    },
  }));
  await page.route('**/api/draws', async (route) => {
    saveCount += 1;
    await sleep(220);
    await route.fulfill({
      status: 200,
      json: {
        ok: true,
        file: 'draw-history-a.json',
        statusId: '1111111111',
        statusUrl: 'https://weibo.com/2715025067/HistoryA',
        drawNumber: 4,
        drawCount: 4,
        savedAt: new Date().toISOString(),
        auditHash: 'history-a-audit-hash',
      },
    });
  });

  await gotoUiPage(page, baseUrl);
  await page.getByRole('button', { name: '查看全部', exact: true }).click();
  const historyTab = page.locator('.root-tabbar [data-tab-target="history"]');
  await page.waitForFunction(
    (element) => element === document.activeElement,
    await historyTab.elementHandle(),
  );
  await page.locator('.root-tabbar [data-tab-target="home"]').click();

  const homeStatusInput = page.getByRole('textbox', { name: '微博链接、mid 或 bid' });
  await homeStatusInput.fill('https://weibo.com/2715025067/Temporary');
  await page.getByRole('button', { name: /手动导入候选名单/ }).click();
  const sourceSheet = page.getByRole('dialog', { name: '候选来源' });
  await sourceSheet.getByRole('button', { name: '关闭候选来源' }).click();
  await sourceSheet.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '清空微博链接' }).click();
  assert.equal(await homeStatusInput.evaluate((element) => element === document.activeElement), true);

  await page.getByRole('textbox', { name: '微博链接、mid 或 bid' })
    .fill('https://weibo.com/2715025067/CurrentB');
  await page.getByRole('button', { name: /载入候选/ }).click();
  await page.getByText('1 名候选 · 1 个奖项 · 1 个名额', { exact: true }).waitFor();

  await page.locator('.root-tabbar button').filter({ hasText: '名单' }).click();
  await page.getByRole('button', { name: /当前候选/ }).click();
  const candidateDialog = page.getByRole('dialog', { name: '候选详情' });
  await candidateDialog.getByRole('button', { name: '复制昵称' }).click();
  const copyError = page.getByRole('alertdialog');
  assert.equal(await copyError.getByText(/复制失败/).isVisible(), true);
  assert.match(await page.locator('[data-app-status="error"]').textContent(), /复制失败/);
  assert.equal(
    await page.locator('[data-app-status="error"]').getAttribute('aria-live'),
    'off',
    '错误弹窗存在时状态区域不应重复播报',
  );
  await copyError.getByRole('button', { name: '知道了' }).click();
  assert.match(await candidateDialog.getByRole('button', { name: '复制昵称' }).textContent(), /复制昵称/);
  await candidateDialog.getByRole('button', { name: '关闭候选详情' }).click();
  await candidateDialog.waitFor({ state: 'detached' });

  await page.locator('.root-tabbar button').filter({ hasText: '记录' }).click();
  await page.locator('.history-list > button').first().click();
  const resultDialog = page.getByRole('dialog', { name: '开奖结果' });
  const retryButton = resultDialog.getByRole('button', { name: '重新保存' });
  await retryButton.evaluate((button) => {
    button.click();
    button.click();
  });
  await resultDialog.getByRole('button', { name: '关闭开奖结果' }).click();
  await resultDialog.waitFor({ state: 'detached' });
  await page.waitForTimeout(350);
  assert.equal(saveCount, 1, '快速重复点击只能发送一次保存请求');
  assert.equal(await resultDialog.count(), 0, '关闭后返回的保存响应不能重新打开旧结果');

  await page.locator('.root-tabbar button').filter({ hasText: '抽奖' }).click();
  assert.equal(await page.getByText('此前已完成 7 次', { exact: true }).first().isVisible(), true);
  await context.close();

  const syncErrorContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  await syncErrorContext.addInitScript(() => {
    localStorage.setItem('weibo-draw-motion', 'system');
  });
  const syncErrorPage = await syncErrorContext.newPage();
  syncErrorPage.setDefaultTimeout(8_000);
  await syncErrorPage.route('**/api/draws', async (route) => {
    await route.fulfill({
      status: 503,
      json: { ok: false, error: '模拟开奖记录服务不可用' },
    });
  });
  await gotoUiPage(syncErrorPage, baseUrl);
  await syncErrorPage.locator('.root-tabbar button').filter({ hasText: '名单' }).click();
  await syncErrorPage.getByRole('button', { name: '手动名单', exact: true }).click();
  await syncErrorPage.getByRole('textbox', { name: '手动候选名单' }).fill('同步失败候选');
  await syncErrorPage.getByRole('button', { name: '替换名单', exact: true }).click();
  await syncErrorPage.locator('.root-tabbar button').filter({ hasText: '抽奖' }).click();
  await syncErrorPage.getByRole('button', { name: /设置奖项并确认/ }).click();
  await syncErrorPage.getByRole('dialog', { name: '奖项设置' })
    .getByRole('button', { name: '确认奖项设置' }).click();
  await syncErrorPage.getByRole('dialog', { name: '开奖前确认' })
    .getByRole('button', { name: '确认并开始抽奖' }).click();

  const syncingResult = syncErrorPage.getByRole('dialog', { name: '开奖结果' });
  await syncingResult.waitFor({ state: 'visible' });
  await syncingResult.locator('.receipt-local-note strong').getByText('未计入开奖次数', { exact: true }).waitFor();
  const syncError = syncErrorPage.getByRole('alertdialog', { name: '开奖记录未同步' });
  await syncError.waitFor({ state: 'visible' });
  assert.equal(await syncingResult.isVisible(), true, '同步错误出现时本机结果仍应保留');
  assert.equal(
    await syncError.evaluate((dialog) => dialog.contains(document.activeElement)),
    true,
    '同步错误应成为唯一的顶层键盘焦点',
  );
  await syncErrorPage.keyboard.press('Escape');
  await syncError.waitFor({ state: 'detached' });
  assert.equal(await syncingResult.isVisible(), true, '关闭同步错误不应同时关闭开奖结果');
  await syncErrorPage.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '关闭开奖结果');
  assert.equal(
    await syncingResult.getByRole('button', { name: '关闭开奖结果' })
      .evaluate((button) => button === document.activeElement),
    true,
    '同步错误关闭后应把焦点还给开奖结果',
  );
  await syncErrorContext.close();

  const syncRaceContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  await syncRaceContext.addInitScript(() => {
    localStorage.setItem('weibo-draw-motion', 'system');
  });
  const syncRacePage = await syncRaceContext.newPage();
  syncRacePage.setDefaultTimeout(8_000);
  const oldStatusUrl = 'https://weibo.com/2715025067/SyncOld';
  const nextStatusUrl = 'https://weibo.com/2715025067/SyncNext';
  let releaseOldSave = () => {};
  let signalOldSaveStarted;
  let signalOldSaveSettled;
  const oldSaveStarted = new Promise((resolve) => { signalOldSaveStarted = resolve; });
  const oldSaveSettled = new Promise((resolve) => { signalOldSaveSettled = resolve; });

  await syncRacePage.route('**/api/weibo/draw-count**', (route) => {
    const target = new URL(route.request().url()).searchParams.get('statusUrl') || '';
    const nextTask = target.includes('SyncNext');
    return route.fulfill({
      status: 200,
      json: {
        ok: true,
        statusId: nextTask ? '5555555555' : '4444444444',
        drawCount: nextTask ? 9 : 3,
        lastDrawnAt: '',
      },
    });
  });
  await syncRacePage.route('**/api/weibo/reposts/jobs', (route) => {
    const payload = route.request().postDataJSON();
    const nextTask = String(payload.statusUrl || '').includes('SyncNext');
    const statusId = nextTask ? '5555555555' : '4444444444';
    const statusUrl = nextTask ? nextStatusUrl : oldStatusUrl;
    return route.fulfill({
      status: 200,
      json: {
        ok: true,
        jobId: '',
        status: 'done',
        delivery: 'fresh',
        progress: { phase: 'done', percent: 100, message: '载入完成' },
        result: {
          ok: true,
          statusId,
          statusUrl,
          drawCount: nextTask ? 9 : 3,
          candidates: [{
            id: nextTask ? 'next-candidate' : 'old-candidate',
            uid: nextTask ? '5001' : '4001',
            screenName: nextTask ? '切换后候选' : '旧任务候选',
            text: '转发微博',
            source: 'desktop-cookie',
          }],
          meta: {
            provider: 'desktop-cookie',
            complete: true,
            loadedAt: new Date().toISOString(),
            pages: [{ page: 1, count: 1 }],
          },
        },
      },
    });
  });
  await syncRacePage.route('**/api/draws', async (route) => {
    const payload = route.request().postDataJSON();
    if (payload.statusId === '4444444444') {
      await new Promise((resolve) => {
        releaseOldSave = resolve;
        signalOldSaveStarted();
      });
      await route.fulfill({
        status: 200,
        json: {
          ok: true,
          file: 'draw-sync-old.json',
          statusId: '4444444444',
          statusUrl: oldStatusUrl,
          drawNumber: 41,
          drawCount: 41,
          savedAt: new Date().toISOString(),
        },
      });
      signalOldSaveSettled();
      return;
    }
    await route.fulfill({
      status: 200,
      json: {
        ok: true,
        file: 'draw-sync-next.json',
        statusId: '5555555555',
        statusUrl: nextStatusUrl,
        drawNumber: 10,
        drawCount: 10,
        savedAt: new Date().toISOString(),
        auditHash: 'next-task-audit-hash',
      },
    });
  });

  try {
    await gotoUiPage(syncRacePage, baseUrl);
    const raceStatusInput = syncRacePage.getByRole('textbox', { name: '微博链接、mid 或 bid' });
    await raceStatusInput.fill(oldStatusUrl);
    await syncRacePage.getByRole('button', { name: /载入候选/ }).click();
    await syncRacePage.getByText('1 名候选 · 1 个奖项 · 1 个名额', { exact: true }).waitFor();
    await syncRacePage.getByRole('button', { name: /设置奖项并确认/ }).click();
    await syncRacePage.getByRole('dialog', { name: '奖项设置' })
      .getByRole('button', { name: '确认奖项设置' }).click();
    await syncRacePage.getByRole('dialog', { name: '开奖前确认' })
      .getByRole('button', { name: '确认并开始抽奖' }).click();
    await Promise.race([
      oldSaveStarted,
      sleep(8_000).then(() => { throw new Error('旧任务保存请求未开始'); }),
    ]);

    const oldResult = syncRacePage.getByRole('dialog', { name: '开奖结果' });
    await oldResult.getByText('旧任务候选', { exact: true }).first().waitFor();
    await oldResult.getByRole('button', { name: '关闭开奖结果' }).click();
    await oldResult.waitFor({ state: 'detached' });

    await syncRacePage.locator('.root-tabbar button').filter({ hasText: '名单' }).click();
    await syncRacePage.getByRole('textbox', { name: '微博链接、mid 或 bid' }).fill(nextStatusUrl);
    await syncRacePage.getByRole('button', { name: /载入候选/ }).click();
    await syncRacePage.getByRole('button', { name: /切换后候选/ }).waitFor();
    await syncRacePage.locator('.root-tabbar button').filter({ hasText: '抽奖' }).click();
    await syncRacePage.getByRole('button', { name: /设置奖项并确认/ }).click();
    await syncRacePage.getByRole('dialog', { name: '奖项设置' })
      .getByRole('button', { name: '确认奖项设置' }).click();
    await syncRacePage.getByRole('dialog', { name: '开奖前确认' })
      .getByRole('button', { name: '确认并开始抽奖' }).click();

    const nextResult = syncRacePage.getByRole('dialog', { name: '开奖结果' });
    await nextResult.getByText('切换后候选', { exact: true }).first().waitFor();
    releaseOldSave();
    await Promise.race([
      oldSaveSettled,
      sleep(8_000).then(() => { throw new Error('旧任务保存请求未结束'); }),
    ]);
    await syncRacePage.waitForTimeout(100);
    assert.equal(await nextResult.isVisible(), true, '旧任务保存响应不能替换正在查看的新结果');
    assert.equal(await nextResult.getByText('切换后候选', { exact: true }).first().isVisible(), true);
    assert.equal(await syncRacePage.getByRole('alertdialog').count(), 0, '旧任务同步错误不应覆盖新任务');
    assert.equal(
      await nextResult.getByText('本链接第 10 次开奖', { exact: true }).isVisible(),
      true,
      '旧任务保存响应不能改写当前链接的开奖次数',
    );
    assert.doesNotMatch(
      await syncRacePage.locator('[data-app-status]').textContent(),
      /开奖记录未同步/,
    );
  } finally {
    releaseOldSave();
    await syncRaceContext.close();
  }

  const feedbackContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  const feedbackPage = await feedbackContext.newPage();
  let feedbackCount = 0;
  let feedbackPayload = null;
  await feedbackPage.route('**/api/feedback', async (route) => {
    feedbackCount += 1;
    feedbackPayload = route.request().postDataJSON();
    await sleep(180);
    await route.fulfill({ status: 201, json: { ok: true, id: 'single-feedback' } });
  });
  await gotoUiPage(feedbackPage, baseUrl);
  await feedbackPage.getByRole('button', { name: '更多', exact: true }).click();
  await feedbackPage.getByRole('button', { name: /意见反馈/ }).click();
  const feedbackDialog = feedbackPage.getByRole('dialog', { name: '意见反馈' });
  await feedbackDialog.getByRole('radio', { name: /遇到问题/ }).click();
  await feedbackDialog.getByRole('textbox').fill('快速点击提交时只应发送一次。');
  await feedbackDialog.getByRole('button', { name: '提交反馈' }).evaluate((button) => {
    button.click();
    button.click();
  });
  await feedbackDialog.getByText('谢谢你的反馈', { exact: true }).waitFor();
  assert.equal(feedbackCount, 1, '快速重复点击只能提交一次反馈');
  assert.deepEqual(feedbackPayload, { category: 'problem', content: '快速点击提交时只应发送一次。' });
  await feedbackContext.close();

  const fileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  await fileContext.addInitScript(() => {
    const originalText = File.prototype.text;
    File.prototype.text = async function delayedText() {
      await new Promise((resolve) => setTimeout(resolve, 180));
      return originalText.call(this);
    };
  });
  const filePage = await fileContext.newPage();
  await gotoUiPage(filePage, baseUrl);
  await filePage.locator('.root-tabbar button').filter({ hasText: '名单' }).click();
  await filePage.getByRole('button', { name: '手动名单', exact: true }).click();
  const fileInput = filePage.locator('.v3-source-section .v3-file-action input');
  await fileInput.focus();
  assert.equal(
    await fileInput.evaluate((input) => input.parentElement.matches(':focus-within')),
    true,
    '文件选择器获得键盘焦点时应显示父级焦点状态',
  );
  assert.equal(
    await fileInput.evaluate((input) => getComputedStyle(input.parentElement).outlineStyle),
    'solid',
  );
  await fileInput.setInputFiles({ name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('第一份名单') });
  await fileInput.setInputFiles({ name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('第二份名单') });
  await filePage.getByRole('textbox', { name: '手动候选名单' }).waitFor();
  await filePage.waitForFunction(() => document.querySelector('[name="manualCandidateInput"]')?.value === '第一份名单');
  assert.equal(await filePage.getByRole('textbox', { name: '手动候选名单' }).inputValue(), '第一份名单');
  await fileContext.close();

  const storageContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  await storageContext.addInitScript(() => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function guardedSetItem(key, value) {
      if (key === 'weibo-draw-storage-check' || key === 'weibo-draw-cooldowns-v1') {
        throw new DOMException('storage blocked', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    };
  });
  const storagePage = await storageContext.newPage();
  await storagePage.route('**/api/weibo/draw-count**', (route) => route.fulfill({
    status: 200,
    json: { ok: true, statusId: '3333333333', drawCount: 0, lastDrawnAt: '' },
  }));
  await storagePage.route('**/api/weibo/reposts/jobs', (route) => route.fulfill({
    status: 200,
    json: {
      ok: true,
      jobId: '',
      status: 'done',
      progress: { phase: 'done', percent: 100, message: '载入完成' },
      result: {
        ok: true,
        statusId: '3333333333',
        statusUrl: 'https://weibo.com/2715025067/StorageCheck',
        drawCount: 0,
        candidates: [{ id: 'storage-candidate', uid: '3001', screenName: '存储测试候选' }],
        meta: { provider: 'mobile', complete: true, loadedAt: new Date().toISOString(), pages: [] },
      },
    },
  }));
  await gotoUiPage(storagePage, baseUrl);
  await storagePage.getByRole('textbox', { name: '微博链接、mid 或 bid' })
    .fill('https://weibo.com/2715025067/StorageCheck');
  await storagePage.getByRole('button', { name: /载入候选/ }).click();
  await storagePage.getByRole('button', { name: /设置奖项并确认/ }).click();
  const prizeDialog = storagePage.getByRole('dialog', { name: '奖项设置' });
  await prizeDialog.getByRole('button', { name: '确认奖项设置' }).click();
  const confirmDialog = storagePage.getByRole('dialog', { name: '开奖前确认' });
  const storageConfirmText = await confirmDialog.textContent();
  assert.match(storageConfirmText, /当前页面内成功开奖后一分钟内不能重复开奖/, storageConfirmText);
  await storageContext.close();
} finally {
  await browser.close();
}

console.log('MAIN_FLOW_GUARDS_UI_OK');
