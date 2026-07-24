import React, { useEffect, useMemo, useRef } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Copy,
  Image,
  Link2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from 'lucide-react';

import {
  buildFilterSummary,
  DRAW_RANDOM_ALGORITHM,
  friendlyProviderText,
} from '../lib/appCore.js';
import { drawCountCopy, normalizeDrawReceipt } from '../lib/drawReceipts.js';
import CandidateAvatar from './CandidateAvatar.jsx';

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
  if (receipt.sourceMeta?.complete === false) return '公开可见转发';
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
  isCapturing = false,
  onClose,
  onSaveImage,
  onCopyPost,
  onCopyFairness,
  onRetrySave,
}) {
  const closeButtonRef = useRef(null);
  const receipt = useMemo(
    () => (receiptInput ? normalizeDrawReceipt(receiptInput) : null),
    [receiptInput],
  );

  useEffect(() => {
    if (!receipt) return undefined;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus?.({ preventScroll: true });
    };
  }, [receipt, onClose]);

  if (!receipt) return null;

  const winnerCount = receipt.results.reduce(
    (sum, group) => sum + group.winners.length,
    0,
  );
  const prizeCount = receipt.results.filter((group) => group.winners.length).length;
  const manualCount = receipt.drawNumber || 1;
  const drawLabel = receipt.recordState === 'server' && receipt.drawNumber
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
  const displayedWinners = receipt.results.flatMap((group) => group.winners).slice(0, 4);

  return (
    <div className="receipt-backdrop" onClick={onClose} role="presentation">
      <section
        className="receipt-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="开奖结果"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="receipt-grabber" aria-hidden="true" />
        <header className="receipt-header">
          <span className="receipt-title-icon" aria-hidden="true">
            <Sparkles />
          </span>
          <div>
            <h2>开奖结果</h2>
            <p>{formatReceiptDate(receipt.drawnAt)}</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="receipt-close"
            aria-label="关闭开奖结果"
            onClick={onClose}
          >
            <X />
          </button>
        </header>

        <div className="receipt-content">
          <section className="receipt-summary">
            <div className="receipt-summary-copy">
              <span><CheckCircle2 /> 开奖完成</span>
              <strong>{winnerCount} 位中奖用户</strong>
              <p>{prizeCount} 个奖项 · {formatReceiptDate(receipt.drawnAt)}</p>
            </div>
            <div className="receipt-avatar-stack" aria-label="中奖用户头像">
              {displayedWinners.map((winner, index) => (
                <CandidateAvatar
                  key={winner.id || winner.uid || winner.screenName || index}
                  candidate={winner}
                  className="receipt-stack-avatar"
                />
              ))}
              {winnerCount > displayedWinners.length && (
                <span className="receipt-stack-more">+{winnerCount - displayedWinners.length}</span>
              )}
            </div>
          </section>

          <div className="receipt-section-heading">
            <div>
              <span>本轮结果</span>
              <h3>中奖名单</h3>
            </div>
            <small>{winnerCount} 人</small>
          </div>

          <div className="receipt-prize-list">
            {receipt.results.map((group, groupIndex) => (
              <section
                className="receipt-prize"
                key={`${group.prize.name}-${groupIndex}`}
                style={{ '--receipt-accent': group.prize.color || '#ee8fa1' }}
              >
                <header>
                  <span className="receipt-prize-mark">{groupIndex + 1}</span>
                  <div>
                    <strong>{group.prize.name}</strong>
                    <small>{group.winners.length} 名</small>
                  </div>
                </header>
                <div className="receipt-winner-list">
                  {group.winners.map((winner, winnerIndex) => (
                    <div
                      className="receipt-winner"
                      key={winner.id || winner.uid || winner.screenName || winnerIndex}
                      style={{ '--receipt-index': winnerIndex }}
                    >
                      <CandidateAvatar candidate={winner} className="receipt-winner-avatar" />
                      <span>
                        <strong>{winner.screenName || winner.uid || `中奖用户 ${winnerIndex + 1}`}</strong>
                        <small>{winnerIdentity(winner)}</small>
                      </span>
                      <em>{String(winnerIndex + 1).padStart(2, '0')}</em>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <section className="receipt-audit">
            <header>
              <div>
                <span><ShieldCheck /> 公平记录</span>
                <p>{drawLabel}</p>
              </div>
              <button type="button" onClick={onCopyFairness} aria-label="复制公平摘要">
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
              <span className="receipt-audit-code"><small>审计哈希</small><strong title={receipt.auditHash}>{compactHash(receipt.auditHash)}</strong></span>
            </div>

            {receipt.recordState !== 'server' && (
              <div className="receipt-local-note">
                <RefreshCw />
                <span><strong>未计入开奖次数</strong><small>重新保存成功后才会计入本链接开奖次数</small></span>
                <button type="button" onClick={onRetrySave}>重新保存</button>
              </div>
            )}

            <details>
              <summary>
                <span>查看完整记录</span>
                <ChevronDown />
              </summary>
              <dl>
                <div><dt>开奖时间</dt><dd>{formatReceiptDate(receipt.drawnAt)}</dd></div>
                <div><dt>排除候选</dt><dd>{receipt.excludedCount} 人</dd></div>
                <div><dt>奖项快照</dt><dd>{prizeText}</dd></div>
                <div><dt>筛选规则</dt><dd>{filterText}</dd></div>
                <div><dt>随机规则</dt><dd>{DRAW_RANDOM_ALGORITHM}</dd></div>
                <div><dt>随机种子</dt><dd title={receipt.seed}>{compactHash(receipt.seed)}</dd></div>
                <div><dt>名单指纹</dt><dd title={receipt.candidateDigest}>{compactHash(receipt.candidateDigest)}</dd></div>
                <div><dt>审计哈希</dt><dd title={receipt.auditHash}>{compactHash(receipt.auditHash)}</dd></div>
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
          <button type="button" className="receipt-action-secondary" onClick={onCopyPost}>
            <Copy />
            复制文案
          </button>
        </div>
      </section>
    </div>
  );
}
