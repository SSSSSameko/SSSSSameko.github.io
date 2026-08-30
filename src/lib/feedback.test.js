import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEEDBACK_MAX_LENGTH,
  normalizeFeedbackSubmission,
} from './feedback.js';

test('normalizes a valid feedback submission', () => {
  assert.deepEqual(normalizeFeedbackSubmission({
    category: 'suggestion',
    content: '  希望增加抽奖前预览\r\n谢谢  ',
  }), {
    category: 'suggestion',
    content: '希望增加抽奖前预览\n谢谢',
  });
});

test('accepts privacy and data requests', () => {
  assert.deepEqual(
    normalizeFeedbackSubmission({ category: 'privacy', content: '请删除过程哈希 abc123 对应的开奖记录' }),
    { category: 'privacy', content: '请删除过程哈希 abc123 对应的开奖记录' },
  );
});

test('rejects unknown categories', () => {
  assert.throws(
    () => normalizeFeedbackSubmission({ category: 'contact', content: '测试内容' }),
    /请选择反馈类型/,
  );
});

test('rejects empty and short content', () => {
  assert.throws(
    () => normalizeFeedbackSubmission({ category: 'problem', content: ' ' }),
    /请再多写一点/,
  );
  assert.throws(
    () => normalizeFeedbackSubmission({ category: 'problem', content: 'a' }),
    /请再多写一点/,
  );
});

test('rejects content over the limit', () => {
  assert.throws(
    () => normalizeFeedbackSubmission({ category: 'other', content: '好'.repeat(FEEDBACK_MAX_LENGTH + 1) }),
    /不能超过/,
  );
});

test('removes control characters but keeps line breaks', () => {
  assert.equal(
    normalizeFeedbackSubmission({ category: 'experience', content: '第一行\u0000\n第二行\u0007\u202e' }).content,
    '第一行\n第二行',
  );
});
