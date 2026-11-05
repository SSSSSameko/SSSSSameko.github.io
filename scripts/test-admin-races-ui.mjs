import assert from 'node:assert/strict';
import { gotoUiPage, launchUiBrowser } from './playwright-browser.mjs';
import { draws, feedback, summary } from './fixtures/admin-preview.mjs';

const baseUrl = process.env.ADMIN_UI_URL || 'http://127.0.0.1:4173/admin';
const browser = await launchUiBrowser();
const screenshot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

function gate() {
  let release;
  let arrived;
  return {
    waiting: new Promise((resolve) => { release = resolve; }),
    started: new Promise((resolve) => { arrived = resolve; }),
    release: () => release(),
    arrive: () => arrived(),
  };
}

async function fixture(run) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const data = {
    draws: structuredClone(draws.slice(0, 2)),
    feedback: structuredClone(feedback.slice(0, 2)),
    login: { active: false, status: 'idle' },
    summaryGates: [],
    statusGates: [],
    drawsGates: [],
    feedbackGates: [],
    drawsRequests: 0,
    feedbackRequests: 0,
    statusRequests: 0,
  };
  const allGates = [];
  data.hold = (kind) => {
    const pending = gate();
    data[`${kind}Gates`].push(pending);
    allGates.push(pending);
    return pending;
  };
  await page.route('**/api/admin/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let response = { ok: true };
    let pending;
    if (path === '/api/admin/session') response = { username: 'fixture', csrfToken: 'fixture' };
    else if (path === '/api/admin/summary') {
      response = { ...summary, weiboLogin: structuredClone(data.login) };
      pending = data.summaryGates.shift();
    } else if (path === '/api/admin/draws') {
      data.drawsRequests += 1;
      response = { ok: true, items: data.draws };
      pending = data.drawsGates.shift();
    } else if (path === '/api/admin/feedback') {
      data.feedbackRequests += 1;
      response = { ok: true, items: data.feedback };
      pending = data.feedbackGates.shift();
    } else if (path.startsWith('/api/admin/draws/')) {
      const file = decodeURIComponent(path.split('/').at(-1));
      if (method === 'DELETE') data.draws = data.draws.filter((item) => item.file !== file);
      else response = { ok: true, item: data.draws.find((item) => item.file === file) };
    } else if (path.startsWith('/api/admin/feedback/')) {
      const id = decodeURIComponent(path.split('/').at(-1));
      if (method === 'DELETE') data.feedback = data.feedback.filter((item) => item.id !== id);
    } else if (path === '/api/admin/weibo-login/start') {
      data.login = { active: true, status: 'waiting_scan', screenshot, message: '等待扫码' };
      response = data.login;
    } else if (path === '/api/admin/weibo-login/stop') {
      data.login = { active: false, status: 'idle', message: '扫码窗口已关闭' };
      response = data.login;
    } else if (path === '/api/admin/weibo-login/status') {
      data.statusRequests += 1;
      response = structuredClone(data.login);
      pending = data.statusGates.shift();
    }
    if (pending) {
      pending.arrive();
      await pending.waiting;
    }
    await route.fulfill({ json: response }).catch(() => {});
  });
  try {
    await gotoUiPage(page, baseUrl);
    await page.locator('#dashboard:not(.hidden)').waitFor();
    await page.waitForFunction(() => !document.querySelector('#refreshBtn').disabled);
    await run(page, data);
    assert.deepEqual(errors, []);
  } finally {
    for (const pending of allGates) pending.release();
    await context.close();
  }
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

try {
  for (const kind of ['draws', 'feedback']) {
    await fixture(async (page, data) => {
      const oldSummary = data.hold('summary');
      const oldList = data.hold(kind);
      await page.locator('#refreshBtn').click();
      await oldSummary.started;
      await oldList.started;
      await page.getByRole('tab', { name: kind === 'draws' ? '记录' : '反馈', exact: true }).click();
      const beforeCount = data[`${kind}Requests`];
      const target = data[kind][0];
      if (kind === 'draws') {
        await page.locator(`[data-file="${target.file}"]`).click();
        await page.locator('#detailContent [data-action="delete"]').click();
      } else {
        await page.locator(`[data-feedback-id="${target.id}"][data-feedback-action="delete"]`).click();
      }
      const newSummary = data.hold('summary');
      await page.locator('#confirmDeleteBtn').click();
      // The post-delete refresh must start while the earlier summary is still pending.
      await Promise.race([
        newSummary.started,
        page.waitForTimeout(5000).then(() => { throw new Error(`${kind}: post-delete refresh did not start`); }),
      ]);
      const deletedSelector = kind === 'draws'
        ? `[data-file="${target.file}"]`
        : `[data-feedback-id="${target.id}"]`;
      await page.locator(deletedSelector).first().waitFor({ state: 'detached' });
      assert.ok(data[`${kind}Requests`] > beforeCount);
      const oldResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/admin/summary');
      oldList.release();
      oldSummary.release();
      await oldResponse;
      await settle(page);
      assert.equal(await page.locator('#refreshBtn').isDisabled(), true, 'old refresh must not finish the replacement refresh');
      assert.equal(await page.locator(deletedSelector).count(), 0, 'old refresh must not restore deleted data');
      newSummary.release();
      await page.waitForFunction(() => !document.querySelector('#refreshBtn').disabled);
      assert.equal(await page.locator(deletedSelector).count(), 0);
    });
  }

  await fixture(async (page, data) => {
    const oldSummary = data.hold('summary');
    await page.locator('#refreshBtn').click();
    await oldSummary.started;
    await page.getByRole('tab', { name: 'Cookie', exact: true }).click();
    const oldStatus = data.hold('status');
    await page.locator('#startWeiboLoginBtn').click();
    await page.locator('#qrFrame:not(.hidden)').waitFor();
    const oldResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/admin/summary');
    oldSummary.release();
    await oldResponse;
    await settle(page);
    assert.equal(await page.locator('#qrFrame').isVisible(), true, 'old summary must not hide the new QR code');
    assert.equal(await page.locator('#stopWeiboLoginBtn').isEnabled(), true);
    await Promise.race([
      oldStatus.started,
      page.waitForTimeout(5000).then(() => { throw new Error('QR polling stopped after stale summary'); }),
    ]);
    await page.locator('#stopWeiboLoginBtn').click();
    await page.locator('#qrFrame').waitFor({ state: 'hidden' });
    const statusResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/admin/weibo-login/status');
    oldStatus.release();
    await statusResponse;
    await settle(page);
    assert.equal(await page.locator('#qrFrame').isVisible(), false, 'old status must not restore a stopped QR session');
    assert.equal(await page.locator('#startWeiboLoginBtn').isEnabled(), true);
    assert.equal(await page.locator('#stopWeiboLoginBtn').isDisabled(), true);
    const polls = data.statusRequests;
    await page.waitForTimeout(2800);
    assert.equal(data.statusRequests, polls, 'stale status must not restart polling');
  });
  console.log('ADMIN_RACES_UI_OK');
} finally {
  await browser.close();
}
