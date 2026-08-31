import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildResultPosterModel,
  measureResultPoster,
} from './resultPoster.js';

const sample = {
  statusUrl: 'https://weibo.com/1/Example',
  drawCount: '本链接第 2 次开奖',
  drawnAt: '2026-07-24T02:00:00.000Z',
  candidateCount: 20,
  eligibleCount: 18,
  winnerCount: 3,
  providerText: 'mobile',
  filterSummary: '去重，排除已中奖用户',
  seed: 'seed-for-poster',
  candidateDigest: 'digest-for-poster',
  auditHash: 'audit-for-poster',
  results: [{
    prize: { name: '幸运奖', count: 3, color: '#ee8fa1' },
    winners: [
      { uid: '1001', screenName: 'sameko', avatar: 'https://tvax3.sinaimg.cn/avatar.jpg?Expires=1' },
      { uid: '1002', screenName: 'Alice' },
      { uid: '1003', screenName: '小蓝' },
    ],
  }],
};

test('buildResultPosterModel keeps complete prize and fairness information', () => {
  const model = buildResultPosterModel(sample);

  assert.equal(model.drawLabel, '本链接第 2 次开奖');
  assert.equal(model.winnerCount, 3);
  assert.equal(model.groups.length, 1);
  assert.deepEqual(model.groups[0].winners.map((winner) => winner.name), ['sameko', 'Alice', '小蓝']);
  assert.equal(model.groups[0].winners[0].avatar, 'https://tvax3.sinaimg.cn/avatar.jpg?Expires=1');
  assert.equal(model.fairness.candidateCount, 20);
  assert.equal(model.fairness.eligibleCount, 18);
  assert.equal(model.fairness.algorithm, 'SHA-256 · Fisher–Yates');
  assert.equal(model.fairness.auditHash, 'audit-for-poster');
});

test('measureResultPoster grows with the number of winners without excess empty space', () => {
  const shortModel = buildResultPosterModel(sample);
  const longModel = buildResultPosterModel({
    ...sample,
    results: [{
      ...sample.results[0],
      winners: Array.from({ length: 12 }, (_, index) => ({
        uid: String(2000 + index),
        screenName: `中奖用户${index + 1}`,
      })),
    }],
    winnerCount: 12,
  });

  const shortLayout = measureResultPoster(shortModel);
  const longLayout = measureResultPoster(longModel);
  assert.equal(shortLayout.width, 1080);
  assert.ok(shortLayout.height >= 1280);
  assert.ok(longLayout.height > shortLayout.height);
  assert.ok(longLayout.height - shortLayout.height < 1400);
});

test('result poster caps rendered rows while preserving the actual winner total', () => {
  const model = buildResultPosterModel({
    ...sample,
    results: [{
      ...sample.results[0],
      winners: Array.from({ length: 100 }, (_, index) => ({
        uid: String(index),
        screenName: `中奖用户${index + 1}`,
      })),
    }],
  });

  assert.equal(model.winnerCount, 100);
  assert.equal(model.displayedWinnerCount, 60);
  assert.equal(model.omittedWinnerCount, 40);
  assert.equal(model.groups[0].totalWinnerCount, 100);
});

test('result poster also caps prize groups and extreme canvas height', () => {
  const model = buildResultPosterModel({
    ...sample,
    results: Array.from({ length: 80 }, (_, index) => ({
      prize: { name: `超长奖项名称 ${index + 1}`, count: 1 },
      winners: [{ uid: `group-${index + 1}`, screenName: `获奖用户 ${index + 1}` }],
    })),
  });
  const layout = measureResultPoster(model);

  assert.equal(model.winnerCount, 80);
  assert.equal(model.groups.length, 20);
  assert.equal(model.displayedWinnerCount, 20);
  assert.equal(model.omittedWinnerCount, 60);
  assert.ok(layout.height < 7000, `unexpected poster height: ${layout.height}`);
});
