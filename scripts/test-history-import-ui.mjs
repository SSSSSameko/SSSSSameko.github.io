import assert from 'node:assert/strict';
import { serializeDrawHistoryBackup } from '../src/lib/drawReceipts.js';
import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5199/';
const historyKey = 'weibo-draw-history-v2';
const receipt = {
  id: 'history-import-regression', source: 'manual', drawnAt: '2026-11-06T01:00:00.000Z',
  recordState: 'local', candidateCount: 2, eligibleCount: 2,
  results: [{ prize: { name: '测试奖项', count: 1 }, winners: [{ uid: '1001', screenName: '测试用户' }] }],
};
const backup = Buffer.from(serializeDrawHistoryBackup([receipt]));
const browser = await launchUiBrowser();
try {
  for (const scenario of ['clear', 'merge', 'locked-clear', 'invalid', 'practice']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ historyKey, receipt, scenario }) => {
      localStorage.setItem(historyKey, JSON.stringify({ version: 2, items: [{ ...receipt, id: 'existing-record' }] }));
      const nativeText = File.prototype.text;
      File.prototype.text = async function () {
        window.__importReading = true;
        await new Promise(resolve => { window.__releaseImportRead = resolve; });
        return nativeText.call(this);
      };
      if (scenario === 'locked-clear') {
        const locks = navigator.locks;
        Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
        const nativeRequest = locks.request.bind(locks);
        locks.request = async (...args) => {
          if (!window.__importLockWaited) {
            window.__importLockWaited = true;
            await new Promise(resolve => { window.__releaseImportLock = resolve; });
          }
          return nativeRequest(...args);
        };
      }
    }, { historyKey, receipt, scenario });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => route.fulfill({ json: { ok: true, hasCookie: true } }));
    try {
      await gotoUiPage(page, baseUrl);
      if (scenario === 'practice') {
        await page.getByRole('button', { name: '或手动导入候选名单' }).click();
        const source = page.getByRole('dialog', { name: '候选来源' });
        await source.getByRole('textbox', { name: '弹窗手动候选名单', exact: true }).fill('测试甲\n测试乙\n测试丙');
        await source.getByRole('button', { name: '替换名单', exact: true }).click();
        await source.getByRole('button', { name: '设置奖项并确认', exact: true }).click();
        await page.getByRole('dialog', { name: '奖项设置' }).getByRole('button', { name: '确认奖项设置' }).click();
        await page.getByRole('dialog', { name: '开奖前确认' }).waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('dialog', { name: '开奖前确认' }).waitFor({ state: 'detached' });
      }
      await page.getByRole('tab', { name: '更多', exact: true }).click();
      await page.getByRole('button', { name: /数据设置/ }).click();
      const settings = page.getByRole('dialog', { name: '设置', exact: true });
      await settings.locator('input[type="file"]').setInputFiles({
        name: 'history.json', mimeType: 'application/json', buffer: scenario === 'invalid' ? Buffer.from('{broken') : backup,
      });
      await page.waitForFunction(() => window.__importReading);
      assert.equal(await settings.getByRole('button', { name: /恢复开奖记录/ }).isDisabled(), true);
      if (scenario === 'locked-clear') {
        await page.evaluate(() => window.__releaseImportRead());
        await page.waitForFunction(() => window.__importLockWaited);
      }
      if (scenario === 'clear' || scenario === 'locked-clear') {
        await settings.getByRole('button', { name: /清空本机抽奖数据/ }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: '清空', exact: true }).click();
        await page.getByText('已清空', { exact: true }).waitFor();
        await page.evaluate(() => {
          window.__releaseImportRead();
          window.__releaseImportLock?.();
        });
        await page.waitForTimeout(250);
        assert.equal(await page.evaluate(key => localStorage.getItem(key), historyKey), null,
          '清空本机记录后，迟到的备份读取或持锁回调不得恢复已清空数据');
        assert.equal(await page.getByText('记录已恢复', { exact: true }).count(), 0);
      } else if (scenario === 'practice') {
        await settings.getByRole('button', { name: '关闭设置' }).click();
        await settings.waitFor({ state: 'detached' });
        await page.getByRole('tab', { name: '抽奖', exact: true }).click();
        await page.locator('.draw-ready > button').click();
        await page.getByRole('dialog', { name: '开奖前确认' }).getByRole('button', { name: /本地演练/ }).click();
        const result = page.getByRole('dialog', { name: '本地演练结果' });
        await result.waitFor();
        await page.evaluate(() => window.__releaseImportRead());
        await page.waitForTimeout(250);
        assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).items.length, historyKey), 1);
        assert.equal(await result.isVisible(), true, '旧备份导入不得清掉新一轮演练结果');
        assert.equal(await page.getByText('记录已恢复', { exact: true }).count(), 0);
      } else {
        await page.evaluate(() => window.__releaseImportRead());
        if (scenario === 'merge') {
          await page.getByText('记录已恢复', { exact: true }).waitFor();
          const ids = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).items.map(item => item.id), historyKey);
          assert.deepEqual(ids.sort(), ['existing-record', receipt.id].sort());
        } else {
          await page.getByText(/记录恢复失败：/).first().waitFor();
          assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).items.length, historyKey), 1);
        }
        assert.equal(await settings.getByRole('button', { name: /恢复开奖记录/ }).isEnabled(), true);
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log('HISTORY_IMPORT_UI_OK');
