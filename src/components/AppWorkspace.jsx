import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import CandidateAvatar from './CandidateAvatar.jsx';
import CandidateSourceForm from './CandidateSourceForm.jsx';
import CandidateLoadProgress from './CandidateLoadProgress.jsx';
import WorkspaceHeading from './WorkspaceHeading.jsx';
import DrawResultSheet from './DrawResultSheet.jsx';
import SheetFrame from './ui/SheetFrame.jsx';
import NoticeToast from './ui/NoticeToast.jsx';
import ConfirmActionDialog from './ui/ConfirmActionDialog.jsx';
import { icons as I } from './ui/icons.jsx';
import FilterEditorSheet from './sheets/FilterEditorSheet.jsx';
import DrawConfirmSheet from './sheets/DrawConfirmSheet.jsx';
import GuideSheet from './sheets/GuideSheet.jsx';
import SettingsSheet from './sheets/SettingsSheet.jsx';
import CandidateDetailSheet from './sheets/CandidateDetailSheet.jsx';
import FeedbackSheet from './sheets/FeedbackSheet.jsx';
import LegalSheet from './sheets/LegalSheet.jsx';
import DisplayModeSheet from './sheets/DisplayModeSheet.jsx';
import useDisplayMode from '../hooks/useDisplayMode.js';
import useVisualViewport from '../hooks/useVisualViewport.js';
import { friendlyProviderText } from '../lib/appCore.js';
import { cancelDrawDeckMotion, settleDrawDeckMotion, startDrawDeckMotion } from '../lib/drawDeckMotion.js';
import { DRAW_HISTORY_LIMIT } from '../lib/drawReceipts.js';
import { getDrawActionState, getIntakeState } from '../lib/drawUiModel.js';
import { candidateIdentity } from '../lib/candidateEligibility.js';
import { COLORS, MAX_DRAW_WINNERS, MAX_DRAW_RESULT_GROUPS } from '../lib/drawConfig.js';
import { shouldReduceMotion } from '../lib/motionPreferences.js';
import { rollingStore } from '../lib/rollingCandidates.js';

const publicAsset = (name) => `${import.meta.env.BASE_URL}${name}`;
const APP_VERSION = __APP_VERSION__;
const CANDIDATE_PAGE_SIZE = 20;
const CANDIDATE_RENDER_LIMIT = 200;

const historyDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function historyDateParts(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return { month: '--', day: '--', time: '暂无', compact: '--' };
  const parts = Object.fromEntries(
    historyDateFormatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    month: parts.month || '--',
    day: parts.day || '--',
    time: `${parts.hour || '--'}:${parts.minute || '--'}`,
    compact: `${parts.month || '--'}.${parts.day || '--'}`,
  };
}

const DRAW_ACTION_ICONS = {
  load: I.link,
  filter: I.listChecks,
  draw: I.shuffle,
  setup: I.gift,
};

function SectionTitle({ title, action, onAction }) {
  return (
    <header className="section-header">
      <h2>{title}</h2>
      {action && <button type="button" onClick={onAction}>{action}</button>}
    </header>
  );
}

function AppListRow({ id, icon, tone = 'blue', title, detail, value, onClick }) {
  return (
    <button id={id} className="list-row" type="button" onClick={onClick}>
      <span className={`row-icon ${tone}`}>{icon}</span>
      <span className="row-copy">
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </span>
      {value && <span className="row-value">{value}</span>}
      {I.chevron}
    </button>
  );
}

function compactCandidateUid(candidate) {
  const uid = String(candidate?.uid || '');
  if (!uid) return friendlyProviderText(candidate?.source) || '微博候选';
  return uid.length > 8 ? `UID ${uid.slice(0, 4)}••••${uid.slice(-2)}` : `UID ${uid}`;
}

function DrawStageCard({ controller: c, drawState }) {
  const rolling = useSyncExternalStore(rollingStore.subscribe, rollingStore.getSnapshot);
  const stageCandidate = c.isDrawing
    ? rolling.candidate || c.eligible[0] || c.candidates[0]
    : c.eligible[0] || c.candidates[0];
  const stageName = stageCandidate?.screenName || stageCandidate?.uid || '候选用户';
  return (
    <article className="candidate-pass pass-main lens-center" data-deck-card>
      <header>
        <span>{c.isDrawing ? c.phase === '正在同步开奖记录' ? '正在同步结果' : '正在抽取候选' : '候选'}</span>
        {I.shield}
      </header>
      <div className="pass-identity">
        <CandidateAvatar candidate={stageCandidate} className="pass-avatar" apiBase={c.apiBase} priority={c.isDrawing} />
        <span key={c.isDrawing ? candidateIdentity(stageCandidate) || stageName : `${drawState}-${c.eligible.length}`}>
          <small>{c.isDrawing ? c.phase || '正在抽取' : '候选已载入'}</small>
          <strong>{c.isDrawing ? stageName : c.eligibleUserCount.toLocaleString()}</strong>
          <em>{c.isDrawing ? compactCandidateUid(stageCandidate) : '名候选'}</em>
        </span>
      </div>
      <footer>
        <span><small>奖项</small><strong>{c.normalizedPrizes.length} 个</strong></span>
        <span><small>名额</small><strong>{c.totalSlots} 名</strong></span>
        <span><small>状态</small><strong>{c.isDrawing ? '抽取中' : !c.candidateSourceReady ? '待载入' : c.eligible.length ? c.drawSetupConfirmed ? '可开奖' : '待确认' : '需调整'}</strong></span>
      </footer>
    </article>
  );
}

function RollingName({ fallback = '候选用户' }) {
  const rolling = useSyncExternalStore(rollingStore.subscribe, rollingStore.getSnapshot);
  return rolling.candidate?.screenName || rolling.candidate?.uid || fallback;
}

