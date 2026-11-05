import SheetFrame from '../ui/SheetFrame.jsx';
import { icons as I } from '../ui/icons.jsx';
import { useState } from 'react';

export default function FilterEditorSheet({ values, onApply, onClose }) {
  const [draft, setDraft] = useState(() => ({
    keyword: values.keyword,
    mentionMin: values.mentionMin,
    blocklist: values.blocklist,
    uniqueByUser: values.uniqueByUser,
    excludePrevious: values.excludePrevious,
  }));

  const updateDraft = (patch) => setDraft((current) => ({ ...current, ...patch }));
  const setPreset = (keyword, mentionMin) => updateDraft({ keyword, mentionMin });

  return (
    <SheetFrame
      title="筛选规则"
      tone="mint"
      subtitle="调整本轮可抽候选"
      icon={I.listChecks}
      onClose={onClose}
      className="v3-editor-sheet"
      footer={(close) => (
        <button
          type="button"
          className="flow-sheet-primary v3-primary-action"
          onClick={() => {
            if (onApply(draft)) close();
          }}
        >
          应用筛选
        </button>
      )}
    >
      {() => (
        <>
          <div className="v3-filter-presets">
            <button
              type="button"
              className={!draft.keyword && Number(draft.mentionMin) === 0 ? 'is-active' : ''}
              aria-pressed={!draft.keyword && Number(draft.mentionMin) === 0}
              onClick={() => setPreset('', 0)}
            >
              不限内容
            </button>
            <button
              type="button"
              className={draft.keyword === '抽奖' && Number(draft.mentionMin) === 0 ? 'is-active' : ''}
              aria-pressed={draft.keyword === '抽奖' && Number(draft.mentionMin) === 0}
              onClick={() => setPreset('抽奖', 0)}
            >
              含“抽奖”
            </button>
            <button
              type="button"
              className={!draft.keyword && Number(draft.mentionMin) === 1 ? 'is-active' : ''}
              aria-pressed={!draft.keyword && Number(draft.mentionMin) === 1}
              onClick={() => setPreset('', 1)}
            >
              至少 @1
            </button>
            <button
              type="button"
              className={!draft.keyword && Number(draft.mentionMin) === 2 ? 'is-active' : ''}
              aria-pressed={!draft.keyword && Number(draft.mentionMin) === 2}
              onClick={() => setPreset('', 2)}
            >
              至少 @2
            </button>
          </div>
          <div className="v3-form-group">
            <label><span>转发关键词</span><input name="filterKeyword" autoComplete="off" value={draft.keyword} onChange={(event) => updateDraft({ keyword: event.target.value })} placeholder="留空表示不限…" /></label>
            <label><span>至少 @ 人数</span><input name="filterMentionMinimum" type="number" min="0" max="10" inputMode="numeric" value={draft.mentionMin} onChange={(event) => updateDraft({ mentionMin: event.target.value })} /></label>
            <label><span>排除名单</span><textarea name="filterBlocklist" autoComplete="off" value={draft.blocklist} onChange={(event) => updateDraft({ blocklist: event.target.value })} placeholder="每行一个 UID 或昵称…" /></label>
          </div>
          <div className="v3-toggle-list">
            <label><span><strong>候选去重</strong><small>同一用户只保留一次</small></span><input type="checkbox" checked={draft.uniqueByUser} onChange={(event) => updateDraft({ uniqueByUser: event.target.checked })} /></label>
            {!draft.uniqueByUser && <p className="flow-field-hint">每条转发参与抽取，同一用户每轮最多中奖一次。</p>}
            <label><span><strong>排除已中奖用户</strong><small>仅限当前浏览器的当前任务</small></span><input type="checkbox" checked={draft.excludePrevious} onChange={(event) => updateDraft({ excludePrevious: event.target.checked })} /></label>
          </div>
        </>
      )}
    </SheetFrame>
  );
}
