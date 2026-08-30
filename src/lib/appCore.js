const SOURCE_LABELS = { mobile: '微博公开转发', manual: '手动名单', official: '官方接口' };

const PROVIDER_LABELS = {
  manual: '手动名单',
  cookie: '服务器登录态',
  mobile: '微博公开转发',
  official: '官方接口',
  desktop: '微博桌面接口',
  legacy: '微博旧版接口',
  'desktop-cookie': '微博桌面登录态',
};

export const DRAW_RANDOM_ALGORITHM = 'SHA-256 · Fisher–Yates';
export const MAX_MANUAL_CANDIDATES = 20_000;
export const MAX_MANUAL_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_MENTION_MIN = 10;

export function normalizeMentionMin(value, fallback = 0) {
  const fallbackNumber = Number(fallback);
  const safeFallback = Number.isFinite(fallbackNumber)
    ? Math.min(MAX_MENTION_MIN, Math.max(0, Math.floor(fallbackNumber)))
    : 0;
  if (typeof value === 'string' && !value.trim()) return safeFallback;
  if (typeof value !== 'string' && typeof value !== 'number') return safeFallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return safeFallback;
  return Math.min(MAX_MENTION_MIN, Math.max(0, Math.floor(number)));
}

export function cleanApiBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function safeWeiboUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    const host = url.hostname.toLowerCase();
    const isWeiboHost = host === 'weibo.com'
      || host.endsWith('.weibo.com')
      || host === 'weibo.cn'
      || host.endsWith('.weibo.cn');
    if (!isWeiboHost || !['http:', 'https:'].includes(url.protocol)) return '';
    url.protocol = 'https:';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '';
  }
}

export function readStoredValue(key) {
  try {
    return window.localStorage?.getItem(key) || '';
  } catch {
    return '';
  }
}

export function writeStoredValue(key, value) {
  try {
    if (value) window.localStorage?.setItem(key, value);
    else window.localStorage?.removeItem(key);
  } catch {
  }
}

export function safeMentionName(value) {
  return String(value || '').replace(/^@+/, '').trim();
}

export function friendlyProviderText(value) {
  const parts = Array.isArray(value) ? value : String(value || '').split(/[\/,]/);
  const labels = parts
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((item) => PROVIDER_LABELS[item] || SOURCE_LABELS[item] || item);
  return [...new Set(labels)].join(' / ');
}

export function buildFilterSummary({ keyword, mentionMin, uniqueByUser, excludePrevious, blocklistCount }) {
  const parts = [];
  const normalizedMentionMin = normalizeMentionMin(mentionMin);
  if (keyword) parts.push(`关键词：${keyword}`);
  if (normalizedMentionMin > 0) parts.push(`至少 @${normalizedMentionMin}`);
  if (Number(blocklistCount || 0) > 0) parts.push(`排除名单 ${Number(blocklistCount)} 人`);
  if (uniqueByUser) parts.push('同一用户只保留一次');
  if (excludePrevious) parts.push('排除当前任务已中奖用户');
  return parts.length ? parts.join(' / ') : '未启用额外筛选';
}

export function candidateLoadWarning(meta) {
  if (!meta || meta.complete !== false) return '';
  const warnings = Array.isArray(meta.warnings)
    ? [...new Set(meta.warnings.map((item) => String(item || '').trim()).filter(Boolean))]
    : [];
  const important = warnings.filter((message) => (
    /失败|停止|上限|最多|只拿到|差额|重复|风控|不可见/.test(message)
  ));
  return important.slice(-2).join('；')
    || '微博接口只返回了当前登录态可见的部分转发，请核对名单后再开奖。';
}

export function candidateCutoffInfo(value, now = Date.now()) {
  const loadedAt = new Date(value || '');
  if (Number.isNaN(loadedAt.getTime())) return { label: '本次载入', ageMs: 0 };

  const current = new Date(now);
  const sameDay = loadedAt.getFullYear() === current.getFullYear()
    && loadedAt.getMonth() === current.getMonth()
    && loadedAt.getDate() === current.getDate();
  const time = loadedAt.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const date = `${loadedAt.getMonth() + 1}月${loadedAt.getDate()}日`;
  return {
    label: `${sameDay ? time : `${date} ${time}`} 截止`,
    ageMs: Math.max(0, current.getTime() - loadedAt.getTime()),
  };
}

