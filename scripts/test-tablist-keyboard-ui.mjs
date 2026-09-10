import assert from 'node:assert/strict';

import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const browser = await launchUiBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await gotoUiPage(page, baseUrl);

  const homeTab = page.getByRole('tab', { name: '抽奖', exact: true });
  const candidatesTab = page.getByRole('tab', { name: '名单', exact: true });
  const historyTab = page.getByRole('tab', { name: '记录', exact: true });
  const moreTab = page.getByRole('tab', { name: '更多', exact: true });

  await homeTab.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((element) => element === document.activeElement, await candidatesTab.elementHandle());
  assert.equal(await candidatesTab.getAttribute('aria-selected'), 'true');
  assert.equal(await candidatesTab.evaluate((element) => element.tabIndex), 0);
  assert.equal(await homeTab.evaluate((element) => element.tabIndex), -1);

  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((element) => element === document.activeElement, await historyTab.elementHandle());
  assert.equal(await historyTab.getAttribute('aria-selected'), 'true');

  await page.keyboard.press('End');
  await page.waitForFunction((element) => element === document.activeElement, await moreTab.elementHandle());
  assert.equal(await moreTab.getAttribute('aria-selected'), 'true');

  await page.keyboard.press('Home');
  await page.waitForFunction((element) => element === document.activeElement, await homeTab.elementHandle());
  assert.equal(await homeTab.getAttribute('aria-selected'), 'true');

  await context.close();
} finally {
  await browser.close();
}
