export const SOURCE_LABELS = { mobile: 'H5 可见转发', manual: '手动名单', official: '官方接口' };

export const PROVIDER_LABELS = {
  manual: '手动名单',
  cookie: '服务器 Cookie 池',
  mobile: 'H5 可见转发',
  official: '官方接口',
  desktop: '桌面可见转发',
  legacy: '微博旧版接口',
  'desktop-cookie': '桌面 Cookie 接口',
};

export function cleanApiBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
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

export function buildFilterSummary({ keyword, mentionMin, uniqueByUser, excludePrevious }) {
  const parts = [];
  if (keyword) parts.push(`关键词：${keyword}`);
  if (Number(mentionMin || 0) > 0) parts.push(`至少 @${Number(mentionMin || 0)}`);
  if (uniqueByUser) parts.push('同一用户只保留一次');
  if (excludePrevious) parts.push('排除本轮已中奖用户');
  return parts.length ? parts.join(' / ') : '未启用额外筛选';
}

export function parseCsvLine(line, delimiter) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') { value += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { cells.push(value.trim()); value = ''; }
    else value += char;
  }
  cells.push(value.trim());
  return cells;
}

export function normalizeManualItem(raw, index) {
  const values = Array.isArray(raw) ? raw : Object.values(raw || {});
  const singleCell = Array.isArray(raw) && values.length === 1;
  const uid = String(raw.uid || raw.UID || raw.userId || raw.user_id || (singleCell ? '' : values[0]) || '').trim();
  const screenName = String(raw.screenName || raw.name || raw.nickname || raw['昵称'] || (singleCell ? values[0] : values[1]) || `候选人 ${index + 1}`).trim();
  const text = String(raw.text || raw.content || raw['转发内容'] || values[2] || '').trim();
  const createdAt = String(raw.createdAt || raw.time || raw['时间'] || values[3] || '').trim();
  const stable = [uid, screenName, text, createdAt].filter(Boolean).join('|') || String(index);
  return { id: stable, uid, screenName, avatar: '', verified: false, followers: 0, text, createdAt, repostId: '', source: 'manual' };
}

export function parseManualInput(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('JSON 顶层需要是数组');
    return parsed.map(normalizeManualItem);
  }
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const delimiter = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
  const first = parseCsvLine(lines[0], delimiter);
  const headerKeys = ['uid', 'UID', '昵称', 'screenName', 'name', 'text', '转发内容', 'time', '时间'];
  const hasHeader = first.some((cell) => headerKeys.includes(cell));
  const headers = hasHeader ? first : [];
  const dataLines = hasHeader ? lines.slice(1) : lines;
  return dataLines.map((line, index) => {
    const cells = parseCsvLine(line, delimiter);
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

export function toCsv(rows) {
  const headers = ['tier', 'uid', 'screenName', 'text', 'createdAt', 'source'];
  const escape = (value) => {
    const raw = String(value ?? '');
    const safe = /^[=+\-@\t\r\n]/.test(raw.trimStart()) ? `'${raw}` : raw;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return [headers.map(escape).join(','), ...rows.map((row) => headers.map((key) => escape(row[key])).join(','))].join('\n');
}
