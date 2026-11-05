import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  buildFilterSummary,
  candidateCutoffInfo,
  candidateLoadWarning,
  cleanApiBase,
  digestCandidates,
  friendlyProviderText,
  MAX_MANUAL_CANDIDATES,
  MAX_MANUAL_FILE_BYTES,
  normalizeMentionMin,
  parseManualInput,
  randomSeedHex,
  readStoredValue,
  seededShuffle,
  toCsv,
  writeStoredValue,
} from './lib/appCore.js';
import { avatarProxyUrl, safeAvatarUrl } from './lib/avatar.js';
import {
  buildFairnessSummary,
  clearDrawHistoryStorage,
  DRAW_HISTORY_KEY,
  DRAW_HISTORY_LIMIT,
  drawCountCopy,
  mergeDrawHistory,
  mutateDrawHistory,
  nextManualDrawNumber,
  normalizeDrawReceipt,
  parseDrawHistoryBackup,
  readDrawHistoryState,
  receiptWinnerRows,
  receiptWinnerText,
  serializeDrawHistoryBackup,
  upsertDrawReceipt,
  withDrawHistoryLock,
  winnerIdsForStatus,
} from './lib/drawReceipts.js';
import {
  acquireDrawGuard,
  acquireDrawTabLock,
  clearDrawCooldownStorage,
  completeDrawGuard,
  drawCooldownScope,
  drawCooldownStatus,
  releaseDrawGuard,
} from './lib/drawCooldown.js';
import {
  getAccountStatusText,
  getCandidateFreshnessText,
  getDrawCountText,
  getNextDrawText,
} from './lib/drawUiModel.js';
import {
  candidateIdentity,
  eligibleCandidates,
  evaluateCandidateEligibility,
  summarizeCandidateEligibility,
} from './lib/candidateEligibility.js';
import { buildAnnouncementText } from './lib/drawAnnouncements.js';
import { normalizeFeedbackSubmission } from './lib/feedback.js';
import AppWorkspace from './components/AppWorkspace.jsx';
import { useBackendStatus } from './hooks/useBackendStatus.js';
import { useDrawCount } from './hooks/useDrawCount.js';
import { validateRepostResult } from './lib/repostResponse.js';
import { countEligibleUsers, uniqueWinnerPool } from './lib/drawPool.js';
import {
  apiError,
  initialApiBase,
  initialApiBaseInput,
  initialApiKey,
  isPresetApiBase,
  isTrustedApiBase,
  presetApiBase,
  readApiResponse,
  requestApi,
} from './lib/browserApi.js';
import { COLORS, DEFAULT_PRIZES, MAX_DRAW_WINNERS, MAX_DRAW_RESULT_GROUPS, defaultPrize } from './lib/drawConfig.js';
import { initialMotionPreference, shouldReduceMotion } from './lib/motionPreferences.js';
import { rollingStore } from './lib/rollingCandidates.js';

import { isWeiboStatusReference } from './lib/weiboStatus.js';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  let timer;
  const finish = () => {
    signal?.removeEventListener('abort', cancel);
    resolve();
  };
  const cancel = () => {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    reject(new DOMException('操作已取消', 'AbortError'));
  };
  timer = window.setTimeout(finish, ms);
  if (!signal) return;
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
});
const throwIfAborted = (signal) => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('操作已取消', 'AbortError');
};
const publicAsset = (name) => `${import.meta.env.BASE_URL}${name}`;
const APP_VERSION = __APP_VERSION__;
const REPOST_JOB_TIMEOUT_MS = 90 * 60 * 1000;
const REPOST_JOB_POLL_MS = 2000;
const REPOST_JOB_RECONNECT_ATTEMPTS = 4;
const REPOST_JOB_RECONNECT_BASE_MS = 900;
const MAX_HISTORY_BACKUP_BYTES = 2 * 1024 * 1024;
const DRAW_HISTORY_MUTATION_CANCELLED = Symbol('draw-history-mutation-cancelled');

async function warmDrawAvatars(candidates, apiBase, signal) {
  if (typeof window.Image !== 'function') return;
  const urls = [...new Set(candidates
    .flatMap((candidate) => {
      const avatar = safeAvatarUrl(candidate?.avatar);
      if (!avatar) return [];
      const proxy = avatarProxyUrl(avatar, apiBase);
      return proxy ? [proxy, avatar] : [avatar];
    })
    .filter(Boolean))]
    .slice(0, 36);
  if (!urls.length) return;

  const loads = urls.map((url) => new Promise((resolve) => {
    const image = new window.Image();
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const cancel = () => {
      image.src = '';
      done();
    };
    const timer = window.setTimeout(done, 1500);
    image.decoding = 'async';
    image.onload = done;
    image.onerror = done;
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }
    image.src = url;
  }));
  await Promise.race([
    Promise.allSettled(loads),
    sleep(650, signal),
  ]);
}

function download(name, content, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  downloadUrl(name, url);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadUrl(name, url) {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
function canvasBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('图片编码失败'));
    }, type);
  });
}

function canUseLocalStorage() {
  const key = 'weibo-draw-storage-check';
  try {
    window.localStorage.setItem(key, key);
    const stored = window.localStorage.getItem(key) === key;
    window.localStorage.removeItem(key);
    return stored;
  } catch {
    try {
      window.localStorage.removeItem(key);
    } catch {
    }
    return false;
  }
}

function shortLoadedTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

let legalDocumentsPromise = null;
function loadLegalDocuments() {
  legalDocumentsPromise ||= import('./data/legalDocuments.js')
    .then((module) => module.buildLegalDocuments({ appVersion: APP_VERSION, publicAsset }))
    .catch((error) => {
      legalDocumentsPromise = null;
      throw error;
    });
  return legalDocumentsPromise;
}

