import { chromium } from 'playwright';

const executablePath = process.env.PLAYWRIGHT_CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const baseUrl = process.env.UI_CONSOLE_URL
  || process.env.DRAW_UI_URL
  || 'http://127.0.0.1:5195/';
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];

page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

await page.goto(baseUrl, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const layout = await page.evaluate(() => ({
  viewport: window.innerWidth,
  pageWidth: document.documentElement.scrollWidth,
  unnamedButtons: [...document.querySelectorAll('button')]
    .filter((button) => !String(button.innerText || button.getAttribute('aria-label') || button.title || '').trim())
    .length,
}));
await browser.close();

if (errors.length) {
  throw new Error(errors.join('\n'));
}
if (layout.pageWidth > layout.viewport || layout.unnamedButtons) {
  throw new Error(`UI layout check failed: ${JSON.stringify(layout)}`);
}

console.log('UI_CONSOLE_OK');
