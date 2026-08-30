import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAnnouncementText,
  DRAW_ANNOUNCEMENT_TEMPLATES,
} from './drawAnnouncements.js';

const receipt = {
  source: 'mobile',
  statusUrl: 'https://weibo.com/1/example',
  drawNumber: 3,
  drawnAt: '2026-08-28T10:20:00.000Z',
  candidateCount: 20,
  eligibleCount: 18,
  rules: {
    filters: {
      keyword: '',
      mentionMin: 0,
      uniqueByUser: true,
      excludePrevious: true,
    },
  },
  results: [{
    prize: { name: '一等奖' },
    winners: [
      { uid: '1001', screenName: '小花' },
      { uid: '1002', screenName: 'Alice' },
    ],
  }],
};

test('announcement templates expose concise, grouped and record variants', () => {
  assert.deepEqual(DRAW_ANNOUNCEMENT_TEMPLATES.map((item) => item.value), [
    'concise',
    'grouped',
    'record',
  ]);
});

test('concise announcement keeps the post easy to publish', () => {
  assert.equal(buildAnnouncementText(receipt, 'concise'), [
    '微博转发抽奖结果',
    '',
    '一等奖：@小花 @Alice',
    '',
    '请获奖用户留意私信。',
    '',
    '原微博：https://weibo.com/1/example',
  ].join('\n'));
});

test('grouped announcement includes the draw number and winner order', () => {
  const text = buildAnnouncementText(receipt, 'grouped');
  assert.match(text, /本链接第 3 次开奖/);
  assert.match(text, /一等奖\n1\. @小花\n2\. @Alice/);
});

test('record announcement includes the recorded random method', () => {
  const text = buildAnnouncementText(receipt, 'record');
  assert.match(text, /开奖时间：/);
  assert.match(text, /候选范围：载入 20 人 · 可抽 18 人/);
  assert.match(text, /随机规则：SHA-256 · Fisher–Yates/);
});

test('practice announcement is explicit about not counting the draw', () => {
  const text = buildAnnouncementText({
    ...receipt,
    recordState: 'practice',
    drawNumber: null,
  }, 'grouped');
  assert.match(text, /本地演练 · 不计入开奖次数/);
});
