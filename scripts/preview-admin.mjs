// Local, synthetic design preview. Deliberately separate from the production server.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { draws, summary, feedback } from './fixtures/admin-preview.mjs';

const previewDraws = structuredClone(draws);
previewDraws[0].statusUrl = 'https://weibo.com/123/1234567890';
previewDraws[0].winners[0].screenName = '测试中奖用户';
previewDraws[0].results[0].winners[0].screenName = '测试中奖用户';
const previewSummary = structuredClone(summary);
previewSummary.system.events = previewSummary.system.events.map((event) => ({ ...event,
  message: event.message?.startsWith('<img') ? '移动端请求失败，请查看上游响应' : event.message,
}));

const files = new Map([
  ['/admin', ['server-admin/admin.html', 'text/html']],
  ['/admin/', ['server-admin/admin.html', 'text/html']],
  ...['admin.js', 'admin.css', 'admin-list-state.js', 'admin-export.js', 'admin-diagnostics-view.js'].map((name) => [`/admin/${name}`, [`server-admin/${name}`, name.endsWith('.css') ? 'text/css' : 'text/javascript']]),
  ...Object.entries({ 'admin-diagnostics.js': 'adminDiagnostics', 'admin-status.js': 'adminStatus', 'api-response.js': 'apiResponse', 'diagnostics.js': 'diagnostics' }).map(([name, module]) => [`/admin/${name}`, [`src/lib/${module}.js`, 'text/javascript']]),
  ...['avatar-96.webp', 'favicon-32.png', 'apple-touch-icon.png'].map((name) => [`/${name}`, [`static/${name}`, name.endsWith('.webp') ? 'image/webp' : 'image/png']]),
]);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Never expose a real login or send requests to Weibo from the preview.
  const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  if (req.method !== 'GET') return json({ error: '这是模拟预览，写入操作未启用。' }, 405);
  if (url.pathname === '/api/admin/session') return json({ username: '设计预览 · 模拟数据', csrfToken: 'synthetic-preview' });
  if (url.pathname === '/api/admin/summary') return json(previewSummary);
  if (url.pathname === '/api/admin/draws') return json({ items: previewDraws, ok: true });
  if (url.pathname === '/api/admin/feedback') return json({ items: feedback, ok: true });
  if (url.pathname === '/api/admin/weibo-login/status') return json({ status: 'idle', history: [] });
  if (url.pathname.startsWith('/api/admin/draws/')) {
    const item = previewDraws.find((record) => record.file === decodeURIComponent(url.pathname.split('/').pop()));
    return json(item ? { ok: true, item } : { error: '未找到模拟记录' }, item ? 200 : 404);
  }
  const file = files.get(url.pathname);
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  try {
    let body = await readFile(new URL(`../${file[0]}`, import.meta.url));
    if (file[1] === 'text/html') body = Buffer.from(body.toString().replace('<head>', '<head><base href="/admin/">').replace('<h1>今天的服务状态</h1>', '<h1>后台设计预览</h1>').replace('<strong>抽奖助手后台</strong>', '<strong>后台 · 模拟预览</strong>'));
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` }); res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(Number(process.env.ADMIN_PREVIEW_PORT || 5197), '127.0.0.1', () => console.log(`模拟后台预览：http://127.0.0.1:${server.address().port}/admin/`));
