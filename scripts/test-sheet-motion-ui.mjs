import assert from 'node:assert/strict';

import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const browser = await launchUiBrowser();

try {
  const filterContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  try {
    const filterPage = await filterContext.newPage();
    filterPage.setDefaultTimeout(8_000);
    await gotoUiPage(filterPage, baseUrl);
    await filterPage.getByRole('button', { name: '筛选', exact: true }).click();
    const firstFilterDialog = filterPage.getByRole('dialog', { name: '筛选规则' });
    const keywordInput = firstFilterDialog.locator('.v3-form-group input').first();
    await keywordInput.fill('抽奖');
    await filterPage.keyboard.press('Escape');
    await firstFilterDialog.waitFor({ state: 'detached' });

    await filterPage.getByRole('button', { name: '筛选', exact: true }).click();
    const discardedFilterDialog = filterPage.getByRole('dialog', { name: '筛选规则' });
    assert.equal(await discardedFilterDialog.locator('.v3-form-group input').first().inputValue(), '');
    await discardedFilterDialog.locator('.v3-filter-presets').getByRole('button', { name: '含“抽奖”', exact: true }).click();
    await discardedFilterDialog.getByRole('button', { name: '应用筛选', exact: true }).click();
    await discardedFilterDialog.waitFor({ state: 'detached' });

    await filterPage.getByRole('button', { name: '筛选', exact: true }).click();
    const appliedFilterDialog = filterPage.getByRole('dialog', { name: '筛选规则' });
    assert.equal(await appliedFilterDialog.locator('.v3-form-group input').first().inputValue(), '抽奖');
    await appliedFilterDialog.locator('.v3-filter-presets').getByRole('button', { name: '不限内容', exact: true }).click();
    await appliedFilterDialog.getByRole('button', { name: '应用筛选', exact: true }).click();
    await appliedFilterDialog.waitFor({ state: 'detached' });
  } finally {
    await filterContext.close();
  }

  const restoreContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  try {
    const restorePage = await restoreContext.newPage();
    restorePage.setDefaultTimeout(8_000);
    await gotoUiPage(restorePage, baseUrl);
    const homeScroll = restorePage.locator('[data-root-view="home"] .root-scroll');
    const initialScrollTop = await homeScroll.evaluate((element) => element.scrollTop);

    await restorePage.getByRole('button', { name: '或手动导入候选名单', exact: true }).click();
    const sourceDialog = restorePage.getByRole('dialog', { name: '候选来源' });
    await sourceDialog.getByRole('textbox', { name: '弹窗手动候选名单' }).fill('滚动恢复候选');
    await sourceDialog.getByRole('button', { name: '替换名单', exact: true }).click();
    await sourceDialog.getByRole('button', { name: '完成', exact: true }).click();
    await sourceDialog.waitFor({ state: 'detached' });

    assert.equal(await homeScroll.evaluate((element) => element.scrollTop), initialScrollTop);
    const sourceRow = restorePage.locator('#candidate-source-row');
    await restorePage.waitForFunction(() => document.activeElement?.id === 'candidate-source-row');
    assert.equal(await sourceRow.evaluate((element) => element === document.activeElement), true);
  } finally {
    await restoreContext.close();
  }

  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'no-preference',
  });
  await gotoUiPage(page, baseUrl);
  await page.getByRole('button', { name: '筛选', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: '筛选规则' });
  const grabber = page.locator('.flow-sheet-grabber');
  await dialog.waitFor({ state: 'visible' });
  await page.waitForTimeout(420);
  assert.equal(await page.locator('.app-shell.stack-open').count(), 1);

  const box = await grabber.boundingBox();
  assert.ok(box);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 42, { steps: 6 });
  await page.waitForFunction(() => (
    Number.parseFloat(document.querySelector('.flow-sheet')?.style.getPropertyValue('--sheet-drag-y')) > 20
  ));
  const dragged = await dialog.evaluate((sheet) => (
    Number.parseFloat(sheet.style.getPropertyValue('--sheet-drag-y'))
  ));
  assert.ok(dragged > 20);
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(380);
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialog.evaluate((sheet) => sheet.classList.contains('is-dragging')), false);

  const secondBox = await grabber.boundingBox();
  const secondX = secondBox.x + secondBox.width / 2;
  const secondY = secondBox.y + secondBox.height / 2;
  await page.mouse.move(secondX, secondY);
  await page.mouse.down();
  await page.mouse.move(secondX, secondY + 190, { steps: 8 });
  await page.mouse.up();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.app-shell.stack-open').count(), 0);

  const shortContext = await browser.newContext({
    viewport: { width: 320, height: 568 },
    reducedMotion: 'reduce',
  });
  try {
    const shortPage = await shortContext.newPage();
    shortPage.setDefaultTimeout(8_000);
    await gotoUiPage(shortPage, baseUrl);
    await shortPage.locator('.root-tabbar button').filter({ hasText: '名单' }).click();
    await shortPage.getByRole('button', { name: '手动名单', exact: true }).click();
    await shortPage.getByRole('textbox', { name: '手动候选名单' }).fill('短视口候选');
    await shortPage.getByRole('button', { name: '替换名单', exact: true }).click();
    await shortPage.locator('.root-tabbar button').filter({ hasText: '抽奖' }).click();
    await shortPage.getByRole('button', { name: /设置奖项并确认/ }).click();
    const prizeDialog = shortPage.getByRole('dialog', { name: '奖项设置' });
    await prizeDialog.getByRole('button', { name: '确认奖项设置' }).click();

    const confirmDialog = shortPage.getByRole('dialog', { name: '开奖前确认' });
    const confirmBody = confirmDialog.locator('.flow-sheet-body');
    const scrollMetrics = await confirmBody.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    assert.ok(scrollMetrics.scrollHeight > scrollMetrics.clientHeight, JSON.stringify(scrollMetrics));

    const factRows = confirmDialog.locator('.v3-confirm-facts > div');
    assert.equal(await factRows.count(), 4);
    assert.deepEqual(await factRows.locator('dt').allTextContents(), [
      '可抽候选',
      '中奖名额',
      '名单截止',
      '筛选规则',
    ]);
    for (let index = 0; index < await factRows.count(); index += 1) {
      const fact = factRows.nth(index);
      await fact.scrollIntoViewIfNeeded();
      const reachable = await fact.evaluate((element) => {
        const scroller = element.closest('.flow-sheet-body');
        const factBox = element.getBoundingClientRect();
        const scrollerBox = scroller?.getBoundingClientRect();
        return Boolean(
          scroller
          && scrollerBox
          && factBox.top >= scrollerBox.top - 1
          && factBox.bottom <= scrollerBox.bottom + 1,
        );
      });
      assert.equal(reachable, true, `确认事实 ${index + 1} 无法滚动访问`);
    }

    const closeButton = confirmDialog.getByRole('button', { name: '关闭开奖前确认' });
    const primaryButton = confirmDialog.getByRole('button', { name: '确认并开始抽奖' });
    await closeButton.focus();
    assert.equal(await closeButton.evaluate((element) => element === document.activeElement), true);
    await shortPage.keyboard.press('Tab');
    assert.equal(await primaryButton.evaluate((element) => element === document.activeElement), true);
    await shortPage.keyboard.press('Shift+Tab');
    assert.equal(await closeButton.evaluate((element) => element === document.activeElement), true);
    await closeButton.click();
    await confirmDialog.waitFor({ state: 'detached' });
  } finally {
    await shortContext.close();
  }
} finally {
  await browser.close();
}

console.log('SHEET_MOTION_UI_OK');
