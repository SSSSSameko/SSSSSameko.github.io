import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  Image,
  Link2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';

import {
  buildFilterSummary,
  candidateCutoffInfo,
  DRAW_RANDOM_ALGORITHM,
  friendlyProviderText,
} from '../lib/appCore.js';
import {
  buildAnnouncementText,
  DRAW_ANNOUNCEMENT_TEMPLATES,
} from '../lib/drawAnnouncements.js';
import { drawCountCopy, normalizeDrawReceipt } from '../lib/drawReceipts.js';
import useSheetDrag from '../hooks/useSheetDrag.js';
import useDialogStack from '../hooks/useDialogStack.js';
import CandidateAvatar from './CandidateAvatar.jsx';

const WINNERS_PER_GROUP = 12;
const WINNER_BATCH_SIZE = 50;

function formatReceiptDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date).replace(/\//g, '.');
}

function compactHash(value) {
  const text = String(value || '');
  if (!text) return '未记录';
  return text.length > 22 ? `${text.slice(0, 10)}…${text.slice(-8)}` : text;
}

function sourceScope(receipt) {
  if (receipt.source === 'manual') return '手动名单';
  if (receipt.sourceMeta?.complete === false) return '当前可见转发';
  const visible = Number(receipt.sourceMeta?.visibleNumber);
  const total = Number(receipt.sourceMeta?.totalNumber);
  if (Number.isFinite(visible) && Number.isFinite(total) && visible < total) {
    return `可见 ${visible} / 约 ${total} 条`;
  }
  return friendlyProviderText(
    receipt.sourceMeta?.providers || receipt.sourceMeta?.provider || receipt.source,
  ) || '微博转发';
}

function winnerIdentity(winner) {
  const uid = String(winner?.uid || '');
  if (!uid) return 'UID 未记录';
  return uid.length > 12 ? `UID ${uid.slice(0, 6)}…${uid.slice(-4)}` : `UID ${uid}`;
}

