import assert from 'node:assert/strict';
import test from 'node:test';

import { xsrfTokenFromCookie } from './cookieHeaders.js';

test('xsrfTokenFromCookie decodes a valid token', () => {
  assert.equal(
    xsrfTokenFromCookie('SUB=logged-in; XSRF-TOKEN=hello%2Bworld'),
    'hello+world',
  );
});

test('xsrfTokenFromCookie ignores malformed URL encoding', () => {
  assert.equal(xsrfTokenFromCookie('XSRF-TOKEN=%E0%A4%A'), '');
});

test('xsrfTokenFromCookie does not match a similarly named cookie', () => {
  assert.equal(xsrfTokenFromCookie('X-XSRF-TOKEN=wrong; OTHER=1'), '');
});
