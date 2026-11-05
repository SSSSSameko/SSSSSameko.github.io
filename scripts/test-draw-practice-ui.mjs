import assert from 'node:assert/strict';

import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';

const baseUrl = process.env.DRAW_UI_URL || 'http://127.0.0.1:5195/';
const browser = await launchUiBrowser();

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const drawRequests = [];
  const errors = [];

  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/draws') drawRequests.push(request);
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await gotoUiPage(page, baseUrl);
  const currentStep = page.locator('.workspace-steps [aria-current="step"]');
  assert.match(await currentStep.innerText(), /载入名单/);
  await page.getByRole('button', { name: '或手动导入候选名单' }).click();
  const sourceSheet = page.getByRole('dialog', { name: '候选来源' });
  const sourceInput = sourceSheet.getByRole('textbox', { name: '弹窗手动候选名单' });
  await sourceInput.fill('小柚子\n森森\n月岛');
  await sourceSheet.getByRole('button', { name: '替换名单', exact: true }).click();
  const sourceNext = sourceSheet.getByRole('button', { name: '设置奖项并确认', exact: true });
  await sourceNext.waitFor({ state: 'visible' });
  await sourceInput.fill('小柚子\n森森\n月岛\n圆圆');
  assert.equal(await sourceNext.count(), 0, '编辑来源后不可直接使用旧名单继续开奖');
  await sourceSheet.getByRole('button', { name: '替换名单', exact: true }).click();
  await sourceNext.click();
  await sourceSheet.waitFor({ state: 'detached' });
  const sourcePrizeSheet = page.getByRole('dialog', { name: '奖项设置' });
  await sourcePrizeSheet.waitFor();
  await page.waitForFunction(() => document.activeElement?.closest('[aria-label="奖项设置"]'));
  await sourcePrizeSheet.getByRole('button', { name: '关闭奖项设置' }).click();
  await sourcePrizeSheet.waitFor({ state: 'detached' });

  await page.locator('.root-tabbar button').filter({ hasText: '名单' }).click();
  await page.getByRole('button', { name: '收起来源', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '手动候选名单', exact: true }).count(), 0);
  await page.getByRole('button', { name: '编辑来源', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '手动候选名单', exact: true }).inputValue(), '小柚子\n森森\n月岛\n圆圆', '收起来源不能清空输入');
  await page.getByRole('textbox', { name: '手动候选名单', exact: true }).fill('小柚子\n森森');
  assert.equal(await page.locator('.candidate-next-step').count(), 0, '名单页编辑后也必须重新载入');
  await page.getByRole('textbox', { name: '手动候选名单', exact: true }).fill('小柚子\n森森\n月岛\n圆圆');
  await page.getByRole('button', { name: '替换名单', exact: true }).click();

  assert.match(await currentStep.innerText(), /确认奖项/);
  await page.getByRole('button', { name: /设置奖项并确认/ }).click();
  assert.equal(await page.getByRole('tab', { name: '抽奖', exact: true, includeHidden: true }).getAttribute('aria-selected'), 'true', '从名单继续应返回开奖工作台');
  const prizeSheet = page.getByRole('dialog', { name: '奖项设置' });
  await prizeSheet.getByRole('button', { name: '确认奖项设置' }).click();

  const confirmSheet = page.getByRole('dialog', { name: '开奖前确认' });
  await confirmSheet.waitFor({ state: 'visible' });
  assert.match(await currentStep.innerText(), /开始抽奖/);
  assert.equal(await confirmSheet.locator('.v3-confirm-preview').isVisible(), true);
  assert.equal(await confirmSheet.getByText('4', { exact: true }).count() > 0, true);
  assert.equal(await confirmSheet.getByText('可抽人数', { exact: true }).isVisible(), true);
  assert.equal(await confirmSheet.getByRole('button', { name: /本地演练/ }).isVisible(), true);

  await confirmSheet.getByRole('button', { name: /本地演练/ }).click();
  await confirmSheet.waitFor({ state: 'detached' });

  const resultSheet = page.getByRole('dialog', { name: '本地演练结果' });
  await resultSheet.waitFor({ state: 'visible' });
  assert.equal(await currentStep.count(), 0, '抽奖完成后不应仍显示待执行的当前步骤');
  assert.equal(await page.locator('.workspace-steps .is-complete').count(), 3);
  assert.equal(await resultSheet.getByText('本地演练 · 不计入开奖次数', { exact: true }).isVisible(), true);
  assert.equal(await resultSheet.getByText('仅用于核对动画与设置，不保存记录，也不计入本链接开奖次数。', { exact: true }).isVisible(), true);
  const copyFormat = resultSheet.getByRole('group', { name: '公示文案格式' });
  assert.equal(await copyFormat.isVisible(), true);
  assert.deepEqual(
    await copyFormat.getByRole('button').allTextContents(),
    ['公示版', '名单版', '记录版'],
  );
  assert.equal(await resultSheet.getByRole('button', { name: '重新保存' }).count(), 0);
  assert.equal(drawRequests.length, 0, '本地演练不应请求正式开奖记录接口');
  assert.deepEqual(errors, []);

  await page.keyboard.press('Escape');
  await resultSheet.waitFor({ state: 'detached' });
  const resultTrigger = page.getByRole('button', { name: '查看开奖结果' });
  await resultTrigger.waitFor({ state: 'visible' });
  await page.waitForFunction(() => (
    document.activeElement?.getAttribute('aria-label') === '查看开奖结果'
  ));
  assert.equal(
    await resultTrigger.evaluate((element) => element === document.activeElement),
    true,
    '关闭自动打开的结果弹层后，焦点没有回到结果入口',
  );
  await page.locator('.root-tabbar button').filter({ hasText: '记录' }).click();
  assert.equal(
    await page.locator('[data-root-view="history"]').getByText('暂无开奖记录', { exact: true }).isVisible(),
    true,
  );
  assert.equal(drawRequests.length, 0, '本地演练不应在关闭结果后写入记录');

  await context.close();
} finally {
  await browser.close();
}

console.log('DRAW_PRACTICE_UI_OK');
