import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clientAddress,
  isLoopbackAddress,
  trustedForwardedHeader,
} from './requestTrust.js';

test('forwarded headers are trusted only from a local reverse proxy', () => {
  const directRequest = {
    headers: { 'x-forwarded-for': '198.51.100.8', 'x-forwarded-host': 'evil.example' },
    socket: { remoteAddress: '203.0.113.9' },
  };
  const proxiedRequest = {
    headers: { 'x-forwarded-for': '198.51.100.8, 203.0.113.9', 'x-forwarded-host': 'lottery.example' },
    socket: { remoteAddress: '::ffff:127.0.0.1' },
  };

  assert.equal(clientAddress(directRequest), '203.0.113.9');
  assert.equal(trustedForwardedHeader(directRequest, 'x-forwarded-host'), '');
  assert.equal(clientAddress(proxiedRequest), '203.0.113.9');
  assert.equal(trustedForwardedHeader(proxiedRequest, 'x-forwarded-host'), 'lottery.example');
});

test('clientAddress uses the address appended by the trusted local proxy', () => {
  const request = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.8' },
  };
  assert.equal(clientAddress(request), '203.0.113.8');
});

test('loopback detection accepts IPv4 and IPv6 forms', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.10'), false);
});
