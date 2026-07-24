import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5191/';
const executablePath = process.env.PLAYWRIGHT_CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const outputDir = new URL('../output/ui-checks/', import.meta.url);
const historyKey = 'weibo-draw-history-v2';
const receipt = {
  id: 'receipt-ui-test',
  source: 'mobile',
  statusId: '1234567890',
  statusUrl: 'https://weibo.com/1/Example',
  drawNumber: 2,
  drawnAt: '2026-07-24T02:00:00.000Z',
  savedAt: '2026-07-24T02:00:01.000Z',
  results: [{
    prize: { name: '幸运奖', count: 3, color: '#ee8fa1' },
    winners: [
      { uid: '1001', screenName: 'sameko', avatar: '' },
      { uid: '1002', screenName: 'Alice', avatar: '' },
      { uid: '1003', screenName: '小蓝', avatar: '' },
    ],
  }, {
    prize: { name: '特别奖', count: 3, color: '#54c6a8' },
    winners: [
      { uid: '1004', screenName: 'Yui', avatar: '' },
      { uid: '1005', screenName: 'Momo', avatar: '' },
      { uid: '1006', screenName: '奈奈', avatar: '' },
    ],
  }],
  candidateCount: 20,
  eligibleCount: 18,
  excludedCount: 2,
  rules: {
    filters: {
      keyword: '',
      mentionMin: 0,
      uniqueByUser: true,
      excludePrevious: true,
    },
    prizes: [
      { name: '幸运奖', count: 3, color: '#ee8fa1' },
      { name: '特别奖', count: 3, color: '#54c6a8' },
    ],
  },
  sourceMeta: {
    provider: 'mobile',
    complete: true,
    totalNumber: 20,
    visibleNumber: 20,
  },
  seed: 'seed-for-ui-test',
  candidateDigest: 'candidate-digest-for-ui-test',
  auditHash: 'audit-hash-for-ui-test',
  recordState: 'server',
};
const cases = [
  { name: '390x844', viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' },
  { name: '320x700', viewport: { width: 320, height: 700 }, reducedMotion: 'no-preference' },
  { name: 'reduced-motion', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' },
  { name: 'desktop-1440x900', viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' },
];

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
try {
  for (const item of cases) {
    const context = await browser.newContext({
      viewport: item.viewport,
      reducedMotion: item.reducedMotion,
    });
    await context.addInitScript(({ key, value }) => {
      localStorage.setItem(key, JSON.stringify({ version: 2, items: [value] }));
    }, { key: historyKey, value: receipt });
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    if (item.name === 'desktop-1440x900') {
      const shell = await page.locator('.app-shell').boundingBox();
      assert.ok(shell && shell.width >= 390 && shell.width <= 430);
      assert.ok(shell.height > 600);
    }
    await page.locator('.root-tabbar button').filter({ hasText: '记录' }).click();
    await page.locator('.history-list > button').first().click();

    const dialog = page.getByRole('dialog', { name: /开奖结果/ });
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.getByText('本链接第 2 次开奖').first().isVisible(), true);
    assert.equal(await dialog.getByText('筛选规则').first().isVisible(), true);
    assert.equal(await dialog.getByText('SHA-256 · Fisher–Yates').first().isVisible(), true);
    assert.equal(await dialog.getByText('审计哈希').first().isVisible(), true);
    assert.equal(await dialog.getByText('开奖序号').count(), 0);
    assert.equal(await dialog.getByText('仅保存在本机').count(), 0);
    assert.equal(await dialog.getByText('幸运奖').first().isVisible(), true);
    assert.equal(await dialog.getByText('sameko').first().isVisible(), true);
    assert.equal(await dialog.locator('.receipt-winner').count(), 6);
    const finalWinner = dialog.getByText('奈奈').first();
    await finalWinner.scrollIntoViewIfNeeded();
    assert.equal(await finalWinner.isVisible(), true);
    const saveImageButton = dialog.getByRole('button', { name: /保存结果图/ });
    const layout = await page.evaluate(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          top: box.top,
          bottom: box.bottom,
          height: box.height,
          display: style.display,
          overflow: style.overflow,
          gridTemplateRows: style.gridTemplateRows,
        };
      };
      return {
        viewport: {
          innerHeight: window.innerHeight,
          clientHeight: document.documentElement.clientHeight,
          visualHeight: window.visualViewport?.height,
        },
        backdrop: rect('.receipt-backdrop'),
        sheet: rect('.receipt-sheet'),
        content: rect('.receipt-content'),
        actions: rect('.receipt-actions'),
      };
    });
    assert.equal(await saveImageButton.isVisible(), true, JSON.stringify(layout));
    const sheetBox = await dialog.boundingBox();
    const actionBox = await saveImageButton.boundingBox();
    assert.ok(sheetBox && sheetBox.y >= 0);
    assert.ok(
      actionBox && actionBox.y + actionBox.height <= item.viewport.height + 1,
      JSON.stringify({ actionBox, layout, viewport: item.viewport }),
    );
    if (item.name === '390x844') {
      await dialog.locator('.receipt-audit').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: fileURLToPath(new URL('390x844-audit.png', outputDir)),
      });
      const downloadPromise = page.waitForEvent('download');
      await saveImageButton.click();
      const download = await downloadPromise;
      const posterPath = fileURLToPath(new URL('result-poster.png', outputDir));
      await download.saveAs(posterPath);
      const png = await readFile(posterPath);
      assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
      assert.equal(png.readUInt32BE(16), 1080);
      assert.ok(png.readUInt32BE(20) >= 1280);
    }
    const overflow = await page.evaluate(() => (
      document.documentElement.scrollWidth > document.documentElement.clientWidth
    ));
    assert.equal(overflow, false);
    await dialog.locator('.receipt-content').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: fileURLToPath(new URL(`${item.name}.png`, outputDir)),
      fullPage: true,
    });
    await dialog.getByRole('button', { name: /关闭/ }).click();
    await dialog.waitFor({ state: 'detached' });
    await context.close();
  }
} finally {
  await browser.close();
}

console.log('DRAW_RECEIPT_UI_OK');
