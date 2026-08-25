import { listDisplayState } from './admin-list-state.js';

(() => {
  const ATTEMPT_VISIBLE_LIMIT = 5;
  const state = {
    username: '',
    csrfToken: '',
    sessionExpiresAt: '',
    summary: null,
    draws: [],
    feedback: [],
    feedbackFilter: 'all',
    selected: null,
    search: '',
    detailOpen: false,
    attemptsExpanded: false,
    pendingDeleteFile: '',
    loading: false,
    loginPoller: null,
    summaryPoller: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    loginPanel: $('loginPanel'),
    dashboard: $('dashboard'),
    loginForm: $('loginForm'),
    usernameInput: $('usernameInput'),
    passwordInput: $('passwordInput'),
    passwordToggle: $('passwordToggle'),
    loginBtn: $('loginBtn'),
    loginMessage: $('loginMessage'),
    refreshBtn: $('refreshBtn'),
    logoutBtn: $('logoutBtn'),
    topbarStatus: $('topbarStatus'),
    topbarActions: $('topbarActions'),
    topStatusLight: $('topStatusLight'),
    accountLabel: $('accountLabel'),
    lastUpdated: $('lastUpdated'),
    heroSubtitle: $('heroSubtitle'),
    healthPill: $('healthPill'),
    metricGrid: $('metricGrid'),
    memoryChart: $('memoryChart'),
    memoryInsight: $('memoryInsight'),
    requestPanel: $('requestPanel'),
    eventPanel: $('eventPanel'),
    systemEventPanel: $('systemEventPanel'),
    searchInput: $('searchInput'),
    exportAllBtn: $('exportAllBtn'),
    recordCount: $('recordCount'),
    recordList: $('recordList'),
    detailPanel: $('detailPanel'),
    detailContent: $('detailContent'),
    detailClose: $('detailClose'),
    feedbackCount: $('feedbackCount'),
    feedbackFilters: $('feedbackFilters'),
    feedbackList: $('feedbackList'),
    attemptList: $('attemptList'),
    cookieBox: $('cookieBox'),
    startWeiboLoginBtn: $('startWeiboLoginBtn'),
    refreshWeiboCookieBtn: $('refreshWeiboCookieBtn'),
    stopWeiboLoginBtn: $('stopWeiboLoginBtn'),
    weiboLoginBadge: $('weiboLoginBadge'),
    weiboLoginText: $('weiboLoginText'),
    qrFrame: $('qrFrame'),
    qrImage: $('qrImage'),
    keepalivePanel: $('keepalivePanel'),
    systemPanel: $('systemPanel'),
    confirmDialog: $('confirmDialog'),
    confirmCancelBtn: $('confirmCancelBtn'),
    confirmDeleteBtn: $('confirmDeleteBtn'),
    toast: $('toast'),
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function plain(value, fallback = '-') {
    const text = String(value ?? '').trim();
    return text || fallback;
  }

  function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString('zh-CN') : '-';
  }

  function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return plain(value);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatDurationMs(value) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0) return '-';
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (ms % day === 0) return `${ms / day} 天`;
    if (ms % hour === 0) return `${ms / hour} 小时`;
    if (ms % minute === 0) return `${ms / minute} 分钟`;
    return `${Math.round(ms / 1000)} 秒`;
  }

  function formatFileSize(value) {
    const size = Number(value);
    if (!Number.isFinite(size) || size <= 0) return '-';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
    return `${Math.round(size / 1024 / 102.4) / 10} MB`;
  }

  function formatMemoryMb(value) {
    const mb = Number(value);
    if (!Number.isFinite(mb)) return '-';
    if (mb >= 1024) return `${Math.round((mb / 1024) * 10) / 10} GB`;
    return `${Math.round(mb * 10) / 10} MB`;
  }

  function percentOf(value, total) {
    const part = Number(value);
    const whole = Number(total);
    if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
    return Math.round((part / whole) * 1000) / 10;
  }

  function formatPercent(value) {
    if (value === null || value === undefined || value === '') return '-';
    const percent = Number(value);
    if (!Number.isFinite(percent)) return '-';
    return `${percent.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`;
  }

  function reasonLabel(value) {
    return {
      'qr-login': '扫码登录',
      'manual-refresh': '手动保活',
      'scheduled-refresh': '自动保活',
      manual: '手动写入',
    }[value] || plain(value, '系统');
  }

  function statusLabel(value) {
    return {
      idle: '未连接',
      waiting_scan: '等待扫码',
      starting: '启动中',
      logged_in: '已登录',
      ok: '成功',
      refreshing: '保活中',
      error: '异常',
    }[value] || plain(value, '未知');
  }

  function isWeiboUrlHost(hostname) {
    const host = String(hostname || '').trim().toLowerCase();
    return ['weibo.com', 'www.weibo.com', 'm.weibo.cn', 'weibo.cn', 'www.weibo.cn'].includes(host);
  }

  function safeUrl(value) {
    try {
      const url = new URL(String(value || ''));
      if (!['http:', 'https:'].includes(url.protocol) || !isWeiboUrlHost(url.hostname)) return '';
      url.protocol = 'https:';
      url.username = '';
      url.password = '';
      url.hash = '';
      return url.href;
    } catch {
      return '';
    }
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 2300);
  }

  function setAuthed(authed) {
    els.loginPanel.classList.toggle('hidden', authed);
    els.dashboard.classList.toggle('hidden', !authed);
    els.topbarStatus.classList.toggle('hidden', !authed);
    els.topbarActions.classList.toggle('hidden', !authed);
    els.refreshBtn.disabled = !authed;
    els.exportAllBtn.disabled = !authed;
    els.logoutBtn.disabled = !authed;
    if (authed) {
      els.accountLabel.textContent = state.username;
      startSummaryPolling();
    } else {
      stopSummaryPolling();
      setTimeout(() => els.usernameInput.focus(), 50);
    }
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const method = String(options.method || 'GET').toUpperCase();
    if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && state.csrfToken) {
      headers.set('x-admin-csrf', state.csrfToken);
    }
    const response = await fetch(path, {
      ...options,
      method,
      headers,
      credentials: 'same-origin',
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      state.username = '';
      state.csrfToken = '';
      setAuthed(false);
      throw new Error(data.error || '登录已失效，请重新登录');
    }
    if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败：${response.status}`);
    return data;
  }

  function metricCard(value, label, note = '', progress = null) {
    const displayed = typeof value === 'number' ? formatNumber(value) : plain(value);
    const progressValue = progress === null ? Number.NaN : Number(progress);
    const tone = progressValue >= 90 ? ' is-critical' : progressValue >= 75 ? ' is-warning' : '';
    const meter = Number.isFinite(progressValue)
      ? `<span class="metric-meter" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, progressValue))}%"></i></span>`
      : '';
    return `
      <div class="metric-card${tone}">
        <div class="metric-value">${escapeHtml(displayed)}</div>
        <div class="metric-label">${escapeHtml(label)}</div>
        ${note ? `<div class="metric-note">${escapeHtml(note)}</div>` : ''}
        ${meter}
      </div>
    `;
  }

  function listToggleHtml(kind, display, noun) {
    if (!display.canToggle) return '';
    const hint = display.expanded
      ? `已显示全部 ${formatNumber(display.total)} 条${noun}`
      : `已收起 ${formatNumber(display.hiddenCount)} 条较早${noun}`;
    return `
      <div class="list-more-bar">
        <span>${escapeHtml(hint)}</span>
        <button class="list-toggle-button" type="button" data-list-toggle="${escapeHtml(kind)}">${escapeHtml(display.actionLabel)}</button>
      </div>
    `;
  }

  function renderSummary() {
    const summary = state.summary || {};
    const system = summary.system || {};
    const memory = system.memory || {};
    const browser = system.browser || {};
    const queue = summary.queue || {};
    const service = system.service || {};
    const memoryLimit = Number(service.memoryMaxMb || 0);
    const serviceMemoryPercent = percentOf(memory.cgroupCurrentMb, memoryLimit);
    const anonymousMemoryPercent = percentOf(memory.cgroupAnonMb, memoryLimit);
    const hostMemoryPercent = Number(memory.hostUsedPercent);
    const queuePercent = percentOf(queue.active, queue.maxActive);
    els.metricGrid.innerHTML = [
      metricCard(formatPercent(serviceMemoryPercent), '服务内存', `${formatMemoryMb(memory.cgroupCurrentMb)} / ${formatMemoryMb(memoryLimit)}`, serviceMemoryPercent),
      metricCard(formatPercent(anonymousMemoryPercent), '匿名内存', `${formatMemoryMb(memory.cgroupAnonMb)} · 排查持续增长`, anonymousMemoryPercent),
      metricCard(formatPercent(hostMemoryPercent), '主机内存', `可用 ${formatMemoryMb(memory.hostAvailableMb)}`, hostMemoryPercent),
      metricCard(browser.processCount || 0, 'Chromium', browser.operation?.label || '当前进程'),
      metricCard(summary.cookie?.accountCount || 0, '可用账号', `Cookie ${summary.cookie?.cookieCount || 0} 条`),
      metricCard(formatPercent(queuePercent), '并发占用', `${queue.active || 0} 运行 · ${queue.queued || 0} 排队`, queuePercent),
    ].join('');

    els.heroSubtitle.textContent = `已运行 ${plain(system.uptimeText)}，记录 ${formatNumber(summary.savedDrawCount)} 次开奖、${formatNumber(summary.winnerCount)} 人次中奖。`;
    els.healthPill.innerHTML = `<span></span>${summary.adminEnabled ? '服务正常' : '后台未启用'}`;
    els.lastUpdated.textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    els.topStatusLight.classList.toggle('error', !summary.adminEnabled);

    renderAttempts(summary.recentAttempts || []);
    renderCookie(summary.cookie || {});
    renderWeiboLogin(summary.weiboLogin || {});
    renderKeepaliveDiagnostics(summary.weiboLogin || {}, summary.cookie || {});
    renderMemoryChart(memory, service);
    renderRequestSummary(system, queue);
    renderEvents(system.events || []);
    renderSystem(system, queue);
  }

  function chartPoints(samples, field, plot, min, max) {
    const range = Math.max(1, max - min);
    return samples.map((sample, index) => {
      const ratio = samples.length === 1 ? 0.5 : index / (samples.length - 1);
      const x = plot.left + ratio * (plot.right - plot.left);
      const rawValue = Number(sample[field] || 0);
      const value = Math.max(min, Math.min(max, rawValue));
      const y = plot.bottom - ((value - min) / range) * (plot.bottom - plot.top);
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
    }).join(' ');
  }

  function renderMemoryChart(memory, service) {
    const samples = Array.isArray(memory.samples) ? memory.samples : [];
    const trend = memory.trend || {};
    const memoryLimit = Number(service.memoryMaxMb || 0);
    const hourlyPercent = percentOf(Math.abs(Number(trend.perHourMb || 0)), memoryLimit);
    const trendText = {
      rising: `持续上升 ${formatPercent(hourlyPercent)}/小时`,
      falling: `正在回落 ${formatPercent(hourlyPercent)}/小时`,
      stable: '内存趋势稳定',
      insufficient: '等待更多采样',
    }[trend.status] || '等待更多采样';
    els.memoryInsight.textContent = trendText;
    els.memoryInsight.title = Number.isFinite(Number(trend.perHourMb))
      ? `${Math.abs(Number(trend.perHourMb))} MB/小时`
      : '';
    els.memoryInsight.classList.toggle('rising', trend.status === 'rising');
    if (samples.length < 2 || !memoryLimit) {
      els.memoryChart.innerHTML = '<div class="chart-empty">采样满 5 分钟后显示趋势</div>';
      return;
    }
    const width = 720;
    const height = 190;
    const plot = { left: 72, right: width - 12, top: 14, bottom: height - 24 };
    const percentageSamples = samples.map((sample) => ({
      servicePercent: percentOf(sample.cgroupCurrentMb, memoryLimit) || 0,
      anonymousPercent: percentOf(sample.cgroupAnonMb, memoryLimit) || 0,
    }));
    const current = chartPoints(percentageSamples, 'servicePercent', plot, 0, 100);
    const anon = chartPoints(percentageSamples, 'anonymousPercent', plot, 0, 100);
    const area = `${plot.left},${plot.bottom} ${current} ${plot.right},${plot.bottom}`;
    const grid = [100, 75, 50, 25, 0].map((value) => {
      const y = plot.bottom - (value / 100) * (plot.bottom - plot.top);
      return `<line class="chart-grid" x1="${plot.left}" x2="${plot.right}" y1="${y}" y2="${y}"/>`;
    }).join('');
    els.memoryChart.innerHTML = `
      <div class="chart-scale" aria-hidden="true"><span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span></div>
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="近 24 小时服务内存占上限比例">
        ${grid}
        <polygon class="chart-area" points="${area}"></polygon>
        <polyline class="chart-line-current" points="${current}"></polyline>
        <polyline class="chart-line-anon" points="${anon}"></polyline>
      </svg>
    `;
  }

  function quickRow(label, value, note = '') {
    return `
      <div class="quick-row">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        ${note ? `<small>${escapeHtml(note)}</small>` : ''}
      </div>
    `;
  }

  function renderRequestSummary(system, queue) {
    const runtime = system.runtime || {};
    const requests = runtime.requests || {};
    const service = system.service || {};
    const disk = system.disk || {};
    const requestErrors = Number(requests.clientErrors || 0) + Number(requests.serverErrors || 0);
    const requestErrorPercent = percentOf(requestErrors, requests.total) ?? 0;
    const queuePercent = percentOf(queue.active, queue.maxActive);
    els.requestPanel.innerHTML = [
      quickRow('事件循环 P99', `${plain(runtime.eventLoopP99Ms, 0)} ms`, Number(runtime.eventLoopP99Ms || 0) < 100 ? '响应正常' : '存在阻塞'),
      quickRow('HTTP 错误率', formatPercent(requestErrorPercent), `${formatNumber(requests.total)} 次请求 · 4xx ${formatNumber(requests.clientErrors)} · 5xx ${formatNumber(requests.serverErrors)}`),
      quickRow('自动重启', formatDate(service.nextRecycleAt), `每 ${plain(service.recycleIntervalText)} 回收进程`),
      quickRow('磁盘', `${plain(disk.usedPercent, 0)}%`, `可用 ${plain(disk.availableMb, 0)} MB`),
      quickRow('并发占用', formatPercent(queuePercent), `${formatNumber(queue.active)} 运行 · ${formatNumber(queue.queued)} 排队 · 锁 ${formatNumber(queue.sameStatusLocks)}`),
      quickRow('抓取复用', `${formatNumber(queue.sharedTasks)} 个共享任务`, `${formatNumber(queue.recentSnapshots)} / ${formatNumber(queue.maxSnapshots)} 个快照 · 时效 ${formatDurationMs(queue.snapshotTtlMs)} · 累计合并 ${formatNumber(queue.deliveries?.sharedRunning)} 次`),
    ].join('');
  }

  function eventHtml(item) {
    return `
      <div class="event-row ${escapeHtml(item.status || '')}">
        <span class="status-dot"></span>
        <div>
          <strong>${escapeHtml(plain(item.message, plain(item.action, '系统事件')))}</strong>
          <small>${escapeHtml(formatDate(item.at))} · ${escapeHtml(plain(item.category, 'system'))}${item.source ? ` · 来源 ${escapeHtml(item.source)}` : ''}</small>
        </div>
      </div>
    `;
  }

  function renderEvents(events) {
    const items = Array.isArray(events) ? events : [];
    const empty = '<div class="empty-list compact">暂无运行事件。</div>';
    els.eventPanel.innerHTML = items.length ? items.slice(0, 5).map(eventHtml).join('') : empty;
    els.systemEventPanel.innerHTML = items.length ? items.map(eventHtml).join('') : empty;
  }

  function renderAttempts(attempts) {
    if (!attempts.length) {
      els.attemptList.innerHTML = '<div class="empty-list">暂无开奖动作记录。</div>';
      return;
    }
    const display = listDisplayState(attempts, {
      limit: ATTEMPT_VISIBLE_LIMIT,
      expanded: state.attemptsExpanded,
    });
    els.attemptList.innerHTML = display.items.map((item) => {
      const label = plain(item.statusId || item.statusUrl, '未识别微博链接');
      return `
        <div class="attempt-row">
          <strong>${escapeHtml(formatDate(item.drawnAt))}</strong>
          <div>${escapeHtml(label)}</div>
          <div>候选 ${escapeHtml(formatNumber(item.candidateCount))} · 可抽 ${escapeHtml(formatNumber(item.eligibleCount))} · 名额 ${escapeHtml(formatNumber(item.prizeCount))}</div>
        </div>
      `;
    }).join('') + listToggleHtml('attempts', display, '动作');
  }

  function renderCookie(cookie) {
    const queue = state.summary?.queue || {};
    const cookieCount = Number(cookie.cookieCount || 0);
    const accountCount = Number(cookie.accountCount || cookieCount);
    const status = cookie.cookieStoreDisabled
      ? 'Cookie 保存已关闭'
      : cookie.hasCookie
        ? `可用账号 ${formatNumber(accountCount)} 个 · 保存 Cookie ${formatNumber(cookieCount)} 条`
        : '暂未保存 Cookie';
    els.cookieBox.innerHTML = `
      <div class="cookie-line"><strong>${escapeHtml(status)}</strong></div>
      <div class="cookie-line">最近有效：${escapeHtml(formatDate(cookie.lastValidAt))}</div>
      <div class="cookie-line">最近校验：${escapeHtml(formatDate(cookie.lastCheckedAt))}</div>
      <div class="cookie-line">最近保存：${escapeHtml(formatDate(cookie.savedAt))}</div>
      <div class="cookie-line">当前指纹：${escapeHtml(cookie.activeId ? cookie.activeId.slice(0, 12) : '-')}</div>
      <div class="cookie-line">外部写入：${escapeHtml(cookie.cookieStoreWriteProtected ? '独立密钥保护' : '已禁用')}</div>
      <div class="cookie-line">抓取队列：运行 ${escapeHtml(formatNumber(queue.active))} / 排队 ${escapeHtml(formatNumber(queue.queued))}</div>
      ${cookie.lastError ? `<div class="status-note danger">最近 Cookie 错误：${escapeHtml(cookie.lastError)}</div>` : ''}
      <div class="subtle">后台不会返回 Cookie 明文，只显示保存状态和时间。</div>
    `;
  }

  function renderWeiboLogin(login) {
    els.weiboLoginBadge.textContent = statusLabel(login.status);
    els.weiboLoginText.textContent = [
      plain(login.message, '扫码后 Cookie 会保存到服务器 Cookie 池，普通用户只共享代抓能力。'),
      login.intervalText ? `自动间隔：${login.intervalText}` : '',
      login.lastRefreshAt ? `最近保活：${formatDate(login.lastRefreshAt)}` : '',
      login.nextRefreshAt ? `下次自动保活：${formatDate(login.nextRefreshAt)}` : '',
      login.lastError ? `最近错误：${login.lastError}` : '',
    ].filter(Boolean).join(' · ');

    const image = String(login.screenshot || '');
    if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image)) {
      els.qrImage.src = image;
      els.qrFrame.classList.remove('hidden');
    } else {
      els.qrImage.src = '/avatar.jpg';
      els.qrFrame.classList.add('hidden');
    }

    const browserBusy = Boolean(login.active || login.refreshing || login.browserOperation);
    els.startWeiboLoginBtn.disabled = browserBusy;
    els.refreshWeiboCookieBtn.disabled = browserBusy;
    els.stopWeiboLoginBtn.disabled = !login.active;

    if (login.active) startLoginPolling();
    if (!login.active && state.loginPoller) stopLoginPolling();
  }

  function diagnosticRow(label, value, note = '') {
    return `
      <div class="diagnostic-row">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        ${note ? `<small>${escapeHtml(note)}</small>` : ''}
      </div>
    `;
  }

  function renderKeepaliveDiagnostics(login, cookie) {
    const history = Array.isArray(login.history) ? login.history : [];
    const profileText = login.profileReady ? '已保存' : '缺失';
    const enabledText = login.enabled ? '已开启' : '已关闭';
    const operation = login.browserOperation || null;
    const historyHtml = history.length
      ? history.map((item) => `
          <div class="history-row ${escapeHtml(item.status || '')}">
            <span class="status-dot"></span>
            <div>
              <strong>${escapeHtml(statusLabel(item.status))}</strong>
              <small>${escapeHtml(formatDate(item.at))} · ${escapeHtml(reasonLabel(item.reason))}${item.durationMs ? ` · ${escapeHtml(formatDurationMs(item.durationMs))}` : ''}</small>
              <p>${escapeHtml(plain(item.message, '无附加信息'))}</p>
            </div>
          </div>
        `).join('')
      : '<div class="empty-list compact">暂无保活历史。扫码登录或保活后会记录在这里。</div>';

    els.keepalivePanel.innerHTML = `
      <div class="diagnostic-list">
        ${diagnosticRow('自动保活', enabledText, login.intervalText ? `每 ${login.intervalText} 一次` : '')}
        ${diagnosticRow('当前浏览器任务', operation?.label || '空闲', operation?.startedAt ? `开始于 ${formatDate(operation.startedAt)}` : '没有运行中的 Chromium 任务')}
        ${diagnosticRow('浏览器 Profile', profileText, login.profileReady ? '可直接打开浏览器保活' : '需要先扫码登录一次')}
        ${diagnosticRow('下次自动保活', formatDate(login.nextRefreshAt), login.lastReason ? `最近原因：${reasonLabel(login.lastReason)}` : '')}
        ${diagnosticRow('最近尝试', formatDate(login.lastAttemptAt))}
        ${diagnosticRow('最近成功', formatDate(login.lastSuccessAt || login.lastRefreshAt))}
        ${diagnosticRow('最近失败', formatDate(login.lastFailureAt), login.lastError || '')}
        ${diagnosticRow('Cookie 可用账号', `${formatNumber(cookie.accountCount || cookie.cookieCount || 0)} 个`, `保存 Cookie ${formatNumber(cookie.cookieCount || 0)} 条${cookie.lastValidAt ? ` · 最近有效 ${formatDate(cookie.lastValidAt)}` : ''}`)}
      </div>
      ${login.lastError ? `<div class="status-note danger">最近保活失败原因：${escapeHtml(login.lastError)}</div>` : ''}
      <div class="history-list">${historyHtml}</div>
    `;
  }

  function renderSystem(system, queue) {
    const config = system.config || {};
    const memory = system.memory || {};
    const browser = system.browser || {};
    const runtime = system.runtime || {};
    const requests = runtime.requests || {};
    const service = system.service || {};
    const disk = system.disk || {};
    const storage = Array.isArray(system.storage) ? system.storage : [];
    const memoryLimit = Number(service.memoryMaxMb || 0);
    const serviceMemoryPercent = percentOf(memory.cgroupCurrentMb, memoryLimit);
    const peakMemoryPercent = percentOf(memory.cgroupPeakMb, memoryLimit);
    const anonymousMemoryPercent = percentOf(memory.cgroupAnonMb, memoryLimit);
    const nodeHeapPercent = percentOf(memory.heapUsedMb, memory.heapTotalMb);
    const slabPercent = percentOf(memory.hostSlabMb, memory.hostTotalMb);
    const highWaterPercent = percentOf(service.memoryHighMb, memoryLimit);
    const queuePercent = percentOf(queue.active, queue.maxActive);
    const requestErrors = Number(requests.clientErrors || 0) + Number(requests.serverErrors || 0);
    const requestErrorPercent = percentOf(requestErrors, requests.total) ?? 0;
    const trendPercent = percentOf(Math.abs(Number(memory.trend?.perHourMb || 0)), memoryLimit);
    const cgroupMemoryText = memory.cgroupAvailable
      ? formatPercent(serviceMemoryPercent)
      : '-';
    const cgroupMemoryNote = memory.cgroupAvailable
      ? `${formatMemoryMb(memory.cgroupCurrentMb)} / ${formatMemoryMb(memoryLimit)} · 峰值 ${formatPercent(peakMemoryPercent)} · 可回收 ${formatMemoryMb(memory.cgroupReclaimableMb)}`
      : '当前系统未提供 cgroup v2 内存明细';
    const cacheNotice = memory.cgroupAvailable && Number(memory.cgroupReclaimableMb || 0) > 0
      ? `<div class="status-note">服务总占用包含约 ${escapeHtml(memory.cgroupReclaimableMb)} MB Linux 文件缓存；该部分可由内核回收，不等同于 Node 堆泄漏。</div>`
      : '';
    const slabNotice = Number(memory.hostSlabUnreclaimableMb || 0) >= 256
      ? `<div class="status-note danger">内核不可回收 Slab 已达到 ${escapeHtml(memory.hostSlabUnreclaimableMb)} MB，需检查网络、驱动或系统代理。</div>`
      : '';
    const storageHtml = storage.length
      ? storage.map((item) => `
          <div class="storage-row ${item.exists ? 'ok' : 'missing'}">
            <span class="status-dot"></span>
            <div>
              <strong>${escapeHtml(item.label)}</strong>
              <small>${escapeHtml(item.exists ? `${item.type || 'item'} · ${formatFileSize(item.size)} · ${formatDate(item.modifiedAt)}` : '未找到')}${item.error ? ` · ${escapeHtml(item.error)}` : ''}</small>
            </div>
          </div>
        `).join('')
      : '<div class="empty-list compact">暂无存储诊断。</div>';

    els.systemPanel.innerHTML = `
      <div class="diagnostic-list">
        ${diagnosticRow('服务时间', formatDate(system.now), system.uptimeText ? `已运行 ${system.uptimeText}` : '')}
        ${diagnosticRow('启动时间', formatDate(system.startedAt))}
        ${diagnosticRow('Node 版本', plain(system.nodeVersion), plain(system.platform))}
        ${diagnosticRow('进程', system.pid ? `PID ${system.pid}` : '-', system.hostname ? `主机 ${system.hostname}` : '')}
        ${diagnosticRow('Node 堆内存', formatPercent(nodeHeapPercent), memory.heapUsedMb ? `${formatMemoryMb(memory.heapUsedMb)} / ${formatMemoryMb(memory.heapTotalMb)} · RSS ${formatMemoryMb(memory.rssMb)}` : '')}
        ${diagnosticRow('服务内存', cgroupMemoryText, cgroupMemoryNote)}
        ${diagnosticRow('匿名内存', memory.cgroupAvailable ? formatPercent(anonymousMemoryPercent) : '-', `${formatMemoryMb(memory.cgroupAnonMb)} · 趋势 ${plain(memory.trend?.status)} · ${formatPercent(trendPercent)}/小时`)}
        ${diagnosticRow('主机内存', memory.hostTotalMb ? formatPercent(memory.hostUsedPercent) : '-', `已用 ${formatMemoryMb(memory.hostUsedMb)} / ${formatMemoryMb(memory.hostTotalMb)} · 可用 ${formatMemoryMb(memory.hostAvailableMb)}`)}
        ${diagnosticRow('内核 Slab', formatPercent(slabPercent), `${formatMemoryMb(memory.hostSlabMb)} · 不可回收 ${formatMemoryMb(memory.hostSlabUnreclaimableMb)} · 可回收 ${formatMemoryMb(memory.hostSlabReclaimableMb)}`)}
        ${diagnosticRow('系统负载', Array.isArray(system.loadAverage) ? system.loadAverage.join(' / ') : '-', system.cpus ? `${system.cpus} 核 CPU` : '')}
        ${diagnosticRow('事件循环', `P99 ${plain(runtime.eventLoopP99Ms, 0)} ms`, `平均 ${plain(runtime.eventLoopMeanMs, 0)} ms`)}
        ${diagnosticRow('限流缓存', `${formatNumber(Number(runtime.rateLimitBuckets || 0) + Number(runtime.adminLoginBuckets || 0))} 项`, `API ${formatNumber(runtime.rateLimitBuckets)} · 后台登录 ${formatNumber(runtime.adminLoginBuckets)} · 每分钟清理`)}
        ${diagnosticRow('HTTP 错误率', formatPercent(requestErrorPercent), `${formatNumber(requests.total)} 次请求 · 4xx ${formatNumber(requests.clientErrors)} · 5xx ${formatNumber(requests.serverErrors)} · 最慢 ${plain(requests.slowestMs, 0)} ms`)}
        ${diagnosticRow('Chromium', `${formatNumber(browser.processCount)} 个进程`, browser.operation?.label ? `正在执行 ${browser.operation.label}` : '当前无浏览器任务')}
        ${diagnosticRow('并发占用', formatPercent(queuePercent), `运行 ${formatNumber(queue.active)} / 上限 ${formatNumber(queue.maxActive)} · 排队 ${formatNumber(queue.queued)}`)}
        ${diagnosticRow('抓取复用', `${formatNumber(queue.sharedTasks)} 个共享任务`, `快照 ${formatNumber(queue.recentSnapshots)} / ${formatNumber(queue.maxSnapshots)} · 时效 ${formatDurationMs(queue.snapshotTtlMs)} · 新抓取 ${formatNumber(queue.deliveries?.fresh)} · 合并 ${formatNumber(queue.deliveries?.sharedRunning)} · 命中 ${formatNumber(queue.deliveries?.recentSnapshot)}`)}
        ${diagnosticRow('内存高水位', formatPercent(highWaterPercent), `${formatMemoryMb(service.memoryHighMb)} / ${formatMemoryMb(memoryLimit)} · 达到后准备回收进程`)}
        ${diagnosticRow('周期回收', formatDate(service.nextRecycleAt), `每 ${plain(service.recycleIntervalText)} 重启服务进程`)}
        ${diagnosticRow('磁盘空间', disk.available ? `${plain(disk.usedPercent, 0)}%` : '-', disk.available ? `已用 ${plain(disk.usedMb, 0)} MB · 可用 ${plain(disk.availableMb, 0)} MB` : plain(disk.error))}
        ${diagnosticRow('静态前端', config.frontendBuilt ? 'dist 构建版' : 'public 兜底版', config.staticDir || '')}
        ${diagnosticRow('Playwright', config.playwrightBrowsersPathSet ? '已配置浏览器路径' : '使用默认路径')}
        ${diagnosticRow('浏览器启动上限', config.browserLaunchTimeoutText || '-', '超时后自动清理残留进程与 Profile 锁')}
        ${diagnosticRow('后台会话', config.adminAccountEnabled ? '账密登录已启用' : '未配置', config.adminSessionTtlText ? `有效期 ${config.adminSessionTtlText}` : '')}
      </div>
      ${cacheNotice}
      ${slabNotice}
      <div class="storage-list">${storageHtml}</div>
    `;
  }

  function recordTitle(item) {
    return plain(item.statusUrl || item.statusId || item.file, '开奖记录');
  }

  function prizeSummary(item) {
    if (!item.results?.length) return '未记录奖项分组';
    return item.results.map((result) => {
      const count = result.winnerCount ?? result.winners?.length ?? 0;
      return `${plain(result.prize?.name, '奖项')} ${count} 人`;
    }).join(' · ');
  }

  function winnerPreview(item) {
    const names = (item.winners || [])
      .map((winner) => plain(winner.screenName || winner.uid, ''))
      .filter(Boolean);
    return names.length ? names.join('、') : '暂无中奖人';
  }

  function compactHash(value) {
    const hash = plain(value);
    return hash.length > 24 ? `${hash.slice(0, 12)}…${hash.slice(-8)}` : hash;
  }

  function renderDraws() {
    els.recordCount.textContent = `${formatNumber(state.draws.length)} 条`;
    if (!state.draws.length) {
      els.recordList.innerHTML = '<div class="empty-list">暂无开奖记录。完成开奖后，后台会自动保存一条记录。</div>';
      return;
    }

    els.recordList.innerHTML = state.draws.map((item, index) => {
      const active = state.selected?.file === item.file ? ' active' : '';
      return `
        <button class="record-row${active}" type="button" data-file="${escapeHtml(item.file)}" data-index="${index}"${active ? ' aria-current="true"' : ''}>
          <span>
            <span class="record-title">
              <strong>${escapeHtml(recordTitle(item))}</strong>
              <span class="badge">${escapeHtml(prizeSummary(item))}</span>
            </span>
            <span class="record-meta">${escapeHtml(formatDate(item.drawnAt || item.savedAt))} · ${escapeHtml(plain(item.source, '数据源'))}</span>
            <span class="record-winners">${escapeHtml(winnerPreview(item))}</span>
          </span>
          <span class="record-count">${escapeHtml(formatNumber(item.winnerCount))}<br><small>人</small></span>
        </button>
      `;
    }).join('');
  }

  function renderDetail() {
    const item = state.selected;
    const detailVisible = Boolean(item && state.detailOpen);
    els.detailPanel.classList.toggle('has-selection', detailVisible);
    els.detailClose.hidden = !item;
    document.body.classList.toggle('record-detail-open', detailVisible);
    if (!item) {
      els.detailContent.innerHTML = `
        <div class="empty-detail">
          <p class="eyebrow">详情</p>
          <h2>选择一条开奖记录</h2>
          <p>点开左侧记录后，可以按奖项查看中奖人、复制名单、导出单条记录或删除误保存的数据。</p>
        </div>
      `;
      return;
    }

    const href = safeUrl(item.statusUrl);
    const auditHash = plain(item.auditHash);
    const linkHtml = href
      ? `<a class="ghost-button" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">打开微博</a>`
      : '';
    const resultHtml = (item.results || []).map((result) => `
      <div class="prize-block">
        <div class="prize-head">
          <h3>${escapeHtml(plain(result.prize?.name, '奖项'))}</h3>
          <span class="badge">${escapeHtml(formatNumber(result.winners?.length || 0))} 人</span>
        </div>
        <div class="winner-grid">
          ${(result.winners || []).map((winner) => `
            <div class="winner-card">
              <span class="winner-name">${escapeHtml(plain(winner.screenName || winner.uid, '未知用户'))}</span>
              <span class="winner-text">UID：${escapeHtml(plain(winner.uid))}</span>
              ${winner.text ? `<span class="winner-text">${escapeHtml(winner.text)}</span>` : ''}
            </div>
          `).join('') || '<div class="empty-list">这个奖项暂无中奖人。</div>'}
        </div>
      </div>
    `).join('');

    els.detailContent.innerHTML = `
      <div class="detail-title">
        <p class="eyebrow">详情</p>
        <h2>${escapeHtml(prizeSummary(item))}</h2>
        <p class="subtle">${escapeHtml(formatDate(item.drawnAt || item.savedAt))} · 文件 ${escapeHtml(item.file)}</p>
      </div>
      <div class="detail-actions">
        ${linkHtml}
        <button class="ghost-button" type="button" data-action="copy">复制名单</button>
        <button class="ghost-button" type="button" data-action="csv">导出 CSV</button>
        <button class="ghost-button" type="button" data-action="json">下载 JSON</button>
        <button class="ghost-button danger-text" type="button" data-action="delete">删除</button>
      </div>
      <div class="detail-audit">
        <span>候选 ${escapeHtml(formatNumber(item.totalCount))}</span>
        <span>可抽 ${escapeHtml(formatNumber(item.eligibleCount))}</span>
        <span title="${escapeHtml(auditHash)}">Hash ${escapeHtml(compactHash(auditHash))}</span>
      </div>
      <div class="winner-grid detail-results">${resultHtml || '<div class="empty-list">暂无中奖明细。</div>'}</div>
    `;
  }

  const feedbackCategories = {
    suggestion: { label: '功能建议', tone: 'suggestion' },
    problem: { label: '遇到问题', tone: 'problem' },
    experience: { label: '使用体验', tone: 'experience' },
    other: { label: '其他', tone: 'other' },
  };

  function renderFeedback() {
    const selected = state.feedbackFilter;
    const items = selected === 'all'
      ? state.feedback
      : state.feedback.filter((item) => item.category === selected);

    els.feedbackCount.textContent = selected === 'all'
      ? `${formatNumber(state.feedback.length)} 条`
      : `${formatNumber(items.length)} / ${formatNumber(state.feedback.length)} 条`;
    els.feedbackFilters.querySelectorAll('[data-feedback-filter]').forEach((button) => {
      const active = button.dataset.feedbackFilter === selected;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    if (!items.length) {
      els.feedbackList.innerHTML = `
        <div class="empty-list feedback-empty">
          <span class="empty-symbol">✦</span>
          <strong>${state.feedback.length ? '这个分类还没有内容' : '暂时没有用户反馈'}</strong>
          <p>${state.feedback.length ? '可以切换到其他分类继续查看。' : '前台提交后会按时间显示在这里。'}</p>
        </div>
      `;
      return;
    }

    els.feedbackList.innerHTML = items.map((item) => {
      const category = feedbackCategories[item.category] || feedbackCategories.other;
      return `
        <article class="feedback-row">
          <header>
            <span class="feedback-kind ${escapeHtml(category.tone)}">${escapeHtml(category.label)}</span>
            <time datetime="${escapeHtml(item.createdAt)}">${escapeHtml(formatDate(item.createdAt))}</time>
          </header>
          <p>${escapeHtml(item.content)}</p>
          <small>匿名来源 ${escapeHtml(plain(item.source))}</small>
        </article>
      `;
    }).join('');
  }

  async function loadSummary() {
    const data = await api('/api/admin/summary');
    state.summary = data;
    renderSummary();
  }

  function startLoginPolling() {
    if (state.loginPoller) return;
    state.loginPoller = setInterval(() => {
      loadWeiboLoginStatus(false).catch(() => {});
    }, 2600);
  }

  function stopLoginPolling() {
    clearInterval(state.loginPoller);
    state.loginPoller = null;
  }

  function startSummaryPolling() {
    if (state.summaryPoller) return;
    state.summaryPoller = setInterval(() => {
      if (!document.hidden && state.username && !state.loading) {
        loadSummary().catch(() => {});
      }
    }, 60_000);
  }

  function stopSummaryPolling() {
    clearInterval(state.summaryPoller);
    state.summaryPoller = null;
  }

  async function loadWeiboLoginStatus(showMessage = true) {
    const data = await api('/api/admin/weibo-login/status');
    renderWeiboLogin(data);
    if (state.summary) {
      state.summary.weiboLogin = data;
      renderKeepaliveDiagnostics(data, state.summary.cookie || {});
    }
    if (data.saved) await loadSummary();
    if (showMessage) showToast(data.message || '微博登录状态已刷新');
    return data;
  }

  async function startWeiboLogin() {
    try {
      els.startWeiboLoginBtn.disabled = true;
      showToast('正在打开微博扫码登录');
      const data = await api('/api/admin/weibo-login/start', { method: 'POST' });
      renderWeiboLogin(data);
      if (state.summary) {
        state.summary.weiboLogin = data;
        renderKeepaliveDiagnostics(data, state.summary.cookie || {});
      }
      startLoginPolling();
    } catch (error) {
      showToast(error.message);
      await loadSummary().catch(() => {});
    }
  }

  async function stopWeiboLogin() {
    try {
      const data = await api('/api/admin/weibo-login/stop', { method: 'POST' });
      renderWeiboLogin(data);
      if (state.summary) {
        state.summary.weiboLogin = data;
        renderKeepaliveDiagnostics(data, state.summary.cookie || {});
      }
      showToast(data.message || '扫码窗口已关闭');
    } catch (error) {
      showToast(error.message);
    }
  }

  async function refreshWeiboCookie() {
    try {
      els.refreshWeiboCookieBtn.disabled = true;
      showToast('正在刷新服务器微博 Cookie');
      const data = await api('/api/admin/weibo-login/refresh', { method: 'POST' });
      renderWeiboLogin(data);
      await loadSummary();
      showToast(data.message || '服务器 Cookie 已刷新');
    } catch (error) {
      showToast(error.message);
      await loadSummary().catch(() => {});
    }
  }

  async function loadDraws() {
    const query = new URLSearchParams({ limit: '200', search: state.search });
    const data = await api(`/api/admin/draws?${query.toString()}`);
    state.draws = data.items || [];
    renderDraws();
  }

  async function loadFeedback() {
    const data = await api('/api/admin/feedback?limit=500');
    state.feedback = Array.isArray(data.items) ? data.items : [];
    renderFeedback();
  }

  async function loadAll(showMessage = false) {
    if (state.loading) return;
    state.loading = true;
    els.refreshBtn.disabled = true;
    els.loginMessage.textContent = '';
    try {
      await Promise.all([loadSummary(), loadDraws(), loadFeedback()]);
      if (state.selected) {
        const found = state.draws.find((item) => item.file === state.selected.file);
        if (!found) {
          state.selected = null;
          state.detailOpen = false;
        }
      }
      renderDetail();
      if (showMessage) showToast('后台数据已刷新');
    } catch (error) {
      els.loginMessage.textContent = error.message;
      showToast(error.message);
    } finally {
      state.loading = false;
      els.refreshBtn.disabled = !state.username;
    }
  }

  async function openRecord(file) {
    try {
      const data = await api(`/api/admin/draws/${encodeURIComponent(file)}`);
      state.selected = data.item;
      state.detailOpen = true;
      renderDraws();
      renderDetail();
      if (window.matchMedia('(max-width: 760px)').matches) {
        setTimeout(() => els.detailClose.focus({ preventScroll: true }), 260);
      }
    } catch (error) {
      showToast(error.message);
    }
  }

  async function removeRecord(file) {
    if (!file) return;
    state.pendingDeleteFile = file;
    els.confirmDialog.showModal();
    requestAnimationFrame(() => els.confirmCancelBtn.focus());
  }

  function closeDeleteConfirm() {
    state.pendingDeleteFile = '';
    if (els.confirmDialog.open) els.confirmDialog.close();
  }

  async function confirmRemoveRecord() {
    const file = state.pendingDeleteFile;
    if (!file) return;
    els.confirmDeleteBtn.disabled = true;
    try {
      await api(`/api/admin/draws/${encodeURIComponent(file)}`, { method: 'DELETE' });
      if (state.selected?.file === file) {
        state.selected = null;
        state.detailOpen = false;
      }
      closeDeleteConfirm();
      showToast('开奖记录已删除');
      await loadAll();
    } catch (error) {
      showToast(error.message);
    } finally {
      els.confirmDeleteBtn.disabled = false;
    }
  }

  function csvCell(value) {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r\n]/.test(text.trimStart())) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function rowsFromRecords(records) {
    const rows = [['开奖时间', '微博链接', '奖项', 'UID', '昵称', '转发内容', '记录文件']];
    for (const record of records) {
      for (const result of record.results || []) {
        for (const winner of result.winners || []) {
          rows.push([
            formatDate(record.drawnAt || record.savedAt),
            record.statusUrl || record.statusId || '',
            result.prize?.name || '',
            winner.uid || '',
            winner.screenName || '',
            winner.text || '',
            record.file || '',
          ]);
        }
      }
    }
    return rows;
  }

  function downloadBlob(content, mime, fileName) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function exportCsv(records, name) {
    const csv = rowsFromRecords(records).map((row) => row.map(csvCell).join(',')).join('\n');
    downloadBlob(`\uFEFF${csv}`, 'text/csv;charset=utf-8', name);
  }

  async function exportAll() {
    if (!state.draws.length) {
      showToast('暂无可导出的开奖记录');
      return;
    }
    try {
      els.exportAllBtn.disabled = true;
      const records = [];
      for (const item of state.draws) {
        const data = await api(`/api/admin/draws/${encodeURIComponent(item.file)}`);
        records.push(data.item);
      }
      exportCsv(records, `sameko-draws-${Date.now()}.csv`);
      showToast('CSV 已生成');
    } catch (error) {
      showToast(error.message);
    } finally {
      els.exportAllBtn.disabled = false;
    }
  }

  async function copySelectedNames() {
    if (!state.selected) return;
    const names = (state.selected.winners || [])
      .map((winner) => winner.screenName ? `@${winner.screenName}` : winner.uid)
      .filter(Boolean)
      .join(' ');
    if (!names) {
      showToast('暂无中奖名单可复制');
      return;
    }
    try {
      await navigator.clipboard.writeText(names);
      showToast('中奖名单已复制');
    } catch {
      showToast('浏览器没有允许剪贴板权限');
    }
  }

  function downloadSelectedJson() {
    if (!state.selected) return;
    downloadBlob(JSON.stringify(state.selected, null, 2), 'application/json;charset=utf-8', `${state.selected.file}.json`);
  }

  async function login() {
    const username = els.usernameInput.value.trim();
    const password = els.passwordInput.value;
    if (!username || !password) {
      els.loginMessage.textContent = '请填写账号和密码。';
      return;
    }
    els.loginBtn.disabled = true;
    els.loginBtn.querySelector('span').textContent = '正在登录';
    els.loginMessage.textContent = '';
    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || '登录失败');
      state.username = data.username;
      state.csrfToken = data.csrfToken;
      state.sessionExpiresAt = data.expiresAt;
      els.passwordInput.value = '';
      setAuthed(true);
      await loadAll();
    } catch (error) {
      els.loginMessage.textContent = error.message;
    } finally {
      els.loginBtn.disabled = false;
      els.loginBtn.querySelector('span').textContent = '进入后台';
    }
  }

  async function logout() {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    state.username = '';
    state.csrfToken = '';
    state.sessionExpiresAt = '';
    state.summary = null;
    state.draws = [];
    state.feedback = [];
    state.feedbackFilter = 'all';
    state.selected = null;
    state.detailOpen = false;
    state.attemptsExpanded = false;
    document.body.classList.remove('record-detail-open');
    stopLoginPolling();
    setAuthed(false);
    showToast('已退出后台');
  }

  async function restoreSession() {
    try {
      const response = await fetch('/api/admin/session', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        setAuthed(false);
        return;
      }
      const data = await response.json();
      state.username = data.username;
      state.csrfToken = data.csrfToken;
      state.sessionExpiresAt = data.expiresAt;
      setAuthed(true);
      await loadAll();
    } catch {
      setAuthed(false);
      els.loginMessage.textContent = '暂时无法连接服务器，请稍后重试。';
    }
  }

  function setTab(name) {
    const buttons = [...document.querySelectorAll('[data-tab]')];
    const index = Math.max(0, buttons.findIndex((button) => button.dataset.tab === name));
    buttons.forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
    document.querySelectorAll('[data-view]').forEach((view) => {
      view.classList.toggle('active', view.dataset.view === name);
    });
    document.querySelector('.tab-indicator').style.transform = `translateX(${index * 100}%)`;
    if (name !== 'records' && state.detailOpen) {
      state.detailOpen = false;
      renderDetail();
    }
  }

  function closeRecordDetail() {
    state.detailOpen = false;
    renderDetail();
    const selectedButton = [...els.recordList.querySelectorAll('[data-file]')]
      .find((button) => button.dataset.file === state.selected?.file);
    selectedButton?.focus({ preventScroll: true });
  }

  els.loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    login();
  });
  els.passwordToggle.addEventListener('click', () => {
    const showing = els.passwordInput.type === 'text';
    els.passwordInput.type = showing ? 'password' : 'text';
    els.passwordToggle.setAttribute('aria-label', showing ? '显示密码' : '隐藏密码');
    els.passwordToggle.setAttribute('title', showing ? '显示密码' : '隐藏密码');
  });
  els.refreshBtn.addEventListener('click', () => loadAll(true));
  els.logoutBtn.addEventListener('click', logout);
  els.exportAllBtn.addEventListener('click', exportAll);
  els.startWeiboLoginBtn.addEventListener('click', startWeiboLogin);
  els.refreshWeiboCookieBtn.addEventListener('click', refreshWeiboCookie);
  els.stopWeiboLoginBtn.addEventListener('click', stopWeiboLogin);

  let searchTimer = null;
  els.searchInput.addEventListener('input', () => {
    state.search = els.searchInput.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadDraws, 220);
  });

  els.recordList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-file]');
    if (button) openRecord(button.dataset.file);
  });

  els.detailClose.addEventListener('click', closeRecordDetail);
  els.confirmCancelBtn.addEventListener('click', closeDeleteConfirm);
  els.confirmDeleteBtn.addEventListener('click', confirmRemoveRecord);
  els.confirmDialog.addEventListener('close', () => {
    state.pendingDeleteFile = '';
  });
  els.confirmDialog.addEventListener('click', (event) => {
    if (event.target === els.confirmDialog) closeDeleteConfirm();
  });

  els.feedbackFilters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-feedback-filter]');
    if (!button) return;
    state.feedbackFilter = button.dataset.feedbackFilter;
    renderFeedback();
  });

  els.attemptList.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-list-toggle="attempts"]');
    if (!toggle) return;
    state.attemptsExpanded = !state.attemptsExpanded;
    renderAttempts(state.summary?.recentAttempts || []);
  });

  els.detailPanel.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button || !state.selected) return;
    const action = button.dataset.action;
    if (action === 'copy') copySelectedNames();
    if (action === 'csv') exportCsv([state.selected], `sameko-draw-${Date.now()}.csv`);
    if (action === 'json') downloadSelectedJson();
    if (action === 'delete') removeRecord(state.selected.file);
  });

  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    const goTab = event.target.closest('[data-go-tab]');
    if (tab) setTab(tab.dataset.tab);
    if (goTab) setTab(goTab.dataset.goTab);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.detailOpen && window.matchMedia('(max-width: 760px)').matches) {
      closeRecordDetail();
    }
  });

  setAuthed(false);
  restoreSession();
})();
