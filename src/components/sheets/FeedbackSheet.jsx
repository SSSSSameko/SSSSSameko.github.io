import SheetFrame from '../ui/SheetFrame.jsx';
import { icons as I } from '../ui/icons.jsx';
import { useRef, useState } from 'react';
import { FEEDBACK_CATEGORIES, FEEDBACK_MAX_LENGTH, normalizeFeedbackSubmission } from '../../lib/feedback.js';

export default function FeedbackSheet({ initialCategory = FEEDBACK_CATEGORIES[0].value, onClose, onSubmit }) {
  const [category, setCategory] = useState(initialCategory);
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(null);
  const [error, setError] = useState('');
  const textareaRef = useRef(null);
  const submittingRef = useRef(false);

  const focusComposer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  async function submit(event) {
    event.preventDefault();
    if (submittingRef.current) return;
    setError('');
    try {
      const payload = normalizeFeedbackSubmission({ category, content });
      submittingRef.current = true;
      setSubmitting(true);
      const receipt = await onSubmit(payload);
      setSent(receipt || {});
    } catch (submitError) {
      setError(submitError.message || '反馈暂时未能送达，请稍后再试');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function moveCategoryFocus(event, index) {
    const directions = {
      ArrowDown: 1,
      ArrowRight: 1,
      ArrowUp: -1,
      ArrowLeft: -1,
    };
    let nextIndex;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = FEEDBACK_CATEGORIES.length - 1;
    else if (directions[event.key]) {
      nextIndex = (index + directions[event.key] + FEEDBACK_CATEGORIES.length) % FEEDBACK_CATEGORIES.length;
    } else return;
    event.preventDefault();
    setCategory(FEEDBACK_CATEGORIES[nextIndex].value);
    event.currentTarget.parentElement?.children[nextIndex]?.focus();
  }

  return (
    <SheetFrame
      title="意见反馈"
      tone="mint"
      subtitle="你的建议会由运营者直接查看"
      icon={I.feedback}
      onClose={onClose}
      className="flow-feedback-sheet"
      initialFocusRef={focusComposer ? textareaRef : null}
      footer={(close) => (sent ? (
        <button type="button" className="flow-sheet-primary v3-primary-action" onClick={() => close()}>完成</button>
      ) : (
        <button type="submit" form="feedback-form" className="flow-sheet-primary v3-primary-action feedback-submit" disabled={submitting || content.trim().length < 2}>
          {submitting ? I.refresh : I.send}
          <span>{submitting ? '正在提交' : '提交反馈'}</span>
        </button>
      ))}
    >
      {() => sent ? (
        <div className="feedback-success" role="status" aria-live="polite" aria-atomic="true">
          <span>{I.check}</span>
          <h3>谢谢你的反馈</h3>
          <p>内容已经送达，运营者会在后台查看。</p>
          {sent.id && <code>反馈编号 {sent.id}</code>}
          {category === 'privacy' && <p>站内不提供回复或进度查询。如需处理结果，请通过隐私政策中的联系邮箱跟进，并附上反馈编号。</p>}
        </div>
      ) : (
        <form className="feedback-form" id="feedback-form" onSubmit={submit}>
          <fieldset className="feedback-category">
            <legend id="feedback-category-label">反馈类型</legend>
            <div role="radiogroup" aria-labelledby="feedback-category-label">
              {FEEDBACK_CATEGORIES.map((item, index) => (
                <button
                  key={item.value}
                  type="button"
                  role="radio"
                  className={category === item.value ? 'is-active' : ''}
                  aria-checked={category === item.value}
                  tabIndex={category === item.value ? 0 : -1}
                  onClick={() => setCategory(item.value)}
                  onKeyDown={(event) => moveCategoryFocus(event, index)}
                >
                  <strong>{item.label}</strong>
                  <small>{item.hint}</small>
                </button>
              ))}
            </div>
          </fieldset>

          <label className="feedback-editor">
            <span>反馈内容</span>
            <textarea
              ref={textareaRef}
              name="feedbackContent"
              autoComplete="off"
              value={content}
              maxLength={FEEDBACK_MAX_LENGTH}
              placeholder={category === 'privacy' ? '请填写过程哈希或反馈编号，以及需要处理的数据…' : '请描述你的建议或遇到的问题…'}
              onChange={(event) => {
                setContent(event.target.value);
                if (error) setError('');
              }}
              aria-describedby={`feedback-hint${error ? ' feedback-error' : ''}`}
            />
            <span className="feedback-count">{content.length} / {FEEDBACK_MAX_LENGTH}</span>
          </label>

          <p className="feedback-privacy" id="feedback-hint">
            {I.shield} {category === 'privacy' ? '此处为匿名反馈，无法回复。如需处理结果，请通过隐私政策中的联系邮箱提出请求；请勿填写 Cookie、密码或完整证件。' : '无需填写联系方式；请勿填写 Cookie、密码等敏感信息'}
          </p>
          {error && <p className="feedback-error" id="feedback-error" role="alert" aria-live="assertive">{error}</p>}
        </form>
      )}
    </SheetFrame>
  );
}
