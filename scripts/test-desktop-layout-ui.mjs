import assert from 'node:assert/strict';

import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const browser = await launchUiBrowser();
const rectanglesOverlap = (left, right) => Boolean(
  left && right
  && left.left < right.right
  && left.right > right.left
  && left.top < right.bottom
  && left.bottom > right.top,
);

try {
  const desktopContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
  });
  const desktopPage = await desktopContext.newPage();
  await gotoUiPage(desktopPage, baseUrl);
  await desktopPage.waitForTimeout(650);

  const desktopLayout = await desktopPage.evaluate(() => {
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
    return {
      shell: rect('.app-shell'),
      studio: rect('.draw-studio'),
      settings: rect('.home-settings-section'),
      history: rect('.home-history-section'),
      scroll: rect('.root-view.is-active .root-scroll'),
      bodyScrollWidth: document.body.scrollWidth,
    };
  });

  assert.ok(desktopLayout.shell.width >= 900, '桌面端应使用宽屏工作区');
  assert.ok(desktopLayout.settings.left > desktopLayout.studio.right, '桌面端设置应位于控制台右侧');
  assert.ok(desktopLayout.history.left > desktopLayout.studio.right, '桌面端记录应位于控制台右侧');
  assert.equal(desktopLayout.bodyScrollWidth, 1440, '桌面端不应出现横向溢出');
  assert.ok(desktopLayout.scroll.width < desktopLayout.shell.width, '桌面端滚动内容应保留安全内边距');

  await desktopPage.getByRole('button', { name: '设置', exact: true }).click();
  await desktopPage.waitForTimeout(450);
  const settingsSheet = await desktopPage.getByRole('dialog', { name: '设置', exact: true }).evaluate((element) => (
    element.getBoundingClientRect().toJSON()
  ));
  assert.ok(settingsSheet.width <= 640, '桌面端设置弹层应保持可读宽度');
  assert.ok(Math.abs((settingsSheet.left + settingsSheet.width / 2) - 720) <= 1, '桌面端设置弹层应水平居中');
  assert.ok(settingsSheet.bottom < 1000, '桌面端设置弹层应与窗口底部保留间距');
  await desktopPage.getByRole('button', { name: '关闭设置', exact: true }).click();
  await desktopPage.getByRole('dialog', { name: '设置', exact: true }).waitFor({ state: 'detached' });

  for (const tab of ['名单', '记录', '更多']) {
    await desktopPage.getByRole('tab', { name: tab, exact: true }).click();
    const tabLayout = await desktopPage.evaluate(() => ({
      scrollWidth: document.querySelector('.root-view.is-active .root-scroll')?.scrollWidth,
      clientWidth: document.querySelector('.root-view.is-active .root-scroll')?.clientWidth,
      contentWidth: document.querySelector('.root-view.is-active .root-scroll > *')?.getBoundingClientRect().width,
    }));
    assert.equal(tabLayout.scrollWidth, tabLayout.clientWidth, tab + '页不应出现横向溢出');
    assert.ok(tabLayout.contentWidth <= 820, tab + '页内容应保持可读宽度');
  }
  await desktopContext.close();

  const shortDesktopContext = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    colorScheme: 'light',
  });
  const shortDesktopPage = await shortDesktopContext.newPage();
  await gotoUiPage(shortDesktopPage, baseUrl);
  await shortDesktopPage.waitForTimeout(650);
  const shortDesktopLayout = await shortDesktopPage.evaluate(() => ({
    tabbar: document.querySelector('.root-tabbar')?.getBoundingClientRect().toJSON(),
    manualAction: document.querySelector('.draw-studio.is-empty .v3-text-action')?.getBoundingClientRect().toJSON(),
  }));
  assert.equal(rectanglesOverlap(shortDesktopLayout.tabbar, shortDesktopLayout.manualAction), false, '短桌面端底部导航不应遮挡手动导入入口');
  await shortDesktopContext.close();

  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
  });
  const mobilePage = await mobileContext.newPage();
  await gotoUiPage(mobilePage, baseUrl);
  await mobilePage.waitForTimeout(650);
  const mobileLayout = await mobilePage.evaluate(() => ({
    shellWidth: document.querySelector('.app-shell')?.getBoundingClientRect().width,
    studioWidth: document.querySelector('.draw-studio')?.getBoundingClientRect().width,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  assert.equal(mobileLayout.shellWidth, 390, '手机端应保持全宽应用壳');
  assert.equal(mobileLayout.bodyScrollWidth, 390, '手机端不应出现横向溢出');
  assert.ok(mobileLayout.studioWidth < mobileLayout.shellWidth, '手机端控制台应保留页面边距');
  await mobilePage.setViewportSize({ width: 320, height: 568 });
  await mobilePage.waitForTimeout(100);
  const compactMobileLayout = await mobilePage.evaluate(() => ({
    tabbar: document.querySelector('.root-tabbar')?.getBoundingClientRect().toJSON(),
    manualAction: document.querySelector('.draw-studio.is-empty .v3-text-action')?.getBoundingClientRect().toJSON(),
  }));
  assert.equal(rectanglesOverlap(compactMobileLayout.tabbar, compactMobileLayout.manualAction), false, '窄屏底部导航不应遮挡手动导入入口');
  await mobileContext.close();
} finally {
  await browser.close();
}

console.log('DESKTOP_LAYOUT_UI_OK');
