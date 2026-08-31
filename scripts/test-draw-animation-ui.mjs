import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const outputDir = new URL('../output/ui-checks/', import.meta.url);

await mkdir(outputDir, { recursive: true });
const browser = await launchUiBrowser();
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  let saveResponded = false;
  await page.route('**/api/draws', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await route.fulfill({
      status: 201,
      json: {
        ok: true,
        file: 'draw-ui-test.json',
        drawNumber: 1,
        savedAt: new Date().toISOString(),
        auditHash: 'draw-ui-test-audit-hash',
      },
    });
    saveResponded = true;
  });
  await gotoUiPage(page, baseUrl);

  await page.getByRole('button', { name: '或手动导入候选名单' }).click();
  await page.getByRole('textbox', { name: '弹窗手动候选名单' }).fill(
    '小柚子\n森森\n月岛\n圆圆\n小蓝\nAlice\nMomo\n奈奈',
  );
  await page.getByRole('button', { name: '替换名单' }).click();
  const sourceSheet = page.getByRole('dialog', { name: '候选来源' });
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await sourceSheet.waitFor({ state: 'detached' });

  assert.equal(await page.getByText('8 名候选 · 1 个奖项 · 1 个名额', { exact: true }).isVisible(), true);
  assert.equal(
    await page.locator('.candidate-deck .pass-main').getByText('8', { exact: true }).isVisible(),
    true,
  );
  assert.equal(await page.locator('.result-rail header button').count(), 0);

  await page.locator('.draw-specs > button').first().click();
  const sourceSwitchSheet = page.getByRole('dialog', { name: '候选来源' });
  await sourceSwitchSheet.getByRole('button', { name: '微博链接', exact: true }).click();
  await sourceSwitchSheet.getByRole('button', { name: '完成', exact: true }).click();
  await sourceSwitchSheet.waitFor({ state: 'detached' });
  const sourceRow = page.getByRole('button', { name: /候选来源/ }).first();
  await sourceRow.click();
  const reloadSheet = page.getByRole('dialog', { name: '候选来源' });
  assert.equal(await page.getByRole('dialog', { name: '奖项设置' }).count(), 0);
  await reloadSheet.getByRole('button', { name: '手动名单', exact: true }).click();
  await reloadSheet.getByRole('button', { name: '替换名单', exact: true }).click();
  await reloadSheet.getByRole('button', { name: '完成', exact: true }).click();
  await reloadSheet.waitFor({ state: 'detached' });

  const setup = page.getByRole('button', { name: /设置奖项并确认/ });
  assert.equal(await setup.isVisible(), true);
  await setup.click();
  const prizeSheet = page.getByRole('dialog', { name: '奖项设置' });
  await page.waitForTimeout(360);
  await page.screenshot({
    path: fileURLToPath(new URL('prize-setup-mobile.png', outputDir)),
    fullPage: false,
  });
  await prizeSheet.getByRole('button', { name: '确认奖项设置' }).click();
  await prizeSheet.waitFor({ state: 'detached' });
  const confirmSheet = page.getByRole('dialog', { name: '开奖前确认' });
  await confirmSheet.waitFor({ state: 'visible' });
  assert.equal(await confirmSheet.getByText('本机第 1 次手动开奖').isVisible(), true);
  assert.equal(await confirmSheet.getByText('名单截止', { exact: true }).isVisible(), true);
  assert.equal(await confirmSheet.getByRole('button', { name: '更新候选', exact: true }).count(), 0);
  assert.equal(await confirmSheet.getByRole('button', { name: '修改奖项', exact: true }).isVisible(), true);
  await page.waitForTimeout(360);
  await page.screenshot({
    path: fileURLToPath(new URL('draw-confirm-mobile.png', outputDir)),
    fullPage: false,
  });
  await page.evaluate(() => {
    const shell = document.querySelector('.app-shell');
    window.__drawUiTiming = { finishedAt: 0, receiptAt: 0 };
    const recordTiming = () => {
      const now = performance.now();
      if (shell?.dataset.drawState === 'finished' && !window.__drawUiTiming.finishedAt) {
        window.__drawUiTiming.finishedAt = now;
      }
      if (document.querySelector('.receipt-sheet') && !window.__drawUiTiming.receiptAt) {
        window.__drawUiTiming.receiptAt = now;
      }
    };
    window.__drawUiTimingObserver = new MutationObserver(recordTiming);
    window.__drawUiTimingObserver.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['data-draw-state'],
    });
    recordTiming();
  });
  await confirmSheet.getByRole('button', { name: '确认并开始抽奖' }).click();
  const running = page.locator('.app-shell[data-draw-state="running"]');
  await page.locator('.flow-sheet-backdrop.is-closing').waitFor({ state: 'visible' });
  assert.equal(await running.count(), 0);
  await confirmSheet.waitFor({ state: 'detached' });
  await running.waitFor({ state: 'visible' });
  const stopDraw = page.getByRole('button', { name: '停止本次开奖' });
  assert.equal(await stopDraw.isVisible(), true);
  await stopDraw.click();
  await page.locator('.app-shell[data-draw-state="ready"]').waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('dialog', { name: '开奖结果' }).count(), 0);
  assert.equal(await page.locator('.result-rail header button').count(), 0);
  assert.equal(saveResponded, false);
  await page.locator('[data-app-status]').getByText('本次开奖已停止，未产生有效结果。', { exact: true }).waitFor();

  await page.locator('.draw-ready .primary-button').click();
  const resumedConfirmSheet = page.getByRole('dialog', { name: '开奖前确认' });
  await resumedConfirmSheet.waitFor({ state: 'visible' });
  await resumedConfirmSheet.getByRole('button', { name: '确认并开始抽奖' }).click();
  await resumedConfirmSheet.waitFor({ state: 'detached' });
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
  assert.equal(transformsA.length, 3);
  assert.ok(new Set(transformsA).size >= 2);
  await page.screenshot({
    path: fileURLToPath(new URL('draw-running-b.png', outputDir)),
    fullPage: false,
  });

  const finished = page.locator('.app-shell[data-draw-state="finished"]');
  await finished.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.result-rail header button').isVisible(), true);
  const dialog = page.getByRole('dialog', { name: '开奖结果' });
  assert.equal(await dialog.count(), 0);
  await page.screenshot({
    path: fileURLToPath(new URL('draw-finished-before-sheet.png', outputDir)),
    fullPage: false,
  });

  await dialog.waitFor({ state: 'visible' });
  const drawTiming = await page.evaluate(() => {
    window.__drawUiTimingObserver?.disconnect();
    return window.__drawUiTiming;
  });
  assert.ok(drawTiming.finishedAt > 0);
  assert.ok(drawTiming.receiptAt - drawTiming.finishedAt >= 600);
  assert.equal(await dialog.getByText('1 位中奖用户').isVisible(), true);
  const singleWinnerName = dialog.locator('.receipt-single-winner strong');
  assert.equal(await singleWinnerName.isVisible(), true);
  assert.ok((await singleWinnerName.textContent())?.trim());
  assert.equal(saveResponded, false, '结果弹窗不应等待服务器保存完成');
  assert.equal(await dialog.getByText('正在同步开奖记录', { exact: true }).isVisible(), true);
  const announcementFormat = dialog.getByRole('combobox', { name: '公示文案格式' });
  await announcementFormat.focus();
  await dialog.getByText('手动名单 · 本机第 1 次开奖', { exact: true }).waitFor();
  assert.equal(saveResponded, true);
  assert.equal(
    await announcementFormat.evaluate((element) => element === document.activeElement),
    true,
    '服务器同步结果不应重置弹层内的键盘焦点',
  );
  await context.close();

  const linkContext = await browser.newContext({
    viewport: { width: 320, height: 700 },
    reducedMotion: 'reduce',
  });
  const linkPage = await linkContext.newPage();
  const candidates = ['小柚子', '森森', '月岛', '圆圆'].map((screenName, index) => ({
    id: `candidate-${index}`,
    uid: `100${index}`,
    screenName,
    repostId: `repost-${index}`,
    text: '转发微博',
    source: 'desktop-cookie',
  }));
  await linkPage.route('**/api/weibo/draw-count**', (route) => route.fulfill({
    status: 200,
    json: { ok: true, statusId: '1234567890', drawCount: 2, lastDrawnAt: '' },
  }));
  await linkPage.route('**/api/weibo/reposts/jobs', (route) => route.fulfill({
    status: 200,
    json: {
      ok: true,
      jobId: '',
      status: 'done',
      delivery: 'fresh',
      progress: { phase: 'done', percent: 100, message: '载入完成' },
      result: {
        ok: true,
        statusId: '1234567890',
        statusUrl: 'https://weibo.com/2715025067/Example',
        drawCount: 2,
        candidates,
        meta: {
          provider: 'desktop-cookie',
          complete: true,
          loadedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          headReconciled: true,
          headAddedCount: 1,
          pages: [{ page: 1, count: 4 }],
        },
      },
    },
  }));
  await linkPage.route('**/api/draws', (route) => route.fulfill({
    status: 201,
    json: {
      ok: true,
      file: 'draw-link-ui-test.json',
      drawNumber: 3,
      savedAt: new Date().toISOString(),
      auditHash: 'draw-link-ui-test-audit-hash',
    },
  }));
  await linkPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await linkPage.getByRole('textbox', { name: '微博链接、mid 或 bid' }).fill('https://weibo.com/2715025067/Example');
  await linkPage.getByRole('button', { name: /载入候选/ }).click();
  await linkPage.getByRole('button', { name: /设置奖项并确认/ }).click();
  const linkPrizeSheet = linkPage.getByRole('dialog', { name: '奖项设置' });
  await linkPrizeSheet.getByRole('button', { name: '确认奖项设置' }).click();
  await linkPrizeSheet.waitFor({ state: 'detached' });
  const linkConfirmSheet = linkPage.getByRole('dialog', { name: '开奖前确认' });
  await linkConfirmSheet.waitFor({ state: 'visible' });
  assert.equal(await linkConfirmSheet.getByText('本链接第 3 次开奖', { exact: true }).isVisible(), true);
  assert.equal(await linkConfirmSheet.getByText(/一分钟内不能重复开奖/).isVisible(), true);
  assert.equal(await linkConfirmSheet.getByRole('button', { name: '更新候选', exact: true }).isVisible(), true);
  assert.equal(await linkConfirmSheet.locator('.v3-confirm-facts > .is-stale').count(), 1);
  assert.equal(await linkPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await linkPage.waitForTimeout(360);
  await linkPage.screenshot({
    path: fileURLToPath(new URL('draw-confirm-link-320.png', outputDir)),
    fullPage: false,
  });
  await linkConfirmSheet.getByRole('button', { name: '确认并开始抽奖' }).click();
  const linkResultSheet = linkPage.getByRole('dialog', { name: '开奖结果' });
  await linkResultSheet.waitFor({ state: 'visible' });
  await linkResultSheet.getByRole('button', { name: '关闭开奖结果' }).click();
  await linkResultSheet.waitFor({ state: 'detached' });
  await linkPage.getByRole('button', { name: '设置并再次抽奖' }).click();
  const repeatPrizeSheet = linkPage.getByRole('dialog', { name: '奖项设置' });
  await repeatPrizeSheet.waitFor({ state: 'visible' });
  await repeatPrizeSheet.getByRole('button', { name: '确认奖项设置' }).click();
  const repeatConfirmSheet = linkPage.getByRole('dialog', { name: '开奖前确认' });
  await repeatConfirmSheet.waitFor({ state: 'visible' });
  await repeatConfirmSheet.getByRole('button', { name: /本地演练/ }).click();
  const practiceResultSheet = linkPage.getByRole('dialog', { name: '本地演练结果' });
  await practiceResultSheet.waitFor({ state: 'visible' });
  assert.equal(await practiceResultSheet.getByText('本地演练 · 不计入开奖次数', { exact: true }).isVisible(), true);
  await practiceResultSheet.getByRole('button', { name: '关闭开奖结果' }).click();
  await practiceResultSheet.waitFor({ state: 'detached' });

  await linkPage.getByRole('button', { name: '设置并再次抽奖' }).click();
  const blockedPrizeSheet = linkPage.getByRole('dialog', { name: '奖项设置' });
  await blockedPrizeSheet.waitFor({ state: 'visible' });
  await blockedPrizeSheet.getByRole('button', { name: '确认奖项设置' }).click();
  const blockedConfirmSheet = linkPage.getByRole('dialog', { name: '开奖前确认' });
  await blockedConfirmSheet.waitFor({ state: 'visible' });
  await blockedConfirmSheet.getByRole('button', { name: '确认并开始抽奖' }).click();
  const cooldownDialog = linkPage.getByRole('alertdialog');
  assert.equal(await cooldownDialog.getByText('请稍后开奖', { exact: true }).isVisible(), true);
  assert.equal(await cooldownDialog.getByText(/请 \d+ 秒后再试/).isVisible(), true);
  assert.equal(await blockedConfirmSheet.isVisible(), true);
  await linkContext.close();

  const unknownCountContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  try {
    const unknownCountPage = await unknownCountContext.newPage();
    unknownCountPage.setDefaultTimeout(8_000);
    await unknownCountPage.route('**/api/weibo/draw-count**', (route) => route.fulfill({
      status: 503,
      json: { ok: false, error: '模拟次数服务暂不可用' },
    }));
    await unknownCountPage.route('**/api/weibo/reposts/jobs', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        json: {
          ok: true,
          jobId: 'unknown-count-ui-test',
          status: 'done',
          result: {
            ok: true,
            statusId: '9876543210',
            statusUrl: 'https://weibo.com/2715025067/UnknownCount',
            candidates: [{
              id: 'unknown-count-candidate',
              uid: '9001',
              screenName: '次数待核实候选',
              text: '转发微博',
              source: 'desktop-cookie',
            }],
            meta: { provider: 'desktop-cookie', complete: true, pages: [{ page: 1, count: 1 }] },
          },
        },
      });
    });
    await unknownCountPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await unknownCountPage.getByRole('textbox', { name: '微博链接、mid 或 bid' }).fill('https://weibo.com/2715025067/UnknownCount');
    await unknownCountPage.getByRole('button', { name: /载入候选/ }).click();
    await unknownCountPage.getByText('1 名候选 · 1 个奖项 · 1 个名额', { exact: true }).waitFor();
    await unknownCountPage.getByRole('button', { name: /设置奖项并确认/ }).click();
    const unknownPrizeSheet = unknownCountPage.getByRole('dialog', { name: '奖项设置' });
    await unknownPrizeSheet.getByRole('button', { name: '确认奖项设置' }).click();
    const unknownConfirmSheet = unknownCountPage.getByRole('dialog', { name: '开奖前确认' });
    await unknownConfirmSheet.waitFor({ state: 'visible' });
    assert.equal(await unknownConfirmSheet.getByText('本链接下一次开奖（次数待核实）', { exact: true }).isVisible(), true);
    assert.equal(await unknownConfirmSheet.getByText('历史次数暂未核实', { exact: true }).isVisible(), true);
    assert.equal(await unknownConfirmSheet.getByText(/历史次数暂未核实，本次完成后/).isVisible(), true);
  } finally {
    await unknownCountContext.close();
  }
} finally {
  await browser.close();
}

console.log('DRAW_ANIMATION_UI_OK');
