import { chromium, devices } from 'playwright';
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
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
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

function pickDevice(name) {
  if (name === 'android') {
    return {
      label: 'Pixel 5 / Android Chrome',
      descriptor: devices['Pixel 5'],
    };
  }

  if (name === 'desktop') {
    return {
      label: 'Desktop Chromium',
      descriptor: {
        viewport: { width: 1365, height: 900 },
        isMobile: false,
        hasTouch: false,
        deviceScaleFactor: 1,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      },
    };
  }

  return {
    label: 'iPhone 13 / Mobile Safari',
    descriptor: devices['iPhone 13'],
  };
}

function classifyPage({ text, url }) {
  const haystack = `${url}\n${text}`;
  const rules = [
    {
      verdict: 'app_required',
      patterns: [
        /打开微博/i,
        /微博客户端/,
        /客户端内/,
        /请在.*客户端/,
        /请使用.*微博.*打开/,
        /sinaweibo:\/\//i,
        /download.*weibo/i,
      ],
    },
    {
      verdict: 'risk_or_blocked',
      patterns: [
        /风险/,
        /异常/,
        /非法请求/,
        /访问受限/,
        /操作频繁/,
        /暂时无法/,
        /blocked/i,
        /forbidden/i,
        /安全验证/,
      ],
    },
    {
      verdict: 'login_required',
      patterns: [/登录/, /扫码/, /验证码/, /密码/, /请输入手机号/, /passport\.weibo/i],
    },
    {
      verdict: 'possible_success',
      patterns: [/领取成功/, /已领取/, /已存入/, /钱包余额/, /微博钱包/, /红包金额/, /恭喜/],
    },
  ];

  const matched = [];
  for (const rule of rules) {
    const hits = rule.patterns.filter((pattern) => pattern.test(haystack)).map(String);
    if (hits.length) matched.push({ verdict: rule.verdict, hits });
  }

  return matched[0] ?? { verdict: 'unknown', hits: [] };
}

async function safeBodyText(page) {
  try {
    return await page.locator('body').innerText({ timeout: 3000 });
  } catch {
    return '';
  }
}

async function writeJson(file, data) {
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
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
const targetUrl = args.url;
const deviceName = String(args.device || 'iphone').toLowerCase();
const intervalMs = Number(args['interval-ms'] || 5000);
const maxMinutes = Number(args['max-minutes'] || 10);

if (!targetUrl) {
  console.error('缺少 --url。示例：npm run probe -- --url "https://红包链接" --device iphone');
  process.exit(1);
}

const device = pickDevice(deviceName);
const runDir = path.join(rootDir, 'output', 'runs', nowStamp());
const profileDir = path.resolve(rootDir, args.profile || path.join('profiles', deviceName));
await fs.mkdir(runDir, { recursive: true });
await fs.mkdir(profileDir, { recursive: true });

console.log(`\n[weibo-redpacket-probe]`);
console.log(`设备环境: ${device.label}`);
console.log(`目标链接: ${targetUrl}`);
console.log(`登录态目录: ${profileDir}`);
console.log(`输出目录: ${runDir}`);
console.log(`\n浏览器打开后你可以手动扫码登录、手动点击领取。脚本只负责观察、截图和判断。\n`);

const executablePath = await findInstalledBrowser();
if (executablePath) console.log(`使用系统浏览器: ${executablePath}`);

const context = await chromium.launchPersistentContext(profileDir, {
  ...(executablePath ? { executablePath } : {}),
  ...device.descriptor,
  headless: false,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  permissions: [],
});

const page = context.pages()[0] || (await context.newPage());
const events = [];

page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame()) {
    events.push({ type: 'navigation', at: new Date().toISOString(), url: frame.url() });
  }
});

page.on('dialog', async (dialog) => {
  events.push({ type: 'dialog', at: new Date().toISOString(), message: dialog.message() });
  await dialog.dismiss().catch(() => {});
});

await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

const startedAt = Date.now();
let tick = 0;
let lastVerdict = null;

while (Date.now() - startedAt < maxMinutes * 60 * 1000) {
  tick += 1;
  await page.waitForTimeout(tick === 1 ? 1500 : intervalMs);

  const text = await safeBodyText(page);
  const url = page.url();
  const classification = classifyPage({ text, url });
  const screenshotFile = path.join(runDir, `${String(tick).padStart(3, '0')}-${classification.verdict}.png`);
  await page.screenshot({ path: screenshotFile, fullPage: true }).catch(async () => {
    await page.screenshot({ path: screenshotFile, fullPage: false }).catch(() => {});
  });

  const event = {
    tick,
    at: new Date().toISOString(),
    url,
    title: await page.title().catch(() => ''),
    verdict: classification.verdict,
    hits: classification.hits,
    screenshot: screenshotFile,
    textSample: text.slice(0, 1200),
  };
  events.push(event);

  if (classification.verdict !== lastVerdict) {
    console.log(`[${tick}] ${classification.verdict} -> ${url}`);
    if (classification.hits.length) console.log(`    命中: ${classification.hits.join(', ')}`);
    console.log(`    截图: ${screenshotFile}`);
    lastVerdict = classification.verdict;
  }

  await writeJson(path.join(runDir, 'report.json'), {
    targetUrl,
    device: device.label,
    profileDir,
    runDir,
    latestVerdict: classification.verdict,
    events,
  });

  if (['app_required', 'risk_or_blocked', 'possible_success'].includes(classification.verdict)) {
    console.log(`\n检测到明确状态：${classification.verdict}`);
    console.log('我会继续保留浏览器 30 秒，方便你肉眼确认页面。');
    await page.waitForTimeout(30000);
    break;
  }
}

await writeJson(path.join(runDir, 'report.json'), {
  targetUrl,
  device: device.label,
  profileDir,
  runDir,
  events,
});

console.log(`\n探测结束。报告：${path.join(runDir, 'report.json')}\n`);
await context.close();

