import assert from 'node:assert/strict';

import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const browser = await launchUiBrowser();

async function drawOnce(page) {
  await page.locator('.root-tabbar button').filter({ hasText: '抽奖' }).click();
  const readyButton = page.locator('.draw-ready .primary-button');
  if (await readyButton.isVisible().catch(() => false)) {
    await readyButton.click();
  } else {
    await page.getByRole('button', { name: '设置并再次抽奖' }).click();
  }
  const prizeDialog = page.getByRole('dialog', { name: '奖项设置' });
  if (await prizeDialog.count()) {
    await prizeDialog.getByRole('button', { name: '确认奖项设置' }).click();
  }
  const confirmSheet = page.getByRole('dialog', { name: '开奖前确认' });
  await confirmSheet.waitFor({ state: 'visible' });
  await confirmSheet.getByRole('button', { name: '确认并开始抽奖' }).click();
  await confirmSheet.waitFor({ state: 'detached' });
  const resultSheet = page.getByRole('dialog', { name: '开奖结果' });
  await resultSheet.waitFor({ state: 'visible' });
  const winner = (
    await resultSheet.locator('.receipt-single-winner strong, .receipt-winner strong').first().textContent()
  ).trim();
  await resultSheet.getByRole('button', { name: '关闭开奖结果' }).click();
  await resultSheet.waitFor({ state: 'detached' });
  return winner;
}

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await gotoUiPage(page, baseUrl);
  await page.locator('.root-tabbar button').filter({ hasText: '名单' }).click();
  await page.getByRole('button', { name: '手动名单', exact: true }).click();
  await page.getByRole('textbox', { name: '手动候选名单' }).fill('小柚子\n森森\n月岛');
  await page.getByRole('button', { name: '替换名单', exact: true }).click();

  const firstWinner = await drawOnce(page);
  assert.ok(firstWinner, '手动名单首次开奖应产生中奖用户');

  await page.locator('.root-tabbar button').filter({ hasText: '名单' }).click();
  await page.getByRole('button', { name: /^已排除 \d+$/ }).click();
  const excludedRow = page.locator('.people-list button').filter({ hasText: firstWinner });
  await excludedRow.waitFor({ state: 'visible' });
  assert.equal(
    await excludedRow.getByText('已中奖', { exact: true }).isVisible(),
    true,
    '手动名单开奖后应立即把中奖用户列入已排除',
  );

  const secondWinner = await drawOnce(page);
  assert.notEqual(secondWinner, firstWinner, '第二次手动开奖不应再次抽中已中奖用户');
  assert.deepEqual(errors, []);

  await context.close();
} finally {
  await browser.close();
}

console.log('MANUAL_REPEAT_EXCLUSION_UI_OK');
