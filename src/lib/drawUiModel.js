import { drawCountCopy } from './drawReceipts.js';

export function getAccountStatusText({
  cookieHealth,
  verifiedAccountCount,
  tryableAccountCount,
  hasFallbackCookie,
}) {
  if (cookieHealth === 'error') return '登录态状态暂不可用';
  if (cookieHealth === 'checking') return '正在读取登录态';
  if (verifiedAccountCount > 0) return `${verifiedAccountCount} 个已验证服务器登录态`;
  if (tryableAccountCount > 0) return '服务器登录态已保存';
  return hasFallbackCookie ? '已填写备用 Cookie' : '暂无服务器登录态';
}

export function getNextDrawText({
  source,
  previousDrawCount,
  manualLimitReached,
}) {
  if (source === 'manual') {
    return manualLimitReached
      ? '手动名单开奖次数已达上限'
      : `本机第 ${previousDrawCount + 1} 次手动开奖`;
  }
  if (previousDrawCount === null) return '本链接下一次开奖（次数待核实）';
  return `本链接第 ${previousDrawCount + 1} 次开奖`;
}

export function getDrawCountText({
  activeReceipt,
  source,
  manualLimitReached,
  manualDrawCount,
  statusUrl,
  status,
  count,
}) {
  if (activeReceipt) {
    return activeReceipt.drawNumber
      ? drawCountCopy({
        source: activeReceipt.source,
        count: activeReceipt.drawNumber,
        completed: true,
      })
      : '本次结果未计入次数';
  }
  if (source === 'manual') {
    return manualLimitReached
      ? '手动名单开奖次数已达上限'
      : drawCountCopy({ source, count: manualDrawCount, completed: false });
  }
  if (!statusUrl.trim()) return '输入链接后显示';
  if (status === 'loading') return '正在查询记录';
  if (status === 'error') return '开奖次数查询失败';
  if (count === null) return '暂未获取到开奖次数';
  return drawCountCopy({ source, count, completed: false });
}

export function getCandidateFreshnessText({
  loadError,
  candidateCount,
  sourceReady,
  source,
  loadedTime,
  sourceMeta,
}) {
  if (loadError) return '上次载入未完成，等待重新载入';
  if (candidateCount && !sourceReady) return '来源已修改，等待重新载入';
  if (source === 'manual') return loadedTime ? `${loadedTime} 更新` : '手动名单';
  if (sourceMeta?.delivery === 'recent-snapshot') {
    const ageSeconds = Math.max(1, Math.round(Number(sourceMeta.snapshotAgeMs || 0) / 1000));
    return `复用 ${ageSeconds} 秒内名单`;
  }
  if (sourceMeta?.delivery === 'shared-running') return '共享载入完成';
  return loadedTime ? `${loadedTime} 更新` : '本次载入';
}

export function getIntakeState({
  loading,
  loadError,
  hasCandidates,
  drawState,
  loadCompleted,
  statusUrl,
}) {
  if (loading) return 'loading';
  if (loadError) return 'error';
  if (hasCandidates) return drawState;
  if (loadCompleted) return 'checked-empty';
  return statusUrl.trim() ? 'link-ready' : 'empty';
}

export function getDrawActionState({
  loadError,
  hasCandidates,
  sourceReady,
  eligibleCount,
  setupConfirmed,
  nextDrawLabel,
  totalSlots,
  prizeCount,
}) {
  if (loadError || (hasCandidates && !sourceReady)) {
    return {
      kind: 'load',
      title: loadError ? '重新载入候选' : '载入当前来源',
      detail: loadError
        ? hasCandidates ? '上次名单仍在页面中，刷新成功后才能开奖' : '请检查链接或登录态后重试'
        : '来源或链接已更改，载入后再设置奖项',
    };
  }
  if (!eligibleCount) {
    return {
      kind: 'filter',
      title: '调整筛选',
      detail: '当前没有符合条件的候选',
    };
  }
  if (setupConfirmed) {
    return {
      kind: 'draw',
      title: '核对并开奖',
      detail: `${nextDrawLabel} · 将抽取 ${totalSlots} 人`,
    };
  }
  return {
    kind: 'setup',
    title: '设置奖项并确认',
    detail: `${prizeCount} 个奖项 · ${totalSlots} 个名额`,
  };
}
