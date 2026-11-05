import assert from 'node:assert/strict';

import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const browser = await launchUiBrowser();

try {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('weibo-draw-motion', 'system'));
  try {
    const page = await context.newPage();
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
      { width: 1440, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      await gotoUiPage(page, baseUrl);
      await page.getByRole('heading', { name: '抽奖工作台' }).waitFor();
      const layout = await page.evaluate(() => {
        const shell = document.querySelector('.app-shell').getBoundingClientRect();
        const scroller = document.querySelector('.root-view.is-active .root-scroll');
        return {
          bodyWidth: document.body.scrollWidth,
          shellTop: shell.top,
          shellBottom: shell.bottom,
          contentWidth: scroller.scrollWidth,
          availableWidth: scroller.clientWidth,
          headingMotion: getComputedStyle(document.querySelector('.workspace-heading')).animationName,
          decorativeBackgrounds: document.querySelectorAll('.studio-backdrop').length,
        };
      });
      assert.equal(layout.bodyWidth, viewport.width, `横向溢出：${JSON.stringify(viewport)}`);
      assert.ok(
        layout.shellTop >= 0 && layout.shellBottom <= viewport.height + 1,
        `应用壳超出窗口：${JSON.stringify({ viewport, layout })}`,
      );
      assert.equal(
        layout.contentWidth,
        layout.availableWidth,
        `工作区横向溢出：${JSON.stringify(viewport)}`,
      );
      assert.equal(layout.headingMotion, 'none', '系统减少动效时应停止标题入场动画');
      assert.equal(layout.decorativeBackgrounds, 0, '工作区不应显示装饰性轨道背景');
    }

    await page.getByRole('tab', { name: '名单', exact: true }).click();
    await page.getByRole('button', { name: '手动名单', exact: true }).click();
    await page
      .getByRole('textbox', { name: '手动候选名单' })
      .fill('界面测试候选一\n界面测试候选二');
    await page.getByRole('button', { name: '替换名单', exact: true }).click();
    await page.getByRole('tab', { name: '抽奖', exact: true }).click();
    await page.waitForTimeout(350);
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 320, height: 568 },
      { width: 1280, height: 720 },
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(350);
      const action = await page.getByRole('button', { name: /设置奖项并确认/ }).boundingBox();
      const navigation = await page.locator('.root-tabbar').boundingBox();
      assert.ok(
        action && navigation && action.y + action.height <= navigation.y - 6,
        `载入名单后主操作被导航遮挡：${JSON.stringify({ viewport, action, navigation })}`,
      );
    }

    const media = await context.newCDPSession(page);
    await media.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });
    assert.equal(
      await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches),
      true,
    );
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page.getByRole('dialog', { name: '筛选规则' }).waitFor({ state: 'visible' });
    const backdrop = await page.locator('.flow-sheet-backdrop').evaluate((element) => {
      const style = getComputedStyle(element);
      return { filter: style.backdropFilter, background: style.backgroundColor };
    });
    assert.equal(backdrop.filter, 'none', '降低透明度时弹层遮罩不应模糊背景');
    assert.ok(
      /^rgb\(/.test(backdrop.background),
      `降低透明度时遮罩应使用不透明背景：${backdrop.background}`,
    );
  } finally {
    await context.close();
  }

  const contrastContext = await browser.newContext({
    forcedColors: 'active',
    reducedMotion: 'reduce',
  });
  try {
    const page = await contrastContext.newPage();
    await gotoUiPage(page, baseUrl);
    await page.getByRole('tab', { name: '名单', exact: true }).click();
    await page.locator('.segmented-control').first().waitFor();
    const selection = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.cssText = 'background:Highlight;color:HighlightText;forced-color-adjust:none';
      document.body.append(probe);
      const read = (element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color };
      };
      const expected = read(probe);
      probe.remove();
      return {
        expected,
        selected: ['.root-tabbar button.is-active', '.segmented-control button.is-active'].map(
          (selector) => ({ selector, ...read(document.querySelector(selector)) }),
        ),
      };
    });
    for (const { selector, ...colors } of selection.selected) {
      assert.deepEqual(colors, selection.expected, `${selector} 应采用用户的系统选择颜色`);
    }
  } finally {
    await contrastContext.close();
  }
} finally {
  await browser.close();
}

console.log('STUDIO_UI_OK');
