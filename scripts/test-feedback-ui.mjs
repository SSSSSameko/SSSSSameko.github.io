import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const baseUrl = process.env.FEEDBACK_UI_URL || 'http://127.0.0.1:5195/';
const executablePath = process.env.PLAYWRIGHT_CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const outputDir = new URL('../output/ui-checks/', import.meta.url);

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  let submitted = null;
  await page.route('**/api/feedback', async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { ok: true, id: 'preview-feedback' } });
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '更多', exact: true }).click();
  assert.equal(await page.getByText('版本 3.0.0 · by.sameko', { exact: true }).first().isVisible(), true);
  await page.locator('.app-summary').click();
  await page.getByRole('dialog', { name: '关于此应用' }).getByRole('button', { name: /更新日志/ }).click();
  const updates = page.getByRole('dialog', { name: '更新日志' });
  await updates.waitFor({ state: 'visible' });
  assert.equal(await updates.getByText('版本 3.0.0', { exact: true }).isVisible(), true);
  assert.equal(await updates.getByText('版本 0.0.1', { exact: true }).isVisible(), true);
  assert.equal(await updates.getByText('新增 意见反馈', { exact: true }).isVisible(), true);
  await updates.getByRole('button', { name: '关闭更新日志' }).click();
  await page.getByRole('button', { name: /意见反馈/ }).click();
  const dialog = page.getByRole('dialog', { name: '意见反馈' });
  await dialog.waitFor({ state: 'visible' });
  const submit = dialog.getByRole('button', { name: '提交反馈' });
  assert.equal(await submit.isDisabled(), true);
  await dialog.getByRole('button', { name: /遇到问题/ }).click();
  await dialog.getByRole('textbox').fill('载入候选时页面没有反应。');
  await page.screenshot({ path: fileURLToPath(new URL('feedback-sheet-mobile.png', outputDir)) });
  await submit.click();
  assert.deepEqual(submitted, { category: 'problem', content: '载入候选时页面没有反应。' });
  await dialog.getByText('谢谢你的反馈', { exact: true }).waitFor();
  await page.waitForTimeout(480);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: fileURLToPath(new URL('feedback-success-mobile.png', outputDir)) });

  await page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: fileURLToPath(new URL('feedback-success-320.png', outputDir)) });
  await context.close();
} finally {
  await browser.close();
}

console.log('FEEDBACK_UI_OK');