export default function AppWorkspace({ controller: c }) {
  useVisualViewport();
  const displayMode = useDisplayMode();
  const [showDisplayGuide, setShowDisplayGuide] = useState(false);
  const drawState = c.isDrawing ? 'running' : c.hasResults ? 'finished' : 'ready';
  const [mountedTabs, setMountedTabs] = useState(() => new Set([c.activeTab]));
  const [chromeState, setChromeState] = useState('expanded');
  const [pageDirection, setPageDirection] = useState(1);
  const [candidateLimit, setCandidateLimit] = useState(CANDIDATE_PAGE_SIZE);
  const [selectedCandidateEntry, setSelectedCandidateEntry] = useState(null);
  const [sourceFormCollapsed, setSourceFormCollapsed] = useState(false);
  const drawDeckRef = useRef(null);
  const drawSceneRef = useRef(null);
  const tabFrameRef = useRef(null);
  const deckAnimationsRef = useRef([]);
  const previousDrawStateRef = useRef(drawState);
  const deferredCandidateQuery = useDeferredValue(c.candidateQuery);

  useEffect(() => {
    const reducedMotion = shouldReduceMotion(c.motionPreference);
    const deck = drawDeckRef.current;
    const previousState = previousDrawStateRef.current;
    const currentTransforms = drawState === 'finished' && previousState === 'running' && deck
      ? [...deck.querySelectorAll('[data-deck-card]')].map((card) => getComputedStyle(card).transform)
      : [];
    cancelDrawDeckMotion(deckAnimationsRef.current);
    deckAnimationsRef.current = [];

    if (drawState === 'running') {
      deckAnimationsRef.current = startDrawDeckMotion(deck, { reducedMotion });
    } else if (drawState === 'finished' && previousState === 'running') {
      deckAnimationsRef.current = settleDrawDeckMotion(deck, {
        reducedMotion,
        readTransform: (_, index) => currentTransforms[index] || 'none',
      });
    }
    previousDrawStateRef.current = drawState;
  }, [drawState, c.motionPreference]);

  useEffect(() => () => {
    cancelDrawDeckMotion(deckAnimationsRef.current);
  }, []);

  useEffect(() => {
    setMountedTabs((current) => (current.has(c.activeTab) ? current : new Set(current).add(c.activeTab)));
  }, [c.activeTab]);

  useEffect(() => {
    const scrollRoot = document.querySelector(`[data-root-view="${c.activeTab}"] .root-scroll`);
    if (!scrollRoot) {
      setChromeState('expanded');
      return undefined;
    }

    let lastScrollTop = scrollRoot.scrollTop;
    let animationFrame = 0;
    const updateChrome = () => {
      animationFrame = 0;
      const nextScrollTop = scrollRoot.scrollTop;
      const delta = nextScrollTop - lastScrollTop;
      lastScrollTop = nextScrollTop;
      if (nextScrollTop <= 24 || delta < -6) {
        setChromeState((current) => (current === 'expanded' ? current : 'expanded'));
      } else if (nextScrollTop > 72 && delta > 6) {
        setChromeState((current) => (current === 'compact' ? current : 'compact'));
      }
    };
    const handleScroll = () => {
      if (!animationFrame) animationFrame = window.requestAnimationFrame(updateChrome);
    };

    setChromeState('expanded');
    scrollRoot.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      scrollRoot.removeEventListener('scroll', handleScroll);
      window.cancelAnimationFrame(animationFrame);
    };
  }, [c.activeTab]);

  const tabIndex = { home: 0, candidates: 1, history: 2, more: 3 }[c.activeTab] ?? 0;
  const tabOrder = ['home', 'candidates', 'history', 'more'];
  const candidateSegmentIndex = { eligible: 0, all: 1, excluded: 2 }[c.candidateSegment] ?? 0;
  const candidateGroups = useMemo(() => {
    const evaluationByCandidate = new Map(
      c.candidateEvaluations.map((entry) => [entry.candidate, entry]),
    );
    const excludedCandidates = c.candidateEvaluations
      .filter((entry) => !entry.eligible)
      .map((entry) => entry.candidate);
    const segmentCandidates = c.candidateSegment === 'all'
      ? c.candidates
      : c.candidateSegment === 'excluded'
        ? excludedCandidates
        : c.eligible;
    return { evaluationByCandidate, excludedCandidates, segmentCandidates };
  }, [c.candidateSegment, c.candidates, c.candidateEvaluations, c.eligible]);
  const candidateView = useMemo(() => {
    const query = deferredCandidateQuery.trim().toLowerCase();
    const { segmentCandidates } = candidateGroups;
    const matchingCandidates = segmentCandidates.filter((candidate) => !query || [
      candidate.screenName,
      candidate.uid,
      candidate.text,
    ].some((value) => String(value || '').toLowerCase().includes(query)));
    return { ...candidateGroups, matchingCandidates, query };
  }, [candidateGroups, deferredCandidateQuery]);
  const { evaluationByCandidate, excludedCandidates, matchingCandidates, query } = candidateView;
  const browsableCandidateCount = Math.min(matchingCandidates.length, CANDIDATE_RENDER_LIMIT);
  const visibleCandidates = matchingCandidates.slice(0, Math.min(candidateLimit, browsableCandidateCount));
  const remainingCandidates = Math.max(0, browsableCandidateCount - visibleCandidates.length);
  const searchOnlyCandidates = Math.max(0, matchingCandidates.length - browsableCandidateCount);

  useLayoutEffect(() => {
    setCandidateLimit(CANDIDATE_PAGE_SIZE);
  }, [c.candidateSegment, c.candidates, deferredCandidateQuery]);
  const deferredHistoryQuery = useDeferredValue(c.historyQuery);
  const historySearch = String(deferredHistoryQuery || '').trim().toLowerCase();
  const historySearchIndex = useMemo(() => c.drawHistory.map((item) => ({
    item,
    text: [
      item.statusUrl,
      item.statusId,
      item.drawNumber,
      ...(item.results || []).flatMap((group) => [
        group.prize?.name,
        ...(group.winners || []).flatMap((winner) => [winner.screenName, winner.uid]),
      ]),
    ].map((value) => String(value || '').toLowerCase()).join('\n'),
  })), [c.drawHistory]);
  const filteredHistory = useMemo(() => {
    if (!historySearch) return c.drawHistory;
    return historySearchIndex
      .filter((entry) => entry.text.includes(historySearch))
      .map((entry) => entry.item);
  }, [c.drawHistory, historySearch, historySearchIndex]);
  const visibleHistory = c.historyExpanded ? filteredHistory : filteredHistory.slice(0, 3);
  const totalHistoricWinners = c.drawHistory.reduce((sum, item) => sum + Number(item.total || 0), 0);
  const latestHistory = c.drawHistory.slice(0, 2);
  const sourceDetail = {
    mobile: '当前可见的微博转发',
    manual: '粘贴、填写或文件导入',
    official: '微博官方接口',
  }[c.source];
  const sourceFormHidden = sourceFormCollapsed && c.candidateSourceReady && !c.isLoading;
  const primaryResult = c.results.find((item) => item.winners?.length);
  const primaryWinner = primaryResult?.winners?.[0];
  const stackOpen = Boolean(
    c.showGuide
    || c.showFeedback
    || c.legalDocument
    || c.confirmAction
    || c.showDrawConfirm
    || c.showSourceEditor
    || c.showPrizeEditor
    || c.showFilters
    || c.showSettings
    || c.selectedReceipt
    || selectedCandidateEntry
    || showDisplayGuide,
  );
  const contentInert = stackOpen || c.notice?.tone === 'error';
  const layerSignature = [
    c.notice?.tone === 'error' ? `notice:${c.notice.id}` : '',
    c.showGuide ? 'guide' : '',
    c.showFeedback ? 'feedback' : '',
    c.legalDocument ? 'legal' : '',
    c.confirmAction ? 'confirm' : '',
    c.showDrawConfirm ? 'draw-confirm' : '',
    c.showSourceEditor ? 'source' : '',
    c.showPrizeEditor ? 'prize' : '',
    c.showFilters ? 'filters' : '',
    c.showSettings ? 'settings' : '',
    c.selectedReceipt ? 'receipt' : '',
    selectedCandidateEntry ? 'candidate' : '',
    showDisplayGuide ? 'display-mode' : '',
  ].filter(Boolean).join('|');
  useLayoutEffect(() => {
    const pageRegions = [...document.querySelectorAll('.root-navbar, .root-pages, .root-tabbar')];
    const layers = [...document.querySelectorAll('.v3-alert-backdrop, .flow-sheet-backdrop, .receipt-backdrop')];
    const topLayer = layers.reduce((currentTop, layer) => {
      if (!currentTop) return layer;
      const currentZIndex = Number.parseInt(window.getComputedStyle(currentTop).zIndex, 10) || 0;
      const layerZIndex = Number.parseInt(window.getComputedStyle(layer).zIndex, 10) || 0;
      return layerZIndex >= currentZIndex ? layer : currentTop;
    }, null);
    pageRegions.forEach((region) => {
      if (contentInert) region.setAttribute('inert', '');
      else region.removeAttribute('inert');
    });
    layers.forEach((layer) => {
      if (layer !== topLayer) layer.setAttribute('inert', '');
      else layer.removeAttribute('inert');
    });
    return () => {
      pageRegions.forEach((region) => region.removeAttribute('inert'));
      layers.forEach((layer) => layer.removeAttribute('inert'));
    };
  }, [contentInert, layerSignature]);
  const intakeState = getIntakeState({
    loading: c.isLoading,
    loadError: c.candidateLoadError,
    hasCandidates: c.hasCandidates,
    drawState,
    loadCompleted: c.candidateLoadCompleted,
    statusUrl: c.statusUrl,
  });
  const intakePercent = Math.max(0, Math.min(100, Math.round(c.progress?.percent || 0)));
  const visibleWinners = c.results
    .flatMap((item) => item.winners.map((winner) => ({
      candidate: winner,
      prizeName: item.prize.name,
    })))
    .slice(0, 4);
  const resultReceipt = c.currentReceipt || c.drawHistory[0] || null;
  const resolvedDrawAction = getDrawActionState({
    loadError: c.candidateLoadError,
    hasCandidates: c.hasCandidates,
    sourceReady: c.candidateSourceReady,
    eligibleCount: c.eligible.length,
    setupConfirmed: c.drawSetupConfirmed,
    nextDrawLabel: c.nextDrawText,
    totalSlots: c.totalSlots,
    prizeCount: c.normalizedPrizes.length,
  });
  const drawAction = {
    ...resolvedDrawAction,
    icon: DRAW_ACTION_ICONS[resolvedDrawAction.kind],
  };

  useEffect(() => () => window.cancelAnimationFrame(tabFrameRef.current), []);

  const switchTab = (tab, { focus = false } = {}) => {
    const reselected = tab === c.activeTab;
    if (tab !== c.activeTab) {
      const currentIndex = tabOrder.indexOf(c.activeTab);
      const nextIndex = tabOrder.indexOf(tab);
      setPageDirection(nextIndex >= currentIndex ? 1 : -1);
      setChromeState('expanded');
    }
    setMountedTabs((current) => (current.has(tab) ? current : new Set(current).add(tab)));
    c.setActiveTab(tab);
    window.cancelAnimationFrame(tabFrameRef.current);
    tabFrameRef.current = window.requestAnimationFrame(() => {
      tabFrameRef.current = null;
      if (reselected && !c.isBusy) {
        document.querySelector(`[data-root-view="${tab}"] .root-scroll`)?.scrollTo({
          top: 0,
          behavior: shouldReduceMotion(c.motionPreference) ? 'auto' : 'smooth',
        });
      }
      if (focus) {
        document.querySelector(`.root-tabbar [data-tab-target="${tab}"]`)?.focus({
          preventScroll: true,
        });
      }
    });
  };

  const handleTabListKeyDown = (event) => {
    const currentIndex = tabOrder.indexOf(c.activeTab);
    let nextTab = null;
    if (event.key === 'ArrowRight') nextTab = tabOrder[(currentIndex + 1 + tabOrder.length) % tabOrder.length];
    else if (event.key === 'ArrowLeft') nextTab = tabOrder[(currentIndex - 1 + tabOrder.length) % tabOrder.length];
    else if (event.key === 'Home') nextTab = tabOrder[0];
    else if (event.key === 'End') nextTab = tabOrder.at(-1);
    if (!nextTab) return;
    event.preventDefault();
    switchTab(nextTab, { focus: true });
  };

  const continueToDraw = () => {
    if (c.isLoading || c.isDrawing) return;
    switchTab('home');
    c.requestDraw();
  };

  const confirmDraw = (close) => {
    drawSceneRef.current?.scrollIntoView({
      behavior: 'auto',
      block: 'nearest',
    });
    c.confirmAndDraw({ close });
  };
  const practiceDraw = (close) => {
    drawSceneRef.current?.scrollIntoView({
      behavior: 'auto',
      block: 'nearest',
    });
    c.confirmAndDraw({ practice: true, close });
  };

  return (
    <div
      className={`app-shell v3-app-shell studio-app ${stackOpen ? 'stack-open' : ''}`}
      data-draw-state={drawState}
      data-intake-state={intakeState}
      data-motion={c.motionPreference}
      data-setup={c.drawSetupConfirmed ? 'confirmed' : 'unconfirmed'}
      data-chrome={chromeState}
      data-root-tab={c.activeTab === 'home' ? 'draw' : c.activeTab}
      style={{
        '--page-direction': String(pageDirection),
        '--page-enter-x': `${pageDirection * 12}px`,
      }}
    >
      <a className="skip-link" href="#main-content" inert={contentInert ? '' : undefined}>跳到主要内容</a>
      <header className="root-navbar glass" inert={contentInert ? '' : undefined}>
        <button className="brand-button" type="button" onClick={() => switchTab('home')}>
          <img src={publicAsset('avatar-96.webp')} alt="" width="48" height="48" />
          <span>
            <strong>微博转发抽奖</strong>
            <small>by.sameko</small>
          </span>
        </button>
        <div className="navbar-actions">
          <button className={c.showGuide ? 'is-presenting' : ''} type="button" onClick={() => c.setShowGuide(true)} aria-label="使用教程" aria-expanded={c.showGuide}>
            {I.book}
          </button>
          <button className={c.showSettings ? 'is-presenting' : ''} type="button" onClick={() => c.openSettings()} aria-label="设置" aria-expanded={c.showSettings}>
            {I.settings}
          </button>
        </div>
      </header>

      <NoticeToast notice={c.notice} onClose={c.dismissNotice} />
      {showDisplayGuide && <DisplayModeSheet mode={displayMode} onClose={() => setShowDisplayGuide(false)} />}
      <div
        className="sr-only"
        role="status"
        aria-live={c.notice ? 'off' : c.statusTone === 'error' ? 'assertive' : 'polite'}
        aria-atomic="true"
        data-app-status={c.statusTone}
      >
        {c.status}
      </div>
      {c.confirmAction && (
        <ConfirmActionDialog
          action={c.confirmAction}
          motionPreference={c.motionPreference}
          onClose={() => c.setConfirmAction(null)}
          onConfirm={() => c.applySettingsAction(c.confirmAction.kind)}
        />
      )}

      <main id="main-content" className="root-pages" tabIndex={-1} inert={contentInert ? '' : undefined}>
        <section id="root-view-home" role="tabpanel" aria-label="抽奖" className={`root-view ${c.activeTab === 'home' ? 'is-active' : ''}`} data-root-view="home" hidden={c.activeTab !== 'home'}>
          {mountedTabs.has('home') && <div className="root-scroll">
            <WorkspaceHeading
              loaded={c.hasCandidates && c.candidateSourceReady && !c.candidateLoadError}
              confirmed={c.drawSetupConfirmed}
              completed={c.hasResults && c.candidateSourceReady}
              running={c.isDrawing}
            />
            <section className={`draw-studio ${!c.hasCandidates ? 'is-empty' : ''}`} aria-label="抽奖控制台">
              <header className="studio-header">
                <div>
                  <span className={`title-status ${c.isLoading || c.isDrawing ? 'is-busy' : ''}`}>
                    <i />
                     {c.isLoading
                       ? '正在载入候选'
                       : c.candidateLoadError
                       ? c.hasCandidates ? '上次名单待复核' : '候选载入失败'
                       : c.isDrawing
                      ? c.phase === '正在同步开奖记录' ? '正在同步结果' : '正在抽取'
                        : c.hasResults
                          ? '本轮开奖已完成'
                          : c.hasCandidates
                            ? c.candidateWarningText
                              ? '请核对候选范围'
                              : !c.candidateSourceReady
                              ? '请载入当前来源'
                              : c.drawSetupConfirmed ? '已准备开奖' : '请确认奖项'
                            : c.candidateLoadCompleted ? '未找到可见候选' : '等待载入候选'}
                  </span>
                  <strong>
                     {c.hasCandidates
                       ? c.candidateLoadError
                         ? '刷新未完成，当前名单不能直接开奖'
                         : `${c.eligibleUserCount.toLocaleString()} 名候选 · ${c.normalizedPrizes.length} 个奖项 · ${c.totalSlots} 个名额`
                       : c.candidateLoadError ? '请重新载入候选名单' : c.candidateLoadCompleted ? '可以更新名单或改用手动导入' : '粘贴微博链接即可载入'}
                  </strong>
                </div>
                <button className={c.showFilters ? 'is-presenting' : ''} type="button" onClick={() => c.setShowFilters(true)} aria-expanded={c.showFilters}>
                  {I.listChecks}
                  筛选
                </button>
              </header>

              {!c.hasCandidates ? (
                <>
                   <div className={`draw-scene v3-intake-scene ${c.statusUrl.trim() ? 'has-link' : ''} ${c.candidateLoadError ? 'has-error' : ''}`}>
                    <div className="v3-intake-deck-frame">
                      <div className="candidate-deck v3-intake-deck">
                        <article className="candidate-pass pass-under pass-coral" aria-hidden="true"><span /><i /></article>
                        <article className="candidate-pass pass-under pass-blue" aria-hidden="true"><span /><i /></article>
                        <article className="candidate-pass pass-main">
                          <header>
                            <span>候选名单</span>
                            {I.shield}
                          </header>
                          <div className="pass-identity">
                            <span className="pass-avatar v3-intake-symbol">
                              {I.link}
                            </span>
                           <span aria-hidden="true">
                               <small>{c.isLoading ? '正在载入候选' : c.candidateLoadError ? '载入未完成' : c.candidateLoadCompleted ? '候选检查已完成' : '从一条微博开始'}</small>
                               <strong>{c.isLoading ? `${intakePercent}%` : c.candidateLoadError ? '请重新载入' : c.candidateLoadCompleted ? '未找到候选' : c.statusUrl.trim() ? '链接已识别' : '等待链接'}</strong>
                               <em>{c.isLoading ? c.progress?.message || '正在读取当前可见转发' : c.candidateLoadError || (c.candidateLoadCompleted ? '当前登录态没有返回可见转发' : c.statusUrl.trim() ? '可以载入候选名单' : '载入后会显示符合条件的候选')}</em>
                            </span>
                          </div>
                          <footer className="intake-journey" aria-label="抽奖准备步骤">
                            <span className="blue">{I.link}<strong>载入名单</strong></span>
                            <span className="coral">{I.gift}<strong>确认奖项</strong></span>
                            <span className="mint">{I.shuffle}<strong>开始抽奖</strong></span>
                          </footer>
                        </article>
                      </div>
                    </div>
                  </div>
                  <div className="v3-intake-controls">
                    <div className="v3-link-field">
                      <label className="sr-only" htmlFor="weibo-status-url">微博链接、mid 或 bid</label>
                      <input
                        id="weibo-status-url"
                        ref={c.homeStatusInputRef}
                        value={c.statusUrl}
                        onChange={(event) => c.updateStatusInput(event.target.value)}
                        name="weiboStatusUrl"
                        autoComplete="off"
                        inputMode="url"
                        placeholder="粘贴微博正文链接、mid 或 bid…"
                      />
                      {c.statusUrl.trim() && (
                        <button
                          type="button"
                          aria-label="清空微博链接"
                          onClick={() => {
                            c.updateStatusInput('');
                            c.homeStatusInputRef.current?.focus();
                          }}
                        >
                          {I.close}
                        </button>
                      )}
                    </div>
                    <button
                      className="primary-button v3-load-button v3-primary-action"
                      type="button"
                      onClick={c.pasteAndLoadCandidates}
                      disabled={c.isLoading}
                    >
                      <span className="draw-button-icon">{c.isLoading ? I.refresh : I.link}</span>
                      <span>
                         <strong>{c.isLoading ? '正在载入候选' : c.candidateLoadError && c.statusUrl.trim() ? '重新载入候选' : c.statusUrl.trim() ? '载入候选' : '粘贴链接并载入'}</strong>
                        <small>优先使用服务器登录态</small>
                      </span>
                      {I.chevron}
                    </button>
                    <button className="v3-text-action" type="button" onClick={() => c.selectCandidateSource('manual')} disabled={c.isLoading}>
                      或手动导入候选名单
                      {I.chevron}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="draw-scene" ref={drawSceneRef}>
                    <div className="candidate-deck" ref={drawDeckRef}>
                      <article className="candidate-pass pass-under pass-coral" data-deck-card aria-hidden="true"><span /><i /></article>
                      <article className="candidate-pass pass-under pass-blue" data-deck-card aria-hidden="true"><span /><i /></article>
                      <DrawStageCard controller={c} drawState={drawState} />
                      <article className="candidate-pass winner-core" aria-hidden={!c.hasResults}>
                        <header>
                          <span>中奖结果</span>
                          {I.badgeCheck}
                        </header>
                        <div className="pass-identity">
                          <CandidateAvatar candidate={primaryWinner} className="pass-avatar" apiBase={c.apiBase} priority />
                          <span>
                            <small>{primaryResult?.prize?.name || '幸运奖'}</small>
                            <strong>{primaryWinner?.screenName || primaryWinner?.uid || '幸运用户'}</strong>
                            <em>{compactCandidateUid(primaryWinner)}</em>
                          </span>
                        </div>
                        <footer>
                          <span><small>奖项</small><strong>{primaryResult?.prize?.name || '幸运奖'}</strong></span>
                          <span><small>结果</small><strong>已记录</strong></span>
                        </footer>
                      </article>
                    </div>
                    <div className="result-rail" aria-label="中奖结果" aria-hidden={!c.hasResults}>
                      {c.hasResults && (
                        <>
                          <header>
                            <div>
                              <span>开奖结果</span>
                              <strong>{c.resultTotal} 名幸运用户</strong>
                            </div>
                            <button type="button" onClick={() => c.setSelectedReceipt(resultReceipt)}>查看结果</button>
                          </header>
                          <div className="winner-list">
                            {visibleWinners.map(({ candidate, prizeName }, index) => (
                              <button
                                type="button"
                                key={candidate.id || candidate.uid || candidate.screenName || index}
                          onClick={() => c.showStatus(compactCandidateUid(candidate), 'success', {
                                  popup: true,
                                  title: candidate.screenName || candidate.uid || '获奖用户',
                                })}
                              >
                                <CandidateAvatar candidate={candidate} className={`avatar ${['pink', 'blue', 'lilac', 'mint'][index % 4]}`} apiBase={c.apiBase} decorative />
                                <strong>{candidate.screenName || candidate.uid || `获奖用户 ${index + 1}`}</strong>
                                <small>{prizeName}</small>
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="draw-specs" aria-label="开奖准备情况">
                    <button
                      type="button"
                      className={c.showSourceEditor ? 'is-presenting' : ''}
                      data-state={c.candidateSourceReady ? 'complete' : 'pending'}
                      aria-expanded={c.showSourceEditor}
                      aria-label={`候选：${c.eligibleUserCount.toLocaleString()} 人，${c.candidateSourceReady ? '已载入' : '待载入'}`}
                      onClick={() => c.setShowSourceEditor(true)}
                    >
                      <span className="spec-icon blue">{I.users}</span>
                      <span><small>候选</small><strong>{c.eligibleUserCount.toLocaleString()}</strong></span>
                    </button>
                    <button
                      type="button"
                      className={`${c.drawSetupConfirmed ? 'is-confirmed' : ''} ${c.showPrizeEditor ? 'is-presenting' : ''}`.trim()}
                      data-state={c.drawSetupConfirmed ? 'complete' : 'pending'}
                      aria-expanded={c.showPrizeEditor}
                      aria-label={`奖项：${c.normalizedPrizes.length} 个，${c.drawSetupConfirmed ? '已确认' : '待确认'}`}
                      onClick={() => c.setShowPrizeEditor(true)}
                    >
                      <span className="spec-icon coral">{I.gift}</span>
                       <span><small>奖项</small><strong>{c.normalizedPrizes.length} 个</strong></span>
                    </button>
                    <button type="button" className={c.showFilters ? 'is-presenting' : ''} data-state="complete" aria-expanded={c.showFilters} aria-label={`筛选规则：${c.filterEnabledText}`} onClick={() => c.setShowFilters(true)}>
                      <span className="spec-icon mint">{I.badgeCheck}</span>
                      <span><small>规则</small><strong>{c.filterEnabledText}</strong></span>
                    </button>
                  </div>
                  <div className="v3-draw-count">
                    {I.shield}
                    <span>
                      <strong>{c.drawCountText}</strong>
                      {c.drawCountStatus === 'error'
                        ? <small><button type="button" className="v3-draw-count-retry" onClick={c.retryDrawCount}>点击重试</button></small>
                        : <small>仅统计成功保存的结果</small>}
                    </span>
                  </div>
                  <div className="draw-control">
                    <div className="draw-control-state draw-ready">
                      <button
                        className="primary-button v3-primary-action"
                        type="button"
                        onClick={() => c.requestDraw()}
                        disabled={c.isDrawing || c.isLoading}
                      >
                        <span className="draw-button-icon">{drawAction.icon}</span>
                        <span>
                          <strong>{drawAction.title}</strong>
                          <small>{drawAction.detail}</small>
                        </span>
                        {I.chevron}
                      </button>
                    </div>
                    <div className="draw-control-state draw-running">
                      <span className="progress-indicator" />
                      <span>
                         <small>{c.phase || '正在抽取候选'}</small>
                        <strong><RollingName fallback={c.eligible[0]?.screenName || c.eligible[0]?.uid || '候选用户'} /></strong>
                      </span>
                      <button type="button" onClick={c.cancelDraw} aria-label="停止本次开奖">
                        {I.close} 停止
                      </button>
                    </div>
                    <div className="draw-control-state draw-finished">
                      <div>
                        <span className="complete-icon">{I.check}</span>
                        <span><small>开奖完成</small><strong>{c.drawCountText}</strong></span>
                      </div>
                      <div className="result-buttons">
                        <button type="button" aria-label="设置并再次抽奖" onClick={() => c.requestDraw()}>{I.shuffle}<span>再次抽奖</span></button>
                        <button id="draw-result-trigger" type="button" className="v3-primary-action" aria-label="查看开奖结果" onClick={() => c.setSelectedReceipt(resultReceipt)}>{I.clock}<span>查看结果</span></button>
                      </div>
                    </div>
                  </div>
                </>
               )}

               {c.candidateLoadError && c.hasCandidates && (
                 <div className="v3-candidate-warning v3-candidate-warning-error" role="note">
                   {I.alert}
                   <div><strong>候选名单未更新</strong><small>{c.candidateLoadError} 上次名单仍保留，仅供查看；重新载入后才能开奖。</small></div>
                 </div>
               )}

               <CandidateLoadProgress progress={c.progress} isLoading={c.isLoading} onCancel={c.cancelCandidateLoad} />
            </section>

            <section className="content-section home-settings-section">
              <SectionTitle title="抽奖设置" />
              <div className="grouped-list">
                <AppListRow
                  id="candidate-source-row"
                  icon={I.link}
                  title="候选来源"
                  detail={sourceDetail}
                  value={c.hasCandidates ? `${c.loadedCandidateCount.toLocaleString()} 条` : '待载入'}
                  onClick={() => c.setShowSourceEditor(true)}
                />
                <AppListRow
                  icon={I.gift}
                  tone="coral"
                  title="奖项设置"
                  detail={`${c.normalizedPrizes.length} 个奖项，共 ${c.totalSlots} 个名额`}
                  onClick={() => c.setShowPrizeEditor(true)}
                />
                <AppListRow
                  icon={I.listChecks}
                  tone="mint"
                  title="筛选规则"
                  detail={c.filterSummary}
                  onClick={() => c.setShowFilters(true)}
                />
              </div>
            </section>

            <section className="content-section home-history-section">
              <SectionTitle
                title="开奖记录"
                action={c.drawHistory.length ? '查看全部' : ''}
                onAction={() => switchTab('history', { focus: true })}
              />
              {latestHistory.length ? (
                <div className="compact-records">
                  {latestHistory.map((item, index) => (
                    <button
                      type="button"
                      key={`${item.time}-${index}`}
                      onClick={() => c.setSelectedReceipt(item)}
                    >
                      <span className={`record-mark ${index ? 'blue' : 'pink'}`}>{index ? I.clock : I.gift}</span>
                      <span><strong>{item.results?.[0]?.prize?.name || '微博转发抽奖'}</strong><small>{item.total} 名获奖用户</small></span>
                      <time>{historyDateParts(item.time).compact}</time>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="v3-section-empty">
                  <span>{I.clock}</span>
                  <div><strong>暂无开奖记录</strong><small>完成开奖后将在这里显示</small></div>
                </div>
              )}
            </section>
            <div className="bottom-space" />
          </div>}
        </section>

        <section id="root-view-candidates" role="tabpanel" aria-label="名单" className={`root-view ${c.activeTab === 'candidates' ? 'is-active' : ''}`} data-root-view="candidates" hidden={c.activeTab !== 'candidates'}>
          {mountedTabs.has('candidates') && <div className="root-scroll">
            <header className="large-title">
              <span className={`title-status ${c.candidateLoadError || c.candidateWarningText ? 'warning' : c.hasCandidates ? '' : 'neutral'}`}><i /> {c.candidateLoadError ? '候选名单未更新' : c.candidateWarningText ? '名单范围需核对' : c.hasCandidates ? '名单已载入' : c.candidateLoadCompleted ? '候选检查已完成' : '尚未载入候选'}</span>
              <h1>候选名单</h1>
              <p>{c.hasCandidates ? c.candidateLoadError ? `刷新未完成：${c.candidateLoadError}` : `${c.eligibleUserCount.toLocaleString()} 人符合当前筛选规则 · ${c.candidateFreshnessText}` : c.candidateLoadError ? c.candidateLoadError : c.candidateLoadCompleted ? '当前来源没有返回可见候选，可更新名单或改用手动导入' : '从微博载入，也可手动填写或导入文件'}</p>
            </header>

            <section className="content-section v3-source-section">
              <header className="section-header source-section-header">
                <h2>{sourceFormHidden ? '名单来源' : '载入名单'}</h2>
                <div>
                  {c.hasCandidates && c.source !== 'manual' && (
                    <button type="button" onClick={() => c.safeLoadCandidates({ jumpAfterLoad: false, forceRefresh: true })} disabled={c.isLoading}>刷新</button>
                  )}
                  {c.candidateSourceReady && (
                    <button type="button" aria-controls="candidate-source-fields" aria-expanded={!sourceFormHidden} onClick={() => setSourceFormCollapsed(!sourceFormHidden)} disabled={c.isLoading}>
                      {sourceFormHidden ? '编辑来源' : '收起来源'}{I.chevron}
                    </button>
                  )}
                </div>
              </header>
              {sourceFormHidden && <p className="source-collapsed-summary">{sourceDetail} · 已载入 {c.loadedCandidateCount.toLocaleString()} 条</p>}
              <div id="candidate-source-fields" hidden={sourceFormHidden}>
                <CandidateSourceForm controller={c} variant="page" />
              </div>

              <CandidateLoadProgress progress={c.progress} isLoading={c.isLoading} onCancel={c.cancelCandidateLoad} />
            </section>

            {(c.candidateLoadError || c.candidateWarningText) && (
              <div className={`v3-candidate-warning ${c.candidateLoadError ? 'v3-candidate-warning-error' : ''}`.trim()} role="note">
                {I.alert}
                <div>
                  <strong>{c.candidateLoadError ? '候选名单未更新' : '名单范围需要核对'}</strong>
                  <small>{c.candidateLoadError || c.candidateWarningText}</small>
                </div>
              </div>
            )}

            {c.hasCandidates && (
              <>
                {c.candidateSourceReady && (
                  <div className="candidate-next-step">
                    <span><small>下一步</small><strong>{c.eligibleUserCount.toLocaleString()} 人可参与抽奖</strong></span>
                    <button type="button" className="v3-primary-action" onClick={continueToDraw} disabled={c.isLoading || c.isDrawing}>
                      {drawAction.icon}<span>{drawAction.title}</span>{I.chevron}
                    </button>
                  </div>
                )}
                <div className="search-field">
                  {I.users}
                  <input
                    type="search"
                    value={c.candidateQuery}
                    onChange={(event) => c.setCandidateQuery(event.target.value)}
                    placeholder="搜索昵称或 UID"
                    aria-label="搜索候选"
                    name="candidateSearch"
                    autoComplete="off"
                    spellCheck="false"
                  />
                  <button type="button" onClick={() => c.setShowFilters(true)} aria-label="筛选候选">{I.listChecks}</button>
                </div>
                <div className="segmented-control" role="group" aria-label="候选范围" style={{ '--segment-index': candidateSegmentIndex }}>
                  <span className="segmented-highlight" aria-hidden="true" />
                  <button type="button" className={c.candidateSegment === 'eligible' ? 'is-active' : ''} aria-pressed={c.candidateSegment === 'eligible'} onClick={() => c.setCandidateSegment('eligible')}>可抽 {c.eligible.length}</button>
                  <button type="button" className={c.candidateSegment === 'all' ? 'is-active' : ''} aria-pressed={c.candidateSegment === 'all'} onClick={() => c.setCandidateSegment('all')}>全部 {c.candidates.length}</button>
                  <button type="button" className={c.candidateSegment === 'excluded' ? 'is-active' : ''} aria-pressed={c.candidateSegment === 'excluded'} onClick={() => c.setCandidateSegment('excluded')}>已排除 {excludedCandidates.length}</button>
                </div>
              </>
            )}

            <section className="content-section candidate-section">
              <SectionTitle
                title={query ? `搜索结果 · ${matchingCandidates.length.toLocaleString()}` : '候选用户'}
                action={c.hasCandidates ? '导出当前' : ''}
                onAction={() => c.exportCandidates(matchingCandidates, evaluationByCandidate, {
                  segment: c.candidateSegment,
                  query,
                })}
              />
              {visibleCandidates.length ? (
                <div className="people-list">
                  {visibleCandidates.map((candidate, index) => {
                    const entry = evaluationByCandidate.get(candidate) || {
                      candidate,
                      eligible: true,
                      reasonLabel: '',
                    };
                    return (
                      <button
                        type="button"
                        key={`${candidate.id || candidate.uid || candidate.screenName || 'candidate'}-${index}`}
                        onClick={() => setSelectedCandidateEntry(entry)}
                      >
                        <CandidateAvatar candidate={candidate} className="candidate-avatar-list" apiBase={c.apiBase} decorative />
                        <span>
                          <strong>{candidate.screenName || candidate.uid || `候选用户 ${index + 1}`}</strong>
                          <small>{candidate.uid ? `UID ${candidate.uid}` : friendlyProviderText(candidate.source) || '候选名单'}</small>
                        </span>
                        <span className={entry.eligible ? 'status-badge' : 'status-badge is-excluded'}>
                          {entry.eligible ? '可抽' : entry.reasonLabel}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="v3-section-empty v3-candidate-empty">
                  <span>{I.users}</span>
                  <div>
                    <strong>{c.hasCandidates ? '没有匹配的候选用户' : c.candidateLoadError ? '候选载入未完成' : c.candidateLoadCompleted ? '没有找到可见候选' : '候选名单为空'}</strong>
                    <small>{c.hasCandidates ? '调整搜索或筛选条件后再查看' : c.candidateLoadError ? '请重新载入候选名单后再继续' : c.candidateLoadCompleted ? '可以更新当前来源，或切换为手动名单' : '载入名单后，候选用户会显示在这里'}</small>
                    {!c.hasCandidates && (
                      <button className="v3-empty-action" type="button" onClick={() => c.selectCandidateSource('manual')}>
                        手动导入名单 {I.chevron}
                      </button>
                    )}
                  </div>
                </div>
              )}
              {remainingCandidates > 0 && (
                <div className="candidate-load-more">
                  <span>已显示 {visibleCandidates.length.toLocaleString()} / {matchingCandidates.length.toLocaleString()} · 开奖使用完整名单</span>
                  <button
                    type="button"
                    onClick={() => setCandidateLimit((current) => current + CANDIDATE_PAGE_SIZE)}
                  >
                    继续显示 {Math.min(CANDIDATE_PAGE_SIZE, remainingCandidates).toLocaleString()} 条
                  </button>
                </div>
              )}
              {!remainingCandidates && searchOnlyCandidates > 0 && (
                <div className="candidate-load-more" role="note">
                  <span>已显示前 {CANDIDATE_RENDER_LIMIT.toLocaleString()} 条，搜索或导出可查看完整名单；开奖仍使用完整可抽名单</span>
                </div>
              )}
            </section>
            <div className="bottom-space" />
          </div>}
        </section>

        <section id="root-view-history" role="tabpanel" aria-label="记录" className={`root-view ${c.activeTab === 'history' ? 'is-active' : ''}`} data-root-view="history" hidden={c.activeTab !== 'history'}>
          {mountedTabs.has('history') && <div className="root-scroll">
            <header className="large-title">
              <span className="title-status neutral"><i /> {c.historyStorageAvailable ? '本机保存的开奖结果' : '当前页面的开奖结果'}</span>
              <h1>开奖记录</h1>
              <p>{c.drawHistory.length ? `共 ${c.drawHistory.length} 次开奖，${totalHistoricWinners} 名获奖用户${c.drawHistory.length >= DRAW_HISTORY_LIMIT ? ` · 保留最近 ${DRAW_HISTORY_LIMIT} 条` : ''}` : c.historyStorageAvailable ? '完成开奖后，记录会保存在当前浏览器' : '本机存储不可用，完成开奖后仅在当前页面显示'}</p>
            </header>

            <section className="history-summary">
              <div><span>总开奖</span><strong>{c.drawHistory.length}</strong><small>次</small></div>
              <div><span>获奖用户</span><strong>{totalHistoricWinners}</strong><small>人</small></div>
              <div><span>最近开奖</span><strong>{historyDateParts(c.drawHistory[0]?.time).compact}</strong><small>{historyDateParts(c.drawHistory[0]?.time).time}</small></div>
            </section>

            <section className="content-section">
              <SectionTitle title={historySearch ? `搜索记录 · ${filteredHistory.length}` : '全部记录'} />
              {c.drawHistory.length > 2 && (
                <div className="search-field history-search-field">
                  {I.clock}
                  <input
                    type="search"
                    value={c.historyQuery}
                    onChange={(event) => c.setHistoryQuery(event.target.value)}
                    placeholder="搜索奖项、昵称或微博链接"
                    aria-label="搜索开奖记录"
                    name="historySearch"
                    autoComplete="off"
                  />
                  {historySearch && (
                    <button type="button" aria-label="清除记录搜索" onClick={() => c.setHistoryQuery('')}>{I.close}</button>
                  )}
                </div>
              )}
              {visibleHistory.length ? (
                <>
                  <div className="history-list">
                    {visibleHistory.map((item, index) => {
                      const date = historyDateParts(item.time);
                      return (
                        <button
                          type="button"
                          key={`${item.time}-${index}`}
                          onClick={() => c.setSelectedReceipt(item)}
                        >
                          <span className={`date-block ${index % 3 === 1 ? 'blue' : index % 3 === 2 ? 'mint' : ''}`}>
                            <strong>{date.day}</strong><small>{date.month} 月</small>
                          </span>
                          <span><strong>{item.results?.[0]?.prize?.name || '微博转发抽奖'}</strong><small>{item.results?.length || 1} 个奖项 · {item.total} 名获奖用户</small></span>
                          {I.chevron}
                        </button>
                      );
                    })}
                  </div>
                  {filteredHistory.length > 3 && (
                    <button className="show-more-button" type="button" onClick={() => c.setHistoryExpanded((value) => !value)}>
                      {c.historyExpanded ? '收起较早记录' : `展开全部 ${filteredHistory.length} 条`}
                    </button>
                  )}
                </>
              ) : (
                <div className="v3-section-empty v3-history-empty">
                  <span>{I.clock}</span>
                  <div>
                    <strong>{historySearch ? '没有匹配的记录' : '暂无开奖记录'}</strong>
                    <small>{historySearch ? '换个奖项、昵称或链接关键词试试' : '完成一次抽奖后再来查看'}</small>
                    {!historySearch && (
                      <button className="v3-empty-action" type="button" onClick={() => switchTab('home', { focus: true })}>
                        去抽奖 {I.chevron}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </section>
            <div className="bottom-space" />
          </div>}
        </section>

        <section id="root-view-more" role="tabpanel" aria-label="更多" className={`root-view ${c.activeTab === 'more' ? 'is-active' : ''}`} data-root-view="more" hidden={c.activeTab !== 'more'}>
          {mountedTabs.has('more') && <div className="root-scroll">
            <header className="large-title more-title">
              <h1>更多</h1>
              <p>连接设置、数据管理与使用说明</p>
            </header>

            <button className="app-summary" type="button" onClick={() => c.openLegalDocument('about')}>
              <img src={publicAsset('avatar-96.webp')} alt="" width="72" height="72" />
              <span><strong>微博转发抽奖</strong><small>版本 {APP_VERSION} · by.sameko</small></span>
              <em>关于</em>
              {I.chevron}
            </button>

            <section className="content-section">
              <SectionTitle title="数据与连接" />
              <div className="grouped-list">
                <AppListRow icon={I.clock} tone="coral" title="本机记录" detail={c.historyStorageAvailable ? `保存在当前浏览器的最近 ${DRAW_HISTORY_LIMIT} 条开奖记录` : '本机存储不可用，仅保留当前页面记录'} value={`${c.drawHistory.length} 条`} onClick={() => switchTab('history', { focus: true })} />
                <AppListRow icon={I.badgeCheck} title="备用 Cookie" detail="服务器登录态失效时临时顶替" value={c.mobileCookie.trim() ? '已填写' : '未填写'} onClick={() => c.openSettings('cookie')} />
                <AppListRow icon={I.refresh} tone="mint" title="后端连接" detail="名单、开奖记录与头像服务" value={c.serviceStatusText} onClick={() => c.openSettings('backend')} />
              </div>
            </section>

            <section className="content-section">
              <SectionTitle title="偏好与帮助" />
              <div className="grouped-list">
                <AppListRow icon={I.settings} tone="lilac" title="数据设置" detail="导出备份、清理记录与界面动效" onClick={() => c.openSettings('records')} />
                <AppListRow id="display-mode-entry" icon={I.expand}
                  title={displayMode.standalone ? '显示模式' : displayMode.fullscreen ? '退出全屏' : displayMode.supported ? '全屏显示' : '添加到主屏幕'}
                  detail={displayMode.standalone ? '已从主屏幕打开' : '隐藏浏览器工具栏，留出更多操作空间'}
                  onClick={async () => {
                    if (displayMode.standalone || !displayMode.supported || !(await displayMode.toggle())) setShowDisplayGuide(true);
                  }} />
                <AppListRow icon={I.book} tone="coral" title="使用教程" detail="从载入候选到保存结果" onClick={() => c.setShowGuide(true)} />
                <AppListRow icon={I.feedback} tone="mint" title="意见反馈" detail="提交建议或报告使用问题" onClick={() => c.openFeedback()} />
              </div>
            </section>

            <section className="content-section">
              <SectionTitle title="法律与许可" />
              <div className="grouped-list">
                <AppListRow icon={I.shield} title="隐私政策" detail="处理的信息、保存期限与你的权利" onClick={() => c.openLegalDocument('privacy')} />
                <AppListRow icon={I.listChecks} tone="mint" title="使用规则" detail="功能边界、平台规则与禁止用途" onClick={() => c.openLegalDocument('terms')} />
                <AppListRow icon={I.alert} tone="coral" title="免责声明" detail="服务边界与责任划分" onClick={() => c.openLegalDocument('disclaimer')} />
                <AppListRow icon={I.info} tone="lilac" title="版权说明" detail="内容归属与素材授权" onClick={() => c.openLegalDocument('copyright')} />
                <AppListRow icon={I.file} tone="gray" title="第三方许可" detail="开源组件清单与许可文本" onClick={() => c.openLegalDocument('licenses')} />
              </div>
            </section>
            <div className="bottom-space" />
          </div>}
        </section>
      </main>

      <nav className="root-tabbar glass" role="tablist" inert={contentInert ? '' : undefined} aria-label="主要导航" aria-orientation="horizontal" onKeyDown={handleTabListKeyDown} style={{ '--tab-index': tabIndex }}>
        <span className="tab-highlight" aria-hidden="true" />
        <button data-tab-target="home" role="tab" tabIndex={c.activeTab === 'home' ? 0 : -1} aria-selected={c.activeTab === 'home'} className={c.activeTab === 'home' ? 'is-active' : ''} type="button" aria-controls="root-view-home" onClick={() => switchTab('home')}>
          <span className="tab-symbol" aria-hidden="true">{I.gift}</span><span className="tab-label">抽奖</span>
        </button>
        <button data-tab-target="candidates" role="tab" tabIndex={c.activeTab === 'candidates' ? 0 : -1} aria-selected={c.activeTab === 'candidates'} className={c.activeTab === 'candidates' ? 'is-active' : ''} type="button" aria-controls="root-view-candidates" onClick={() => switchTab('candidates')}>
          <span className="tab-symbol" aria-hidden="true">{I.users}</span><span className="tab-label">名单</span>
        </button>
        <button data-tab-target="history" role="tab" tabIndex={c.activeTab === 'history' ? 0 : -1} aria-selected={c.activeTab === 'history'} className={c.activeTab === 'history' ? 'is-active' : ''} type="button" aria-controls="root-view-history" onClick={() => switchTab('history')}>
          <span className="tab-symbol" aria-hidden="true">{I.clock}</span><span className="tab-label">记录</span>
        </button>
        <button data-tab-target="more" role="tab" tabIndex={c.activeTab === 'more' ? 0 : -1} aria-selected={c.activeTab === 'more'} className={c.activeTab === 'more' ? 'is-active' : ''} type="button" aria-controls="root-view-more" onClick={() => switchTab('more')}>
          <span className="tab-symbol" aria-hidden="true">{I.more}</span><span className="tab-label">更多</span>
        </button>
      </nav>

      {c.showGuide && <GuideSheet onClose={() => c.setShowGuide(false)} />}
      {c.showFeedback && <FeedbackSheet key={c.feedbackInitialCategory} initialCategory={c.feedbackInitialCategory} onClose={() => c.setShowFeedback(false)} onSubmit={c.submitFeedback} />}
      {c.legalDocument && <LegalSheet document={c.legalDocument} onClose={() => c.setLegalDocument(null)} onOpenPrivacyRequest={() => c.openFeedback('privacy')} onOpenUpdates={() => c.openLegalDocument('updates')} />}
      {c.showDrawConfirm && (
        <DrawConfirmSheet
          previousDrawCount={c.previousDrawCount}
          candidateSummary={c.candidateSummary}
          source={c.source}
          onEditPrizes={() => c.setShowPrizeEditor(true)}
          nextDrawText={c.nextDrawText}
          candidateLoadError={c.candidateLoadError}
          candidateWarningText={c.candidateWarningText}
          eligibleCount={c.eligibleUserCount}
          totalSlots={c.totalSlots}
          candidateNeedsRefresh={c.candidateNeedsRefresh}
          candidateCutoffLabel={c.candidateCutoffLabel}
          filterSummary={c.filterSummary}
          prizes={c.normalizedPrizes}
          cooldownPersistent={c.cooldownPersistent}
          onClose={() => c.setShowDrawConfirm(false)}
          onConfirm={confirmDraw}
          onPractice={practiceDraw}
          onRefresh={() => c.safeLoadCandidates({ jumpAfterLoad: false, forceRefresh: true })}
        />
      )}

      {c.showSourceEditor && (
        <SheetFrame
          title="候选来源"
          subtitle={sourceDetail}
          icon={I.link}
          onClose={() => c.setShowSourceEditor(false)}
          className="v3-editor-sheet v3-source-sheet"
          returnFocusId="candidate-source-row"
          footer={(close) => (
            <div className="source-sheet-next">
              {c.hasCandidates && (
                <p>{c.candidateSourceReady
                  ? `已载入 ${c.loadedCandidateCount.toLocaleString()} 条 · ${c.eligibleUserCount.toLocaleString()} 人可抽`
                  : '来源内容已变更或尚未载入成功，请先重新载入。'}</p>
              )}
              <div className={c.candidateSourceReady ? 'source-sheet-actions has-next' : 'source-sheet-actions'}>
                <button type="button" className={c.candidateSourceReady ? 'source-sheet-done' : 'flow-sheet-primary v3-primary-action'} onClick={() => close()}>完成</button>
                {c.candidateSourceReady && (
                  <button type="button" className="flow-sheet-primary v3-primary-action" onClick={() => close(continueToDraw)} disabled={c.isLoading || c.isDrawing}>
                    {drawAction.icon}<span>{drawAction.title}</span>{I.chevron}
                  </button>
                )}
              </div>
            </div>
          )}
        >
          {() => <CandidateSourceForm controller={c} variant="sheet" />}
        </SheetFrame>
      )}

      {c.showPrizeEditor && (
        <SheetFrame
          title="奖项设置"
          tone="coral"
          subtitle={`${c.normalizedPrizes.length} 个奖项 · ${c.totalSlots} 个名额`}
          icon={I.gift}
          onClose={() => c.setShowPrizeEditor(false)}
          className="v3-editor-sheet"
          initialFocusRef={c.firstPrizeNameRef}
          footer={(close) => (
            <button
              type="button"
              className="flow-sheet-primary v3-primary-action v3-prize-confirm-button"
              onClick={() => {
                if (c.confirmDrawSetup()) close(() => c.setShowDrawConfirm(true));
              }}
              disabled={!c.hasCandidates || !c.candidateSourceReady}
            >
              {I.check}
              <span>{!c.hasCandidates ? '载入候选后确认' : c.candidateSourceReady ? '确认奖项设置' : '载入当前来源后确认'}</span>
            </button>
          )}
        >
          {() => (
            <>
          <div className="v3-sheet-toolbar">
            <span>按顺序依次抽取</span>
            <button
              type="button"
              onClick={c.addPrize}
              disabled={c.prizes.length >= MAX_DRAW_RESULT_GROUPS}
              title={c.prizes.length >= MAX_DRAW_RESULT_GROUPS ? `最多 ${MAX_DRAW_RESULT_GROUPS} 个奖项` : undefined}
            >{I.plus} 添加奖项</button>
          </div>
          <div className="v3-prize-list">
            {c.prizes.map((prize, index) => (
              <section className="v3-prize-item" key={index}>
                <span className="v3-prize-number" style={{ '--prize-color': prize.color || COLORS[index % COLORS.length] }}>{index + 1}</span>
                <div>
                  <label>
                    <span>奖项名称</span>
                    <input
                      ref={index === 0 ? c.firstPrizeNameRef : null}
                      value={prize.name}
                      onChange={(event) => c.updatePrize(index, { name: event.target.value })}
                      name={`prizeName-${index}`}
                      placeholder="例如：一等奖 / 幸运奖"
                    />
                  </label>
                  <div className="v3-prize-footer">
                    <span>中奖人数</span>
                    <div className="v3-stepper">
                      <button
                        type="button"
                        aria-label={`减少第 ${index + 1} 个奖项名额`}
                        onClick={() => c.updatePrizeCount(index, Number(prize.count || 1) - 1)}
                        disabled={Number(prize.count || 1) <= 1}
                      >
                        {I.minus}
                      </button>
                      <input
                        type="number"
                        min="1"
                        max={MAX_DRAW_WINNERS}
                        inputMode="numeric"
                        value={prize.count}
                        onChange={(event) => c.updatePrizeCount(index, event.target.value)}
                        onBlur={() => c.commitPrizeCount(index)}
                        aria-label={`第 ${index + 1} 个奖项中奖人数`}
                      />
                      <button
                        type="button"
                        aria-label={`增加第 ${index + 1} 个奖项名额`}
                        onClick={() => c.updatePrizeCount(index, Number(prize.count || 1) + 1)}
                        disabled={Number(prize.count || 1) >= MAX_DRAW_WINNERS}
                      >
                        {I.plus}
                      </button>
                    </div>
                    <button
                      className="v3-delete-prize"
                      type="button"
                      aria-label={`删除第 ${index + 1} 个奖项`}
                      onClick={() => c.removePrize(index)}
                      disabled={c.prizes.length <= 1}
                    >
                      {I.trash}
                    </button>
                  </div>
                </div>
              </section>
            ))}
          </div>
          <div className="v3-prize-confirm-summary">
            <span>{I.users}<small>可抽候选</small><strong>{c.eligibleUserCount.toLocaleString()} 人</strong></span>
            <span>{I.gift}<small>中奖名额</small><strong>{c.totalSlots} 人</strong></span>
          </div>
            </>
          )}
        </SheetFrame>
      )}

      {c.showFilters && (
        <FilterEditorSheet
          values={{
            keyword: c.keyword,
            mentionMin: c.mentionMin,
            blocklist: c.blocklist,
            uniqueByUser: c.uniqueByUser,
            excludePrevious: c.excludePrevious,
          }}
          onApply={c.applyFilterDraft}
          onClose={() => c.setShowFilters(false)}
        />
      )}

      {c.showSettings && (
        <SettingsSheet
          apiHealth={c.apiHealth}
          apiHealthDetail={c.apiHealthDetail}
          cookieHealth={c.cookieHealth}
          loadCookieStatus={c.loadCookieStatus}
          accountStatusText={c.accountStatusText}
          apiAuthRequired={c.apiAuthRequired}
          apiBaseInput={c.apiBaseInput}
          apiKey={c.apiKey}
          backendAddressEditorOpen={c.backendAddressEditorOpen}
          drawHistory={c.drawHistory}
          exportHistoryBackup={c.exportHistoryBackup}
          historyImportInputRef={c.historyImportInputRef}
          isImportingHistory={c.isImportingHistory}
          importHistoryBackup={c.importHistoryBackup}
          mobileCookie={c.mobileCookie}
          motionPreference={c.motionPreference}
          openBackendAddressEditor={c.openBackendAddressEditor}
          saveBackendAddress={c.saveBackendAddress}
          serviceStatusText={c.serviceStatusText}
          setApiBaseInput={c.setApiBaseInput}
          setApiKey={c.setApiKey}
          setConfirmAction={c.setConfirmAction}
          setMobileCookie={c.setMobileCookie}
          setMotionPreference={c.setMotionPreference}
          setShowSettings={c.setShowSettings}
          settingsTarget={c.settingsTarget}
          showStatus={c.showStatus}
          testApiConnection={c.testApiConnection}
          usePresetBackend={c.usePresetBackend}
        />
      )}

      <DrawResultSheet
        key={c.selectedReceipt?.drawnAt || 'no-result'}
        receipt={c.selectedReceipt}
        apiBase={c.apiBase}
        isCapturing={c.isCapturing}
        isSyncing={c.syncingReceiptIds.has(c.selectedReceipt?.id)}
        historyStorageAvailable={c.historyStorageAvailable}
        returnFocusId="draw-result-trigger"
        onClose={() => c.setSelectedReceipt(null)}
        onSaveImage={() => c.createShareImage(c.selectedReceipt)}
        onCopyPost={(template) => c.copyReceiptPost(c.selectedReceipt, template)}
        onCopyFairness={() => c.copyReceiptFairness(c.selectedReceipt)}
        onCopyWinners={() => c.copyReceiptWinners(c.selectedReceipt)}
        onExportWinners={() => c.exportReceiptWinners(c.selectedReceipt)}
        onRetrySave={() => c.retrySaveReceipt(c.selectedReceipt)}
      />
      <CandidateDetailSheet
        entry={selectedCandidateEntry}
        apiBase={c.apiBase}
        onClose={() => setSelectedCandidateEntry(null)}
        onCopy={c.copyToClipboard}
      />
    </div>
  );
}
