import assert from 'node:assert/strict';
import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5199/';
const historyKey = 'weibo-draw-history-v2';
const statusId = '5360541620244396';
const receipt = {
  id: 'local-retry-regression', source: 'mobile', statusId,
  statusUrl: `https://weibo.com/1/${statusId}`,
  drawnAt: '2026-11-05T01:00:00.000Z', recordState: 'local',
  candidateCount: 2, eligibleCount: 2,
  results: [{ prize: { name: '测试奖项', count: 1 }, winners: [{ uid: '1001', screenName: '已抽中用户' }] }],
  sourceMeta: { provider: 'desktop-cookie', complete: true },
  seed: 'retry-seed', candidateDigest: 'retry-digest',
};

const browser = await launchUiBrowser();
try {
  for (const scenario of ['reopen', 'count', 'clear']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ historyKey, receipt }) => {
      localStorage.setItem(historyKey, JSON.stringify({ version: 2, items: [receipt] }));
    }, { historyKey, receipt });
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let saveCount = 0;
    let releaseSave;
    const pendingSave = new Promise(resolve => { releaseSave = resolve; });
    await page.route('**/api/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/draws') {
        saveCount += 1;
        await pendingSave;
        return route.fulfill({ json: { ok: true, file: 'retry.json', statusId, drawNumber: 8,
          drawCount: 8, savedAt: new Date().toISOString(), auditHash: 'retry-hash' } }).catch(() => {});
      }
      if (pathname === '/api/weibo/draw-count') return route.fulfill({ json: { ok: true, drawCount: 7 } });
      if (pathname === '/api/weibo/reposts/jobs') return route.fulfill({ json: {
        ok: true, status: 'done', result: { ok: true, statusId, statusUrl: receipt.statusUrl, drawCount: 7,
          candidates: [{ uid: '1002', screenName: '待抽用户' }], meta: { complete: true, provider: 'desktop-cookie' } },
      } });
      return route.fulfill({ json: { ok: true, hasCookie: true } });
    });
    try {
      await gotoUiPage(page, baseUrl);
      if (scenario === 'count') {
        await page.getByRole('textbox', { name: '微博链接、mid 或 bid' }).fill(statusId);
        await page.getByRole('button', { name: /载入候选/ }).click();
        await page.locator('.v3-draw-count').getByText('此前已完成 7 次', { exact: true }).waitFor();
      }
      await page.getByRole('tab', { name: '记录', exact: true }).click();
      await page.locator('.history-list > button').first().click();
      const dialog = page.getByRole('dialog', { name: '开奖结果', exact: true });
      const saveStarted = page.waitForRequest('**/api/draws');
      await dialog.getByRole('button', { name: '重新保存', exact: true }).click();
      await saveStarted;
      await dialog.getByRole('button', { name: '关闭开奖结果' }).click();
      await dialog.waitFor({ state: 'detached' });

      if (scenario === 'reopen') {
        await page.locator('.history-list > button').first().click();
        assert.equal(await dialog.getByRole('button', { name: '重新保存', exact: true }).count(), 0,
          '关闭再打开结果时，尚未结束的保存应保持同步中，不能再次提交');
      } else if (scenario === 'clear') {
        await page.getByRole('tab', { name: '更多', exact: true }).click();
        await page.getByRole('button', { name: /数据设置/ }).click();
        await page.getByRole('button', { name: /清空本机抽奖数据/ }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: '清空', exact: true }).click();
        await page.getByText('已清空', { exact: true }).waitFor();
      }
      releaseSave();
      if (scenario !== 'clear') {
        await page.waitForFunction(key => JSON.parse(localStorage.getItem(key)).items[0]?.recordState === 'server', historyKey);
      } else {
        await page.waitForTimeout(250);
        assert.equal(await page.evaluate(key => localStorage.getItem(key), historyKey), null);
        assert.equal(await page.locator('[data-app-status]').filter({ hasText: /开奖记录已保存|开奖记录已同步/ }).count(), 0,
          '清空操作取消保存后，旧响应不能再宣告成功');
      }
      if (scenario === 'count') {
        await page.getByRole('tab', { name: '抽奖', exact: true }).click();
        await page.locator('.v3-draw-count').getByText('此前已完成 8 次', { exact: true }).waitFor();
      }
      assert.equal(saveCount, 1);
      assert.deepEqual(errors, []);
    } finally {
      releaseSave();
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log('RECEIPT_RETRY_UI_OK');
