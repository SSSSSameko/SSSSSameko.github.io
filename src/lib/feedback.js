export const FEEDBACK_MIN_LENGTH = 2;
export const FEEDBACK_MAX_LENGTH = 1200;

export const FEEDBACK_CATEGORIES = Object.freeze([
  { value: 'suggestion', label: '功能建议', hint: '希望增加或调整的功能' },
  { value: 'problem', label: '遇到问题', hint: '无法完成或结果异常' },
  { value: 'experience', label: '使用体验', hint: '流程、文字或界面感受' },
  { value: 'other', label: '其他', hint: '其他想告诉站长的内容' },
]);

const categoryValues = new Set(FEEDBACK_CATEGORIES.map((item) => item.value));

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function normalizeFeedbackSubmission(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw validationError('反馈内容格式不正确');
  }

  const category = typeof input.category === 'string' ? input.category.trim() : '';
  if (!categoryValues.has(category)) throw validationError('请选择反馈类型');
  if (typeof input.content !== 'string') throw validationError('请填写反馈内容');

  const content = input.content
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '')
    .trim();

  if (content.length < FEEDBACK_MIN_LENGTH) throw validationError('请再多写一点反馈内容');
  if (content.length > FEEDBACK_MAX_LENGTH) {
    throw validationError(`反馈内容不能超过 ${FEEDBACK_MAX_LENGTH} 个字`);
  }

  return { category, content };
}
