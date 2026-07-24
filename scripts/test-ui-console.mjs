import { chromium } from 'playwright';

const executablePath = process.env.PLAYWRIGHT_CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];

page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

await page.goto('http://127.0.0.1:5191/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await browser.close();

if (errors.length) {
  throw new Error(errors.join('\n'));
}

console.log('UI_CONSOLE_OK');
