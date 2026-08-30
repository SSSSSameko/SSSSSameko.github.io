import assert from 'node:assert/strict';

import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const browser = await launchUiBrowser();

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const drawRequests = [];
  const errors = [];

  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/draws') drawRequests.push(request);
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await gotoUiPage(page, baseUrl);
  await page.locator('.root-tabbar button').filter({ hasText: '名单' }).click();
  await page.getByRole('button', { name: '手动名单', exact: true }).click();
  await page.getByRole('textbox', { name: '手动候选名单' }).fill('小柚子\n森森\n月岛\n圆圆');
  await page.getByRole('button', { name: '替换名单', exact: true }).click();

  await page.locator('.root-tabbar button').filter({ hasText: '抽奖' }).click();
  await page.getByRole('button', { name: /设置奖项并确认/ }).click();
  const prizeSheet = page.getByRole('dialog', { name: '奖项设置' });
  await prizeSheet.getByRole('button', { name: '确认奖项设置' }).click();

  const confirmSheet = page.getByRole('dialog', { name: '开奖前确认' });
  await confirmSheet.waitFor({ state: 'visible' });
  assert.equal(await confirmSheet.locator('.v3-confirm-preview').isVisible(), true);
  assert.equal(await confirmSheet.getByText('4', { exact: true }).count() > 0, true);
  assert.equal(await confirmSheet.getByText('可抽人数', { exact: true }).isVisible(), true);
  assert.equal(await confirmSheet.getByRole('button', { name: /本地演练/ }).isVisible(), true);

  await confirmSheet.getByRole('button', { name: /本地演练/ }).click();
  await confirmSheet.waitFor({ state: 'detached' });

  const resultSheet = page.getByRole('dialog', { name: '本地演练结果' });
  await resultSheet.waitFor({ state: 'visible' });
  assert.equal(await resultSheet.getByText('本地演练 · 不计入开奖次数', { exact: true }).isVisible(), true);
  assert.equal(await resultSheet.getByText('仅用于核对动画与设置，不保存记录，也不计入本链接开奖次数。', { exact: true }).isVisible(), true);
  assert.equal(await resultSheet.getByRole('combobox', { name: '公示文案格式' }).isVisible(), true);
  assert.deepEqual(
    await resultSheet.getByRole('combobox', { name: '公示文案格式' }).locator('option').allTextContents(),
    ['简洁版', '分组版', '记录版'],
  );
  assert.equal(await resultSheet.getByRole('button', { name: '重新保存' }).count(), 0);
  assert.equal(drawRequests.length, 0, '本地演练不应请求正式开奖记录接口');
  assert.deepEqual(errors, []);

  await resultSheet.getByRole('button', { name: '关闭开奖结果' }).click();
  await resultSheet.waitFor({ state: 'detached' });
  await page.locator('.root-tabbar button').filter({ hasText: '记录' }).click();
  assert.equal(
    await page.locator('[data-root-view="history"]').getByText('暂无开奖记录', { exact: true }).isVisible(),
    true,
  );
  assert.equal(drawRequests.length, 0, '本地演练不应在关闭结果后写入记录');

  await context.close();
} finally {
  await browser.close();
}

console.log('DRAW_PRACTICE_UI_OK');
