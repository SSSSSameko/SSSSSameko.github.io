(() => {
  const STORAGE_KEY = 'sameko-admin-key';
  const state = {
    token: localStorage.getItem(STORAGE_KEY) || '',
    summary: null,
    draws: [],
    selected: null,
    search: '',
    loading: false,
    loginPoller: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    loginPanel: $('loginPanel'),
    dashboard: $('dashboard'),
    adminKeyInput: $('adminKeyInput'),
    loginBtn: $('loginBtn'),
    loginMessage: $('loginMessage'),
    refreshBtn: $('refreshBtn'),
    logoutBtn: $('logoutBtn'),
    heroSubtitle: $('heroSubtitle'),
    healthPill: $('healthPill'),
    metricGrid: $('metricGrid'),
    searchInput: $('searchInput'),
    exportAllBtn: $('exportAllBtn'),
    recordList: $('recordList'),
    detailPanel: $('detailPanel'),
    attemptList: $('attemptList'),
    cookieBox: $('cookieBox'),
    startWeiboLoginBtn: $('startWeiboLoginBtn'),
    refreshWeiboCookieBtn: $('refreshWeiboCookieBtn'),
    stopWeiboLoginBtn: $('stopWeiboLoginBtn'),
    weiboLoginBadge: $('weiboLoginBadge'),
    weiboLoginText: $('weiboLoginText'),
    qrFrame: $('qrFrame'),
    qrImage: $('qrImage'),
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
    els.refreshBtn.disabled = !authed;
    els.exportAllBtn.disabled = !authed;
    els.logoutBtn.disabled = !state.token;
    if (!authed) setTimeout(() => els.adminKeyInput.focus(), 50);
  }

  async function api(path, options = {}) {
    if (!state.token) throw new Error('请先填写后台密钥');
    const headers = new Headers(options.headers || {});
    headers.set('x-api-key', state.token);
    if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const response = await fetch(path, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      localStorage.removeItem(STORAGE_KEY);
      state.token = '';
      setAuthed(false);
      throw new Error('后台密钥不正确，或服务器还没有配置 ADMIN_KEY');
    }
    if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败：${response.status}`);
    return data;
  }

  function metricCard(value, label) {
    return `
      <div class="metric-card">
        <div class="metric-value">${escapeHtml(formatNumber(value))}</div>
        <div class="metric-label">${escapeHtml(label)}</div>
      </div>
    `;
  }

  function renderSummary() {
    const summary = state.summary || {};
    els.metricGrid.innerHTML = [
      metricCard(summary.savedDrawCount, '开奖记录'),
      metricCard(summary.winnerCount, '中奖人次'),
      metricCard(summary.statusCount, '微博链接'),
      metricCard(summary.attemptCount, '开奖动作'),
    ].join('');

    els.heroSubtitle.textContent = summary.savedDrawCount
      ? `已记录 ${summary.savedDrawCount} 次开奖记录，最近更新时间 ${formatDate(summary.recentDraws?.[0]?.savedAt || summary.recentDraws?.[0]?.drawnAt)}。`
      : '暂无开奖记录，完成一次开奖后会自动出现在这里。';
    els.healthPill.textContent = summary.adminEnabled ? '后台已连接' : '后台未启用';

    renderAttempts(summary.recentAttempts || []);
    renderCookie(summary.cookie || {});
    renderWeiboLogin(summary.weiboLogin || {});
  }

  function renderAttempts(attempts) {
    if (!attempts.length) {
      els.attemptList.innerHTML = '<div class="empty-list">暂无开奖动作记录。</div>';
      return;
    }
    els.attemptList.innerHTML = attempts.map((item) => {
      const label = plain(item.statusId || item.statusUrl, '未识别微博链接');
      return `
        <div class="attempt-row">
          <strong>${escapeHtml(formatDate(item.drawnAt))}</strong>
          <div>${escapeHtml(label)}</div>
          <div>候选 ${escapeHtml(formatNumber(item.candidateCount))} · 可抽 ${escapeHtml(formatNumber(item.eligibleCount))} · 名额 ${escapeHtml(formatNumber(item.prizeCount))}</div>
        </div>
      `;
    }).join('');
  }

  function renderCookie(cookie) {
    const queue = state.summary?.queue || {};
    const status = cookie.cookieStoreDisabled
      ? 'Cookie 保存已关闭'
      : cookie.hasCookie
        ? `已保存 ${formatNumber(cookie.cookieCount)} 条 Cookie`
        : '暂未保存 Cookie';
    els.cookieBox.innerHTML = `
      <div class="cookie-line"><strong>${escapeHtml(status)}</strong></div>
      <div class="cookie-line">最近有效：${escapeHtml(formatDate(cookie.lastValidAt))}</div>
      <div class="cookie-line">最近保存：${escapeHtml(formatDate(cookie.savedAt))}</div>
      <div class="cookie-line">写入保护：${escapeHtml(cookie.cookieStoreWriteProtected ? '已开启' : '未开启')}</div>
      <div class="cookie-line">抓取队列：运行 ${escapeHtml(formatNumber(queue.active))} / 排队 ${escapeHtml(formatNumber(queue.queued))}</div>
      <div class="subtle">后台不会返回 Cookie 明文，只显示保存状态和时间。</div>
    `;
  }

  function renderWeiboLogin(login) {
    const statusLabel = {
      idle: '未连接',
      waiting_scan: '等待扫码',
      starting: '启动中',
      logged_in: '已登录',
      ok: '可用',
      refreshing: '保活中',
      error: '异常',
    }[login.status] || plain(login.status, '未连接');
    els.weiboLoginBadge.textContent = statusLabel;
    els.weiboLoginText.textContent = [
      plain(login.message, '扫码后 Cookie 会保存到服务器 Cookie 池，普通用户只共享代抓能力。'),
      login.lastRefreshAt ? `最近保活：${formatDate(login.lastRefreshAt)}` : '',
      login.nextRefreshAt ? `下次自动保活：${formatDate(login.nextRefreshAt)}` : '',
      login.lastError ? `最近错误：${login.lastError}` : '',
    ].filter(Boolean).join(' · ');

    const image = String(login.screenshot || '');
    if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image)) {
      els.qrImage.src = image;
      els.qrFrame.classList.remove('hidden');
    } else {
      els.qrImage.removeAttribute('src');
      els.qrFrame.classList.add('hidden');
    }

    els.startWeiboLoginBtn.disabled = Boolean(login.active || login.refreshing);
    els.refreshWeiboCookieBtn.disabled = Boolean(login.active || login.refreshing);
    els.stopWeiboLoginBtn.disabled = !login.active;

    if (login.active) startLoginPolling();
    if (!login.active && state.loginPoller) stopLoginPolling();
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

  function renderDraws() {
    if (!state.draws.length) {
      els.recordList.innerHTML = '<div class="empty-list">暂无开奖记录。完成开奖后，后台会自动保存一条记录。</div>';
      return;
    }

    els.recordList.innerHTML = state.draws.map((item) => {
      const active = state.selected?.file === item.file ? ' active' : '';
      return `
        <button class="record-row${active}" type="button" data-file="${escapeHtml(item.file)}">
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
    if (!item) {
      els.detailPanel.innerHTML = `
        <div class="empty-detail">
          <p class="eyebrow">详情</p>
          <h2>选择一条开奖记录</h2>
          <p>点开左侧记录后，可以按奖项查看中奖人、复制名单、导出单条记录或删除误保存的数据。</p>
        </div>
      `;
      return;
    }

    const href = safeUrl(item.statusUrl);
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

    els.detailPanel.innerHTML = `
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
      <div class="subtle">候选 ${escapeHtml(formatNumber(item.totalCount))} · 可抽 ${escapeHtml(formatNumber(item.eligibleCount))} · Hash ${escapeHtml(plain(item.auditHash))}</div>
      <div class="winner-grid" style="margin-top: 14px;">${resultHtml || '<div class="empty-list">暂无中奖明细。</div>'}</div>
    `;
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

  async function loadWeiboLoginStatus(showMessage = true) {
    const data = await api('/api/admin/weibo-login/status');
    renderWeiboLogin(data);
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

  async function loadAll() {
    if (state.loading) return;
    state.loading = true;
    els.refreshBtn.disabled = true;
    els.loginMessage.textContent = '';
    try {
      await Promise.all([loadSummary(), loadDraws()]);
      if (state.selected) {
        const found = state.draws.find((item) => item.file === state.selected.file);
        if (!found) state.selected = null;
      }
      renderDetail();
      showToast('后台数据已刷新');
    } catch (error) {
      els.loginMessage.textContent = error.message;
      showToast(error.message);
    } finally {
      state.loading = false;
      els.refreshBtn.disabled = !state.token;
    }
  }

  async function openRecord(file) {
    try {
      const data = await api(`/api/admin/draws/${encodeURIComponent(file)}`);
      state.selected = data.item;
      renderDraws();
      renderDetail();
    } catch (error) {
      showToast(error.message);
    }
  }

  async function removeRecord(file) {
    if (!file) return;
    const ok = window.confirm('确定删除这条开奖记录吗？删除后服务器记录会移除。');
    if (!ok) return;
    try {
      await api(`/api/admin/draws/${encodeURIComponent(file)}`, { method: 'DELETE' });
      if (state.selected?.file === file) state.selected = null;
      showToast('开奖记录已删除');
      await loadAll();
    } catch (error) {
      showToast(error.message);
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
    const token = els.adminKeyInput.value.trim();
    if (!token) {
      els.loginMessage.textContent = '请填写后台密钥。';
      return;
    }
    state.token = token;
    localStorage.setItem(STORAGE_KEY, token);
    setAuthed(true);
    await loadAll();
  }

  function logout() {
    state.token = '';
    state.summary = null;
    state.draws = [];
    state.selected = null;
    localStorage.removeItem(STORAGE_KEY);
    els.adminKeyInput.value = '';
    stopLoginPolling();
    setAuthed(false);
    showToast('已退出后台');
  }

  els.loginBtn.addEventListener('click', login);
  els.adminKeyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') login();
  });
  els.refreshBtn.addEventListener('click', loadAll);
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

  els.detailPanel.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button || !state.selected) return;
    const action = button.dataset.action;
    if (action === 'copy') copySelectedNames();
    if (action === 'csv') exportCsv([state.selected], `sameko-draw-${Date.now()}.csv`);
    if (action === 'json') downloadSelectedJson();
    if (action === 'delete') removeRecord(state.selected.file);
  });

  els.adminKeyInput.value = state.token;
  setAuthed(Boolean(state.token));
  if (state.token) loadAll();
})();