function normalizeManualItem(raw, index) {
  if (typeof raw === 'string' || typeof raw === 'number') {
    const screenName = String(raw).trim();
    const stable = screenName || String(index);
    return { id: stable, uid: '', screenName: screenName || `候选人 ${index + 1}`, avatar: '', verified: false, followers: 0, text: '', createdAt: '', repostId: '', source: 'manual' };
  }
  const record = raw && typeof raw === 'object' ? raw : {};
  const values = Array.isArray(record) ? record : [];
  const singleCell = values.length === 1;
  const uid = String(record.uid || record.UID || record.userId || record.user_id || (singleCell ? '' : values[0]) || '').trim();
  const screenName = String(record.screenName || record.name || record.nickname || record['昵称'] || (singleCell ? values[0] : values[1]) || '').trim();
  if (!uid && !screenName) {
    throw new Error(`名单第 ${index + 1} 项缺少 uid 或昵称`);
  }
  const text = String(record.text || record.content || record['转发内容'] || values[2] || '').trim();
  const createdAt = String(record.createdAt || record.time || record['时间'] || values[3] || '').trim();
  const stable = [uid, screenName, text, createdAt].filter(Boolean).join('|') || String(index);
  return { id: stable, uid, screenName: screenName || `候选人 ${index + 1}`, avatar: '', verified: false, followers: 0, text, createdAt, repostId: '', source: 'manual' };
}

function parseDelimitedText(text, delimiter) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(value.trim());
      value = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(value.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      value = '';
    } else {
      value += char;
    }
  }

  row.push(value.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function parseManualInput(text) {
  const raw = String(text || '');
  if (new TextEncoder().encode(raw).byteLength > MAX_MANUAL_FILE_BYTES) {
    throw new Error('手动名单内容不能超过 5 MB');
  }
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('名单 JSON 格式不正确，请检查文件内容');
    }
    if (!Array.isArray(parsed)) throw new Error('JSON 顶层需要是数组');
    const items = parsed.filter((item) => item !== null && item !== undefined);
    if (items.length > MAX_MANUAL_CANDIDATES) throw new Error('手动名单最多支持 20,000 人');
    return items.map(normalizeManualItem);
  }
  const firstLine = trimmed.split(/\r?\n/, 1)[0];
  const delimiter = firstLine.includes('\t') ? '\t' : firstLine.includes(';') ? ';' : ',';
  const rows = parseDelimitedText(trimmed, delimiter);
  if (!rows.length) return [];
  const first = rows[0];
  const headerKeys = ['uid', 'UID', '昵称', 'screenName', 'name', 'text', '转发内容', 'time', '时间'];
  const hasHeader = first.some((cell) => headerKeys.includes(cell));
  const headers = hasHeader ? first : [];
  const dataRows = hasHeader ? rows.slice(1) : rows;
  if (dataRows.length > MAX_MANUAL_CANDIDATES) throw new Error('手动名单最多支持 20,000 人');
  return dataRows.map((cells, index) => {
    if (!headers.length) return normalizeManualItem(cells, index);
    const row = {};
    headers.forEach((key, cellIndex) => { row[key] = cells[cellIndex] || ''; });
    cells.forEach((cell, cellIndex) => { row[cellIndex] = cell || ''; });
    return normalizeManualItem(row, index);
  });
}

export async function seededShuffle(items, seedMaterial) {
  const result = [...items];
  let counter = 0;
  let words = [];
  let wordIndex = 0;
  async function refillWords() {
    const input = `${seedMaterial}:${counter++}`;
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    const view = new DataView(buffer);
    words = [];
    for (let offset = 0; offset < view.byteLength; offset += 4) {
      words.push(view.getUint32(offset, false));
    }
    wordIndex = 0;
  }
  async function nextUint32() {
    if (wordIndex >= words.length) await refillWords();
    return words[wordIndex++];
  }
  for (let i = result.length - 1; i > 0; i -= 1) {
    const range = i + 1;
    const limit = Math.floor(0x100000000 / range) * range;
    let value = await nextUint32();
    while (value >= limit) value = await nextUint32();
    const j = value % range;
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export async function digestCandidates(candidates) {
  const payload = JSON.stringify(candidates.map((item) => ({
    uid: item.uid,
    screenName: item.screenName,
    repostId: item.repostId,
    text: item.text,
    createdAt: item.createdAt,
  })));
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomSeedHex() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function toCsv(rows, headers = ['tier', 'uid', 'screenName', 'text', 'createdAt', 'source']) {
  const escape = (value) => {
    const raw = String(value ?? '');
    const safe = /^[=+\-@\t\r\n]/.test(raw.trimStart()) ? `'${raw}` : raw;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return [headers.map(escape).join(','), ...rows.map((row) => headers.map((key) => escape(row[key])).join(','))].join('\n');
}
