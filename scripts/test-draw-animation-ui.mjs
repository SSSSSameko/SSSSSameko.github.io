import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5191/';
const executablePath = process.env.PLAYWRIGHT_CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const outputDir = new URL('../output/ui-checks/', import.meta.url);

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: '没有微博链接？手动导入名单' }).click();
  await page.getByRole('textbox', { name: '弹窗手动候选名单' }).fill(
    '小柚子\n森森\n月岛\n圆圆\n小蓝\nAlice\nMomo\n奈奈',
  );
  await page.getByRole('button', { name: '替换名单' }).click();
  await page.getByRole('button', { name: '完成', exact: true }).click();

  const start = page.getByRole('button', { name: /开始抽奖/ });
  await start.click();
  const running = page.locator('.app-shell[data-draw-state="running"]');
  await running.waitFor({ state: 'visible' });
  await page.waitForTimeout(140);
  const transformsA = await page.locator('[data-deck-card]').evaluateAll((cards) => (
    cards.map((card) => getComputedStyle(card).transform)
  ));
  await page.screenshot({
    path: fileURLToPath(new URL('draw-running-a.png', outputDir)),
    fullPage: false,
  });

  await page.waitForTimeout(360);
  const transformsB = await page.locator('[data-deck-card]').evaluateAll((cards) => (
    cards.map((card) => getComputedStyle(card).transform)
  ));
  assert.notDeepEqual(transformsA, transformsB);
  assert.equal(new Set(transformsA).size, 3);
  await page.screenshot({
    path: fileURLToPath(new URL('draw-running-b.png', outputDir)),
    fullPage: false,
  });

  const finished = page.locator('.app-shell[data-draw-state="finished"]');
  await finished.waitFor({ state: 'visible' });
  const finishedAt = Date.now();
  const dialog = page.getByRole('dialog', { name: '开奖结果' });
  assert.equal(await dialog.count(), 0);
  await page.screenshot({
    path: fileURLToPath(new URL('draw-finished-before-sheet.png', outputDir)),
    fullPage: false,
  });

  await dialog.waitFor({ state: 'visible' });
  assert.ok(Date.now() - finishedAt >= 600);
  assert.equal(await dialog.getByText('1 位中奖用户').isVisible(), true);
  await context.close();
} finally {
  await browser.close();
}

console.log('DRAW_ANIMATION_UI_OK');
