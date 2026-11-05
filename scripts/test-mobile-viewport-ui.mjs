import assert from 'node:assert/strict';
import { webkit } from 'playwright';
import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const engine = process.env.MOBILE_UI_ENGINE || 'chromium';
const browser = engine === 'webkit' ? await webkit.launch() : await launchUiBrowser();
const errors = [];

async function createPage(init) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 664 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
    colorScheme: 'light',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  });
  await context.addInitScript(() => localStorage.setItem('weibo-draw-motion', 'system'));
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await gotoUiPage(page, baseUrl);
  await page.getByRole('tab', { name: '抽奖', exact: true }).waitFor();
  return page;
}

async function more(page) {
  await page.getByRole('tab', { name: '更多', exact: true }).tap();
  return page.locator('#display-mode-entry');
}

async function viewport(page, height, top = 0, scale = 1) {
  await page.evaluate(({ height, top, scale }) => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: height },
      offsetTop: { configurable: true, value: top },
      scale: { configurable: true, value: scale },
    });
    window.visualViewport.dispatchEvent(new Event('resize'));
    window.visualViewport.dispatchEvent(new Event('scroll'));
  }, { height, top, scale });
  await page.waitForTimeout(100);
}

try {
  // Capability detection, rather than the user agent, selects the installation guide.
  const page = await createPage(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
  });
  const drawRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/draws') drawRequests.push(request.url());
  });
  assert.match(await (await more(page)).innerText(), /添加到主屏幕/);
  await page.locator('#display-mode-entry').tap();
  const guide = page.getByRole('dialog', { name: '全屏与主屏幕' });
  await guide.waitFor();
  assert.equal(await guide.getByText('在 Safari 中打开分享菜单').isVisible(), true);
  assert.equal(await guide.getByText(/iPhone 的 Safari 标签页不能由网站强制隐藏地址栏/).count(), 1);
  await guide.getByRole('button', { name: '知道了', exact: true }).tap();
  await guide.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.id === 'display-mode-entry');
  await page.getByRole('tab', { name: '抽奖', exact: true }).tap();

  for (const size of [{ width: 320, height: 568 }, { width: 390, height: 664 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(150);
    const layout = await page.evaluate(() => {
      const scroller = document.querySelector('.root-view.is-active .root-scroll');
      const card = document.querySelector('.v3-intake-deck .pass-main');
      const text = card.querySelector('.pass-identity em');
      return {
        pageWidth: document.body.scrollWidth,
        contentWidth: scroller.scrollWidth,
        availableWidth: scroller.clientWidth,
        card: card.getBoundingClientRect().toJSON(),
        text: text.getBoundingClientRect().toJSON(),
        font: parseFloat(getComputedStyle(text).fontSize),
        controls: [...document.querySelectorAll('.root-tabbar button, .v3-text-action')].map((element) => element.getBoundingClientRect().height),
      };
    });
    assert.equal(layout.pageWidth, size.width, '手机横竖屏不应产生页面横向滚动');
    assert.equal(layout.contentWidth, layout.availableWidth, '内容不应横向溢出');
    assert.ok(layout.font >= 12 && layout.text.bottom <= layout.card.bottom, '手机卡片辅助文字应可读且不被截断');
    assert.ok(layout.controls.every((height) => height >= 44), '导航与手动导入应保留 44px 触控高度');
    const action = page.getByRole('button', { name: /粘贴链接并载入/ });
    if (size.width > size.height) {
      const firstAction = await action.boundingBox();
      const firstNav = await page.locator('.root-tabbar').boundingBox();
      assert.ok(firstAction.y >= 0 && firstAction.y + firstAction.height < firstNav.y, '横屏首屏应能直接看到载入操作');
    }
    await action.scrollIntoViewIfNeeded();
    const button = await action.boundingBox();
    const nav = await page.locator('.root-tabbar').boundingBox();
    assert.ok(button.y >= 0 && button.y + button.height <= nav.y, '主操作必须能滚动到导航上方');
  }

  await page.setViewportSize({ width: 390, height: 664 });
  await page.getByRole('tab', { name: '名单', exact: true }).tap();
  await page.getByRole('button', { name: '手动名单', exact: true }).tap();
  const input = page.getByRole('textbox', { name: '手动候选名单' });
  await input.fill('移动端演练甲\n移动端演练乙\n移动端演练丙');
  assert.ok(await input.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)) >= 16, '输入字号应避免 iOS 自动放大');
  await viewport(page, 350, 24);
  assert.equal(await page.locator('.root-tabbar').isVisible(), false, '键盘打开时导航应让出空间');
  const shell = await page.locator('.app-shell').boundingBox();
  assert.ok(Math.abs(shell.y - 24) < 1 && Math.abs(shell.height - 350) < 1, '应用应匹配键盘上方的可见区域');
  const shellBeforePinch = await page.locator('.app-shell').boundingBox();
  await viewport(page, 175, 50, 2);
  assert.deepEqual(await page.locator('.app-shell').boundingBox(), shellBeforePinch, '双指缩放不应触发布局重新拟合');
  await viewport(page, 664);
  await input.evaluate((element) => element.blur());
  await page.getByRole('button', { name: '替换名单', exact: true }).tap();
  assert.equal(await page.locator('.root-tabbar').isVisible(), true, '键盘收起后导航应恢复');

  await page.getByRole('tab', { name: '抽奖', exact: true }).tap();
  await page.getByRole('button', { name: /设置奖项并确认/ }).tap();
  const prizes = page.getByRole('dialog', { name: '奖项设置' });
  await prizes.locator('input').first().focus();
  await viewport(page, 350, 24);
  const submit = await prizes.getByRole('button', { name: '确认奖项设置' }).boundingBox();
  const sheet = await prizes.boundingBox();
  assert.ok(sheet.y >= 24 && submit.y + submit.height <= 374, '弹层与确认按钮必须留在键盘上方');
  await viewport(page, 664);
  await prizes.getByRole('button', { name: '确认奖项设置' }).tap();
  const confirm = page.getByRole('dialog', { name: '开奖前确认' });
  await confirm.getByRole('button', { name: /本地演练/ }).tap();
  await page.getByRole('dialog', { name: '本地演练结果' }).waitFor();
  assert.deepEqual(drawRequests, [], '移动端本地演练不应写入正式开奖');
  await page.context().close();

  const standalone = await createPage(() => {
    Object.defineProperty(navigator, 'standalone', { value: true });
  });
  assert.match(await (await more(standalone)).innerText(), /显示模式.*已从主屏幕打开/s);
  await standalone.locator('#display-mode-entry').tap();
  assert.equal(await standalone.getByText('当前已从主屏幕打开，浏览器工具栏已隐藏。').isVisible(), true);
  assert.equal(await standalone.locator('.display-mode-guide ol').count(), 0);
  await standalone.context().close();

  const denied = await createPage(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { value: true });
    Element.prototype.requestFullscreen = () => Promise.reject(new Error('Fullscreen denied'));
  });
  assert.match(await (await more(denied)).innerText(), /全屏显示/);
  await denied.locator('#display-mode-entry').tap();
  await denied.getByRole('dialog', { name: '全屏与主屏幕' }).waitFor();
  assert.equal(await denied.getByRole('alert').filter({ hasText: '浏览器未能进入全屏' }).isVisible(), true);
  await denied.context().close();

  if (engine === 'chromium') {
    const fullscreen = await createPage();
    assert.match(await (await more(fullscreen)).innerText(), /全屏显示/);
    await fullscreen.locator('#display-mode-entry').tap();
    await fullscreen.waitForFunction(() => Boolean(document.fullscreenElement));
    await fullscreen.locator('#display-mode-entry').filter({ hasText: '退出全屏' }).tap();
    await fullscreen.waitForFunction(() => !document.fullscreenElement);
    await fullscreen.context().close();
  }
  assert.deepEqual(errors, [], '移动端流程不应出现运行异常');
} finally {
  await browser.close();
}

console.log(`MOBILE_VIEWPORT_UI_OK (${engine})`);
