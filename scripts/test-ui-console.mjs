import assert from 'node:assert/strict';

import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';
const baseUrl = process.env.UI_CONSOLE_URL
  || process.env.DRAW_UI_URL
  || 'http://127.0.0.1:5195/';
const browser = await launchUiBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];

page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

await gotoUiPage(page, baseUrl);
await page.waitForTimeout(700);
assert.equal(await page.locator('.app-shell').getAttribute('data-motion'), 'system');

await page.getByRole('button', { name: '设置', exact: true }).click();
await page.getByRole('button', { name: /清空当前抽奖/ }).click();
const clearDialog = page.getByRole('alertdialog', { name: '清空当前抽奖？' });
await clearDialog.waitFor({ state: 'visible' });
assert.equal(await clearDialog.isVisible(), true);
assert.equal(await clearDialog.getByRole('button', { name: '取消', exact: true }).isVisible(), true);
await clearDialog.getByRole('button', { name: '取消', exact: true }).click();
await clearDialog.waitFor({ state: 'detached' });

await page.getByRole('button', { name: '设置', exact: true }).click();
await page.locator('.flow-connection-details').filter({ hasText: '后端连接' }).locator('summary').click();
assert.equal(await page.getByPlaceholder('仅支持预配置地址或本机地址').isVisible(), true);
const settingsActionLabels = await page.locator('.flow-settings-action-label').evaluateAll((labels) => (
  labels.map((label) => ({
    height: label.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(getComputedStyle(label).lineHeight),
  }))
));
assert.equal(settingsActionLabels.every(({ height, lineHeight }) => height <= lineHeight * 1.5), true);
await page.locator('.flow-sheet-close').click();
await page.locator('.root-tabbar button').filter({ hasText: '名单' }).click();
await page.locator('.v3-source-control').getByRole('button', { name: '官方接口', exact: true }).click();
assert.equal(await page.getByPlaceholder('微博正文链接、mid 或 bid', { exact: true }).isVisible(), true);
assert.equal(await page.getByPlaceholder('输入官方访问令牌').isVisible(), true);

const layout = await page.evaluate(() => ({
  viewport: window.innerWidth,
  pageWidth: document.documentElement.scrollWidth,
  unnamedButtons: [...document.querySelectorAll('button')]
    .filter((button) => !String(button.innerText || button.getAttribute('aria-label') || button.title || '').trim())
    .length,
  }));
await page.locator('.root-tabbar button').filter({ hasText: '抽奖' }).click();
await page.setViewportSize({ width: 320, height: 568 });
await page.waitForTimeout(80);
const shortViewport = await page.evaluate(() => {
  const shell = document.querySelector('.app-shell')?.getBoundingClientRect();
  const tabbar = document.querySelector('.root-tabbar')?.getBoundingClientRect();
  const primaryAction = document.querySelector('.draw-studio.is-empty .v3-load-button')?.getBoundingClientRect();
  return {
    viewportHeight: window.visualViewport?.height || window.innerHeight,
    shellBottom: shell?.bottom || 0,
    primaryActionBottom: primaryAction?.bottom || 0,
    tabbarTop: tabbar?.top || 0,
    tabbarBottom: tabbar?.bottom || 0,
  };
});
await browser.close();

if (errors.length) {
  throw new Error(errors.join('\n'));
}
if (layout.pageWidth > layout.viewport || layout.unnamedButtons) {
  throw new Error(`UI layout check failed: ${JSON.stringify(layout)}`);
}
assert.ok(shortViewport.shellBottom <= shortViewport.viewportHeight + 1, JSON.stringify(shortViewport));
assert.ok(shortViewport.tabbarBottom <= shortViewport.viewportHeight + 1, JSON.stringify(shortViewport));
assert.ok(shortViewport.primaryActionBottom <= shortViewport.tabbarTop - 6, JSON.stringify(shortViewport));

console.log('UI_CONSOLE_OK');