function App() {
  const [source, setSource] = useState('mobile');
  const [statusUrl, setStatusUrl] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [mobileCookie, setMobileCookie] = useState('');
  const [manualInput, setManualInput] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [historyUids, setHistoryUids] = useState(new Set());
  const [prizes, setPrizes] = useState([...DEFAULT_PRIZES]);
  const [keyword, setKeyword] = useState('');
  const [mentionMin, setMentionMin] = useState(0);
  const [blocklist, setBlocklist] = useState('');
  const [uniqueByUser, setUniqueByUser] = useState(true);
  const [excludePrevious, setExcludePrevious] = useState(true);
  const [results, setResults] = useState([]);
  const [lastAudit, setLastAudit] = useState(null);
  const [sourceMeta, setSourceMeta] = useState(null);
  const [loadedSource, setLoadedSource] = useState('');
  const [sourceInputDirty, setSourceInputDirty] = useState(false);
  const [candidateLoadError, setCandidateLoadError] = useState('');
  const [currentStatusId, setCurrentStatusId] = useState('');
  const [currentStatusUrl, setCurrentStatusUrl] = useState('');
  const [status, setStatus] = useState('等待载入候选。');
  const [statusTone, setStatusTone] = useState('neutral');
  const [progress, setProgress] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [phase, setPhase] = useState('');
  const [initialDrawHistoryState] = useState(() => readDrawHistoryState());
  const [drawHistory, setDrawHistory] = useState(initialDrawHistoryState.items);
  const [historyStorageAvailable, setHistoryStorageAvailable] = useState(initialDrawHistoryState.safeToPersist);
  const [historyQuery, setHistoryQuery] = useState('');
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [pendingReceipt, setPendingReceipt] = useState(null);
  const [syncingReceiptIds, setSyncingReceiptIds] = useState(() => new Set());
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState('overview');
  const [showGuide, setShowGuide] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackInitialCategory, setFeedbackInitialCategory] = useState('suggestion');
  const [legalDocument, setLegalDocument] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);
  const [activeTab, setActiveTab] = useState('home');
  const [showSourceEditor, setShowSourceEditor] = useState(false);
  const [showPrizeEditor, setShowPrizeEditor] = useState(false);
  const [showDrawConfirm, setShowDrawConfirm] = useState(false);
  const [confirmedSetup, setConfirmedSetup] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const [candidateQuery, setCandidateQuery] = useState('');
  const [candidateSegment, setCandidateSegment] = useState('eligible');
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [manualCookieOpen, setManualCookieOpen] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [motionPreference, setMotionPreference] = useState(initialMotionPreference);
  const [cooldownStorageAvailable, setCooldownStorageAvailable] = useState(canUseLocalStorage);
  const [, setFreshnessTick] = useState(0);
  const [apiBase, setApiBase] = useState(initialApiBase);
  const [apiBaseInput, setApiBaseInput] = useState(initialApiBaseInput);
  const [backendAddressEditorOpen, setBackendAddressEditorOpen] = useState(() => Boolean(initialApiBaseInput()));
  const [apiKey, setApiKey] = useState(initialApiKey);
  const { drawCount, drawCountStatus, refreshDrawCount, acceptDrawCount } = useDrawCount({ source, statusUrl, apiBase, apiKey });
  const { apiHealth, apiHealthDetail, apiAuthRequired, cookieHealth, cookieInfo, loadCookieStatus, checkConnection } = useBackendStatus({ apiBase, apiKey, onNotice: showStatus });
  const firstPrizeNameRef = useRef(null);
  const homeStatusInputRef = useRef(null);
  const candidateStatusInputRef = useRef(null);
  const sourceSheetStatusInputRef = useRef(null);
  const historyImportInputRef = useRef(null);
  const drawGuardRef = useRef(null);
  const drawTabLockRef = useRef(null);
  const repostLoadRef = useRef(null);
  const drawOperationRef = useRef(null);
  const drawSyncControllersRef = useRef(new Set());
  const receiptRetryIdsRef = useRef(new Set());
  const drawHistoryMutationRevisionRef = useRef(0);
  const taskRevisionRef = useRef(0);
  const candidateLoadRevisionRef = useRef(0);
  const noticeIdRef = useRef(0);
  const mountedRef = useRef(true);
  const selectedReceiptRef = useRef(null);
  const drawHistoryRef = useRef(drawHistory);
  const manualDrawSequenceRef = useRef(0);
  const candidateLoadStartRef = useRef(false);
  const drawStartRef = useRef(false);
  const manualFileReadRef = useRef(false);
  const capturingRef = useRef(false);
  const pendingCandidateLoadRef = useRef(null);
  const pendingSourceChangeRef = useRef('');
  const progressClearTimerRef = useRef(null);
  const historyStorageNoticeRef = useRef('');
  const historyStorageErrorRef = useRef(false);

  function invalidateDrawContext() {
    taskRevisionRef.current += 1;
    candidateLoadRevisionRef.current += 1;
  }

  function invalidateDrawHistoryMutations() {
    drawHistoryMutationRevisionRef.current += 1;
    for (const controller of drawSyncControllersRef.current) controller.abort();
    return drawHistoryMutationRevisionRef.current;
  }

  async function commitDrawHistoryMutation(updater, options = {}) {
    const revision = options.revision ?? drawHistoryMutationRevisionRef.current;
    let proposedItems = null;
    let result;
    try {
      result = await mutateDrawHistory(window.localStorage, (storedHistory) => {
        if (drawHistoryMutationRevisionRef.current !== revision) {
          throw DRAW_HISTORY_MUTATION_CANCELLED;
        }
        proposedItems = updater(storedHistory);
        return proposedItems;
      });
    } catch (error) {
      if (error === DRAW_HISTORY_MUTATION_CANCELLED) return { ok: false, cancelled: true, items: [] };
      result = {
        ok: false,
        items: [],
        reason: 'unavailable',
        recoveryProtected: false,
      };
    }
    if (drawHistoryMutationRevisionRef.current !== revision) {
      return { ...result, ok: false, cancelled: true };
    }

    const nextHistory = result.ok
      ? result.items
      : proposedItems || updater(drawHistoryRef.current);
    drawHistoryRef.current = nextHistory;
    setDrawHistory(nextHistory);
    if (currentStatusId) setHistoryUids(winnerIdsForStatus(nextHistory, currentStatusId));
    setHistoryStorageAvailable(result.ok);

    if (!result.ok) {
      const recoveryBlocked = Boolean(result.recoveryProtected || result.reason === 'recovery');
      if (!historyStorageErrorRef.current) {
        historyStorageErrorRef.current = true;
        showStatus(
          recoveryBlocked
            ? '检测到损坏的本机记录，但恢复副本写入失败。为避免覆盖原数据，本次未保存新记录；请先导出浏览器站点数据或清空本机记录。'
            : '本机存储空间不足，当前页面仍可查看结果，但刷新后可能无法保留全部记录。',
          'error',
          { title: recoveryBlocked ? '已保护原始记录' : '本机记录未完整保存' },
        );
      }
      return { ...result, items: nextHistory };
    }

    historyStorageErrorRef.current = false;
    if (proposedItems && result.items.length < proposedItems.length) {
      const noticeKey = `${proposedItems.length}:${result.items.length}`;
      if (historyStorageNoticeRef.current !== noticeKey) {
        historyStorageNoticeRef.current = noticeKey;
        showStatus(`本机空间有限，已保留最近 ${result.items.length} 条开奖记录。`, 'neutral', {
          popup: true,
          title: '记录已整理',
        });
      }
    }
    return result;
  }

  function isCurrentCandidateLoad(revision, operation = null) {
    return mountedRef.current
      && candidateLoadRevisionRef.current === revision
      && (!operation || repostLoadRef.current === operation);
  }

  function focusStatusInput() {
    const preferred = showSourceEditor
      ? sourceSheetStatusInputRef.current
      : activeTab === 'candidates'
        ? candidateStatusInputRef.current
        : homeStatusInputRef.current;
    preferred?.focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    taskRevisionRef.current += 1;
  }, [source, statusUrl, candidates]);

  useLayoutEffect(() => {
    selectedReceiptRef.current = selectedReceipt;
  }, [selectedReceipt]);

  useLayoutEffect(() => {
    drawHistoryRef.current = drawHistory;
  }, [drawHistory]);

  useLayoutEffect(() => {
    const next = nextManualDrawNumber(drawHistory);
    if (next !== null) {
      manualDrawSequenceRef.current = Math.max(manualDrawSequenceRef.current, next - 1);
    }
  }, [drawHistory]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      candidateLoadRevisionRef.current += 1;
      const guard = drawGuardRef.current;
      if (guard) releaseDrawGuard(window.localStorage, guard.scope, guard.token);
      drawTabLockRef.current?.release();
      drawOperationRef.current?.abort();
      for (const controller of drawSyncControllersRef.current) controller.abort();
      drawSyncControllersRef.current.clear();
      const repostLoad = repostLoadRef.current;
      if (repostLoad) {
        repostLoad.cancelIntent = true;
        if (repostLoad.cancelServer) {
          repostLoad.cancelServer();
          repostLoad.controller.abort();
        }
      }
      window.clearTimeout(progressClearTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const hasUnsavedManualList = source === 'manual' && sourceInputDirty && manualInput.trim();
    const hasMemoryOnlyResults = !historyStorageAvailable
      && drawHistory.some((receipt) => receipt.recordState === 'local');
    if (!isLoading && !isDrawing && !hasUnsavedManualList && !hasMemoryOnlyResults) return undefined;
    const warnBeforeLeaving = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [isDrawing, isLoading, manualInput, source, sourceInputDirty, historyStorageAvailable, drawHistory]);

  const normalizedPrizes = useMemo(() => prizes
    .map((prize, index) => ({
      ...prize,
      name: String(prize.name || '').trim(),
      count: Math.max(0, Math.floor(Number(prize.count || 0))),
      color: prize.color || COLORS[index % COLORS.length],
    }))
    .filter((prize) => prize.name && prize.count > 0), [prizes]);
  const totalSlots = normalizedPrizes.reduce((sum, prize) => sum + prize.count, 0);

  const rules = useMemo(() => {
    const blocked = new Set(blocklist.split(/\r?\n|,/).map((item) => item.trim().toLowerCase()).filter(Boolean));
    return {
      keyword: keyword.trim().toLowerCase(),
      mentionMin: normalizeMentionMin(mentionMin),
      uniqueByUser,
      excludePrevious,
      blocked,
    };
  }, [keyword, mentionMin, uniqueByUser, excludePrevious, blocklist]);

  const candidateEvaluations = useMemo(
    () => evaluateCandidateEligibility(candidates, rules, historyUids),
    [candidates, rules, historyUids],
  );
  const eligible = useMemo(
    () => candidateEvaluations.filter((entry) => entry.eligible).map((entry) => entry.candidate),
    [candidateEvaluations],
  );
  const eligibleUserCount = useMemo(() => countEligibleUsers(eligible), [eligible]);
  const candidateSummary = useMemo(
    () => summarizeCandidateEligibility(candidateEvaluations),
    [candidateEvaluations],
  );

  const winners = results.flatMap((item) => item.winners);
  const candidateSourceReady = Boolean(
    candidates.length
    && loadedSource === source
    && !sourceInputDirty
    && !candidateLoadError,
  );
  const drawSetupConfirmed = Boolean(
    candidateSourceReady
    && confirmedSetup
    && confirmedSetup.candidates === candidates
    && confirmedSetup.prizes === prizes
    && confirmedSetup.source === source
    && confirmedSetup.statusId === currentStatusId
    && confirmedSetup.statusUrl === currentStatusUrl
    && confirmedSetup.keyword === keyword
    && confirmedSetup.mentionMin === rules.mentionMin
    && confirmedSetup.blocklist === blocklist
    && confirmedSetup.uniqueByUser === uniqueByUser
    && confirmedSetup.excludePrevious === excludePrevious
    && confirmedSetup.eligibleCount === eligible.length,
  );
  const isBusy = isLoading || isDrawing;
  const cooldownPersistent = useMemo(() => {
    if (source === 'manual') return true;
    if (!cooldownStorageAvailable) return false;
    return drawCooldownStatus(window.localStorage, drawCooldownScope({
      source,
      statusId: currentStatusId,
      statusUrl: currentStatusUrl || statusUrl,
    })).persistent;
  }, [cooldownStorageAvailable, currentStatusId, currentStatusUrl, source, statusUrl]);

  function apiFetch(path, options = {}, baseOverride = apiBase) {
    return requestApi(path, options, { apiBase: baseOverride, apiKey });
  }
  function showStatus(message, tone = 'neutral', options = {}) {
    setStatus(message);
    setStatusTone(tone);
    if (tone === 'error' || options.popup) {
      setNotice({
        id: ++noticeIdRef.current,
        tone,
        title: options.title || (tone === 'error' ? '操作失败' : '提示'),
        message,
      });
    }
  }
  function dismissNotice() {
    setNotice(null);
  }
  function selectReceipt(receipt) {
    if (receipt) setPendingReceipt(null);
    setSelectedReceipt(receipt);
  }
  function refuseWhileBusy() {
    const drawBusy = isDrawing || drawStartRef.current;
    const candidateBusy = isLoading || candidateLoadStartRef.current;
    if (!drawBusy && !candidateBusy) return false;
    showStatus(drawBusy ? '开奖正在进行，请等待结果完成。' : '候选正在载入，请等待载入完成。');
    return true;
  }
  function openSettings(target = 'overview') {
    const customBase = isPresetApiBase(apiBase) ? '' : apiBase;
    setApiBaseInput(customBase);
    setBackendAddressEditorOpen(Boolean(customBase));
    setSettingsTarget(target);
    setShowSettings(true);
  }
  async function openLegalDocument(key) {
    setShowSettings(false);
    setShowSourceEditor(false);
    try {
      const documents = await loadLegalDocuments();
      setLegalDocument(documents[key] || null);
    } catch {
      showStatus('法律文本加载失败，请检查网络后重试。', 'error');
    }
  }
  function openFeedback(category = 'suggestion') {
    setLegalDocument(null);
    setFeedbackInitialCategory(category);
    setShowFeedback(true);
  }
  async function submitFeedback(payload) {
    try {
      const response = await apiFetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(normalizeFeedbackSubmission(payload)),
      });
      const data = await readApiResponse(response, '反馈服务');
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || `提交失败：${response.status}`);
      }
      setStatus('反馈已提交。');
      setStatusTone('success');
      return data;
    } catch (error) {
      throw error instanceof Error ? error : new Error('反馈暂时未能送达，请稍后再试。');
    }
  }
  function changeSource(value, options = {}) {
    if (refuseWhileBusy()) return false;
    if (value === source) {
      return true;
    }
    if (hasCurrentResultToProtect() && !options.confirmed) {
      pendingSourceChangeRef.current = value;
      setConfirmAction({
        kind: 'replace-source',
        title: '切换候选来源？',
        message: '当前已有开奖结果或尚未同步的结果。继续切换会清除当前结果，但不会删除服务器已保存的开奖记录。',
        confirmLabel: '切换并清除',
      });
      return false;
    }
    invalidateDrawContext();
    setSource(value);
    setCandidates([]);
    setHistoryUids(new Set());
    setSourceMeta(null);
    setLoadedSource('');
    setSourceInputDirty(false);
    setCandidateLoadError('');
    setCurrentStatusId('');
    setCurrentStatusUrl('');
    acceptDrawCount(null, { idle: true });
    clearResult();
    return true;
  }
  function selectCandidateSource(value) {
    if (!changeSource(value)) return;
    setShowSourceEditor(true);
  }
  function updateStatusInput(value) {
    if (value !== statusUrl) invalidateDrawContext();
    setStatusUrl(value);
    setSourceInputDirty(true);
    setCandidateLoadError('');
    setConfirmedSetup(null);
  }
  function updateManualInput(value) {
    if (value !== manualInput) invalidateDrawContext();
    setManualInput(value);
    setSourceInputDirty(true);
    setCandidateLoadError('');
    setConfirmedSetup(null);
  }
  function applyFilterDraft(draft) {
    if (refuseWhileBusy()) return false;
    const nextKeyword = String(draft?.keyword ?? '');
    const nextMentionMin = normalizeMentionMin(draft?.mentionMin);
    const nextBlocklist = String(draft?.blocklist ?? '');
    const nextUniqueByUser = draft?.uniqueByUser !== false;
    const nextExcludePrevious = draft?.excludePrevious === true;
    const changed = keyword !== nextKeyword
      || normalizeMentionMin(mentionMin) !== nextMentionMin
      || blocklist !== nextBlocklist
      || uniqueByUser !== nextUniqueByUser
      || excludePrevious !== nextExcludePrevious;

    setKeyword(nextKeyword);
    setMentionMin(nextMentionMin);
    setBlocklist(nextBlocklist);
    setUniqueByUser(nextUniqueByUser);
    setExcludePrevious(nextExcludePrevious);
    if (changed) {
      setConfirmedSetup(null);
      clearResult('筛选规则已更新，请重新开奖。');
    }
    return true;
  }
  function updateApiBaseInput(value) {
    setApiBaseInput(value);
  }
  function updateApiBase(value) {
    const cleaned = cleanApiBase(value);
    setApiBaseInput(cleaned);
    setApiBase(cleaned);
  }
  function commitApiBase(value = apiBaseInput) {
    const raw = String(value || '').trim();
    const cleaned = cleanApiBase(raw || presetApiBase());
    if (!cleaned) {
      setApiBaseInput('');
      setApiBase('');
      return '';
    }
    if (!isTrustedApiBase(cleaned)) {
      showStatus('后端接口地址不在可信列表里，请使用预置服务或本机地址。', 'error', { title: '地址不可用' });
      return null;
    }
    setApiBaseInput(isPresetApiBase(cleaned) ? '' : cleaned);
    setApiBase(cleaned);
    return cleaned;
  }
  function openBackendAddressEditor() {
    setApiBaseInput(isPresetApiBase(apiBase) ? '' : apiBase);
    setBackendAddressEditorOpen(true);
  }
  function saveBackendAddress() {
    const saved = commitApiBase();
    if (saved === null) return;
    setBackendAddressEditorOpen(false);
    showStatus(saved ? '已切换到自定义后端地址。' : '已使用预置服务地址。', 'success');
  }
  function usePresetBackend() {
    const restored = commitApiBase(presetApiBase());
    if (restored === null) return;
    setBackendAddressEditorOpen(false);
    setApiBaseInput('');
    showStatus('已使用预置服务地址。', 'success');
  }
  function shouldForceCandidateRefresh(value, sourceValue = source) {
    const target = String(value || '').trim();
    const loadedUrl = String(sourceMeta?.statusUrl || '').trim();
    const loadedId = String(sourceMeta?.statusId || '').trim();
    return Boolean(
      candidates.length
      && loadedSource === sourceValue
      && !sourceInputDirty
      && (target === loadedUrl || target === loadedId || (loadedId && target.includes(loadedId))),
    );
  }

  function prepareCandidateLoad(sourceValue, statusValue) {
    const nextSource = sourceValue || source;
    const nextStatusUrl = String(statusValue || '').trim();
    const sameLoadedContext = source === nextSource
      && loadedSource === nextSource
      && !sourceInputDirty
      && (nextSource === 'manual' || nextStatusUrl === statusUrl.trim());

    invalidateDrawContext();
    setSource(nextSource);
    setConfirmedSetup(null);
    setCandidateLoadError('');
    if (nextSource !== 'manual') {
      setStatusUrl(nextStatusUrl);
      setSourceInputDirty(true);
    }

    if (!sameLoadedContext) {
      setCandidates([]);
      setHistoryUids(new Set());
      setSourceMeta(null);
      setLoadedSource('');
      setCurrentStatusId('');
      setCurrentStatusUrl('');
      acceptDrawCount(null, { idle: true });
    }
  }

  function showInvalidStatusReference() {
    focusStatusInput();
    showStatus('请粘贴微博正文链接、mid 或 bid。', 'neutral', {
      popup: true,
      title: '微博链接格式不正确',
    });
  }

  function showClipboardReadError(error) {
    focusStatusInput();
    const emptyClipboard = error?.message === 'clipboard-empty';
    showStatus(
      emptyClipboard
        ? '剪贴板中没有内容，请先复制微博正文链接、mid 或 bid。'
        : '无法读取剪贴板，请在输入框中手动粘贴微博正文链接、mid 或 bid。',
      'neutral',
      { popup: true, title: emptyClipboard ? '剪贴板为空' : '无法读取剪贴板' },
    );
  }

  function hasCurrentResultToProtect() {
    return Boolean(
      results.length
      || pendingReceipt?.results?.some((group) => group.winners?.length),
    );
  }

  function safeLoadCandidates(options = {}) {
    if (hasCurrentResultToProtect() && !options.confirmed) {
      requestCandidateReplacement({ ...options });
      return;
    }
    const {
      confirmed: _confirmed,
      prepareSource,
      prepareStatusUrl,
      ...loadOptions
    } = options;
    if (prepareSource) prepareCandidateLoad(prepareSource, prepareStatusUrl);
    loadCandidates(loadOptions).catch(() => {});
  }
  function requestCandidateReplacement(operation, action = {}) {
    pendingCandidateLoadRef.current = operation;
    setConfirmAction({
      kind: 'replace-candidates',
      title: action.title || '替换当前候选？',
      message: action.message || '当前已有开奖结果或尚未同步的结果。继续载入会清除当前结果，但不会删除服务器已保存的开奖记录。',
      confirmLabel: action.confirmLabel || '替换并载入',
    });
  }
  async function pasteAndLoadCandidates() {
    if (isLoading || isDrawing || candidateLoadStartRef.current || drawStartRef.current) return;
    const existingValue = statusUrl.trim();
    if (existingValue) {
      if (!isWeiboStatusReference(existingValue)) {
        showInvalidStatusReference();
        return;
      }
      const forceRefresh = shouldForceCandidateRefresh(existingValue, 'mobile');
      safeLoadCandidates({
        jumpAfterLoad: false,
        sourceOverride: 'mobile',
        statusUrlOverride: existingValue,
        forceRefresh,
        prepareSource: 'mobile',
        prepareStatusUrl: existingValue,
      });
      return;
    }
    let pastedValue;
    let clipboardRevision;
    try {
      if (!navigator.clipboard?.readText) throw new Error('clipboard-unavailable');
      clipboardRevision = candidateLoadRevisionRef.current;
      pastedValue = (await navigator.clipboard.readText()).trim();
    } catch (error) {
      showClipboardReadError(error);
      return;
    }
    if (!pastedValue) {
      showClipboardReadError(new Error('clipboard-empty'));
      return;
    }
    if (!mountedRef.current || clipboardRevision !== candidateLoadRevisionRef.current) return;
    if (candidateLoadStartRef.current || drawStartRef.current) {
      showStatus('当前操作正在进行，请稍候再试。');
      return;
    }
    if (!isWeiboStatusReference(pastedValue)) {
      showInvalidStatusReference();
      return;
    }
    const forceRefresh = shouldForceCandidateRefresh(pastedValue, 'mobile');
    safeLoadCandidates({
      jumpAfterLoad: false,
      sourceOverride: 'mobile',
      statusUrlOverride: pastedValue,
      forceRefresh,
      prepareSource: 'mobile',
      prepareStatusUrl: pastedValue,
    });
  }
  function clearResult(message) {
    if (isBusy) return false;
    invalidateDrawContext();
    if (message && results.length) showStatus(message);
    setResults([]);
    setLastAudit(null);
    setSelectedReceipt(null);
    setPendingReceipt(null);
    return true;
  }
  async function applySettingsAction(kind) {
    if (refuseWhileBusy()) return;
    if (kind === 'replace-candidates') {
      const pendingLoad = pendingCandidateLoadRef.current;
      pendingCandidateLoadRef.current = null;
      if (!pendingLoad) return;
      if (pendingLoad.operation === 'append-manual') {
        applyManualAdditions(pendingLoad.additions, pendingLoad.reachedLimit);
        return;
      }
      if (pendingLoad.operation === 'import-manual-file') {
        applyManualFileImport(pendingLoad.text, pendingLoad.fileName);
        return;
      }
      safeLoadCandidates({ ...pendingLoad, confirmed: true });
      return;
    }
    if (kind === 'replace-source') {
      const nextSource = pendingSourceChangeRef.current;
      pendingSourceChangeRef.current = '';
      if (nextSource) changeSource(nextSource, { confirmed: true });
      return;
    }
    if (kind === 'current-draw') {
      setCandidates([]);
      setHistoryUids(new Set());
      setConfirmedSetup(null);
      setSourceMeta(null);
      setLoadedSource('');
      setCandidateLoadError('');
      setSourceInputDirty(Boolean(source === 'manual' ? manualInput.trim() : statusUrl.trim()));
      setCurrentStatusId('');
      setCurrentStatusUrl('');
      clearResult();
      showStatus('已清空当前候选和结果。', 'success', { popup: true, title: '已清空' });
      return;
    }
    if (kind === 'local-history') {
      invalidateDrawHistoryMutations();
      let historyCleared;
      try {
        historyCleared = await withDrawHistoryLock(
          () => clearDrawHistoryStorage(window.localStorage),
        );
      } catch {
        historyCleared = { ok: false, reason: 'unavailable' };
      }
      const cooldownCleared = clearDrawCooldownStorage(window.localStorage);
      if (historyCleared.ok) {
        const emptyHistory = [];
        drawHistoryRef.current = emptyHistory;
        setDrawHistory(emptyHistory);
        setHistoryUids(new Set());
        setConfirmedSetup(null);
        setHistoryStorageAvailable(true);
        historyStorageErrorRef.current = false;
      }
      if (!historyCleared.ok || !cooldownCleared.ok) {
        showStatus('部分本机抽奖数据未能清除，请检查浏览器存储权限后重试。', 'error', { title: '清理未完成' });
        return;
      }
      showStatus('已清空本机开奖记录、恢复副本和防重复状态。', 'success', { popup: true, title: '已清空' });
    }
  }
  function jumpToPrizeSettings() {
    setShowPrizeEditor(true);
  }
  function ensurePrizeSettingsReady() {
    if (!normalizedPrizes.length || totalSlots < 1) {
      showStatus('请先填写至少一个奖项名称和中奖人数。', 'error');
      jumpToPrizeSettings();
      return false;
    }
    return true;
  }
  function confirmDrawSetup() {
    if (refuseWhileBusy()) return false;
    if (!ensurePrizeSettingsReady()) return false;
    if (prizes.length > MAX_DRAW_RESULT_GROUPS) {
      showStatus(`单次最多设置 ${MAX_DRAW_RESULT_GROUPS} 个奖项。`, 'error');
      return false;
    }
    if (!candidateSourceReady) {
      setShowSourceEditor(true);
      showStatus('来源或链接已更改，请先重新载入候选。', 'error');
      return false;
    }
    if (!eligible.length) {
      showStatus('当前没有可抽候选，请先载入名单或调整筛选规则。', 'error');
      return false;
    }
    if (totalSlots > eligibleUserCount) {
      showStatus(`中奖总人数 ${totalSlots} 不能超过可抽人数 ${eligibleUserCount}。`, 'error');
      return false;
    }
    if (totalSlots > MAX_DRAW_WINNERS) {
      showStatus(`单次开奖最多设置 ${MAX_DRAW_WINNERS} 个中奖名额。`, 'error');
      return false;
    }
    setConfirmedSetup({
      candidates,
      prizes,
      source,
      statusId: currentStatusId,
      statusUrl: currentStatusUrl,
      keyword,
      mentionMin: rules.mentionMin,
      blocklist,
      uniqueByUser,
      excludePrevious,
      eligibleCount: eligible.length,
    });
    showStatus('抽奖设置已确认，请核对本轮信息后开奖。', 'success');
    return true;
  }
  function requestDraw() {
    if (refuseWhileBusy()) return;
    if (source === 'manual' && manualDrawLimitReached) {
      showStatus('手动名单开奖次数已达到浏览器可记录的上限，请先导出并清理本机记录。', 'error');
      return;
    }
    if (pendingReceipt) {
      showStatus('本次结果正在准备，请稍候。', 'neutral', { popup: true, title: '请稍候' });
      return;
    }
    if (candidates.length && !candidateSourceReady) {
      setShowSourceEditor(true);
      showStatus('来源或链接已更改，请先重新载入候选。');
      return;
    }
    if (!eligible.length) {
      setShowFilters(true);
      return;
    }
    if (!drawSetupConfirmed) {
      setShowPrizeEditor(true);
      return;
    }
    setShowDrawConfirm(true);
  }
  function confirmAndDraw(options = {}) {
    if (refuseWhileBusy()) return;
    if (!drawSetupConfirmed) {
      setShowDrawConfirm(false);
      setShowPrizeEditor(true);
      showStatus('抽奖设置已变化，请重新确认。', 'error');
      return;
    }
    if (!options.practice) {
      const scope = drawCooldownScope({
        source,
        statusId: currentStatusId,
        statusUrl: currentStatusUrl || statusUrl,
      });
      const cooldown = drawCooldownStatus(window.localStorage, scope);
      if (cooldown.blocked) {
        const message = cooldown.reason === 'running'
          ? '本链接正在当前浏览器的另一个页面开奖，请稍后再试。'
          : `本链接刚刚完成开奖，请 ${Math.max(1, Math.ceil(cooldown.remainingMs / 1000))} 秒后再试。`;
        showStatus(message, 'error', { title: '请稍后开奖' });
        return;
      }
    }
    const startDraw = () => drawAll({ practice: Boolean(options.practice) });
    if (typeof options.close === 'function') {
      options.close(startDraw);
    } else {
      setShowDrawConfirm(false);
      startDraw();
    }
  }
  function updatePrize(index, patch) {
    if (refuseWhileBusy()) return;
    const current = prizes[index];
    if (!current) return;
    const changed = Object.entries(patch).some(([key, value]) => !Object.is(current[key], value));
    if (!changed) return;
    setPrizes((previous) => previous.map((prize, prizeIndex) => (
      prizeIndex === index ? { ...prize, ...patch } : prize
    )));
    clearResult('奖项已更新，请重新开奖。');
  }
  function updatePrizeCount(index, nextCount) {
    if (String(nextCount) === '') {
      updatePrize(index, { count: '' });
      return;
    }
    const count = Math.floor(Number(nextCount));
    if (!Number.isFinite(count)) return;
    updatePrize(index, { count: Math.min(MAX_DRAW_WINNERS, Math.max(1, count)) });
  }
  function commitPrizeCount(index) {
    const count = Math.floor(Number(prizes[index]?.count));
    if (Number.isFinite(count) && count >= 1) return;
    updatePrize(index, { count: 1 });
  }
  function addPrize() {
    if (refuseWhileBusy()) return;
    if (prizes.length >= MAX_DRAW_RESULT_GROUPS) {
      showStatus(`单次最多设置 ${MAX_DRAW_RESULT_GROUPS} 个奖项。`, 'error');
      return;
    }
    setPrizes((previous) => [...previous, defaultPrize(previous.length, 1)]);
    clearResult('奖项已更新，请重新开奖。');
  }
  function removePrize(index) {
    if (refuseWhileBusy()) return;
    if (prizes.length <= 1) {
      showStatus('至少保留一个奖项。', 'error');
      return;
    }
    setPrizes((previous) => previous.filter((_, prizeIndex) => prizeIndex !== index));
    clearResult('奖项已更新，请重新开奖。');
  }

  async function testApiConnection() {
    const targetBase = backendAddressEditorOpen ? commitApiBase() : apiBase;
    if (targetBase !== null) await checkConnection(targetBase, { notify: true });
  }

  useEffect(() => {
    const cleaned = cleanApiBase(apiBase);
    const custom = cleaned && isTrustedApiBase(cleaned) && !isPresetApiBase(cleaned) ? cleaned : '';
    writeStoredValue('weibo-draw-api-base', custom);
  }, [apiBase]);
  useEffect(() => {
    writeStoredValue('weibo-draw-api-key', apiKey.trim());
  }, [apiKey]);
  useEffect(() => {
    writeStoredValue('weibo-draw-motion', motionPreference);
  }, [motionPreference]);
  useEffect(() => {
    if (!sourceMeta?.loadedAt) return undefined;
    const timer = window.setInterval(() => setFreshnessTick((tick) => tick + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [sourceMeta?.loadedAt]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadLegalDocuments().catch(() => {});
    }, 4000);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const syncDrawHistory = (event) => {
      if (event.storageArea !== window.localStorage || event.key !== DRAW_HISTORY_KEY) return;
      if (event.newValue === null) invalidateDrawHistoryMutations();
      const state = readDrawHistoryState(window.localStorage);
      setHistoryStorageAvailable(state.safeToPersist);
      if (!state.safeToPersist) return;
      historyStorageErrorRef.current = false;
      drawHistoryRef.current = state.items;
      setDrawHistory(state.items);
      if (currentStatusId) setHistoryUids(winnerIdsForStatus(state.items, currentStatusId));
    };
    window.addEventListener('storage', syncDrawHistory);
    return () => window.removeEventListener('storage', syncDrawHistory);
  }, [currentStatusId]);
  useEffect(() => {
    if (!pendingReceipt || isDrawing || selectedReceipt) return undefined;
    const reducedMotion = shouldReduceMotion(motionPreference);
    const receipt = pendingReceipt;
    const timer = window.setTimeout(() => {
      if (selectedReceiptRef.current) return;
      setSelectedReceipt(receipt);
      setPendingReceipt((current) => current?.id === receipt.id ? null : current);
    }, reducedMotion ? 220 : 680);
    return () => window.clearTimeout(timer);
  }, [pendingReceipt, isDrawing, motionPreference, selectedReceipt]);

  async function fetchRepostsWithProgress(payload, operation) {
    setProgress({ percent: 3, message: '创建抓取任务' });
    const startResponse = await apiFetch('/api/weibo/reposts/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const started = await readApiResponse(startResponse, '候选载入服务');
    if (!started.ok) throw apiError(started.error || '抓取任务创建失败', startResponse.status);
    if (!started.jobId && !(started.status === 'done' && started.result)) {
      throw new Error('抓取任务创建失败：服务器没有返回任务编号');
    }
    operation.jobId = started.jobId || '';
    operation.readToken = started.readToken || '';
    operation.cancelToken = started.cancelToken || '';
    if (operation.jobId && operation.cancelToken) {
      operation.cancelServer = () => {
        if (operation.cancelRequested) return Promise.resolve();
        operation.cancelRequested = true;
        return apiFetch(`/api/weibo/reposts/jobs/${encodeURIComponent(operation.jobId)}`, {
          method: 'DELETE',
          headers: { 'x-job-cancel-token': operation.cancelToken },
          keepalive: true,
        }).then((response) => readApiResponse(response, '候选取消服务')).catch(() => {});
      };
    }
    if (operation.cancelIntent) {
      await operation.cancelServer?.();
      operation.controller.abort();
      throw new DOMException('候选载入已取消', 'AbortError');
    }
    let lastProgress = started.progress || { percent: 3, message: '任务已创建' };
    if (started.delivery === 'shared-running') {
      lastProgress = { ...lastProgress, message: `已合并到同一微博的载入任务 · ${lastProgress.message}` };
    } else if (started.delivery === 'recent-snapshot') {
      lastProgress = { ...lastProgress, message: '正在读取刚刚载入的候选快照' };
    }
    const deadline = Date.now() + REPOST_JOB_TIMEOUT_MS;
    let reconnectAttempts = 0;
    setProgress(lastProgress);
    if (started.status === 'done' && started.result) {
      return {
        ...started.result,
        meta: { ...started.result.meta, delivery: started.delivery || 'fresh' },
      };
    }
    while (true) {
      if (operation.controller.signal.aborted) throw new DOMException('候选载入已取消', 'AbortError');
      if (Date.now() > deadline) {
        operation.cancelServer?.();
        throw new Error('抓取任务等待时间过长，服务器已停止本次任务。');
      }
      await sleep(REPOST_JOB_POLL_MS, operation.controller.signal);
      let response;
      let json;
      try {
        response = await apiFetch(`/api/weibo/reposts/jobs/${encodeURIComponent(started.jobId)}`, {
          headers: { 'x-job-read-token': operation.readToken },
          signal: operation.controller.signal,
        });
        json = await readApiResponse(response, '候选载入服务');
        if (!json.ok) {
          throw apiError(json.error || '抓取进度读取失败', response.status);
        }
        reconnectAttempts = 0;
      } catch (error) {
        if (operation.controller.signal.aborted || error?.name === 'AbortError') throw error;
        const statusCode = Number(error?.status || response?.status || 0);
        const retryable = !statusCode || statusCode === 429 || statusCode >= 500;
        if (!retryable || reconnectAttempts >= REPOST_JOB_RECONNECT_ATTEMPTS) throw error;
        reconnectAttempts += 1;
        setProgress({
          ...lastProgress,
          message: `连接暂时中断，正在重新读取任务（${reconnectAttempts}/${REPOST_JOB_RECONNECT_ATTEMPTS}）`,
        });
        await sleep(REPOST_JOB_RECONNECT_BASE_MS * reconnectAttempts, operation.controller.signal);
        continue;
      }
      lastProgress = json.progress || lastProgress;
      setProgress(lastProgress);
      if (json.status === 'done') {
        return {
          ...json.result,
          meta: { ...json.result?.meta, delivery: started.delivery || json.delivery || 'fresh' },
        };
      }
      if (json.status === 'cancelled') throw new DOMException('候选载入已取消', 'AbortError');
      if (json.status === 'error') throw new Error(json.error || lastProgress.message || '抓取失败');
    }
  }

  function cancelCandidateLoad() {
    const operation = repostLoadRef.current;
    if (!operation || operation.cancelIntent || operation.controller.signal.aborted) return;
    candidateLoadRevisionRef.current += 1;
    operation.cancelIntent = true;
    if (operation.cancelServer) {
      operation.cancelServer();
      operation.controller.abort();
    }
    setCandidateLoadError('候选载入已取消，请重新载入后再开奖。');
    setProgress((current) => ({
      percent: current?.percent || 0,
      message: '正在取消候选载入',
    }));
    showStatus('候选载入已取消，请重新载入后再开奖。');
  }

  async function loadCandidates(options = {}) {
    if (candidateLoadStartRef.current) {
      showStatus('候选正在载入，请稍候或先取消当前任务。');
      return null;
    }
    if (isDrawing || drawStartRef.current) {
      refuseWhileBusy();
      return null;
    }
    const {
      jumpAfterLoad = true,
      sourceOverride = source,
      statusUrlOverride = statusUrl,
      forceRefresh = false,
    } = options;
    const activeOperation = repostLoadRef.current;
    if (activeOperation && !activeOperation.controller.signal.aborted) {
      showStatus('候选正在载入，请稍候或先取消当前任务。');
      return null;
    }
    candidateLoadStartRef.current = true;
    setConfirmedSetup(null);
    setCandidateLoadError('');
    const effectiveSource = sourceOverride;
    const effectiveStatusUrl = String(statusUrlOverride || '').trim();
    window.clearTimeout(progressClearTimerRef.current);
    setProgress(null);
    const operation = effectiveSource === 'manual'
      ? null
      : {
        controller: new AbortController(),
        jobId: '',
        readToken: '',
        cancelToken: '',
        cancelServer: null,
        cancelRequested: false,
        cancelIntent: false,
      };
    if (operation) repostLoadRef.current = operation;
    setIsLoading(true);
    clearResult();
    const loadRevision = ++candidateLoadRevisionRef.current;
    try {
      if (effectiveSource === 'manual') {
        const parsed = parseManualInput(manualInput);
        if (!parsed.length) throw new Error('请先粘贴或导入候选名单。');
        const freshHistory = new Set();
        const manualMeta = { provider: 'manual', loadedAt: new Date().toISOString() };
        setCandidates(parsed);
        setCurrentStatusId('');
        setCurrentStatusUrl('');
        acceptDrawCount(null, { idle: true });
        setSourceMeta(manualMeta);
        setLoadedSource('manual');
        setSourceInputDirty(false);
        setCandidateLoadError('');
        setHistoryUids(freshHistory);
        showStatus(`已导入 ${parsed.length} 位候选用户，请确认奖项设置。`, 'success');
        if (jumpAfterLoad) jumpToPrizeSettings();
        return {
          candidates: parsed,
          eligible: eligibleCandidates(parsed, rules, freshHistory),
          statusId: '',
          statusUrl: '',
          sourceMeta: manualMeta,
        };
      }
      if (!effectiveStatusUrl) throw new Error('请先粘贴微博正文链接、mid 或 bid。');
      if (effectiveSource === 'official' && !accessToken.trim()) throw new Error('请先填写微博官方访问令牌。');
      setStatusUrl(effectiveStatusUrl);
      showStatus(effectiveSource === 'mobile'
        ? '正在通过服务器登录态读取微博转发；不可用时再尝试备用 Cookie。'
        : '正在通过微博官方接口读取当前接口可见的转发。');
      const json = await fetchRepostsWithProgress({
        source: effectiveSource,
        statusUrl: effectiveStatusUrl,
        accessToken,
        mobileCookie: effectiveSource === 'mobile' ? mobileCookie : '',
        forceRefresh,
      }, operation);
      if (!isCurrentCandidateLoad(loadRevision, operation)) return null;
      if (!json.ok) throw new Error(json.error || '微博数据拉取失败');
      validateRepostResult(json);
      const loadedCandidates = json.candidates;
      const loadedStatusId = json.statusId || '';
      const freshHistory = winnerIdsForStatus(drawHistoryRef.current, loadedStatusId);
      setCandidates(loadedCandidates);
      setCurrentStatusId(loadedStatusId);
      setCurrentStatusUrl(json.statusUrl || effectiveStatusUrl);
      acceptDrawCount(json.drawCount, { source: effectiveSource, statusUrl: effectiveStatusUrl });
      setSourceMeta({ ...json.meta, statusId: json.statusId, statusUrl: json.statusUrl });
      setLoadedSource(effectiveSource);
      setSourceInputDirty(false);
      setCandidateLoadError('');
      setHistoryUids(freshHistory);
      if (effectiveSource === 'mobile' && mountedRef.current) loadCookieStatus(false).catch(() => {});
      const deliveryText = json.meta?.delivery === 'recent-snapshot'
        ? '已复用刚刚完成的候选快照。'
        : json.meta?.delivery === 'shared-running'
          ? '本次与同一微博的载入任务合并完成。'
          : '';
      const headText = Number(json.meta?.headAddedCount || 0) > 0
        ? `完成前补入 ${Number(json.meta.headAddedCount)} 条新转发。`
        : json.meta?.headReconciled
          ? '完成前已复核最新转发。'
          : '';
      showStatus(`已载入 ${json.candidates?.length || 0} 条可见转发。${deliveryText}${headText}请确认奖项后开奖。`, 'success');
      if (jumpAfterLoad) jumpToPrizeSettings();
      if (mountedRef.current && effectiveSource === 'mobile') setMobileCookie('');
      if (mountedRef.current && effectiveSource === 'official') setAccessToken('');
      return {
        candidates: loadedCandidates,
        eligible: eligibleCandidates(loadedCandidates, rules, freshHistory),
        statusId: json.statusId || '',
        statusUrl: json.statusUrl || effectiveStatusUrl,
        sourceMeta: { ...json.meta, statusId: json.statusId, statusUrl: json.statusUrl },
      };
    } catch (error) {
      if (!isCurrentCandidateLoad(loadRevision, operation)) return null;
      operation?.cancelServer?.();
      if (operation?.controller.signal.aborted || error?.name === 'AbortError') {
        const message = '候选载入已取消，请重新载入后再开奖。';
        setCandidateLoadError(message);
        showStatus(message);
        return null;
      }
      const message = error?.status === 401
        ? '该后端要求访问密钥，请到“设置 → 后端连接”填写后重新载入。'
        : error?.message || '微博数据拉取失败。';
      setCandidateLoadError(message);
      showStatus(message, 'error');
      throw error;
    } finally {
      const ownsLoad = !operation || repostLoadRef.current === operation;
      if (ownsLoad) {
        candidateLoadStartRef.current = false;
      }
      if (ownsLoad) {
        repostLoadRef.current = null;
        if (mountedRef.current) {
          setIsLoading(false);
          progressClearTimerRef.current = window.setTimeout(() => {
            if (mountedRef.current) setProgress(null);
          }, 1200);
        }
      }
    }
  }

  function cancelDraw() {
    const operation = drawOperationRef.current;
    if (!isDrawing || !operation || operation.signal.aborted) return;
    setPhase('正在停止开奖');
    operation.abort();
  }

  async function drawAll({ practice = false } = {}) {
    if (drawStartRef.current || drawOperationRef.current || isDrawing || isLoading || pendingReceipt) return;
    if (!ensurePrizeSettingsReady()) return;
    if (!drawSetupConfirmed) {
      setShowPrizeEditor(true);
      showStatus('请先确认本轮奖项设置。');
      return;
    }
    const drawCandidates = candidates;
    const drawEligible = eligible;
    const drawContext = { statusId: currentStatusId, statusUrl: currentStatusUrl, sourceMeta };
    const taskRevision = taskRevisionRef.current;
    if (totalSlots > eligibleUserCount) {
      showStatus(`中奖总人数 ${totalSlots} 不能超过可抽人数 ${eligibleUserCount}。`, 'error');
      return;
    }
    if (!window.isSecureContext || !window.crypto?.subtle) {
      showStatus('当前页面不是安全上下文（需要 HTTPS 或 localhost），浏览器已停用加密能力，无法开奖。请改用 https:// 或本机地址打开后重试。', 'error', { title: '无法开奖' });
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    drawOperationRef.current = controller;
    drawStartRef.current = true;
    let tabLock = null;
    let guard = null;
    let drawCompleted = false;
    try {
      const scope = drawCooldownScope({
        source,
        statusId: drawContext.statusId,
        statusUrl: drawContext.statusUrl || statusUrl,
      });
      tabLock = await acquireDrawTabLock(scope);
      throwIfAborted(signal);
      if (!tabLock.ok) {
        showStatus('本链接正在当前浏览器的另一个页面开奖，请稍后再试。', 'error', { title: '请稍后开奖' });
        return;
      }
      drawTabLockRef.current = tabLock;
      guard = practice
        ? { ok: true, persistent: false, scope, token: null }
        : acquireDrawGuard(window.localStorage, scope);
      if (!practice && source !== 'manual') setCooldownStorageAvailable(guard.persistent !== false);
      if (!guard.ok) {
        const message = guard.reason === 'running'
          ? '本链接正在当前浏览器的另一个页面开奖，请稍后再试。'
          : `本链接刚刚完成开奖，请 ${Math.max(1, Math.ceil(guard.remainingMs / 1000))} 秒后再试。`;
        showStatus(message, 'error', { title: '请稍后开奖' });
        return;
      }
      drawGuardRef.current = practice ? null : guard;
      setIsDrawing(true);
      setResults([]);
      rollingStore.set(null);

      const reducedMotion = shouldReduceMotion(motionPreference);
      const seed = randomSeedHex();
      const candidateDigest = await digestCandidates(drawEligible);
      throwIfAborted(signal);
      const pool = uniqueWinnerPool(await seededShuffle(drawEligible, `${seed}:${candidateDigest}`));
      throwIfAborted(signal);
      const rollingPool = [];
      const rollingSeen = new Set();
      const avatarCandidates = [
        ...pool.slice(0, Math.min(totalSlots, 8)),
        ...pool.filter((candidate) => safeAvatarUrl(candidate.avatar)),
        ...pool,
      ];
      for (const candidate of avatarCandidates) {
        const key = candidateIdentity(candidate);
        if (!key || rollingSeen.has(key)) continue;
        rollingSeen.add(key);
        rollingPool.push(candidate);
        if (rollingPool.length >= 18) break;
      }
      await warmDrawAvatars(rollingPool, apiBase, signal);
      throwIfAborted(signal);
      const all = [];
      let offset = 0;
      for (let prizeIndex = 0; prizeIndex < normalizedPrizes.length; prizeIndex += 1) {
        const prize = normalizedPrizes[prizeIndex];
        const prizeWinners = pool.slice(offset, offset + Number(prize.count || 0));
        offset += Number(prize.count || 0);
        setPhase(`正在抽取 ${prize.name}`);
        showStatus(`正在抽取 ${prize.name}。`);
        const baseDuration = prizeIndex === 0 ? 1700 : 1200;
        const duration = reducedMotion
          ? 80
          : Math.min(2100, baseDuration + Number(prize.count || 1) * 80);
        if (!reducedMotion) {
          const startedAt = Date.now();
          let tick = 0;
          while (Date.now() - startedAt < duration) {
            const index = rollingPool.length
              ? (prizeIndex * 19 + tick * 7 + Math.floor(tick / 3)) % rollingPool.length
              : 0;
            rollingStore.set(rollingPool[index] || null);
            await sleep(88, signal);
            tick += 1;
          }
        }
        rollingStore.set(prizeWinners.at(-1) || null);
        setPhase(`${prize.name} 开奖完成`);
        if (!reducedMotion) await sleep(360, signal);
        all.push({ prize, winners: prizeWinners });
        setResults([...all]);
        if (prizeIndex < normalizedPrizes.length - 1 && !reducedMotion) await sleep(260, signal);
      }
      throwIfAborted(signal);
      const audit = {
        practice,
        seed,
        drawnAt: new Date().toISOString(),
        statusId: drawContext.statusId || currentStatusId,
        statusUrl: drawContext.statusUrl || currentStatusUrl,
        rules: {
          filters: {
            keyword,
            mentionMin: rules.mentionMin,
            uniqueByUser,
            excludePrevious,
            blocklistCount: rules.blocked.size,
          },
          prizes: normalizedPrizes,
        },
        candidateDigest,
        eligibleCount: drawEligible.length,
      };
      setLastAudit(audit);
      const activeSourceMeta = {
        ...(drawContext.sourceMeta || sourceMeta),
        statusId: drawContext.statusId || currentStatusId,
        statusUrl: drawContext.statusUrl || currentStatusUrl || statusUrl.trim(),
      };
      const receipt = normalizeDrawReceipt({
        id: `local-${audit.drawnAt}`,
        source,
        statusId: audit.statusId,
        statusUrl: audit.statusUrl,
        drawNumber: null,
        drawnAt: audit.drawnAt,
        savedAt: '',
        results: all,
        candidateCount: drawCandidates.length,
        eligibleCount: drawEligible.length,
        rules: audit.rules,
        sourceMeta: activeSourceMeta,
        seed: audit.seed,
        candidateDigest: audit.candidateDigest,
        auditHash: '',
        recordState: practice ? 'practice' : 'local',
      });
      if (!practice) {
        const wonIds = new Set(historyUids);
        all.flatMap((item) => item.winners).forEach((winner) => {
          const identity = String(winner.uid || winner.screenName || winner.id || '').toLowerCase();
          if (identity) wonIds.add(identity);
        });
        setHistoryUids(wonIds);
        await commitDrawHistoryMutation((history) => upsertDrawReceipt(history, receipt));
      }
      setPendingReceipt(receipt);
      setConfirmedSetup(null);
      drawCompleted = true;
      if (!practice && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate?.([50, 40, 50]);
      }
      if (practice) {
        setPhase('本地演练完成');
        showStatus('本地演练完成，未保存开奖记录。', 'success');
      } else {
        completeDrawGuard(window.localStorage, guard.scope, guard.token);
        setPhase('正在同步开奖记录');
        showStatus(`已抽出 ${receipt.total} 位中奖用户，正在同步开奖记录。`, 'success');
        const syncController = new AbortController();
        drawSyncControllersRef.current.add(syncController);
        void syncDrawReceipt(receipt, {
          results: all,
          source,
          statusId: drawContext.statusId || currentStatusId,
          statusUrl: drawContext.statusUrl || currentStatusUrl || statusUrl.trim(),
          sourceMeta: activeSourceMeta,
          totalCount: drawCandidates.length,
          eligibleCount: drawEligible.length,
          audit,
          signal: syncController.signal,
          taskRevision,
        }).finally(() => {
          drawSyncControllersRef.current.delete(syncController);
        });
      }
    } catch (error) {
      setResults([]);
      rollingStore.set(null);
      setLastAudit(null);
      setPendingReceipt(null);
      if (error?.name === 'AbortError') {
        showStatus('本次开奖已停止，未产生有效结果。');
      } else {
        showStatus(error.message, 'error');
      }
    } finally {
      drawStartRef.current = false;
      if (!practice && guard?.ok && !drawCompleted) {
        releaseDrawGuard(window.localStorage, guard.scope, guard.token);
      }
      if (drawGuardRef.current === guard) drawGuardRef.current = null;
      if (tabLock?.release) await Promise.resolve(tabLock.release()).catch(() => {});
      if (drawTabLockRef.current === tabLock) drawTabLockRef.current = null;
      if (drawOperationRef.current === controller) drawOperationRef.current = null;
      setPhase('');
      setIsDrawing(false);
    }
  }

  async function saveResult(options = {}) {
    const opts = options?.nativeEvent ? {} : options;
    const activeResults = Array.isArray(opts.results) ? opts.results : results;
    const activeWinners = activeResults.flatMap((item) => item.winners || []);
    if (!activeWinners.length) return null;
    try {
      const activeSourceMeta = opts.sourceMeta || sourceMeta || {};
      const activeStatusId = opts.statusId ?? currentStatusId;
      const activeStatusUrl = opts.statusUrl ?? currentStatusUrl;
      const payload = {
        source: opts.source ?? source,
        statusId: activeStatusId,
        statusUrl: activeStatusUrl,
        sourceMeta: {
          ...activeSourceMeta,
          statusId: activeStatusId || activeSourceMeta?.statusId,
          statusUrl: activeStatusUrl || activeSourceMeta?.statusUrl,
        },
        results: activeResults.map((item) => ({
          prize: item.prize,
          winners: (item.winners || []).map((winner) => ({
            id: winner.id,
            uid: winner.uid,
            screenName: winner.screenName,
            avatar: winner.avatar,
          })),
        })),
        totalCount: opts.totalCount ?? candidates.length,
        eligibleCount: opts.eligibleCount ?? lastAudit?.eligibleCount ?? eligible.length,
        audit: opts.audit ?? lastAudit,
      };
      const response = await apiFetch('/api/draws', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: opts.signal,
      });
      const json = await readApiResponse(response, '开奖记录服务');
      if (!json.ok) throw new Error(json.error || '保存失败');
      if (opts.updateCurrentTask !== false) {
        if (json.statusId) setCurrentStatusId(json.statusId);
        if (json.statusUrl) setCurrentStatusUrl(json.statusUrl);
        if (json.drawCount !== null && json.drawCount !== undefined) {
          acceptDrawCount(json.drawCount);
        }
      }
      if (!opts.silent) showStatus(`开奖记录已保存：${json.file}`, 'success');
      return json;
    } catch (error) {
      if (!opts.silent) showStatus(error.message, 'error');
      if (opts.throwOnError) throw error;
      return null;
    }
  }

  function setReceiptSyncing(receiptId, syncing) {
    if (!receiptId) return;
    setSyncingReceiptIds((current) => {
      const next = new Set(current);
      if (syncing) next.add(receiptId);
      else next.delete(receiptId);
      return next;
    });
  }

  function manualDrawNumberFromSave(value, history, excludeId = '') {
    const persisted = Number(value);
    if (Number.isSafeInteger(persisted) && persisted > 0) {
      manualDrawSequenceRef.current = Math.max(manualDrawSequenceRef.current, persisted);
      return persisted;
    }

    const historyNext = nextManualDrawNumber(history, excludeId);
    const refNext = manualDrawSequenceRef.current >= Number.MAX_SAFE_INTEGER
      ? null
      : manualDrawSequenceRef.current + 1;
    if (historyNext === null || refNext === null) return null;

    const next = Math.max(historyNext, refNext);
    if (!Number.isSafeInteger(next)) return null;
    manualDrawSequenceRef.current = next;
    return next;
  }

  async function syncDrawReceipt(receipt, saveOptions) {
    const { taskRevision, ...requestOptions } = saveOptions;
    const historyMutationRevision = drawHistoryMutationRevisionRef.current;
    setReceiptSyncing(receipt.id, true);
    try {
      const saved = await saveResult({
        ...requestOptions,
        silent: true,
        throwOnError: true,
        updateCurrentTask: false,
      });
      if (!saved?.file) throw new Error('服务器没有返回开奖记录文件');
      const updated = await persistSavedReceipt(receipt, saved, historyMutationRevision);
      if (!updated) return null;
      const isCurrentTask = taskRevisionRef.current === taskRevision;
      if (isCurrentTask) {
        setPendingReceipt((current) => current?.id === receipt.id ? updated : current);
        setSelectedReceipt((current) => current?.id === receipt.id ? updated : current);
        if (saved.statusId) setCurrentStatusId(saved.statusId);
        if (saved.statusUrl) setCurrentStatusUrl(saved.statusUrl);
        showStatus(`已抽出 ${updated.total} 位中奖用户，开奖记录已同步。`, 'success');
        if (saved.drawCount !== null && saved.drawCount !== undefined) {
          acceptDrawCount(saved.drawCount);
        }
      }
      return updated;
    } catch (error) {
      if (requestOptions.signal?.aborted || error?.name === 'AbortError') return null;
      const message = historyStorageAvailable
        ? '服务器同步失败，结果已保留在当前浏览器。重新保存成功后才会计入服务器开奖次数。'
        : '服务器同步失败且本机存储不可用。关闭页面前请保存结果图或导出名单。';
      if (taskRevisionRef.current === taskRevision) {
        setPendingReceipt((current) => current?.id === receipt.id ? null : current);
        const viewedReceipt = selectedReceiptRef.current;
        const canPresentFailure = !viewedReceipt || viewedReceipt.id === receipt.id;
        if (canPresentFailure) {
          setSelectedReceipt((current) => {
            if (current && current.id !== receipt.id) return current;
            return current || receipt;
          });
          showStatus(`${message} ${error.message}`, 'error', { title: '开奖记录未同步' });
        }
      }
      return null;
    } finally {
      setReceiptSyncing(receipt.id, false);
    }
  }

  async function persistSavedReceipt(receipt, saved, historyMutationRevision) {
    if (drawHistoryMutationRevisionRef.current !== historyMutationRevision) return null;
    const manualDrawNumber = receipt.source === 'manual'
      ? manualDrawNumberFromSave(saved.drawNumber, drawHistoryRef.current, receipt.id)
      : null;
    const updated = normalizeDrawReceipt({
      ...receipt,
      id: receipt.id,
      drawNumber: saved.drawNumber ?? manualDrawNumber,
      savedAt: saved.savedAt,
      auditHash: saved.auditHash,
      recordState: 'server',
    });
    const historyUpdate = await commitDrawHistoryMutation(
      (history) => upsertDrawReceipt(history, updated),
      { revision: historyMutationRevision },
    );
    return historyUpdate.cancelled ? null : updated;
  }

  async function copyToClipboard(text, successMessage) {
    if (!text.trim()) {
      showStatus('暂无中奖用户可复制。', 'error');
      return false;
    }
    try {
      let modernCopyFailed = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          modernCopyFailed = true;
        }
      } else {
        modernCopyFailed = true;
      }
      if (modernCopyFailed) {
        const previousFocus = document.activeElement;
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand?.('copy');
        textarea.remove();
        previousFocus?.focus?.({ preventScroll: true });
        if (!copied) throw new Error('浏览器未允许复制');
      }
      showStatus(successMessage, 'success');
      return true;
    } catch (error) {
      showStatus(`复制失败：${error.message}`, 'error');
      return false;
    }
  }

  function exportCandidates(rows, evaluationByCandidate, view = {}) {
    if (!rows.length) {
      showStatus('当前视图没有可导出的候选。', 'error');
      return;
    }
    const exportedRows = rows.map((candidate, index) => {
      const evaluation = evaluationByCandidate.get(candidate);
      return {
        index: index + 1,
        uid: candidate.uid || '',
        screenName: candidate.screenName || '',
        text: candidate.text || '',
        createdAt: candidate.createdAt || '',
        source: friendlyProviderText(candidate.source) || candidate.source || '',
        status: evaluation?.eligible === false ? '已排除' : '可抽',
        exclusionReason: evaluation?.reasonLabel || '',
      };
    });
    const segmentName = { eligible: 'eligible', all: 'all', excluded: 'excluded' }[view.segment] || 'current';
    const searchSuffix = view.query ? '-search' : '';
    download(
      `weibo-candidates-${segmentName}${searchSuffix}-${Date.now()}.csv`,
      `\uFEFF${toCsv(exportedRows, ['index', 'uid', 'screenName', 'text', 'createdAt', 'source', 'status', 'exclusionReason'])}`,
    );
    showStatus(`已导出当前视图中的 ${rows.length.toLocaleString()} 条候选。`, 'success', {
      popup: true,
      title: '名单已导出',
    });
  }

  function exportHistoryBackup() {
    if (!drawHistory.length) {
      showStatus('暂无可导出的开奖记录。', 'error');
      return;
    }
    try {
      const date = new Date().toISOString().slice(0, 10);
      const backup = serializeDrawHistoryBackup(drawHistory, new Date().toISOString(), {
        maxBytes: MAX_HISTORY_BACKUP_BYTES,
      });
      const backupInfo = JSON.parse(backup);
      download(
        `weibo-draw-history-${date}.json`,
        backup,
        'application/json;charset=utf-8',
      );
      showStatus(`已备份 ${backupInfo.items.length} 条开奖记录${backupInfo.omittedCount ? `，因文件大小省略较早的 ${backupInfo.omittedCount} 条` : ''}。`, 'success', {
        popup: true,
        title: '记录已导出',
      });
    } catch (error) {
      showStatus(`记录导出失败：${error.message}`, 'error');
    }
  }

  async function importHistoryBackup(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > MAX_HISTORY_BACKUP_BYTES) throw new Error('备份文件不能超过 2 MB');
      if (drawSyncControllersRef.current.size > 0
        && !window.confirm('有开奖记录正在同步到服务器，导入备份会中断同步。确定继续吗？')) {
        return;
      }
      const imported = parseDrawHistoryBackup(await file.text());
      const historyMutationRevision = invalidateDrawHistoryMutations();
      const stored = await mutateDrawHistory(
        window.localStorage,
        (history) => mergeDrawHistory(history, imported),
      );
      if (drawHistoryMutationRevisionRef.current !== historyMutationRevision) {
        const latest = readDrawHistoryState(window.localStorage);
        if (latest.safeToPersist) {
          drawHistoryRef.current = latest.items;
          setDrawHistory(latest.items);
          if (currentStatusId) setHistoryUids(winnerIdsForStatus(latest.items, currentStatusId));
          setHistoryStorageAvailable(true);
          historyStorageErrorRef.current = false;
        }
        showStatus('开奖记录已在其它页面发生变化，当前显示最新本机记录；如导入结果缺失请重试。', 'neutral', {
          popup: true,
          title: '记录已更新',
        });
        return;
      }
      if (!stored.ok) throw new Error('本机存储空间不足，无法保存恢复后的开奖记录。');
      drawHistoryRef.current = stored.items;
      setDrawHistory(stored.items);
      if (currentStatusId) setHistoryUids(winnerIdsForStatus(stored.items, currentStatusId));
      setHistoryStorageAvailable(true);
      historyStorageErrorRef.current = false;
      setConfirmedSetup(null);
      clearResult();
      showStatus(`已读取 ${imported.length} 条备份，合并后保存 ${stored.items.length} 条记录${stored.dropped ? `，已舍弃较早的 ${stored.dropped} 条` : ''}。`, 'success', {
        popup: true,
        title: '记录已恢复',
      });
    } catch (error) {
      showStatus(`记录恢复失败：${error.message}`, 'error');
    } finally {
      event.target.value = '';
    }
  }

  function currentReceiptSnapshot() {
    return normalizeDrawReceipt({
      id: lastAudit?.candidateDigest ? `current-${lastAudit.candidateDigest}` : 'current-result',
      source,
      statusId: currentStatusId,
      statusUrl: currentStatusUrl || statusUrl.trim(),
      drawNumber: null,
      drawnAt: lastAudit?.drawnAt || '',
      results,
      candidateCount: candidates.length,
      eligibleCount: lastAudit?.eligibleCount ?? eligible.length,
      rules: lastAudit?.rules || null,
      sourceMeta: sourceMeta || {},
      seed: lastAudit?.seed || '',
      candidateDigest: lastAudit?.candidateDigest || '',
      recordState: lastAudit?.practice ? 'practice' : 'local',
    });
  }

  function resolveReceipt(receiptInput) {
    if (receiptInput?.nativeEvent) return selectedReceipt || currentReceiptSnapshot();
    if (receiptInput) return normalizeDrawReceipt(receiptInput);
    return selectedReceipt || currentReceiptSnapshot();
  }

  function copyReceiptPost(receiptInput, template = 'concise') {
    const receipt = resolveReceipt(receiptInput);
    copyToClipboard(
      buildAnnouncementText(receipt, template),
      '开奖文案已复制。',
    );
  }

  function copyReceiptFairness(receiptInput) {
    copyToClipboard(
      buildFairnessSummary(resolveReceipt(receiptInput)),
      '随机过程摘要已复制。',
    );
  }

  function copyReceiptWinners(receiptInput) {
    const text = receiptWinnerText(resolveReceipt(receiptInput));
    copyToClipboard(text, '获奖名单已复制。');
  }

  function exportReceiptWinners(receiptInput) {
    const receipt = resolveReceipt(receiptInput);
    const rows = receiptWinnerRows(receipt);
    if (!rows.length) {
      showStatus('暂无可导出的获奖名单。', 'error');
      return;
    }
    download(
      `weibo-winners-${receipt.statusId || Date.now()}.csv`,
      `\uFEFF${toCsv(rows, ['prize', 'rank', 'uid', 'screenName'])}`,
    );
    showStatus(`已导出 ${rows.length} 位获奖用户。`, 'success', { popup: true, title: '名单已导出' });
  }

  async function retrySaveReceipt(receiptInput) {
    const receipt = resolveReceipt(receiptInput);
    if (receipt.recordState !== 'local' || receiptRetryIdsRef.current.has(receipt.id)
      || syncingReceiptIds.has(receipt.id)) return null;
    receiptRetryIdsRef.current.add(receipt.id);
    const controller = new AbortController();
    drawSyncControllersRef.current.add(controller);
    setReceiptSyncing(receipt.id, true);
    const historyMutationRevision = drawHistoryMutationRevisionRef.current;
    const taskRevision = taskRevisionRef.current;
    try {
      const saved = await saveResult({
        silent: true,
        throwOnError: true,
        signal: controller.signal,
        updateCurrentTask: false,
        source: receipt.source,
        results: receipt.results,
        statusId: receipt.statusId,
        statusUrl: receipt.statusUrl,
        sourceMeta: receipt.sourceMeta,
        totalCount: receipt.candidateCount,
        eligibleCount: receipt.eligibleCount,
        audit: {
          seed: receipt.seed,
          drawnAt: receipt.drawnAt,
          statusId: receipt.statusId,
          statusUrl: receipt.statusUrl,
          rules: receipt.rules,
          candidateDigest: receipt.candidateDigest,
          eligibleCount: receipt.eligibleCount,
        },
      });
      if (!saved?.file) throw new Error('服务器没有返回开奖记录文件');
      throwIfAborted(controller.signal);
      const updated = await persistSavedReceipt(receipt, saved, historyMutationRevision);
      if (!updated || controller.signal.aborted) return null;
      setSelectedReceipt((current) => current?.id === receipt.id ? updated : current);
      setPendingReceipt((current) => current?.id === receipt.id ? updated : current);
      if (taskRevisionRef.current === taskRevision && receipt.source === source
        && receipt.statusId && receipt.statusId === currentStatusId) {
        acceptDrawCount(saved.drawCount);
      }
      showStatus('开奖记录已同步。', 'success');
      return updated;
    } catch (error) {
      if (!controller.signal.aborted) showStatus(error.message, 'error');
      return null;
    } finally {
      receiptRetryIdsRef.current.delete(receipt.id);
      drawSyncControllersRef.current.delete(controller);
      setReceiptSyncing(receipt.id, false);
    }
  }

  async function createShareImage(receiptInput) {
    const receipt = resolveReceipt(receiptInput);
    if (!receipt.results.length) {
      showStatus('请先开奖，再生成开奖记录图。', 'error');
      return;
    }
    if (capturingRef.current) return;
    capturingRef.current = true;
    try {
      setIsCapturing(true);
      showStatus('正在生成开奖记录图。');
      await sleep(80);
      const providerText = [
        ...(Array.isArray(receipt.sourceMeta?.providers)
          ? receipt.sourceMeta.providers
          : [receipt.sourceMeta?.provider]).filter(Boolean),
        receipt.sourceMeta?.complete === false ? '仅含当前可见转发' : '',
      ].filter(Boolean).join(' / ');
      const { createResultPoster } = await import('./lib/resultPoster.js');
      const canvas = await createResultPoster({
        results: receipt.results,
        statusUrl: receipt.statusUrl,
        statusId: receipt.statusId,
        drawnAt: receipt.drawnAt || new Date(),
        seed: receipt.seed,
        auditHash: receipt.auditHash,
        candidateDigest: receipt.candidateDigest,
        candidateCount: receipt.candidateCount,
        candidateCountKnown: !receipt.sourceMeta?.legacyCountsIncomplete,
        eligibleCount: receipt.eligibleCount,
        winnerCount: receipt.total,
        drawCount: receipt.drawNumber
          ? drawCountCopy({
            source: receipt.source,
            count: receipt.drawNumber,
            completed: true,
          })
          : '未计入开奖次数',
        totalNumber: receipt.sourceMeta?.totalNumber,
        providerText,
        filterSummary: receipt.rules?.filters
          ? buildFilterSummary(receipt.rules.filters)
          : '未记录',
        prizeSummary: receipt.results
          .map((group) => `${group.prize.name} × ${group.winners.length}`)
          .join(' / '),
      }, {
        brandAssetUrl: publicAsset('avatar-96.webp'),
        avatarProxyBase: apiBase,
      });
      const imageBlob = await canvasBlob(canvas);
      const imageUrl = URL.createObjectURL(imageBlob);
      const imageName = `weibo-draw-record-${Date.now()}.png`;
      downloadUrl(imageName, imageUrl);
      window.setTimeout(() => URL.revokeObjectURL(imageUrl), 1000);
      showStatus('开奖记录图已生成。', 'success');
    } catch (error) {
      showStatus(`开奖记录图生成失败：${error.message}`, 'error');
    } finally {
      capturingRef.current = false;
      setIsCapturing(false);
    }
  }

  function applyManualAdditions(additions, reachedLimit = false) {
    if (!clearResult()) return false;
    setConfirmedSetup(null);
    setCandidates((previous) => [...previous, ...additions]);
    setSourceMeta({
      provider: 'manual',
      loadedAt: new Date().toISOString(),
    });
    setLoadedSource('manual');
    setSourceInputDirty(false);
    setManualInput('');
    showStatus(`已添加 ${additions.length} 位候选用户${reachedLimit ? '，名单已达到 20,000 人上限' : ''}。`, 'success');
    return true;
  }
  function applyManualFileImport(text, fileName) {
    if (source !== 'manual') {
      if (!changeSource('manual', { confirmed: true })) return false;
    } else if (!clearResult()) {
      return false;
    }
    setManualInput(text);
    setSourceInputDirty(true);
    setCandidateLoadError('');
    setConfirmedSetup(null);
    showStatus(`已读取 ${fileName}，确认后可导入候选名单。`, 'success', { popup: true, title: '文件已读取' });
    return true;
  }
  function addManualNames() {
    if (refuseWhileBusy()) return;
    if (source !== 'manual') {
      showStatus('请先选择手动名单。', 'error');
      return;
    }
    try {
      const parsed = parseManualInput(manualInput);
      if (!parsed.length) throw new Error('请先粘贴或导入候选名单。');
      const seen = new Set(candidates.map((item) => candidateIdentity(item)).filter(Boolean));
      const additions = [];
      for (const item of parsed) {
        const key = candidateIdentity(item);
        if (!key || seen.has(key)) continue;
        if (candidates.length + additions.length >= MAX_MANUAL_CANDIDATES) break;
        seen.add(key);
        additions.push(item);
      }
      if (!additions.length) {
        throw new Error(candidates.length >= MAX_MANUAL_CANDIDATES
          ? '手动名单已达到 20,000 人上限'
          : '这些候选已经在当前名单中');
      }
      const reachedLimit = candidates.length + additions.length >= MAX_MANUAL_CANDIDATES;
      if (hasCurrentResultToProtect()) {
        requestCandidateReplacement({
          operation: 'append-manual',
          additions,
          reachedLimit,
        }, {
          title: '清除当前结果？',
          message: '当前已有开奖结果或尚未同步的结果。继续追加名单会清除当前结果，但会保留现有候选名单。',
          confirmLabel: '清除并追加',
        });
        return;
      }
      applyManualAdditions(additions, reachedLimit);
    } catch (error) {
      showStatus(error.message, 'error');
    }
  }
  async function importCandidateFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (manualFileReadRef.current) {
      event.target.value = '';
      showStatus('正在读取上一份名单文件，请稍候。');
      return;
    }
    manualFileReadRef.current = true;
    const inputRevision = candidateLoadRevisionRef.current;
    try {
      if (file.size > MAX_MANUAL_FILE_BYTES) throw new Error('文件不能超过 5 MB');
      const text = await file.text();
      if (!mountedRef.current || candidateLoadRevisionRef.current !== inputRevision) return;
      if (refuseWhileBusy()) return;
      if (hasCurrentResultToProtect()) {
        requestCandidateReplacement({
          operation: 'import-manual-file',
          text,
          fileName: file.name,
        }, {
          title: '清除当前结果？',
          message: '当前已有开奖结果或尚未同步的结果。继续导入名单会清除当前结果，但不会删除服务器已保存的开奖记录。',
          confirmLabel: '清除并导入',
        });
        return;
      }
      applyManualFileImport(text, file.name);
    } catch (error) {
      showStatus(`文件读取失败：${error.message}`, 'error');
    } finally {
      manualFileReadRef.current = false;
      event.target.value = '';
    }
  }

  const manualDrawCountFromHistory = nextManualDrawNumber(drawHistoryRef.current);
  const manualDrawLimitReached = manualDrawCountFromHistory === null
    || manualDrawSequenceRef.current >= Number.MAX_SAFE_INTEGER;
  const manualDrawCount = Math.max(
    manualDrawCountFromHistory === null ? Number.MAX_SAFE_INTEGER : Math.max(0, manualDrawCountFromHistory - 1),
    manualDrawSequenceRef.current,
  );
  const drawCountKnown = source === 'manual'
    || (drawCountStatus === 'ready' && Number.isFinite(Number(drawCount)) && Number(drawCount) >= 0);
  const previousDrawCount = source === 'manual'
    ? manualDrawCount
    : drawCountKnown
      ? Math.max(0, Math.floor(Number(drawCount)))
      : null;
  const nextDrawText = getNextDrawText({
    source,
    previousDrawCount,
    manualLimitReached: manualDrawLimitReached,
  });
  const activeReceipt = selectedReceipt?.drawnAt === lastAudit?.drawnAt
    ? selectedReceipt
    : lastAudit?.drawnAt
      ? drawHistory.find((item) => item.drawnAt === lastAudit.drawnAt)
      : null;
  const drawCountText = getDrawCountText({
    activeReceipt,
    source,
    manualLimitReached: manualDrawLimitReached,
    manualDrawCount,
    statusUrl,
    status: drawCountStatus,
    count: drawCount,
  });
  const hasCandidates = candidates.length > 0;
  const hasResults = results.length > 0;
  const serverTryableAccountCount = Number(
    cookieInfo.tryableAccountCount
      ?? cookieInfo.availableAccountCount
      ?? cookieInfo.accountCount
      ?? cookieInfo.availableCookieCount
      ?? cookieInfo.cookieCount
      ?? 0,
  );
  const serverVerifiedAccountCount = Number(cookieInfo.verifiedAccountCount || 0);
  const accountStatusText = getAccountStatusText({
    cookieHealth,
    verifiedAccountCount: serverVerifiedAccountCount,
    tryableAccountCount: serverTryableAccountCount,
    hasFallbackCookie: Boolean(mobileCookie.trim()),
  });
  const serviceStatusText = progress
    ? '任务运行中'
    : apiHealth === 'ok'
      ? '连接正常'
      : apiHealth === 'error'
        ? '连接异常'
        : '正在检查';
  const loadedCandidateCount = candidates.length;
  const resultTotal = winners.length;
  const filterEnabledText = keyword.trim() || rules.mentionMin > 0 || blocklist.trim() || excludePrevious ? '已开启' : '默认';
  const filterSummary = buildFilterSummary({
    keyword,
    mentionMin: rules.mentionMin,
    uniqueByUser,
    excludePrevious,
    blocklistCount: rules.blocked.size,
  });
  const candidateLoadCompleted = Boolean(sourceMeta && loadedSource === source && !sourceInputDirty && !candidateLoadError);
  const candidateWarningText = candidateLoadWarning(sourceMeta);
  const loadedTime = shortLoadedTime(sourceMeta?.loadedAt);
  const candidateCutoff = candidateCutoffInfo(sourceMeta?.loadedAt);
  const candidateNeedsRefresh = source !== 'manual' && candidateCutoff.ageMs >= 2 * 60_000;
  const candidateFreshnessText = getCandidateFreshnessText({
    loadError: candidateLoadError,
    candidateCount: candidates.length,
    sourceReady: candidateSourceReady,
    source,
    loadedTime,
    sourceMeta,
  });
  const currentReceipt = hasResults ? currentReceiptSnapshot() : null;
  return (
    <AppWorkspace
      controller={{
        source,
        statusUrl,
        accessToken,
        mobileCookie,
        manualInput,
        candidates,
        candidateEvaluations,
        candidateSummary,
        eligible,
        eligibleUserCount,
        prizes,
        normalizedPrizes,
        keyword,
        mentionMin: rules.mentionMin,
        blocklist,
        uniqueByUser,
        excludePrevious,
        results,
        drawHistory,
        selectedReceipt,
        currentReceipt,
        status,
        statusTone,
        progress,
        isLoading,
        isDrawing,
        isBusy,
        phase,
        activeTab,
        showSourceEditor,
        showPrizeEditor,
        showDrawConfirm,
        showFilters,
        candidateQuery,
        candidateSegment,
        historyExpanded,
        historyQuery,
        showSettings,
        settingsTarget,
        showGuide,
        showFeedback,
        feedbackInitialCategory,
        legalDocument,
        notice,
        confirmAction,
        apiBase,
        apiBaseInput,
        backendAddressEditorOpen,
        apiKey,
        apiAuthRequired,
        apiHealth,
        apiHealthDetail,
        cookieHealth,
        totalSlots,
        hasCandidates,
        hasResults,
        loadedCandidateCount,
        resultTotal,
        filterEnabledText,
        accountStatusText,
        serviceStatusText,
        drawCountText,
        drawCountStatus,
        retryDrawCount: () => refreshDrawCount(),
        previousDrawCount,
        nextDrawText,
        drawSetupConfirmed,
        candidateSourceReady,
        filterSummary,
        candidateLoadCompleted,
        candidateLoadError,
        candidateWarningText,
        candidateFreshnessText,
        candidateCutoffLabel: source === 'manual' ? `手动名单 · ${candidateCutoff.label}` : candidateCutoff.label,
        candidateNeedsRefresh,
        cooldownPersistent,
        historyStorageAvailable,
        syncingReceiptIds,
        manualCookieOpen,
        isCapturing,
        motionPreference,
        homeStatusInputRef,
        candidateStatusInputRef,
        sourceSheetStatusInputRef,
        historyImportInputRef,
        firstPrizeNameRef,
        setSource: changeSource,
        setAccessToken,
        setMobileCookie,
        updateManualInput,
        applyFilterDraft,
        setSelectedReceipt: selectReceipt,
        setActiveTab,
        setShowSourceEditor,
        setShowPrizeEditor,
        setShowDrawConfirm,
        setShowFilters,
        setCandidateQuery,
        setCandidateSegment,
        setHistoryExpanded,
        setHistoryQuery,
        setShowSettings,
        setShowGuide,
        setShowFeedback,
        setLegalDocument,
        setConfirmAction,
        setApiBase: updateApiBase,
        setApiBaseInput: updateApiBaseInput,
        commitApiBase,
        openBackendAddressEditor,
        saveBackendAddress,
        usePresetBackend,
        setApiKey,
        setManualCookieOpen,
        setMotionPreference,
        openSettings,
        dismissNotice,
        applySettingsAction,
        openLegalDocument,
        openFeedback,
        submitFeedback,
        selectCandidateSource,
        updateStatusInput,
        shouldForceCandidateRefresh,
        safeLoadCandidates,
        pasteAndLoadCandidates,
        cancelCandidateLoad,
        clearResult,
        updatePrize,
        updatePrizeCount,
        commitPrizeCount,
        addPrize,
        removePrize,
        confirmDrawSetup,
        requestDraw,
        confirmAndDraw,
        cancelDraw,
        loadCookieStatus,
        testApiConnection,
        showStatus,
        importCandidateFile,
        addManualNames,
        exportCandidates,
        exportHistoryBackup,
        importHistoryBackup,
        createShareImage,
        copyToClipboard,
        copyReceiptPost,
        copyReceiptFairness,
        copyReceiptWinners,
        exportReceiptWinners,
        retrySaveReceipt,
      }}
    />
  );
}

export default App;
