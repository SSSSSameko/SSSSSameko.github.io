import { diagnosticEvents, filterDiagnosticEvents, crawlTraces, sourceEvidence, diagnosticCount, stopLabel, diagnosticReport } from './admin-diagnostics.js';
import { DIAGNOSTIC_CATEGORY_LABELS, normalizeDiagnosticLevel } from './diagnostics.js';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = (value) => diagnosticCount(value) === null ? '未记录' : Number(value).toLocaleString('zh-CN');
const date = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录';
const duration = (value) => diagnosticCount(value) === null ? '未记录' : `${(Number(value) / 1000).toFixed(1)} 秒`;
const pairs = (items) => `<dl class="evidence-grid">${items.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>`;

export function sourceEvidenceHtml(meta) {
  if (!meta || !Object.values(meta).some((value) => value !== null && value !== '' && (!Array.isArray(value) || value.length))) {
    return '<section class="source-evidence"><h3>名单来源</h3><p class="diagnostic-hint">这条记录未保存抓取诊断信息。</p></section>';
  }
  const data = sourceEvidence(meta);
  return `<section class="source-evidence"><div class="panel-head"><h3>名单来源</h3><span class="badge neutral">${escape(data.label)}</span></div>
    ${pairs([['接口声明总数', data.total === null ? '未知' : number(data.total)], ['已载入', number(data.visible)],
      ['数量缺口', data.missing === null ? '未知' : `${number(data.missing)}${data.percent === null ? '' : ` · ${data.percent.toFixed(1)}%`}`],
      ['容差条数', number(meta.tolerance)], ['标识不确定', number(meta.identityUncertainCount)], ['载入时间', date(meta.loadedAt)],
      ['停止原因', stopLabel(meta.stopReason)], ['使用渠道', (Array.isArray(meta.providers) && meta.providers.length ? meta.providers : [meta.provider]).filter(Boolean).join(' → ') || '未记录']])}
    <p class="diagnostic-hint">接口数量与实际可见名单可能有差异；容差停止不表示名单完整。</p>
    ${meta.crawlId ? `<button class="secondary-button trace-link" type="button" data-crawl-id="${escape(meta.crawlId)}">查看关联抓取过程</button><p class="trace-id">${escape(meta.crawlId)}</p>` : ''}</section>`;
}

function preserveContent(element, html) {
  const open = new Set([...element.querySelectorAll('details[open][data-preserve]')].map((item) => item.dataset.preserve));
  const focused = element.contains(document.activeElement) ? document.activeElement.closest('[data-preserve]')?.dataset.preserve : null;
  const top = window.scrollY;
  element.innerHTML = html;
  for (const item of element.querySelectorAll('details[data-preserve]')) {
    item.open = open.has(item.dataset.preserve);
    if (focused === item.dataset.preserve) item.querySelector('summary')?.focus({ preventScroll: true });
  }
  if (focused) window.scrollTo({ top, behavior: 'instant' });
}

