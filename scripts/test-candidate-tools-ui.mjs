import assert from 'node:assert/strict';

import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const browser = await launchUiBrowser();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  reducedMotion: 'reduce',
});
const errors = [];

page.on('pageerror', (error) => errors.push(error.message));

try {
  await gotoUiPage(page, baseUrl);
  await page.locator('.root-tabbar button').filter({ hasText: '名单' }).click();
  await page.getByRole('button', { name: '手动名单', exact: true }).click();
  await page.getByRole('textbox', { name: '手动候选名单' }).fill([
    'uid,screenName,text,createdAt,source',
    '1001,小花,转发抽奖,2026-08-27T08:00:00.000Z,manual',
    '1001,小花重复,转发抽奖,2026-08-27T08:01:00.000Z,manual',
    '1002,小蓝,普通转发,2026-08-27T08:02:00.000Z,manual',
  ].join('\n'));
  await page.getByRole('button', { name: '替换名单', exact: true }).click();

  const excludedSegment = page.getByRole('button', { name: '已排除 1', exact: true });
  await excludedSegment.waitFor({ state: 'visible' });
  await excludedSegment.click();
  await page.setViewportSize({ width: 320, height: 700 });
  await page.getByRole('button', { name: /小花重复/ }).click();

  const candidateDialog = page.getByRole('dialog', { name: '候选详情' });
  await candidateDialog.waitFor({ state: 'visible' });
  assert.equal(await candidateDialog.getByText('重复转发', { exact: true }).first().isVisible(), true);
  assert.equal(await candidateDialog.getByText('同一用户已有一条转发进入候选', { exact: true }).isVisible(), true);
  const candidateLayout = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    pageWidth: document.documentElement.scrollWidth,
    dialogWidth: document.querySelector('.candidate-detail-sheet')?.getBoundingClientRect().width || 0,
  }));
  assert.ok(candidateLayout.dialogWidth <= candidateLayout.viewport + 1, JSON.stringify(candidateLayout));
  assert.ok(candidateLayout.pageWidth <= candidateLayout.viewport + 1, JSON.stringify(candidateLayout));

  await candidateDialog.getByRole('button', { name: '关闭候选详情' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const exportButton = page.getByRole('button', { name: /导出开奖记录/ });
  assert.equal(await exportButton.isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: /恢复开奖记录/ }).isVisible(), true);
  const cookieDetails = page.locator('.flow-connection-details').filter({ hasText: '备用 Cookie' });
  await cookieDetails.locator('summary').click();
  assert.equal(await page.getByPlaceholder('粘贴本人有权使用的微博 Cookie…').isVisible(), true);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}

console.log('CANDIDATE_TOOLS_UI_OK');
