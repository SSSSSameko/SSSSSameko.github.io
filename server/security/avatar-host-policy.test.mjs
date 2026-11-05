import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAvatarHostPolicy, isPrivateAddress } from './avatar-host-policy.mjs';

test('avatar policy rejects local, private, benchmark, documentation and mapped addresses', () => {
  for (const address of [
    '0.0.0.0', '10.1.2.3', '127.0.0.1', '100.64.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.1.1', '198.18.0.49', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '::', '::1', 'fc00::1', 'fe80::1', 'ff00::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', 'fe80::1%eth0',
  ]) assert.equal(isPrivateAddress(address), true, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('a hostname must resolve entirely to public addresses', async () => {
  const policy = createAvatarHostPolicy({
    env: {},
    lookup: async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '198.18.0.49', family: 4 },
    ],
  });
  assert.equal(await policy('https://example.com/avatar.jpg'), false);
  assert.equal(await policy('not a URL'), false);
});

test('DNS failures and empty answers fail closed', async () => {
  for (const lookup of [async () => [], async () => { throw new Error('DNS unavailable'); }]) {
    assert.equal(await createAvatarHostPolicy({ lookup, env: {} })('https://example.com/a.jpg'), false);
  }
});

test('malformed and mismatched DNS address records fail closed', async () => {
  for (const record of [
    { address: 'not-an-ip', family: 4 },
    { address: '', family: 4 },
    { address: '1.1.1.1', family: 6 },
    { address: '2606:4700:4700::1111', family: 4 },
  ]) {
    const policy = createAvatarHostPolicy({ env: {}, lookup: async () => [record] });
    assert.equal(await policy('https://example.com/a.jpg'), false, JSON.stringify(record));
  }
});

test('test DNS records never override production DNS', async () => {
  let lookups = 0;
  const overrides = { 'example.com': [{ address: '1.1.1.1', family: 4 }] };
  const env = { SERVER_TEST_MODE: '0', AVATAR_DNS_OVERRIDES: JSON.stringify(overrides) };
  const policy = createAvatarHostPolicy({
    env,
    lookup: async () => {
      lookups += 1;
      return [{ address: '127.0.0.1', family: 4 }];
    },
  });
  assert.equal(await policy('https://example.com/a.jpg'), false);
  assert.equal(lookups, 1);
  env.SERVER_TEST_MODE = '1';
  const testPolicy = createAvatarHostPolicy({ env, lookup: async () => { throw new Error('should use fixture'); } });
  assert.equal(await testPolicy('https://example.com/a.jpg'), true);
});
