import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';

import {
  initialApiBase,
  initialApiBaseInput,
  isTrustedApiBase,
  readApiResponse,
  requestApi,
} from './browserApi.js';

const nativeFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalLocation = globalThis.location;
let storage;
let timers;

beforeEach(() => {
  storage = new Map();
  timers = new Map();
  let nextTimer = 0;
  globalThis.location = { hostname: '127.0.0.1', protocol: 'http:' };
  globalThis.window = {
    WEIBO_DRAW_API_BASE: 'https://api.example.test',
    WEIBO_DRAW_ALLOWED_API_BASES: ['https://backup.example.test'],
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    setTimeout: (callback) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
});

afterEach(() => {
  globalThis.fetch = nativeFetch;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalLocation === undefined) delete globalThis.location;
  else globalThis.location = originalLocation;
});

test('only configured backends and loopback addresses may receive browser credentials', async () => {
  assert.equal(isTrustedApiBase('https://api.example.test/'), true);
  assert.equal(isTrustedApiBase('https://backup.example.test'), true);
  assert.equal(isTrustedApiBase('http://127.0.0.1:4173'), true);
  assert.equal(isTrustedApiBase('http://[::1]:4173'), true);
  assert.equal(isTrustedApiBase('https://api.example.test.evil.test'), false);
  assert.equal(isTrustedApiBase('file:///private'), false);
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; };
  await assert.rejects(
    requestApi('/api/health', {}, { apiBase: 'https://untrusted.example.test', apiKey: 'private-key' }),
    /可信列表/,
  );
  assert.equal(requests, 0);
  assert.equal(timers.size, 0);
});

test('discarded untrusted settings fall back to the preset without exposing it in the editor', () => {
  storage.set('weibo-draw-api-base', 'https://untrusted.example.test');
  assert.equal(initialApiBase(), 'https://api.example.test');
  assert.equal(storage.has('weibo-draw-api-base'), false);
  storage.set('weibo-draw-api-base', 'https://api.example.test');
  assert.equal(initialApiBaseInput(), '');
  storage.set('weibo-draw-api-base', 'http://localhost:4173');
  assert.equal(initialApiBaseInput(), 'http://localhost:4173');
});

test('static hosting refuses relative backend calls', async () => {
  globalThis.location = { hostname: 'example.github.io', protocol: 'https:' };
  await assert.rejects(requestApi('/api/health'), /静态前端/);
  assert.equal(timers.size, 0);
});

test('request headers and cancellation remain active until the JSON body is consumed', async () => {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response('{"ok":true}');
  };
  const response = await requestApi('api/health', { headers: { 'x-custom': 'retained' } }, {
    apiBase: 'https://api.example.test', apiKey: '  example-key  ',
  });
  assert.equal(request.url, 'https://api.example.test/api/health');
  assert.equal(request.options.headers.get('x-custom'), 'retained');
  assert.equal(request.options.headers.get('x-api-key'), 'example-key');
  assert.match(request.options.headers.get('x-client-id'), /^[A-Za-z0-9._:-]{8,64}$/);
  assert.equal(timers.size, 1);
  assert.deepEqual(await readApiResponse(response), { ok: true });
  assert.equal(timers.size, 0);
});

test('external cancellation after headers aborts and cancels the response body', async () => {
  let bodyCancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    cancel() { bodyCancelled = true; },
  }));
  const controller = new AbortController();
  const response = await requestApi('/api/reposts', { signal: controller.signal });
  const body = readApiResponse(response);
  controller.abort(new Error('user cancelled'));
  await assert.rejects(body, /user cancelled/);
  assert.equal(bodyCancelled, true);
  assert.equal(timers.size, 0);
});

test('a request deadline also covers a response whose body stalls', async () => {
  globalThis.fetch = async () => new Response(new ReadableStream());
  const response = await requestApi('/api/reposts');
  const body = readApiResponse(response, '候选服务');
  const [expire] = timers.values();
  expire();
  await assert.rejects(body, /候选服务响应超时/);
  assert.equal(timers.size, 0);
});

test('empty and malformed responses release the request deadline and keep useful errors', async () => {
  for (const [text, status, message] of [
    ['', 503, /HTTP 503/],
    ['<html>gateway</html>', 502, /返回格式异常（HTTP 502）/],
  ]) {
    globalThis.fetch = async () => new Response(text, { status });
    const response = await requestApi('/api/health');
    await assert.rejects(readApiResponse(response), message);
    assert.equal(timers.size, 0);
  }
});

test('backend redirects cannot forward the API key to another endpoint', async (t) => {
  let redirectedRequests = 0;
  const destination = createServer((_request, response) => {
    redirectedRequests += 1;
    response.end('{"ok":true}');
  });
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  const origin = createServer((_request, response) => {
    response.writeHead(302, {
      location: `http://127.0.0.1:${destination.address().port}/unexpected`,
    });
    response.end();
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  t.after(async () => {
    await Promise.all([origin, destination].map((server) => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    })));
  });
  globalThis.fetch = nativeFetch;
  await assert.rejects(requestApi('/api/health', { redirect: 'follow' }, {
    apiBase: `http://127.0.0.1:${origin.address().port}`,
    apiKey: 'private-key',
  }));
  assert.equal(redirectedRequests, 0);
  assert.equal(timers.size, 0);
});

test('HTTP errors cannot be treated as success even when the body claims ok', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const response = new Response('{"ok":true}', { status });
    await assert.rejects(readApiResponse(response), (error) => error.status === status);
  }
  await assert.rejects(
    readApiResponse(new Response('{"error":"服务暂不可用"}', { status: 503 })),
    (error) => error.message === '服务暂不可用' && error.status === 503,
  );
});

test('invalid JSON shapes fail at the API boundary and HTTP status survives invalid bodies', async () => {
  for (const body of ['null', '[]', '"ok"', '123', 'false']) {
    await assert.rejects(readApiResponse(new Response(body)), /返回格式异常/);
  }
  for (const body of ['', '<html>login required</html>', 'null']) {
    await assert.rejects(readApiResponse(new Response(body, { status: 401 })), (error) => error.status === 401);
  }
});
