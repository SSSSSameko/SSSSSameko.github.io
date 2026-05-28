import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function safeBodyText(page) {
  try {
    return await page.locator('body').innerText({ timeout: 3000 });
  } catch {
    return '';
  }
}

async function findInstalledBrowser() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  return undefined;
}

const args = parseArgs(process.argv);
const profileDir = path.resolve(rootDir, args.profile || path.join('profiles', 'customer'));
const runDir = path.join(rootDir, 'output', 'login', nowStamp());
const maxMinutes = Number(args['max-minutes'] || 8);
await fs.mkdir(profileDir, { recursive: true });
await fs.mkdir(runDir, { recursive: true });

console.log('\n[weibo-redpacket-probe/login]');
console.log(`登录态目录: ${profileDir}`);
console.log(`截图目录: ${runDir}`);
console.log('浏览器会打开微博网页登录页。请让客户扫码登录；登录完成后脚本会保存该资料目录。\n');

const executablePath = await findInstalledBrowser();
if (executablePath) console.log(`使用系统浏览器: ${executablePath}`);

const context = await chromium.launchPersistentContext(profileDir, {
  ...(executablePath ? { executablePath } : {}),
  headless: false,
  viewport: { width: 1280, height: 900 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
});

const page = context.pages()[0] || (await context.newPage());
await page.goto(args.url || 'https://weibo.com/login.php', { waitUntil: 'domcontentloaded', timeout: 60000 });

const startedAt = Date.now();
let tick = 0;
let loggedInSeen = false;

while (Date.now() - startedAt < maxMinutes * 60 * 1000) {
  tick += 1;
  await page.waitForTimeout(tick === 1 ? 3000 : 5000);
  const text = await safeBodyText(page);
  const url = page.url();
  const shot = path.join(runDir, `${String(tick).padStart(3, '0')}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

  const looksLoggedIn = /首页|发现|消息|私信|我的首页|关注|粉丝|微博/.test(text) && !/扫码登录|账号登录|验证码|请输入密码/.test(text);
  console.log(`[${tick}] ${looksLoggedIn ? 'possible_logged_in' : 'waiting_login'} -> ${url}`);
  console.log(`    截图: ${shot}`);

  if (looksLoggedIn) {
    loggedInSeen = true;
    console.log('\n检测到疑似已登录。将再等待 20 秒，方便你确认账号是否正确。');
    await page.waitForTimeout(20000);
    break;
  }
}

const cookies = await context.cookies().catch(() => []);
await fs.writeFile(
  path.join(runDir, 'login-summary.json'),
  `${JSON.stringify({ profileDir, loggedInSeen, cookieCount: cookies.length, finalUrl: page.url() }, null, 2)}\n`,
  'utf8',
);

console.log(`\n登录态已保存在：${profileDir}`);
console.log(`后续探测红包时使用同一个 --profile 参数即可。\n`);
await context.close();

