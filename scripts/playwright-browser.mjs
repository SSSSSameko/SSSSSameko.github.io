import { existsSync } from 'node:fs';

import { chromium } from 'playwright';

const windowsChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export function launchUiBrowser(options = {}) {
  const configuredPath = String(process.env.PLAYWRIGHT_CHROME_PATH || '').trim();
  const executablePath = configuredPath
    || (process.platform === 'win32' && existsSync(windowsChrome) ? windowsChrome : '');
  return chromium.launch({
    headless: true,
    ...options,
    ...(executablePath ? { executablePath } : {}),
  });
}

export async function gotoUiPage(page, url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', ...options });
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      await page.waitForTimeout(150 * (attempt + 1));
    }
  }
  throw lastError;
}
