import assert from 'node:assert/strict';

import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const browser = await launchUiBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
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
  assert.equal(
    await page.locator('.tab-highlight').evaluate((element) => getComputedStyle(element).transitionDuration),
    '0s',
    '键盘切换导航应立即完成高亮切换',
  );

  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((element) => element === document.activeElement, await historyTab.elementHandle());
  assert.equal(await historyTab.getAttribute('aria-selected'), 'true');

  await page.keyboard.press('End');
  await page.waitForFunction((element) => element === document.activeElement, await moreTab.elementHandle());
  assert.equal(await moreTab.getAttribute('aria-selected'), 'true');

  await page.keyboard.press('Home');
  await page.waitForFunction((element) => element === document.activeElement, await homeTab.elementHandle());
  assert.equal(await homeTab.getAttribute('aria-selected'), 'true');

  // A tab owns its scroll position; only explicitly reselecting it returns to the top.
  await moreTab.click();
  const moreScroll = page.locator('[data-root-view="more"] .root-scroll');
  const savedScroll = await moreScroll.evaluate((element) => {
    element.scrollTop = 240;
    return element.scrollTop;
  });
  assert.ok(savedScroll > 100, '更多页必须有实际可滚动内容');
  await historyTab.click();
  await moreTab.click();
  assert.equal(await moreScroll.evaluate((element) => element.scrollTop), savedScroll);
  await moreTab.click();
  await page.waitForFunction(() => document.querySelector('[data-root-view="more"] .root-scroll').scrollTop === 0);

  const waitForSelection = () => page.waitForFunction(() => {
    const selected = document.querySelector('.root-tabbar button.is-active');
    const indicator = document.querySelector('.tab-highlight');
    const a = selected.getBoundingClientRect();
    const b = indicator.getBoundingClientRect();
    return Math.abs(a.x - b.x) < 1 && Math.abs(a.width - b.width) < 1;
  });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const tab of [homeTab, candidatesTab, historyTab, moreTab]) {
      await tab.click();
      await waitForSelection();
      const box = await tab.boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, `${width}px 导航点击区域过小`);
      assert.equal(
        await tab.evaluate((element) => getComputedStyle(element).backgroundColor),
        'rgba(0, 0, 0, 0)',
        '选中按钮不能叠加第二层高亮',
      );
    }
  }

  // New input interrupts the in-flight indicator movement and leaves one visible panel.
  for (const tab of [homeTab, historyTab, candidatesTab, moreTab, candidatesTab]) {
    await tab.click({ force: true });
  }
  await waitForSelection();
  assert.equal(await candidatesTab.getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByRole('tabpanel').count(), 1);
  assert.equal(await page.getByRole('tab', { selected: true }).count(), 1);

  const label = candidatesTab.locator('.tab-label');
  const beforePress = await label.boundingBox();
  const hit = await candidatesTab.boundingBox();
  await page.mouse.move(hit.x + hit.width / 2, hit.y + hit.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => {
    const symbol = document.querySelector('.root-tabbar button.is-active .tab-symbol');
    return new DOMMatrix(getComputedStyle(symbol).transform).a < 0.95;
  });
  assert.deepEqual(await label.boundingBox(), beforePress, '按下反馈不能移动菜单文字');
  await page.mouse.up();
  assert.deepEqual(errors, []);
  await context.close();

  const reduced = await browser.newContext({ reducedMotion: 'reduce' });
  await reduced.addInitScript(() => localStorage.setItem('weibo-draw-motion', 'system'));
  const reducedPage = await reduced.newPage();
  await gotoUiPage(reducedPage, baseUrl);
  await reducedPage.getByRole('tab', { name: '记录', exact: true }).click();
  const duration = await reducedPage.locator('.tab-highlight').evaluate((element) =>
    parseFloat(getComputedStyle(element).transitionDuration));
  assert.ok(duration <= 0.01, '跟随系统减少动效时不应播放滑块位移动画');
  await reduced.close();
} finally {
  await browser.close();
}

console.log('TAB_NAVIGATION_UI_OK');
