import assert from 'node:assert/strict';

import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const browser = await launchUiBrowser();
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  await gotoUiPage(page, baseUrl);
  await page.locator('.root-tabbar button').filter({ hasText: '名单' }).click();
  await page.locator('.segmented-control').first().waitFor({ state: 'attached' });

  const contrast = (selector, foregroundSelector = selector) => page.evaluate(
    ({ targetSelector, textSelector }) => {
      const parseColor = (value) => {
        const channels = String(value || '').match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
        return channels.length >= 3
          ? [channels[0], channels[1], channels[2], channels[3] ?? 1]
          : [0, 0, 0, 0];
      };
      const composite = (front, back) => {
        const alpha = front[3] + back[3] * (1 - front[3]);
        if (!alpha) return [0, 0, 0, 0];
        return [
          (front[0] * front[3] + back[0] * back[3] * (1 - front[3])) / alpha,
          (front[1] * front[3] + back[1] * back[3] * (1 - front[3])) / alpha,
          (front[2] * front[3] + back[2] * back[3] * (1 - front[3])) / alpha,
          alpha,
        ];
      };
      const luminance = (color) => {
        const linear = color.slice(0, 3).map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      };
      const target = document.querySelector(targetSelector);
      const text = document.querySelector(textSelector);
      if (!target || !text) return { ratio: 0, foreground: '', background: '', selector: targetSelector };
      const layers = [];
      for (let element = target; element; element = element.parentElement) layers.push(element);
      let background = [0, 0, 0, 0];
      for (const element of layers.reverse()) {
        background = composite(parseColor(getComputedStyle(element).backgroundColor), background);
      }
      if (background[3] < 1) background = composite(background, [11, 13, 18, 1]);
      const foreground = composite(parseColor(getComputedStyle(text).color), background);
      const foregroundLuminance = luminance(foreground);
      const backgroundLuminance = luminance(background);
      return {
        ratio: (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
          / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
        foreground: getComputedStyle(text).color,
        background: background.slice(0, 3).map((channel) => Math.round(channel)).join(','),
        selector: targetSelector,
      };
    },
    { targetSelector: selector, textSelector: foregroundSelector },
  );

  const assertContrast = async (selector, foregroundSelector = selector) => {
    const result = await contrast(selector, foregroundSelector);
    assert.ok(result.ratio >= 4.5, `contrast should be at least 4.5:1: ${JSON.stringify(result)}`);
  };

  const state = await page.evaluate(() => {
    const read = (selector, property = 'backgroundColor', pseudo = null) => {
      const element = document.querySelector(selector);
      if (!element) return '';
      return getComputedStyle(element, pseudo)[property];
    };
    return {
      scheme: getComputedStyle(document.documentElement).colorScheme,
      body: read('body'),
      studio: read('.draw-studio'),
      navbar: read('.root-navbar'),
      tabbar: read('.root-tabbar'),
      brand: read('.brand-button strong', 'color'),
      segmented: read('.segmented-control'),
      segmentedHighlight: read('.segmented-control .segmented-highlight'),
      drawScene: read('.draw-scene'),
      drawSpecs: read('.draw-specs'),
      specButton: read('.draw-specs button'),
      tabbarShine: read('.root-tabbar', 'backgroundColor', '::before'),
      primarySurface: read('.v3-load-button', 'backgroundImage'),
      primaryText: read('.v3-load-button strong', 'color'),
      darkThemeColor: document.querySelector('meta[name="theme-color"][media*="dark"]')?.content || '',
    };
  });

  assert.ok(/dark/i.test(state.scheme), JSON.stringify(state));
  const surfaces = ['body', 'studio', 'navbar', 'tabbar', 'segmented', 'segmentedHighlight', 'drawScene', 'drawSpecs', 'specButton'];
  const optionalSurfaces = new Set(['drawSpecs', 'specButton']);
  for (const key of surfaces) {
    const values = state[key].match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
    const rgb = values.slice(0, 3);
    const alpha = values[3] ?? 1;
    if (optionalSurfaces.has(key) && rgb.length === 0) continue;
    assert.equal(rgb.length, 3, `${key} missing computed color: ${state[key]}`);
    assert.ok(alpha < 0.15 || Math.max(...rgb) < 120, `${key} should be dark, got ${state[key]}`);
  }
  const brandRgb = state.brand.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) || [];
  assert.ok(brandRgb.length === 3 && Math.min(...brandRgb) > 180, `brand text should be light, got ${state.brand}`);
  const tabbarShineValues = state.tabbarShine.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
  assert.ok((tabbarShineValues[3] ?? 1) <= 0.12, `tabbar shine should stay subtle in dark mode, got ${state.tabbarShine}`);
  const primarySurfaceRgb = [...state.primarySurface.matchAll(/rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/g)]
    .map((match) => match.slice(1, 4).map(Number));
  assert.ok(
    primarySurfaceRgb.length >= 2 && primarySurfaceRgb.slice(0, 2).every((rgb) => Math.max(...rgb) < 120),
    `primary action should use a dark surface, got ${state.primarySurface}`,
  );
  const primaryTextRgb = state.primaryText.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) || [];
  assert.ok(primaryTextRgb.length === 3 && Math.min(...primaryTextRgb) > 180, `primary action text should be light, got ${state.primaryText}`);
  assert.equal(state.darkThemeColor.toLowerCase(), '#0b0d12');

  await assertContrast('.root-tabbar button:not(.is-active)');

  await page.getByRole('tab', { name: '抽奖', exact: true }).click();
  await page.getByRole('button', { name: /奖项设置/ }).click();
  await page.getByRole('dialog', { name: '奖项设置' }).waitFor({ state: 'visible' });
  await assertContrast('.v3-prize-confirm-summary > span', '.v3-prize-confirm-summary > span small');
  await assertContrast('.v3-prize-confirm-summary > span', '.v3-prize-confirm-summary > span strong');
  await page.getByRole('button', { name: '关闭奖项设置' }).click();

  await page.getByRole('tab', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: /意见反馈/ }).click();
  await page.getByRole('dialog', { name: '意见反馈' }).waitFor({ state: 'visible' });
  await assertContrast('.feedback-category button:not(.is-active)');
  await assertContrast('.feedback-category button.is-active');
  await page.getByRole('button', { name: '关闭意见反馈' }).click();

  await page.getByRole('button', { name: /隐私政策/ }).click();
  await page.getByRole('dialog', { name: '隐私政策' }).waitFor({ state: 'visible' });
  await assertContrast('.flow-legal-update-link', '.flow-legal-update-link strong');
  await assertContrast('.flow-legal-update-link', '.flow-legal-update-link small');
  await page.getByRole('button', { name: '关闭隐私政策' }).click();

  await page.getByRole('button', { name: /数据设置/ }).click();
  await page.getByRole('dialog', { name: '设置' }).waitFor({ state: 'visible' });
  await assertContrast('.flow-settings-action-label');

  await context.close();
} finally {
  await browser.close();
}

console.log('DARK_SCHEME_UI_OK');
