import assert from 'node:assert/strict';
import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const browser = await launchUiBrowser();
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  await context.addInitScript(() => {
    localStorage.setItem('weibo-draw-motion', 'system');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let cookieCalls = 0;
  let releaseFirstCookie;
  let firstCookieRequested;
  const firstCookie = new Promise((resolve) => {
    releaseFirstCookie = resolve;
  });
  const cookieStarted = new Promise((resolve) => {
    firstCookieRequested = resolve;
  });
  let malformedCandidates = true;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/health')
      return route.fulfill({ json: { ok: true, authRequired: true } });
    if (pathname === '/api/weibo/cookie-status') {
      const call = ++cookieCalls;
      if (call === 1) {
        firstCookieRequested();
        await firstCookie;
      }
      if (request.headers()['x-api-key'] === 'incorrect') {
        return route.fulfill({ status: 401, json: { ok: false, error: '密钥不正确' } });
      }
      return route
        .fulfill({ json: { ok: true, hasCookie: true, verifiedAccountCount: call === 1 ? 9 : 2 } })
        .catch(() => {});
    }
    if (pathname === '/api/weibo/reposts/jobs')
      return route.fulfill({
        json: {
          ok: true,
          status: 'done',
          result: {
            ok: true,
            statusId: '5360541620244396',
            drawCount: null,
            candidates: malformedCandidates
              ? [{ uid: '1001', screenName: { invalid: true } }]
              : [
                  { uid: '1001', screenName: '恢复测试候选' },
                  { uid: '1001', screenName: '恢复测试候选' },
                  { uid: '1002', screenName: '另一位候选' },
                ],
            meta: { complete: false, provider: 'desktop-cookie', totalNumber: 4, visibleNumber: 3,
              missingCount: 1, stopReason: 'within-tolerance', tolerance: 2 },
          },
        },
      });
    if (pathname === '/api/draws')
      return route.fulfill({
        json: {
          ok: true,
          file: 'fixture-draw.json',
          savedAt: new Date().toISOString(),
          drawNumber: 1,
          auditHash: 'fixture-hash',
        },
      });
    return route.fulfill({ json: { ok: true, drawCount: null } });
  });
  await gotoUiPage(page, baseUrl);
  await cookieStarted;
  await page.getByRole('tab', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: /^后端连接/ }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('button', { name: '测试连接', exact: true }).click();
  await settings
    .locator('.flow-app-summary')
    .getByText('2 个已验证服务器登录态', { exact: true })
    .waitFor();
  releaseFirstCookie();
  await page.waitForTimeout(100);
  assert.doesNotMatch(await settings.innerText(), /9 个已验证/);
  const key = settings.locator('input[name="backendAccessKey"]');
  await key.fill('incorrect');
  await settings
    .locator('.flow-app-summary')
    .getByText('登录态状态暂不可用', { exact: true })
    .waitFor();
  await key.fill('correct-fixture-key');
  await settings
    .locator('.flow-app-summary')
    .getByText('2 个已验证服务器登录态', { exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: '抽奖', exact: true }).click();
  await page.getByRole('textbox', { name: '微博链接、mid 或 bid' }).fill('5360541620244396');
  await page.getByRole('button', { name: /载入候选/ }).click();
  await page
    .getByRole('alertdialog')
    .getByText(/候选名单格式异常/)
    .waitFor();
  assert.equal(await page.locator('.app-error').count(), 0, '无效名单不应导致整个页面崩溃');
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog').waitFor({ state: 'detached' });
  malformedCandidates = false;
  await page.getByRole('button', { name: /重新载入候选/ }).click();
  await page.getByText('2 名候选 · 1 个奖项 · 1 个名额', { exact: true }).waitFor();
  const prizes = page.getByRole('dialog', { name: '奖项设置' });
  await page.keyboard.press('Escape');
  await prizes.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  const filters = page.getByRole('dialog', { name: '筛选规则' });
  await filters.getByRole('checkbox', { name: /候选去重/ }).uncheck();
  await filters.getByRole('button', { name: '应用筛选', exact: true }).click();
  await filters.waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: '名单', exact: true }).click();
  await page.getByText(/已取得 3 \/ 4 条，仍差 1 条.*部分名单/).first().waitFor();
  const people = page.locator('.people-list > button');
  await people.nth(2).waitFor();
  assert.equal(await people.count(), 3, '同一用户的转发条目应完整显示');
  const search = page.getByRole('searchbox', { name: '搜索候选' });
  await search.fill('另一位');
  await page.waitForFunction(() => document.querySelectorAll('.people-list > button').length === 1);
  await people.first().scrollIntoViewIfNeeded();
  assert.match(await people.first().textContent(), /另一位候选/);
  await search.fill('');
  await people.nth(2).waitFor();
  assert.equal(await people.count(), 3, '清空搜索后不应丢失或重复渲染条目');
  await page.getByRole('tab', { name: '抽奖', exact: true }).click();
  await page.getByRole('button', { name: /设置奖项并确认/ }).click();
  await prizes.getByRole('spinbutton', { name: '第 1 个奖项中奖人数' }).fill('3');
  await prizes.getByRole('button', { name: '确认奖项设置' }).click();
  await page
    .getByRole('alertdialog')
    .getByText('中奖总人数 3 不能超过可抽人数 2。', { exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog').waitFor({ state: 'detached' });
  await prizes.getByRole('spinbutton', { name: '第 1 个奖项中奖人数' }).fill('2');
  await prizes.getByRole('button', { name: '确认奖项设置' }).click();
  const confirmation = page.getByRole('dialog', { name: '开奖前确认' });
  await confirmation.getByText('历史次数暂未核实', { exact: true }).waitFor();
  await confirmation.getByText(/3 条转发参与抽取，共 2 位用户/).waitFor();
  await confirmation.getByText(/已取得 3 \/ 4 条，仍差 1 条.*部分名单/).waitFor();
  const savedRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/api/draws',
  );
  await confirmation.getByRole('button', { name: '确认并开始抽奖' }).click();
  const saved = (await savedRequest).postDataJSON();
  assert.equal(saved.sourceMeta.complete, false);
  assert.equal(saved.sourceMeta.missingCount, 1);
  assert.equal(saved.sourceMeta.stopReason, 'within-tolerance');
  const winners = saved.results.flatMap((group) => group.winners);
  assert.equal(winners.length, 2);
  assert.equal(
    new Set(winners.map((winner) => winner.uid)).size,
    2,
    '关闭候选去重仍须满足服务器的单轮中奖唯一约束',
  );
  assert.equal(saved.eligibleCount, 3, '保留参与随机排序的全部转发条目');
  const result = page.getByRole('dialog', { name: /开奖结果/ });
  await result.getByText('候选条目 · 可抽 / 载入').first().waitFor();
  await result.getByRole('button', { name: '记录版', exact: true }).click();
  assert.match(await result.locator('.receipt-copy-details pre').innerText(), /载入 3 条候选 · 可抽 3 条/);
  assert.deepEqual(errors, []);
  await context.close();
} finally {
  await browser.close();
}
console.log('ERROR_RECOVERY_UI_OK');
