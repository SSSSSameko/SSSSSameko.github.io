import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isResponseBodyTimeout,
  readJsonResponse,
  readResponseTextWithin,
} from './apiResponse.js';

test('readResponseTextWithin reads normal and empty responses', async () => {
  assert.equal(await readResponseTextWithin(new Response('ready'), { timeoutMs: 50 }), 'ready');
  assert.equal(await readResponseTextWithin(new Response(''), { timeoutMs: 50 }), '');
});

test('readJsonResponse supports fallback and strict parse errors', async () => {
  assert.deepEqual(
    await readJsonResponse(new Response(''), { timeoutMs: 50 }),
    {},
  );
  assert.deepEqual(
    await readJsonResponse(new Response('{"ok":true}'), { timeoutMs: 50, strict: true }),
    { ok: true },
  );
  await assert.rejects(
    readJsonResponse(new Response('not-json'), { timeoutMs: 50, strict: true }),
    { code: 'INVALID_RESPONSE_JSON' },
  );
  assert.deepEqual(
    await readJsonResponse(new Response('not-json'), { timeoutMs: 50 }),
    {},
  );
});

test('body timeout cancels the stream and does not leak a late rejection', async () => {
  let cancelled = 0;
  const response = {
    body: {
      cancel() {
        cancelled += 1;
        return Promise.reject(new Error('cancel failed'));
      },
    },
    text() {
      return new Promise(() => {});
    },
  };
  await assert.rejects(
    readResponseTextWithin(response, { timeoutMs: 10 }),
    (error) => isResponseBodyTimeout(error),
  );
  assert.equal(cancelled, 1);
});

test('response body limits apply to declared and streamed bytes', async () => {
  await assert.rejects(
    readResponseTextWithin(new Response('123456', {
      headers: { 'content-length': '6' },
    }), { timeoutMs: 50, maxBytes: 5 }),
    { code: 'RESPONSE_BODY_TOO_LARGE' },
  );

  const streamed = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('123'));
      controller.enqueue(new TextEncoder().encode('456'));
      controller.close();
    },
  }));
  await assert.rejects(
    readResponseTextWithin(streamed, { timeoutMs: 50, maxBytes: 5 }),
    { code: 'RESPONSE_BODY_TOO_LARGE' },
  );
});

test('external cancellation reaches a response body after headers arrive', async () => {
  let cancelled = 0;
  const controller = new AbortController();
  const response = new Response(new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
    cancel() {
      cancelled += 1;
    },
  }));
  const reading = readResponseTextWithin(response, {
    timeoutMs: 1000,
    signal: controller.signal,
  });
  controller.abort(new DOMException('操作已取消', 'AbortError'));
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(cancelled, 1);
});
