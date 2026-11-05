import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CandidateCollection, repostCountIsComplete, repostCountLooksComplete, repostResultsLookComplete } from './candidate-collection.mjs';

function candidate(repostId, text = '') {
  return { uid: 'one-user', screenName: '同一用户', repostId, text, createdAt: '' };
}

function collection(options = {}) {
  return new CandidateCollection({ maxCandidates: 3, maxPayloadBytes: 4096, ...options });
}

test('provider merging deduplicates reposts while retaining repeated entries from one user', () => {
  const entries = collection();
  entries.append([candidate('one'), candidate('two')]);
  entries.append([candidate('one'), candidate('three')]);
  assert.deepEqual(entries.candidates.map((entry) => entry.repostId), ['one', 'two', 'three']);
  assert.equal(entries.limitReason, '');
  assert.equal(entries.append([candidate('four')]), true);
  assert.equal(entries.limitReason, 'count');
  assert.equal(entries.discardedCount, 1);
});

test('head reconciliation prepends only new reposts and preserves page order', () => {
  const entries = collection();
  entries.append([candidate('older'), candidate('oldest')]);
  assert.deepEqual(entries.prepend([candidate('newest'), candidate('older')]), {
    addedCount: 1,
    truncatedCount: 0,
  });
  assert.deepEqual(entries.candidates.map((entry) => entry.repostId), ['newest', 'older', 'oldest']);
  assert.equal(entries.limitReason, '');
  entries.prepend([candidate('too-new')]);
  assert.equal(entries.limitReason, 'count');
});

test('head reconciliation reports records discarded beyond its count limit', () => {
  const entries = collection();
  const outcome = entries.prepend([
    candidate('one'), candidate('two'), candidate('three'), candidate('four'),
  ]);
  assert.deepEqual(outcome, { addedCount: 3, truncatedCount: 1 });
  assert.equal(entries.metadata().candidateLimitReason, 'count');
  assert.deepEqual(entries.candidates.map((entry) => entry.repostId), ['one', 'two', 'three']);
});

test('mixed appends and head reconciliation keep their byte count and identity budget consistent', () => {
  const entries = collection({ maxCandidates: 20, maxPayloadBytes: 1024 });
  for (let round = 0; round < 30; round += 1) {
    const items = [candidate(String(round % 12), '中文'), candidate(String((round + 4) % 12), '较长的正文')];
    if (round % 2 === 0) entries.append(items);
    else entries.prepend(items);
    assert.equal(entries.metadata().candidatePayloadBytes, Buffer.byteLength(JSON.stringify(entries.candidates)));
    assert.ok(entries.metadata().candidatePayloadBytes <= 1024);
    assert.ok(entries.candidates.length <= 20);
    assert.equal(new Set(entries.candidates.map((entry) => entry.repostId)).size, entries.candidates.length);
  }
});

test('append and head reconciliation apply the same UTF-8 payload budget', () => {
  const first = candidate('one', '中文');
  const second = candidate('two', '中文');
  const byteBudget = Buffer.byteLength(JSON.stringify([first, second]));
  for (const mode of ['append', 'prepend']) {
    const entries = collection({ maxPayloadBytes: byteBudget });
    entries.append([first]);
    entries[mode]([second]);
    assert.equal(entries.metadata().candidatePayloadBytes, byteBudget);
    assert.equal(entries.limitReason, '');
    entries[mode]([candidate('three')]);
    assert.equal(entries.candidates.length, 2);
    assert.equal(entries.limitReason, 'bytes');
    assert.ok(entries.warnings()[0].includes('候选数据体积'));
  }
});

test('normalization runs once at the provider boundary and existing candidates seed the budget', () => {
  const seed = [candidate('seed')];
  const entries = collection({ candidates: seed });
  entries.append([{
    idstr: 'api-repost',
    text: '<b>正文</b>&amp;内容',
    user: { idstr: 'owner', screen_name: '昵称', profile_image_url: 'javascript:alert(1)' },
  }], 'mobile');
  assert.equal(entries.candidates, seed);
  assert.equal(entries.candidates[1].source, 'mobile');
  assert.equal(entries.candidates[1].text, '正文&内容');
  assert.equal(entries.candidates[1].avatar, '');
  assert.equal(entries.metadata().candidatePayloadBytes, Buffer.byteLength(JSON.stringify(seed)));
});

test('unknown totals require candidates and known totals retain the existing completeness tolerance', () => {
  assert.equal(repostCountLooksComplete(0, null), false);
  assert.equal(repostCountLooksComplete(1, null), true);
  assert.equal(repostCountLooksComplete(0, 0), true);
  assert.equal(repostCountLooksComplete(90, 100), true);
  assert.equal(repostCountLooksComplete(89, 100), false);
});

test('count completeness requires a known valid total and cannot use fallback tolerance', () => {
  for (const total of [null, undefined, '', false, -1, 1.5, NaN, Infinity]) {
    assert.equal(repostCountIsComplete(200, total), false);
  }
  assert.equal(repostCountIsComplete(160, 200), false);
  assert.equal(repostCountIsComplete(4, 5), false);
  assert.equal(repostCountIsComplete(0, 0), true);
  assert.equal(repostCountIsComplete(200, 200), true);
  assert.equal(repostCountIsComplete(201, 200), true);
});

test('failed pagination requires a full aggregate count even when fallback returns a smaller total', () => {
  const interrupted = [
    { meta: { paginationError: { page: 2 }, totalNumber: 100 } },
    { meta: { totalNumber: 1, complete: true } },
  ];
  assert.equal(repostResultsLookComplete(90, 100, interrupted), false);
  assert.equal(repostResultsLookComplete(99, 100, interrupted), false);
  assert.equal(repostResultsLookComplete(100, 100, interrupted), true);
  assert.equal(repostResultsLookComplete(90, null, interrupted), false);
  assert.equal(repostResultsLookComplete(90, 100, [{ meta: {} }]), true);
});
