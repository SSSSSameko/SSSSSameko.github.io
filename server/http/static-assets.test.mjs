import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { StaticAssetCache, staticRequestNotModified, staticResponseBody } from './static-assets.mjs';

async function withAssets(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sameko-static-assets-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('concurrent cold requests share one compressed entry and retain it within the byte budget', async () => {
  await withAssets(async (directory) => {
    const filePath = path.join(directory, 'app.js');
    await writeFile(filePath, 'const text = "页面内容";\n'.repeat(200));
    const cache = new StaticAssetCache({ maxBytes: 16_000 });
    const entries = await Promise.all(Array.from({ length: 20 }, () => cache.load(filePath)));
    for (const entry of entries) assert.equal(entry, entries[0]);
    assert.ok(entries[0].gzip.length > 0);
    assert.ok(entries[0].brotli.length > 0);
    assert.equal(await cache.load(filePath), entries[0]);
  });
});

test('uncacheable concurrent assets still share the in-flight read and compression', async () => {
  await withAssets(async (directory) => {
    const filePath = path.join(directory, 'large.js');
    await writeFile(filePath, 'a'.repeat(4096));
    const cache = new StaticAssetCache({ maxBytes: 1 });
    const entries = await Promise.all(Array.from({ length: 10 }, () => cache.load(filePath)));
    for (const entry of entries) assert.equal(entry, entries[0]);
    assert.notEqual(await cache.load(filePath), entries[0]);
  });
});

test('cache refresh and eviction retain the latest file contents', async () => {
  await withAssets(async (directory) => {
    const firstFile = path.join(directory, 'first.txt');
    const secondFile = path.join(directory, 'second.txt');
    await writeFile(firstFile, 'first');
    await writeFile(secondFile, 'second');
    const cache = new StaticAssetCache({ maxEntries: 1 });
    const first = await cache.load(firstFile);
    await cache.load(secondFile);
    assert.notEqual(await cache.load(firstFile), first);
    await writeFile(firstFile, 'updated content');
    assert.equal((await cache.load(firstFile)).raw.toString(), 'updated content');
    const lateFile = path.join(directory, 'late.txt');
    await assert.rejects(cache.load(lateFile), { code: 'ENOENT' });
    await writeFile(lateFile, 'now available');
    assert.equal((await cache.load(lateFile)).raw.toString(), 'now available');
  });
});

test('explicit encoding exclusions override wildcards and quality controls preference', () => {
  const entry = { raw: Buffer.from('raw'), gzip: Buffer.from('gzip'), brotli: Buffer.from('br') };
  const response = (header) => staticResponseBody({ headers: { 'accept-encoding': header } }, entry);
  assert.equal(response('br;q=0, *;q=1').encoding, 'gzip');
  assert.equal(response('*;q=1, gzip;q=0, br;q=0').encoding, '');
  assert.equal(response('br;q=0.2, gzip;q=0.8').encoding, 'gzip');
  assert.equal(response('br;q=0.8, gzip;q=0.2').encoding, 'br');
  assert.equal(response('br, gzip').encoding, 'br');
  assert.equal(response('').encoding, '');
  assert.equal(response('br;q=invalid, gzip;q=-1').encoding, '');
});

test('an explicit identity exclusion cannot fall back to an unacceptable representation', () => {
  const entry = { raw: Buffer.from('raw'), gzip: Buffer.from('gzip'), brotli: Buffer.from('br') };
  const response = (header, asset = entry) => staticResponseBody({ headers: { 'accept-encoding': header } }, asset);
  assert.equal(response('identity;q=0'), null);
  assert.equal(response('*;q=0'), null);
  assert.equal(response('identity;q=0, gzip', { raw: entry.raw }), null);
  assert.equal(response('identity;q=0, gzip').encoding, 'gzip');
  assert.equal(response('*;q=0, identity;q=1').encoding, '');
});

test('an explicit identity preference competes with available compressed representations', () => {
  const entry = { raw: Buffer.from('raw'), gzip: Buffer.from('gzip'), brotli: Buffer.from('br') };
  const response = (header, asset = entry) => staticResponseBody({ headers: { 'accept-encoding': header } }, asset);
  assert.equal(response('identity;q=1, gzip;q=0.2').encoding, '');
  assert.equal(response('br;q=0.4, gzip;q=0.6, identity;q=0.8').encoding, '');
  assert.equal(response('identity;q=0.2, gzip;q=0.8').encoding, 'gzip');
  assert.equal(response('br, gzip, identity').encoding, 'br');
  assert.equal(response('br, identity;q=0.8, gzip;q=0.2', { raw: entry.raw, gzip: entry.gzip }).encoding, '');
});

test('conditional GET uses weak ETag comparison and wildcard matching', () => {
  const matches = (value) => staticRequestNotModified({ headers: { 'if-none-match': value } }, '"current"');
  assert.equal(matches('"current"'), true);
  assert.equal(matches('W/"current"'), true);
  assert.equal(matches('"other", W/"current"'), true);
  assert.equal(matches('*'), true);
  assert.equal(matches('"other"'), false);
  assert.equal(matches(''), false);
});
