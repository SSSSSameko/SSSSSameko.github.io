import assert from 'node:assert/strict';

import { chromium } from 'playwright';

const executablePath = process.env.PLAYWRIGHT_CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const baseUrl = process.env.UI_CONSOLE_URL
  || process.env.DRAW_UI_URL
  || 'http://127.0.0.1:5195/';
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];

page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);

await page.getByRole('button', { name: '设置', exact: true }).click();
await page.getByRole('button', { name: /清空当前抽奖/ }).click();
const clearDialog = page.getByRole('alertdialog', { name: '清空当前抽奖？' });
await clearDialog.waitFor({ state: 'visible' });
assert.equal(await clearDialog.isVisible(), true);
assert.equal(await clearDialog.getByRole('button', { name: '取消', exact: true }).isVisible(), true);
await clearDialog.getByRole('button', { name: '取消', exact: true }).click();
await clearDialog.waitFor({ state: 'detached' });

await page.getByRole('button', { name: '设置', exact: true }).click();
await page.locator('.flow-connection-details summary').click();
assert.equal(await page.getByPlaceholder('https://111.228.11.206').isVisible(), true);
const settingsActionLabels = await page.locator('.flow-settings-action-label').evaluateAll((labels) => (
  labels.map((label) => ({
    height: label.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(getComputedStyle(label).lineHeight),
  }))
));
assert.equal(settingsActionLabels.every(({ height, lineHeight }) => height <= lineHeight * 1.5), true);

const layout = await page.evaluate(() => ({
  viewport: window.innerWidth,
  pageWidth: document.documentElement.scrollWidth,
  unnamedButtons: [...document.querySelectorAll('button')]
    .filter((button) => !String(button.innerText || button.getAttribute('aria-label') || button.title || '').trim())
    .length,
}));
await browser.close();

if (errors.length) {
  throw new Error(errors.join('\n'));
}
if (layout.pageWidth > layout.viewport || layout.unnamedButtons) {
  throw new Error(`UI layout check failed: ${JSON.stringify(layout)}`);
}

console.log('UI_CONSOLE_OK');
