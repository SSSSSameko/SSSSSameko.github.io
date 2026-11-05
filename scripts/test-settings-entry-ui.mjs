import assert from 'node:assert/strict';
import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const browser = await launchUiBrowser();
try {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 1000 },
  ]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let healthMode = 'healthy';
      await page.route('**/api/**', async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/api/health') {
          if (healthMode === 'offline') return route.abort('failed');
          if (healthMode === 'malformed')
            return route.fulfill({
              status: 502,
              contentType: 'text/html',
              body: '<html>gateway</html>',
            });
          return route.fulfill({ status: healthMode === 'error' ? 503 : 200, json: { ok: true } });
        }
        return route.fulfill({ json: { ok: true, items: [], draws: [], available: false } });
      });
      await gotoUiPage(page, baseUrl);
      const settings = page.getByRole('dialog', { name: '设置', exact: true });
      for (let round = 0; round < 3; round += 1) {
        for (const [label, section] of [
          ['备用 Cookie', 'cookie'],
          ['后端连接', 'backend'],
          ['数据设置', ''],
        ]) {
          await page.getByRole('tab', { name: '更多', exact: true }).click();
          await page.getByRole('button', { name: new RegExp(`^${label}`) }).click();
          await settings.waitFor({ state: 'visible' });
          if (section) {
            const disclosure = settings.locator(`[data-settings-section="${section}"]`);
            await page.waitForFunction(
              (key) => document.querySelector(`[data-settings-section="${key}"]`)?.open,
              section,
            );
            // Exercise both native toggle directions, including deferred React updates.
            await disclosure.locator('summary').click();
            await page.waitForFunction(
              (key) => !document.querySelector(`[data-settings-section="${key}"]`)?.open,
              section,
            );
            await disclosure.locator('summary').click();
            await page.waitForFunction(
              (key) => document.querySelector(`[data-settings-section="${key}"]`)?.open,
              section,
            );
          }
          await page.keyboard.press('Escape');
          await settings.waitFor({ state: 'detached' });
          assert.equal(
            await page.getByRole('tab', { name: '更多', exact: true }).isVisible(),
            true,
          );
          assert.deepEqual(errors, [], `${label} 打开或切换时出现运行错误`);
        }
      }

      await page.getByRole('button', { name: /^备用 Cookie/ }).click();
      const cookie = settings.locator('textarea[name="settingsMobileCookie"]');
      await cookie.fill('test_cookie=local-fixture');
      await settings.getByRole('button', { name: /^清除备用 Cookie/ }).click();
      assert.equal(await cookie.inputValue(), '');
      await page.keyboard.press('Escape');
      await settings.waitFor({ state: 'detached' });

      await page.getByRole('button', { name: /^后端连接/ }).click();
      for (const mode of ['error', 'malformed', 'offline', 'healthy']) {
        healthMode = mode;
        await settings.getByRole('button', { name: '测试连接', exact: true }).click();
        await page
          .getByText(mode === 'healthy' ? '后端连接成功。' : /^后端连接失败：/)
          .first()
          .waitFor();
        assert.equal(await settings.isVisible(), true, '连接失败应保留设置页面');
        assert.deepEqual(errors, []);
        const notice = page.getByRole('alertdialog');
        if (mode !== 'healthy') {
          await notice.waitFor({ state: 'visible' });
          await page.keyboard.press('Escape');
          await notice.waitFor({ state: 'detached' });
        }
      }
      await page.keyboard.press('Escape');
      await settings.waitFor({ state: 'detached' });

      for (const [label, title] of [
        ['关于', '关于'],
        ['使用教程', '使用教程'],
        ['意见反馈', '意见反馈'],
        ['隐私政策', '隐私政策'],
        ['使用规则', '使用规则'],
        ['免责声明', '免责声明'],
        ['版权说明', '版权说明'],
        ['第三方许可', '第三方许可'],
      ]) {
        await page
          .getByRole('tabpanel', { name: '更多', exact: true })
          .getByRole('button', { name: new RegExp(label) })
          .click();
        const dialog = page.getByRole('dialog', { name: new RegExp(title) });
        await dialog.waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        assert.deepEqual(errors, [], `${label} 出现运行错误`);
      }
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log('SETTINGS_ENTRY_UI_OK');