export default function DrawResultSheet({
  receipt: receiptInput,
  apiBase = '',
  isCapturing = false,
  isSyncing = false,
  historyStorageAvailable = true,
  onClose,
  onSaveImage,
  onCopyPost,
  onCopyFairness,
  onCopyWinners,
  onExportWinners,
  onRetrySave,
}) {
  const backdropRef = useRef(null);
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const closeTimerRef = useRef(null);
  const closingRef = useRef(false);
  const retryingRef = useRef(false);
  const requestCloseRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const [isClosing, setIsClosing] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [announcementTemplate, setAnnouncementTemplate] = useState('concise');
  const [visiblePrizeCounts, setVisiblePrizeCounts] = useState(() => new Map());
  const prizeControlRefs = useRef(new Map());
  const receipt = useMemo(
    () => (receiptInput ? normalizeDrawReceipt(receiptInput) : null),
    [receiptInput],
  );
  const isTopDialog = useDialogStack(Boolean(receipt));
  onCloseRef.current = onClose;

  useEffect(() => {
    setAnnouncementTemplate('concise');
    setVisiblePrizeCounts(new Map());
  }, [receipt?.id]);

  const announcementText = useMemo(
    () => (receipt ? buildAnnouncementText(receipt, announcementTemplate) : ''),
    [announcementTemplate, receipt],
  );

  function requestClose({ immediate = false } = {}) {
    if (closingRef.current) return;
    closingRef.current = true;
    if (immediate) {
      onCloseRef.current?.();
      return;
    }
    setIsClosing(true);
    const shellMotion = dialogRef.current?.closest('.app-shell')?.dataset.motion;
    const reduceMotion = shellMotion === 'reduced'
      || (shellMotion !== 'full' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    closeTimerRef.current = window.setTimeout(() => {
      onCloseRef.current?.();
    }, reduceMotion ? 1 : 190);
  }
  requestCloseRef.current = requestClose;
  const sheetDrag = useSheetDrag({
    sheetRef: dialogRef,
    backdropRef,
    onDismiss: () => requestCloseRef.current?.({ immediate: true }),
  });

  useEffect(() => {
    if (!receipt) return undefined;
    closingRef.current = false;
    setIsClosing(false);
    setIsRetrying(false);
    retryingRef.current = false;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event) => {
      if (!isTopDialog()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        requestCloseRef.current?.();
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const controls = [...dialogRef.current.querySelectorAll(
        'a[href], summary, button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hidden && element.getClientRects().length);
      if (!controls.length) return;
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      window.clearTimeout(closeTimerRef.current);
      previousFocus?.focus?.({ preventScroll: true });
    };
  }, [isTopDialog, receipt?.id]);

  if (!receipt) return null;

  const winnerCount = receipt.results.reduce(
    (sum, group) => sum + group.winners.length,
    0,
  );
  const isPractice = receipt.recordState === 'practice';
  const prizeCount = receipt.results.filter((group) => group.winners.length).length;
  const manualCount = receipt.drawNumber || 1;
  const drawLabel = isPractice
    ? '本地演练 · 不计入开奖次数'
    : receipt.recordState === 'server' && receipt.drawNumber
      ? drawCountCopy({
        source: receipt.source,
        count: receipt.drawNumber,
        completed: true,
      })
      : receipt.source === 'manual' && receipt.drawNumber
        ? drawCountCopy({ source: 'manual', count: manualCount, completed: true })
        : '未计入开奖次数';
  const filterText = receipt.rules?.filters
    ? buildFilterSummary(receipt.rules.filters)
    : '未记录';
  const prizeText = receipt.results
    .map((group) => `${group.prize.name} × ${group.winners.length}`)
    .join(' · ') || '未记录';
  const cutoffText = receipt.source === 'manual'
    ? `手动名单 · ${candidateCutoffInfo(receipt.sourceMeta?.loadedAt).label}`
    : candidateCutoffInfo(receipt.sourceMeta?.loadedAt).label;
  const displayedWinners = receipt.results.flatMap((group) => group.winners).slice(0, 4);
  const singleWinner = winnerCount === 1 ? displayedWinners[0] : null;
  let winnerMotionIndex = 0;

  async function retrySave() {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setIsRetrying(true);
    try {
      await onRetrySave?.();
    } finally {
      retryingRef.current = false;
      setIsRetrying(false);
    }
  }

  return (
    <div ref={backdropRef} className={`receipt-backdrop ${isClosing ? 'is-closing' : ''}`} onClick={() => requestClose()} role="presentation">
      <section
        ref={dialogRef}
        className="receipt-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="receipt-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="receipt-grabber" aria-hidden="true" {...sheetDrag} />
        <header className="receipt-header">
          <span className="receipt-title-icon" aria-hidden="true">
            <Sparkles />
          </span>
          <div>
            <h2 id="receipt-title">{isPractice ? '本地演练结果' : '开奖结果'}</h2>
            <p>{formatReceiptDate(receipt.drawnAt)}</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="receipt-close"
            aria-label="关闭开奖结果"
            onClick={requestClose}
          >
            <X />
          </button>
        </header>

        <div className="receipt-content">
          <section className="receipt-summary">
            <div className="receipt-summary-copy">
              <span><CheckCircle2 /> {isPractice ? '演练完成' : '开奖完成'}</span>
              <strong>{winnerCount} 位中奖用户</strong>
              <p>{drawLabel} · {prizeCount} 个奖项</p>
            </div>
            <div
              className={`receipt-avatar-stack ${singleWinner ? 'is-single' : ''}`}
              role="group"
              aria-label="中奖用户摘要"
            >
              {displayedWinners.map((winner, index) => (
                <CandidateAvatar
                  key={winner.id || winner.uid || winner.screenName || index}
                  candidate={winner}
                  className="receipt-stack-avatar"
                  apiBase={apiBase}
                  decorative
                  priority
                />
              ))}
              {singleWinner && (
                <span className="receipt-single-winner">
                  <strong>{singleWinner.screenName || singleWinner.uid || '中奖用户'}</strong>
                  <small>{winnerIdentity(singleWinner)}</small>
                </span>
              )}
              {winnerCount > displayedWinners.length && (
                <span className="receipt-stack-more">+{winnerCount - displayedWinners.length}</span>
              )}
            </div>
          </section>

          {receipt.sourceMeta?.complete === false && (
            <div className="receipt-scope-warning" role="note">
              <span><ShieldCheck /></span>
              <p><strong>本次名单为当前可见范围</strong><small>微博接口或登录态可能隐藏部分转发，公示前请按活动规则核对。</small></p>
            </div>
          )}

          <div className="receipt-section-heading">
            <div>
              <span>本轮结果</span>
              <h3>中奖名单</h3>
            </div>
            <small>{winnerCount} 人</small>
          </div>

          <div className="receipt-prize-list">
            {receipt.results.map((group, groupIndex) => {
              const visibleCount = Math.min(
                group.winners.length,
                visiblePrizeCounts.get(groupIndex) || WINNERS_PER_GROUP,
              );
              const expanded = visibleCount > WINNERS_PER_GROUP;
              const hasMore = visibleCount < group.winners.length;
              const visibleGroupWinners = group.winners.slice(0, visibleCount);
              const showNextBatch = () => setVisiblePrizeCounts((current) => {
                const next = new Map(current);
                next.set(groupIndex, Math.min(group.winners.length, visibleCount + WINNER_BATCH_SIZE));
                return next;
              });
              const collapseGroup = () => setVisiblePrizeCounts((current) => {
                const next = new Map(current);
                next.delete(groupIndex);
                return next;
              });
              const collapseAndRestoreFocus = () => {
                collapseGroup();
                requestAnimationFrame(() => {
                  prizeControlRefs.current.get(groupIndex)?.focus({ preventScroll: true });
                });
              };
              return (
                <section
                  className="receipt-prize"
                  key={`${group.prize.name}-${groupIndex}`}
                  style={{
                    '--receipt-accent': group.prize.color || '#ee8fa1',
                    '--receipt-group-delay': `${130 + Math.min(groupIndex, 6) * 55}ms`,
                  }}
                >
                  <header>
                    <span className="receipt-prize-mark">{groupIndex + 1}</span>
                    <div>
                      <strong>{group.prize.name}</strong>
                      <small>{expanded ? `已显示 ${visibleCount} / ${group.winners.length} 名` : `${group.winners.length} 名`}</small>
                    </div>
                    {group.winners.length > WINNERS_PER_GROUP && (
                      <span className="receipt-prize-controls">
                        <button
                          type="button"
                          ref={(node) => {
                            if (node) prizeControlRefs.current.set(groupIndex, node);
                            else prizeControlRefs.current.delete(groupIndex);
                          }}
                          className={!hasMore ? 'is-collapse' : undefined}
                          aria-expanded={expanded}
                          aria-label={hasMore
                            ? `${expanded ? '继续显示' : '查看'}${group.prize.name}中奖名单，共 ${group.winners.length} 人`
                            : `收起${group.prize.name}中奖名单`}
                          onClick={hasMore ? showNextBatch : collapseGroup}
                        >
                          {hasMore ? (expanded ? '继续' : '查看') : '收起'}
                          <ChevronDown />
                        </button>
                        {expanded && hasMore && (
                          <button type="button" onClick={collapseAndRestoreFocus} aria-label={`收起${group.prize.name}中奖名单`}>
                            收起
                          </button>
                        )}
                      </span>
                    )}
                  </header>
                  <div className="receipt-winner-list">
                    {visibleGroupWinners.map((winner, winnerIndex) => {
                    const motionIndex = winnerMotionIndex;
                    winnerMotionIndex += 1;
                    return (
                      <div
                        className={`receipt-winner ${motionIndex < 8 ? 'is-animated' : ''}`.trim()}
                        key={winner.id || winner.uid || winner.screenName || winnerIndex}
                        style={motionIndex < 8 ? { '--receipt-delay': `${motionIndex * 36}ms` } : undefined}
                      >
                        <CandidateAvatar candidate={winner} className="receipt-winner-avatar" apiBase={apiBase} decorative />
                        <span>
                          <strong>{winner.screenName || winner.uid || `中奖用户 ${winnerIndex + 1}`}</strong>
                          <small>{winnerIdentity(winner)}</small>
                        </span>
                        <em>{String(winnerIndex + 1).padStart(2, '0')}</em>
                      </div>
                    );
                  })}
                  </div>
                </section>
              );
            })}
          </div>

          <section className="receipt-audit">
            <header>
              <div>
                <span><ShieldCheck /> 随机过程记录</span>
                <p>{drawLabel}</p>
              </div>
              <button type="button" onClick={onCopyFairness} aria-label="复制随机过程摘要">
                <Copy />
                复制
              </button>
            </header>

            <div className="receipt-audit-method">
              <span>
                <small>筛选规则</small>
                <strong>{filterText}</strong>
              </span>
              <span>
                <small>随机规则</small>
                <strong>{DRAW_RANDOM_ALGORITHM}</strong>
              </span>
            </div>

            <div className="receipt-audit-grid">
              <span><small>候选范围</small><strong>{receipt.eligibleCount} / {receipt.candidateCount} 人</strong></span>
              <span><small>数据来源</small><strong>{sourceScope(receipt)}</strong></span>
              <span className="receipt-audit-code"><small>名单指纹</small><strong title={receipt.candidateDigest}>{compactHash(receipt.candidateDigest)}</strong></span>
              <span className="receipt-audit-code"><small>过程哈希</small><strong title={receipt.auditHash}>{compactHash(receipt.auditHash)}</strong></span>
            </div>

            {isPractice ? (
              <div className="receipt-local-note is-practice" role="status">
                <Sparkles />
                <span>
                  <strong>本地演练结果</strong>
                  <small>仅用于核对动画与设置，不保存记录，也不计入本链接开奖次数。</small>
                </span>
              </div>
            ) : receipt.recordState !== 'server' && (
              <div className={`receipt-local-note ${isSyncing ? 'is-syncing' : ''}`} role="status" aria-live="polite">
                <RefreshCw />
                <span>
                  <strong>{isSyncing ? '正在同步开奖记录' : '未计入开奖次数'}</strong>
                  <small>{isSyncing
                    ? '结果已生成，可以先查看或保存；同步完成后会自动更新开奖次数'
                    : historyStorageAvailable
                      ? '当前浏览器已保留结果；重新保存成功后才会计入次数'
                      : '本机存储不可用；关闭页面前请保存结果图或导出名单'}</small>
                </span>
                {isSyncing
                  ? <em className="receipt-sync-state">同步中</em>
                  : <button type="button" onClick={retrySave} disabled={isRetrying}>{isRetrying ? '正在保存' : '重新保存'}</button>}
              </div>
            )}

            <details>
              <summary>
                <span>查看完整记录</span>
                <ChevronDown />
              </summary>
              <dl>
                <div><dt>开奖时间</dt><dd>{formatReceiptDate(receipt.drawnAt)}</dd></div>
                <div><dt>名单截止</dt><dd>{cutoffText}</dd></div>
                <div><dt>排除候选</dt><dd>{receipt.excludedCount} 人</dd></div>
                <div><dt>奖项快照</dt><dd>{prizeText}</dd></div>
                <div><dt>筛选规则</dt><dd>{filterText}</dd></div>
                <div><dt>随机规则</dt><dd>{DRAW_RANDOM_ALGORITHM}</dd></div>
                <div><dt>随机种子</dt><dd title={receipt.seed}>{compactHash(receipt.seed)}</dd></div>
                <div><dt>名单指纹</dt><dd title={receipt.candidateDigest}>{compactHash(receipt.candidateDigest)}</dd></div>
                <div><dt>过程哈希</dt><dd title={receipt.auditHash}>{compactHash(receipt.auditHash)}</dd></div>
                <div><dt>数据来源</dt><dd>{sourceScope(receipt)}</dd></div>
              </dl>
              {receipt.statusUrl && (
                <a href={receipt.statusUrl} target="_blank" rel="noreferrer">
                  <Link2 />
                  查看原微博
                </a>
              )}
            </details>
          </section>

          <section className="receipt-copy-details">
            <header>
              <div>
                <span>公示文案</span>
                <strong>选择格式并复制</strong>
              </div>
              <select
                value={announcementTemplate}
                onChange={(event) => setAnnouncementTemplate(event.target.value)}
                aria-label="公示文案格式"
              >
                {DRAW_ANNOUNCEMENT_TEMPLATES.map((template) => (
                  <option key={template.value} value={template.value}>{template.label}</option>
                ))}
              </select>
            </header>
            <p className="receipt-copy-hint">
              {DRAW_ANNOUNCEMENT_TEMPLATES.find((template) => template.value === announcementTemplate)?.hint}
            </p>
            <pre>{announcementText}</pre>
          </section>
        </div>

        <div className="receipt-actions">
          <button
            type="button"
            className="receipt-action-primary v3-primary-action"
            onClick={onSaveImage}
            disabled={isCapturing}
          >
            <Image />
            {isCapturing ? '正在生成' : '保存结果图'}
          </button>
          <button type="button" className="receipt-action-secondary" onClick={() => onCopyPost?.(announcementTemplate)}>
            <Copy />
            复制文案
          </button>
          <button type="button" className="receipt-action-secondary" onClick={onCopyWinners}>
            <Copy />
            复制名单
          </button>
          <button type="button" className="receipt-action-secondary" onClick={onExportWinners}>
            <Download />
            导出 CSV
          </button>
        </div>
      </section>
    </div>
  );
}
