import SheetFrame from '../ui/SheetFrame.jsx';
import { icons as I } from '../ui/icons.jsx';
import { useEffect, useRef, useState } from 'react';
import CandidateAvatar from '../CandidateAvatar.jsx';
import { friendlyProviderText } from '../../lib/appCore.js';

const candidateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formattedCandidateTime(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '';
  return candidateTimeFormatter.format(date).replaceAll('/', '-');
}

export default function CandidateDetailSheet({ entry, apiBase, onClose, onCopy }) {
  const [copiedField, setCopiedField] = useState('');
  const copiedTimerRef = useRef(null);

  useEffect(() => {
    setCopiedField('');
    window.clearTimeout(copiedTimerRef.current);
    return () => window.clearTimeout(copiedTimerRef.current);
  }, [entry]);

  if (!entry?.candidate) return null;
  const { candidate } = entry;
  const name = candidate.screenName || candidate.uid || '候选用户';
  const sourceText = friendlyProviderText(candidate.source) || '候选名单';
  const createdAt = formattedCandidateTime(candidate.createdAt);

  async function copyField(value, field, successMessage) {
    const copied = await onCopy(value, successMessage);
    if (!copied) return;
    setCopiedField(field);
    window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopiedField(''), 1600);
  }

  return (
    <SheetFrame
      title="候选详情"
      subtitle={entry.eligible ? '符合当前筛选规则' : entry.reasonLabel}
      icon={I.users}
      onClose={onClose}
      className="candidate-detail-sheet"
      footer={(close) => (
        <button type="button" onClick={() => close()} className="flow-sheet-primary v3-primary-action">完成</button>
      )}
    >
      {() => (
        <>
          <div className="candidate-detail-identity">
            <CandidateAvatar candidate={candidate} className="candidate-detail-avatar" apiBase={apiBase} priority />
            <div>
              <span className={entry.eligible ? 'is-eligible' : 'is-excluded'}>
                {entry.eligible ? '可参与本轮抽奖' : entry.reasonLabel}
              </span>
              <strong>{name}</strong>
              <small>{candidate.uid ? `UID ${candidate.uid}` : sourceText}</small>
            </div>
          </div>

          <dl className="candidate-detail-facts">
            <div><dt>候选状态</dt><dd>{entry.eligible ? '可抽' : '已排除'}</dd></div>
            {!entry.eligible && <div><dt>排除原因</dt><dd>{entry.reasonDetail}</dd></div>}
            <div><dt>数据来源</dt><dd>{sourceText}</dd></div>
            {createdAt && <div><dt>转发时间</dt><dd>{createdAt}</dd></div>}
          </dl>

          {candidate.text && (
            <section className="candidate-detail-text">
              <h3>转发内容</h3>
              <p>{candidate.text}</p>
            </section>
          )}

          <div className="candidate-detail-actions">
            <button type="button" aria-label="复制昵称" onClick={() => copyField(name, 'name', '昵称已复制。')}>
              {I.copy} {copiedField === 'name' ? '已复制' : '复制昵称'}
            </button>
            {candidate.uid && (
              <button type="button" aria-label="复制 UID" onClick={() => copyField(String(candidate.uid), 'uid', 'UID 已复制。')}>
                {I.copy} {copiedField === 'uid' ? '已复制' : '复制 UID'}
              </button>
            )}
          </div>
        </>
      )}
    </SheetFrame>
  );
}
