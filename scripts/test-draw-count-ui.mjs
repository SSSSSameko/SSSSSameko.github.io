import assert from 'node:assert/strict';
import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const statusId = '5360541620244396';
const browser = await launchUiBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('weibo-draw-motion', 'system'));
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let releaseOldCount;
  const oldCount = new Promise((resolve) => { releaseOldCount = resolve; });
  let countCalls = 0;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/health') return route.fulfill({ json: { ok: true, authRequired: true } });
    if (path === '/api/weibo/cookie-status') return route.fulfill({ json: { ok: true, hasCookie: true } });
    if (path === '/api/weibo/draw-count') {
      const call = ++countCalls;
      if (call === 1) {
        await oldCount;
        return route.fulfill({ json: { ok: true, drawCount: 2 } }).catch(() => {});
      }
      if (request.headers()['x-api-key'] === 'new-count-key') {
        return route.fulfill({ json: { ok: true, drawCount: 11 } });
      }
      return route.fulfill({ status: 401, json: { ok: false, error: '需要更新访问密钥' } });
    }
    if (path === '/api/weibo/reposts/jobs') return route.fulfill({ json: {
      ok: true, status: 'done', result: {
        ok: true, statusId, statusUrl: `https://weibo.com/1/${statusId}`, drawCount: 9,
        candidates: [{ uid: 'test-1', screenName: '次数回归候选' }],
        meta: { provider: 'desktop-cookie', complete: true, loadedAt: new Date().toISOString() },
      },
    } });
    return route.fulfill({ status: 404, json: { ok: false, error: 'unexpected test endpoint' } });
  });
  await gotoUiPage(page, baseUrl);
  const countStarted = page.waitForRequest('**/api/weibo/draw-count?*');
  await page.getByRole('textbox', { name: '微博链接、mid 或 bid' }).fill(statusId);
  await countStarted;
  await page.getByRole('button', { name: /载入候选/ }).click();
  const counter = page.locator('.v3-draw-count');
  await counter.getByText('此前已完成 9 次', { exact: true }).waitFor();
  releaseOldCount();
  await page.waitForTimeout(250);
  assert.match(await counter.innerText(), /此前已完成 9 次/, '较早的次数查询不能覆盖载入任务返回的新次数');

  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.locator('[data-settings-section="backend"] summary').click();
  await settings.locator('input[name="backendAccessKey"]').fill('new-count-key');
  await page.waitForFunction(() => document.querySelector('.v3-draw-count')?.textContent.includes('此前已完成 11 次'));
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'detached' });
  assert.ok(countCalls >= 2, '更新密钥应重新读取当前链接的开奖次数');
  assert.deepEqual(errors, []);
  await context.close();

  // New links and backends must invalidate the old response before the debounce fires.
  for (const change of ['link', 'invalid-link', 'backend']) {
    const raceContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await raceContext.addInitScript(() => localStorage.setItem('weibo-draw-motion', 'system'));
    const racePage = await raceContext.newPage();
    racePage.setDefaultTimeout(7000);
    racePage.on('pageerror', (error) => errors.push(error.message));
    let release;
    const pendingCount = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    let hold = false;
    await racePage.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/count-backend(?=\/api\/)/, '');
      if (path === '/api/weibo/draw-count') {
        if (!hold) return route.fulfill({ json: { ok: true, drawCount: 9 } });
        const call = ++calls;
        if (call === 1) await pendingCount;
        return route.fulfill({ json: { ok: true, drawCount: call === 1 ? 2 : 11 } }).catch(() => {});
      }
      if (path === '/api/weibo/reposts/jobs') return route.fulfill({ json: {
        ok: true, status: 'done', result: {
          ok: true, statusId, drawCount: 9,
          candidates: [{ uid: 'context-count-test', screenName: '上下文回归候选' }],
          meta: { complete: true, provider: 'desktop-cookie' },
        },
      } });
      return route.fulfill({ json: { ok: true, hasCookie: true } });
    });
    await gotoUiPage(racePage, baseUrl);
    await racePage.getByRole('textbox', { name: '微博链接、mid 或 bid' }).fill(statusId);
    await racePage.getByRole('button', { name: /载入候选/ }).click();
    await racePage.locator('.v3-draw-count').getByText('此前已完成 9 次', { exact: true }).waitFor();
    await racePage.getByRole('button', { name: '设置', exact: true }).click();
    const sheet = racePage.getByRole('dialog', { name: '设置', exact: true });
    await sheet.locator('[data-settings-section="backend"] summary').click();
    hold = true;
    const first = racePage.waitForRequest('**/api/weibo/draw-count?*');
    await sheet.locator('input[name="backendAccessKey"]').fill('context-race-key');
    await first;
    if (change === 'backend') {
      await sheet.getByRole('button', { name: '手动填写地址' }).click();
      // A second mocked backend under the same origin also works with the server's strict CSP.
      await sheet.locator('input[name="backendAddress"]').fill(new URL('/count-backend', baseUrl).href);
      await sheet.getByRole('button', { name: '保存并使用' }).click();
    } else {
      await racePage.keyboard.press('Escape');
      await sheet.waitFor({ state: 'detached' });
      await racePage.getByRole('tab', { name: '名单', exact: true }).click();
      await racePage.getByRole('textbox', { name: '微博链接、mid 或 bid' }).fill(change === 'link' ? '5360541620244397' : '无效链接');
      await racePage.getByRole('tab', { name: '抽奖', exact: true }).click();
    }
    release();
    await racePage.waitForTimeout(200);
    assert.doesNotMatch(await racePage.locator('.v3-draw-count').textContent(), /此前已完成 2 次/, `${change}: 防抖期间也不能显示旧上下文的次数`);
    if (change === 'invalid-link') {
      await racePage.waitForTimeout(750);
      assert.equal(calls, 1, '无效链接不应触发查询');
    } else {
      await racePage.waitForFunction(() => document.querySelector('.v3-draw-count')?.textContent.includes('此前已完成 11 次'));
    }
    await raceContext.close();
  }

  // A fast load supersedes a scheduled query, and a saved result supersedes an in-flight query.
  const saveContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await saveContext.addInitScript(() => localStorage.setItem('weibo-draw-motion', 'system'));
  const savePage = await saveContext.newPage();
  savePage.setDefaultTimeout(7000);
  savePage.on('pageerror', (error) => errors.push(error.message));
  let releaseSaveCount;
  const pendingSaveCount = new Promise((resolve) => { releaseSaveCount = resolve; });
  let saveCountCalls = 0;
  await savePage.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/weibo/draw-count') {
      saveCountCalls += 1;
      await pendingSaveCount;
      return route.fulfill({ json: { ok: true, drawCount: 2 } }).catch(() => {});
    }
    if (path === '/api/weibo/reposts/jobs') return route.fulfill({ json: {
      ok: true, status: 'done', result: {
        ok: true, statusId, drawCount: 9,
        candidates: [
          { uid: 'count-save-test', screenName: '次数保存回归候选' },
          { uid: 'count-save-test-2', screenName: '另一位次数保存候选' },
        ],
        meta: { provider: 'desktop-cookie', complete: true, loadedAt: new Date().toISOString() },
      },
    } });
    if (path === '/api/draws') return route.fulfill({ json: {
      ok: true, file: 'count-save-fixture.json', statusId, drawNumber: 10, drawCount: 10,
      savedAt: new Date().toISOString(), auditHash: 'count-save-fixture',
    } });
    return route.fulfill({ json: { ok: true, hasCookie: true } });
  });
  await gotoUiPage(savePage, baseUrl);
  // Freeze the debounce while the user immediately starts loading.
  await savePage.clock.install();
  await savePage.clock.pauseAt(new Date(Date.now() + 1000));
  await savePage.getByRole('textbox', { name: '微博链接、mid 或 bid' }).fill(statusId);
  await savePage.getByRole('button', { name: /载入候选/ }).click();
  await savePage.waitForFunction(() => document.querySelector('.v3-draw-count')?.textContent.includes('此前已完成 9 次'));
  await savePage.clock.runFor(800);
  assert.equal(saveCountCalls, 0, '载入成功后应取消尚未开始的防抖查询');
  await savePage.clock.resume();
  await savePage.getByRole('button', { name: '设置', exact: true }).click();
  const saveSettings = savePage.getByRole('dialog', { name: '设置', exact: true });
  await saveSettings.locator('[data-settings-section="backend"] summary').click();
  const pendingStarted = savePage.waitForRequest('**/api/weibo/draw-count?*');
  await saveSettings.locator('input[name="backendAccessKey"]').fill('count-save-key');
  await pendingStarted;
  await savePage.keyboard.press('Escape');
  await saveSettings.waitFor({ state: 'detached' });
  await savePage.getByRole('button', { name: /设置奖项并确认/ }).click();
  await savePage.getByRole('dialog', { name: '奖项设置' }).getByRole('button', { name: '确认奖项设置' }).click();
  await savePage.getByRole('dialog', { name: '开奖前确认' }).getByRole('button', { name: '确认并开始抽奖' }).click();
  const savedResult = savePage.getByRole('dialog', { name: '开奖结果' });
  await savedResult.getByText('本链接第 10 次开奖', { exact: true }).waitFor();
  releaseSaveCount();
  await savePage.waitForTimeout(250);
  await savedResult.getByRole('button', { name: '关闭开奖结果' }).click();
  await savedResult.waitFor({ state: 'detached' });
  await savePage.getByRole('button', { name: '设置并再次抽奖', exact: true }).click();
  await savePage.getByRole('dialog', { name: '奖项设置' }).getByRole('button', { name: '确认奖项设置' }).click();
  const nextConfirm = savePage.getByRole('dialog', { name: '开奖前确认' });
  assert.match(await nextConfirm.locator('.v3-confirm-hero').textContent(), /此前已完成 10 次/, '正式保存返回的次数不能被旧查询覆盖');
  assert.deepEqual(errors, []);
  await saveContext.close();
} finally {
  await browser.close();
}
console.log('DRAW_COUNT_UI_OK');
