import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const upstream = createHttpServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ ok: true, path: request.url }));
});
let dev;
try {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  dev = await createServer({
    configFile: fileURLToPath(new URL('../vite.config.mjs', import.meta.url)),
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port: 0,
      proxy: { '/api': { target: `http://127.0.0.1:${upstream.address().port}` } },
    },
  });
  await dev.listen();
  const url = `http://127.0.0.1:${dev.httpServer.address().port}/api/health`;
  const success = await fetch(url);
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { ok: true, path: '/api/health' });
  await new Promise(resolve => upstream.close(resolve));
  const unavailable = await fetch(url);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).ok, false);
} finally {
  await dev?.close();
  if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
}
console.log('DEV_PROXY_OK');