export function createDiagnosticsView({ eventHtml, goTab, notify }) {
  const $ = (id) => document.getElementById(id);
  const icons = {
    overview: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    records: '<path d="M8 4H5v17h14V4h-3M8 3h8v4H8ZM8 12h8m-8 4h5"/>',
    feedback: '<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3H3V6a2 2 0 0 1 2-2ZM7 9h10M7 13h6"/>',
    cookie: '<path d="m8 12 3 3 5-6M12 3l8 4v5c0 5-8 9-8 9s-8-4-8-9V7Z"/>',
    system: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  };
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.insertAdjacentHTML('afterbegin', `<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">${icons[button.dataset.tab] || ''}</svg>`);
  });
  const syncKeyboard = () => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    document.body.classList.toggle('admin-keyboard-open', Boolean(typing && window.visualViewport
      && window.visualViewport.scale === 1 && window.innerHeight - window.visualViewport.height > 120));
  };
  window.visualViewport?.addEventListener('resize', syncKeyboard);
  document.addEventListener('focusin', syncKeyboard);
  document.addEventListener('focusout', () => requestAnimationFrame(syncKeyboard));
  const filters = ['eventSearch', 'eventLevel', 'eventCategory', 'eventHours'].map($);
  let summary = {};
  let events = [];
  let eventLimit = 30;
  let crawlLimit = 15;
  let exactCrawl = '';
  let sessionRevision = 0;
  $('eventCategory').insertAdjacentHTML('beforeend', Object.entries(DIAGNOSTIC_CATEGORY_LABELS)
    .map(([value, label]) => `<option value="${escape(value)}">${escape(label)}</option>`).join(''));

  function section(name, focus = false) {
    if (!['events', 'crawls', 'resources', 'security'].includes(name)) return;
    document.querySelectorAll('[data-system-tab]').forEach((button) => {
      const active = button.dataset.systemTab === name;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus({ preventScroll: true });
    });
    document.querySelectorAll('[data-system-view]').forEach((panel) => { panel.hidden = panel.dataset.systemView !== name; });
  }
  function filtered() {
    return filterDiagnosticEvents(events, { query: filters[0].value, level: filters[1].value,
      category: filters[2].value, hours: filters[3].value, now: Date.parse(summary.system?.now) || Date.now() });
  }
  function renderEvents() {
    const items = filtered();
    $('eventResults').textContent = `匹配 ${items.length} / ${events.length} 条 · 已显示 ${Math.min(eventLimit, items.length)} 条`;
    preserveContent($('systemEventPanel'), items.length ? items.slice(0, eventLimit).map((item) => eventHtml(item)).join('')
      : '<div class="empty-list">没有匹配的近期事件。可以清除筛选或刷新数据。</div>');
    $('moreEventsBtn').hidden = items.length <= eventLimit;
  }
  function traceHtml(trace) {
    const result = trace.result;
    const evidence = sourceEvidence(result || {});
    return `<details class="crawl-card" data-preserve="${escape(trace.id)}"><summary>
      <span class="crawl-symbol" aria-hidden="true">↗</span><span class="crawl-heading"><strong>微博 ${escape(trace.statusId || '编号未记录')}</strong><small>${escape(date(trace.at))} · ${trace.steps.length} 条渠道事件</small></span>
      <span class="badge ${result?.complete === false ? 'partial' : 'neutral'}">${result ? escape(evidence.label) : '缺少最终结果'}</span></summary>
      <div class="crawl-body"><p class="trace-id">抓取编号 ${escape(trace.id)}</p>
      ${result ? pairs([['接口声明总数', evidence.total === null ? '未知' : number(evidence.total)], ['实际载入', number(evidence.visible)],
        ['数量缺口', evidence.missing === null ? '未知' : `${number(evidence.missing)}${evidence.percent === null ? '' : ` · ${evidence.percent.toFixed(1)}%`}`],
        ['总耗时', duration(result.durationMs)], ['停止原因', stopLabel(result.stopReason)], ['容差条数', number(result.tolerance)]])
        : '<p class="diagnostic-hint">当前保留窗口内没有最终结果事件，不能据此判断任务仍在运行或已经成功。</p>'}
      <ol class="provider-steps">${trace.steps.map((event) => {
        const data = event.details || {};
        return `<li><div class="provider-heading"><strong>${escape(data.provider || '渠道未记录')}</strong><span class="badge ${event.action === 'provider-error' ? 'partial' : 'neutral'}">${event.action === 'provider-error' ? '渠道异常' : '返回结果'}</span></div>
          ${pairs([['返回', number(data.visibleNumber)], ['真实新增', number(data.addedCount)], ['重复', number(data.duplicateCount)], ['页数', number(data.pages)], ['耗时', duration(data.durationMs)], ['扫描停止', stopLabel(data.scanStopReason)]])}
          ${eventHtml(event)}</li>`;
      }).join('') || '<li class="diagnostic-hint">当前窗口内没有渠道明细。</li>'}</ol></div></details>`;
  }
  function renderCrawls() {
    const query = $('crawlSearch').value.trim().toLowerCase();
    const traces = crawlTraces(events);
    const items = traces.filter((trace) => exactCrawl ? trace.id === exactCrawl : `${trace.id} ${trace.statusId}`.toLowerCase().includes(query));
    $('crawlCount').textContent = `${items.length} / ${traces.length} 个任务`;
    preserveContent($('crawlList'), items.length ? items.slice(0, crawlLimit).map(traceHtml).join('')
      : '<div class="empty-list">当前保留窗口内未找到关联任务。较早日志可能已经轮转，旧事件也可能没有抓取编号。</div>');
    $('moreCrawlsBtn').hidden = items.length <= crawlLimit;
  }
  function renderAttention() {
    const cookie = summary.cookie || {};
    const memory = summary.system?.memory || {};
    const max = diagnosticCount(summary.system?.service?.memoryMaxMb);
    const current = diagnosticCount(memory.cgroupCurrentMb);
    const cards = [];
    if (diagnosticCount(cookie.verifiedAccountCount) === 0) cards.push(['cookie', '登录态待检查', '暂无已验证账号，抓取前请检查 Cookie。', 'warning']);
    else if (Number(cookie.checkFailedAccountCount) > 0) cards.push(['cookie', 'Cookie 校验异常', `${number(cookie.checkFailedAccountCount)} 个账号最近校验异常，可查看保活记录。`, 'warning']);
    if (max > 0 && current !== null && current / max >= .85) cards.push(['resources', '服务内存偏高', `当前占上限 ${(current / max * 100).toFixed(1)}%。`, 'warning']);
    const errors = events.filter((event) => ['error', 'critical'].includes(normalizeDiagnosticLevel(event.level ?? event.status)));
    if (errors.length) cards.push(['events', '近期异常', `${errors.length} 条错误或严重事件，查看发生时间与技术详情。`, 'error']);
    if (!cards.length) cards.push(['events', '查看运行事件', `近期保留 ${events.length} 条事件；其他服务指标见下方。`, 'info']);
    $('attentionPanel').innerHTML = cards.map(([target, title, text, tone]) => `<button class="attention-item ${tone}" type="button" data-diagnostic-destination="${target}"><span class="attention-symbol" aria-hidden="true">${tone === 'info' ? 'i' : '!'}</span><span><strong>${title}</strong><small>${text}</small></span><span aria-hidden="true">›</span></button>`).join('');
  }
  filters.forEach((input) => input.addEventListener(input.tagName === 'INPUT' ? 'input' : 'change', () => { eventLimit = 30; renderEvents(); }));
  $('clearEventFilters').addEventListener('click', () => { filters.forEach((input) => { input.value = ''; }); eventLimit = 30; renderEvents(); });
  $('moreEventsBtn').addEventListener('click', () => { eventLimit += 30; renderEvents(); });
  $('moreCrawlsBtn').addEventListener('click', () => { crawlLimit += 15; renderCrawls(); });
  $('crawlSearch').addEventListener('input', () => { exactCrawl = ''; crawlLimit = 15; renderCrawls(); });
  $('copyDiagnosticsBtn').addEventListener('click', async () => {
    const button = $('copyDiagnosticsBtn');
    const revision = sessionRevision;
    button.disabled = true;
    try { await navigator.clipboard.writeText(diagnosticReport(filtered(), summary.version)); if (revision === sessionRevision) notify('已复制诊断摘要（不含原始日志或凭据）'); }
    catch { if (revision === sessionRevision) notify('复制失败，请允许剪贴板权限后重试'); }
    finally { button.disabled = false; }
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-system-tab], [data-diagnostic-destination], [data-crawl-id]');
    if (!button) return;
    if (button.dataset.crawlId) {
      exactCrawl = button.dataset.crawlId;
      $('crawlSearch').value = exactCrawl;
      goTab('system'); section('crawls', true); renderCrawls();
      $('crawlList').querySelector('details')?.setAttribute('open', '');
      $('diagnostic-crawls').scrollIntoView({ block: 'start', behavior: 'instant' });
    } else if (button.dataset.diagnosticDestination === 'cookie') goTab('cookie', { focus: true });
    else {
      if (button.dataset.diagnosticDestination) goTab('system');
      section(button.dataset.systemTab || button.dataset.diagnosticDestination, true);
    }
  });
  document.querySelector('.system-tabs').addEventListener('keydown', (event) => {
    const buttons = [...document.querySelectorAll('[data-system-tab]')];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    section(buttons[next].dataset.systemTab, true);
  });
  return {
    update(value) {
      summary = value || {}; events = diagnosticEvents(summary.system?.events);
      $('diagnosticWindow').textContent = `近期 ${events.length} 条事件（非全量历史）`;
      renderEvents(); renderCrawls(); renderAttention();
    },
    reset() {
      sessionRevision += 1;
      summary = {}; events = []; exactCrawl = ''; eventLimit = 30; crawlLimit = 15;
      filters.forEach((input) => { input.value = ''; }); $('crawlSearch').value = '';
      $('systemEventPanel').replaceChildren(); $('crawlList').replaceChildren(); $('attentionPanel').replaceChildren();
      $('eventResults').textContent = ''; $('crawlCount').textContent = '0 个任务'; section('events');
    },
  };
}
