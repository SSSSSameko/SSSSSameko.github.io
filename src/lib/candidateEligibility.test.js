import assert from 'node:assert/strict';
import test from 'node:test';

import {
  candidateIdentity,
  eligibleCandidates,
  evaluateCandidateEligibility,
  summarizeCandidateEligibility,
} from './candidateEligibility.js';

const candidates = [
  { id: 'r1', uid: '100', screenName: 'Sameko', text: '抽奖 @小明 @小红' },
  { id: 'r2', uid: '100', screenName: 'Sameko', text: '抽奖 @小明 @小红' },
  { id: 'r3', uid: '200', screenName: 'Alice', text: '抽奖 @小明 @小红' },
  { id: 'r4', uid: '300', screenName: 'Bob', text: '随手转发 @小明 @小红' },
  { id: 'r5', uid: '400', screenName: 'Carol', text: '抽奖 @小明' },
  { id: 'r6', uid: '500', screenName: 'Dave', text: '抽奖 @小明 @小红' },
];

test('candidate identity prefers uid and normalizes case', () => {
  assert.equal(candidateIdentity({ uid: ' ABC ', screenName: 'Name' }), 'abc');
  assert.equal(candidateIdentity({ screenName: ' Sameko ' }), 'sameko');
});

test('candidate evaluation explains every exclusion without changing draw order', () => {
  const evaluation = evaluateCandidateEligibility(candidates, {
    keyword: '抽奖',
    mentionMin: 2,
    uniqueByUser: true,
    excludePrevious: true,
    blocked: new Set(['alice']),
  }, new Set(['500']));

  assert.deepEqual(evaluation.map((entry) => entry.reason), [
    '',
    'duplicate',
    'blocklist',
    'keyword',
    'mention',
    'previousWinner',
  ]);
  assert.deepEqual(eligibleCandidates(candidates, {
    keyword: '抽奖',
    mentionMin: 2,
    uniqueByUser: true,
    excludePrevious: true,
    blocked: new Set(['alice']),
  }, new Set(['500'])).map((candidate) => candidate.id), ['r1']);
});

test('candidate evaluation accepts a text blocklist', () => {
  const [entry] = evaluateCandidateEligibility([
    { uid: '100', screenName: 'Sameko' },
  ], { blocklist: 'sameko\n200' });

  assert.equal(entry.reason, 'blocklist');
  assert.equal(entry.reasonLabel, '排除名单');
});

test('a later valid repost remains eligible when an earlier repost fails the filters', () => {
  const evaluation = evaluateCandidateEligibility([
    { id: 'first', uid: '100', screenName: 'Sameko', text: '普通转发' },
    { id: 'second', uid: '100', screenName: 'Sameko', text: '抽奖 @小明' },
  ], {
    keyword: '抽奖',
    mentionMin: 1,
    uniqueByUser: true,
  });

  assert.deepEqual(evaluation.map((entry) => entry.reason), ['keyword', '']);
});

test('mention filters count unique mentioned accounts', () => {
  const [entry] = evaluateCandidateEligibility([
    { uid: '100', screenName: 'Sameko', text: '@小明 @小明' },
  ], { mentionMin: 2 });

  assert.equal(entry.reason, 'mention');
});

test('mention filters clamp invalid and oversized values consistently', () => {
  const candidate = { uid: '100', text: '@一 @二 @三' };
  assert.equal(evaluateCandidateEligibility([candidate], { mentionMin: '-2' })[0].eligible, true);
  assert.equal(evaluateCandidateEligibility([candidate], { mentionMin: '2.8' })[0].eligible, true);
  assert.equal(evaluateCandidateEligibility([candidate], { mentionMin: '99' })[0].reason, 'mention');
  assert.equal(evaluateCandidateEligibility([candidate], { mentionMin: 'invalid' })[0].eligible, true);
});

test('eligibility summary keeps the useful exclusion reasons in count order', () => {
  const evaluation = evaluateCandidateEligibility(candidates, {
    keyword: '抽奖',
    mentionMin: 2,
    uniqueByUser: true,
    excludePrevious: true,
    blocked: new Set(['alice']),
  }, new Set(['500']));

  assert.deepEqual(summarizeCandidateEligibility(evaluation), {
    total: 6,
    eligible: 1,
    excluded: 5,
    reasons: [
      { reason: 'duplicate', label: '重复转发', detail: '同一用户已有一条转发进入候选', count: 1 },
      { reason: 'blocklist', label: '排除名单', detail: 'UID 或昵称命中排除名单', count: 1 },
      { reason: 'keyword', label: '关键词不符', detail: '转发内容没有包含设置的关键词', count: 1 },
    ],
    reasonText: '重复转发 1 · 排除名单 1 · 关键词不符 1',
  });
});
