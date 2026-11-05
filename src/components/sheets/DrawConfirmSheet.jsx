import SheetFrame from '../ui/SheetFrame.jsx';
import { icons as I } from '../ui/icons.jsx';

export default function DrawConfirmSheet({
  previousDrawCount,
  candidateSummary,
  source,
  onEditPrizes,
  nextDrawText,
  candidateLoadError,
  candidateWarningText,
  eligibleCount,
  totalSlots,
  candidateNeedsRefresh,
  candidateCutoffLabel,
  filterSummary,
  prizes,
  cooldownPersistent,
  onClose,
  onConfirm,
  onPractice,
  onRefresh,
}) {
  const rawPreviousCount = previousDrawCount;
  const parsedPreviousCount = Number(rawPreviousCount);
  const countKnown = rawPreviousCount !== null
    && rawPreviousCount !== undefined
    && rawPreviousCount !== ''
    && Number.isInteger(parsedPreviousCount)
    && parsedPreviousCount >= 0;
  const previousCount = countKnown ? parsedPreviousCount : null;
  const nextCount = countKnown ? previousCount + 1 : null;

  return (
    <SheetFrame
      title="开奖前确认"
      tone="mint"
      subtitle="确认无误后再开始抽取"
      icon={I.shield}
      onClose={onClose}
      className="v3-draw-confirm-sheet"
      footer={(close) => (
        <>
          <button type="button" className="flow-sheet-primary v3-primary-action v3-confirm-draw" onClick={() => onConfirm(close)}>
            {I.shuffle}
            <span>确认并开始抽奖</span>
          </button>
          <button type="button" className="v3-confirm-practice" onClick={() => onPractice(close)}>
            <span>{I.play}</span>
            <span>
              <strong>本地演练</strong>
              <small>播放完整流程，不保存记录</small>
            </span>
            {I.chevron}
          </button>
          <div className="v3-confirm-secondary-actions">
            {source !== 'manual' && (
              <button type="button" onClick={() => close(onRefresh)}>
                {I.refresh}
                更新候选
              </button>
            )}
            <button type="button" onClick={() => close(onEditPrizes)}>
              {I.gift}
              修改奖项
            </button>
          </div>
        </>
      )}
    >
      {() => (
        <>
          <div className={`v3-confirm-hero ${previousCount > 0 ? 'is-repeat' : ''} ${previousCount === null ? 'is-unknown' : ''}`}>
            <span>{previousCount > 0 ? I.history : previousCount === null ? I.info : I.gift}</span>
            <div>
              <small>{previousCount === null ? '历史次数暂未核实' : previousCount > 0 ? `此前已完成 ${previousCount} 次` : '暂无历史开奖记录'}</small>
              <strong>{nextDrawText}</strong>
              <p>{previousCount === null ? '本次完成后会以服务器保存结果为准' : '只有成功保存的结果才会计入次数'}</p>
            </div>
          </div>

          {(candidateLoadError || candidateWarningText) && (
            <div className="v3-confirm-warning" role="note">
              {I.alert}
              <span>
                <strong>{candidateLoadError ? '候选载入未完成' : '请核对候选范围'}</strong>
                <small>{candidateLoadError || candidateWarningText}</small>
              </span>
            </div>
          )}

          <section className="v3-confirm-preview" aria-label="筛选结果预览">
            <header>
              <span>{I.listChecks}</span>
              <div>
                <strong>筛选结果预览</strong>
                <small>按当前名单和规则计算</small>
              </div>
              <em>{candidateSummary.excluded ? `排除 ${candidateSummary.excluded} 条` : '未排除候选'}</em>
            </header>
            <div className="v3-confirm-preview-metrics">
              <div><strong>{candidateSummary.total.toLocaleString()}</strong><small>候选条目</small></div>
              <div><strong>{eligibleCount.toLocaleString()}</strong><small>可抽人数</small></div>
              <div><strong>{candidateSummary.excluded.toLocaleString()}</strong><small>排除条目</small></div>
            </div>
            <p>
              <span>主要排除原因</span>
              <strong>{candidateSummary.reasonText || '暂无排除候选'}</strong>
            </p>
          </section>

          {candidateSummary.eligible > eligibleCount && (
            <p className="flow-field-hint">{candidateSummary.eligible} 条转发参与抽取，共 {eligibleCount} 位用户。每位用户本轮最多中奖一次。</p>
          )}

          <dl className="v3-confirm-facts">
            <div><dt>可抽候选</dt><dd>{eligibleCount.toLocaleString()} 人</dd></div>
            <div><dt>中奖名额</dt><dd>{totalSlots} 人</dd></div>
            <div className={candidateNeedsRefresh ? 'is-stale' : ''}>
              <dt>名单截止</dt>
              <dd>{candidateCutoffLabel}</dd>
            </div>
            <div><dt>筛选规则</dt><dd>{filterSummary}</dd></div>
          </dl>

          <div className="v3-confirm-prizes" aria-label="本轮奖项">
            {prizes.map((prize, index) => (
              <div key={`${prize.name}-${index}`}>
                <span style={{ '--prize-color': prize.color }}>{index + 1}</span>
                <strong title={prize.name}>{prize.name}</strong>
                <small>{prize.count} 名</small>
              </div>
            ))}
          </div>

          <p className="v3-repeat-note">
            {source === 'manual' ? I.info : previousCount > 0 ? I.info : previousCount === null ? I.alert : I.clock}
            {source === 'manual'
              ? '手动名单不会查询链接历史，请确认当前名单和奖项后再开始。'
              : !cooldownPersistent
              ? '本机存储不可用；当前页面内成功开奖后一分钟内不能重复开奖，刷新或关闭页面后限制可能失效。'
              : previousCount === null
              ? '历史次数暂未核实，本次完成后会显示服务器返回的实际次数。'
              : previousCount > 0
              ? `本次完成后显示为第 ${nextCount} 次；同一浏览器一分钟内不能重复开奖。`
              : '同一浏览器内，本链接成功开奖后一分钟内不能重复开奖。'}
          </p>

        </>
      )}
    </SheetFrame>
  );
}
