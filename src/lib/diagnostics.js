// 统一的诊断口径：服务端记录、后台展示和边缘日志解析共用这一套分类，
// 避免每个调用点自己拼字符串，导致后台统计前后不一致。

export const DIAGNOSTIC_LEVELS = ['info', 'warning', 'error', 'critical'];

export const DIAGNOSTIC_LEVEL_LABELS = {
  info: '信息',
  warning: '警告',
  error: '错误',
  critical: '严重',
};

export const DIAGNOSTIC_CATEGORY_LABELS = {
  request: '接口请求',
  auth: '登录与权限',
  security: '安全防护',
  weibo: '微博抓取',
  cookie: 'Cookie 与登录态',
  browser: '浏览器',
  job: '抓取任务',
  storage: '存储',
  records: '开奖记录',
  feedback: '用户反馈',
  admin: '后台',
  system: '服务运行',
};

const CATEGORY_ALIASES = new Map([
  ['server', 'system'],
  ['runtime', 'system'],
  ['process', 'system'],
  ['http', 'request'],
  ['api', 'request'],
  ['reposts', 'weibo'],
  ['weibo-fetch', 'weibo'],
  ['fetch', 'weibo'],
  ['keepalive', 'cookie'],
  ['login', 'auth'],
  ['admin-events', 'admin'],
  ['metrics', 'storage'],
  ['system-metrics', 'storage'],
  ['file', 'storage'],
  ['jobs', 'job'],
  ['tasks', 'job'],
]);

const LEVEL_ALIASES = new Map([
  ['ok', 'info'],
  ['success', 'info'],
  ['info', 'info'],
  ['notice', 'info'],
  ['warn', 'warning'],
  ['warning', 'warning'],
  ['blocked', 'warning'],
  ['fail', 'error'],
  ['failed', 'error'],
  ['error', 'error'],
  ['fatal', 'critical'],
  ['critical', 'critical'],
  ['emergency', 'critical'],
]);

// 常见扫描目标；边缘代理通常在应用之前就拦掉这些路径，缺少代理规则时会落到应用。
const SCANNER_PATH_PATTERNS = [
  /^\/\.env(?:[./]|$)/,
  /^\/\.git(?:\/|$)/,
  /^\/\.well-known\/security\.txt$/,
  /^\/sitemap(?:\.xml)?$/,
  /^\/config\.json$/,
  /^\/home\/login\.html$/,
  /^\/wp-(?:admin|login|content|includes)/,
  /^\/xmlrpc\.php$/,
  /^\/phpmyadmin/,
  /^\/pma(?:\/|$)/,
  /^\/vendor\//,
  /^\/server-(?:status|info)$/,
  /^\/actuator(?:\/|$)/,
  /^\/api\/actuator(?:\/|$)/,
  /^\/mcp(?:\/|$)/,
  /^\/api\/mcp(?:\/|$)/,
  /^\/cgi-bin\//,
  /^\/adminer/,
  /^\/druid\//,
  /^\/telescope/,
  /^\/boaform\//,
  /^\/geoserver/,
];

function boundedText(value, maxChars, fallback = '') {
  const text = String(value ?? '').trim() || fallback;
  if (!text) return '';
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function normalizeDiagnosticCategory(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'system';
  const mapped = CATEGORY_ALIASES.get(raw) || raw;
  return Object.hasOwn(DIAGNOSTIC_CATEGORY_LABELS, mapped) ? mapped : 'system';
}

export function diagnosticCategoryLabel(value) {
  return DIAGNOSTIC_CATEGORY_LABELS[normalizeDiagnosticCategory(value)];
}

export function normalizeDiagnosticLevel(value) {
  const raw = String(value || '').trim().toLowerCase();
  return LEVEL_ALIASES.get(raw) || 'info';
}

export function diagnosticLevelLabel(value) {
  return DIAGNOSTIC_LEVEL_LABELS[normalizeDiagnosticLevel(value)];
}

export function diagnosticLevelRank(value) {
  const index = DIAGNOSTIC_LEVELS.indexOf(normalizeDiagnosticLevel(value));
  return index < 0 ? 0 : index;
}

export function isScannerPath(pathname) {
  const value = String(pathname || '').trim().toLowerCase();
  if (!value) return false;
  return SCANNER_PATH_PATTERNS.some((pattern) => pattern.test(value));
}

// 把一次失败的 HTTP 请求归到「业务错误 / 鉴权 / 限流 / 扫描 / 服务故障」之一。
export function classifyHttpFailure(input = {}) {
  const status = Number(input.status) || 0;
  const requestPath = String(input.path || '/');
  if (input.probe === true || isScannerPath(requestPath)) {
    return { category: 'security', level: 'warning', code: 'scanner-probe', label: '扫描探测' };
  }
  if (status === 401 || status === 403) {
    const adminApi = requestPath === '/api/admin' || requestPath.startsWith('/api/admin/');
    return {
      category: 'auth',
      level: 'warning',
      code: adminApi ? 'admin-auth-rejected' : 'auth-rejected',
      label: adminApi ? '后台鉴权未通过' : '接口鉴权未通过',
    };
  }
  if (status === 429) {
    return { category: 'request', level: 'warning', code: 'rate-limited', label: '触发限流' };
  }
  if (status === 400 || status === 422) {
    return { category: 'request', level: 'warning', code: 'invalid-request', label: '请求内容不合法' };
  }
  if (status === 405) {
    return { category: 'request', level: 'info', code: 'method-not-allowed', label: '请求方法不支持' };
  }
  if (status === 404) {
    return { category: 'request', level: 'info', code: 'not-found', label: '接口或资源不存在' };
  }
  if (status === 413) {
    return { category: 'request', level: 'warning', code: 'payload-too-large', label: '请求体超过限制' };
  }
  if (status >= 500) {
    return { category: 'system', level: 'error', code: 'server-error', label: '服务处理失败' };
  }
  if (status >= 400) {
    return { category: 'request', level: 'warning', code: 'client-error', label: '请求被拒绝' };
  }
  return { category: 'request', level: 'info', code: 'ok', label: '正常' };
}

export function securitySignalLabel(key) {
  return {
    'scanner-scan': '疑似漏洞扫描',
    'admin-login-failure': '后台登录失败聚集',
    'rate-limit-abuse': '接口触发限流聚集',
    'malformed-request': '畸形请求聚集',
    'upstream-auth': '微博登录态失效',
    'upstream-error': '微博抓取失败聚集',
  }[String(key || '')] || '安全提醒';
}

export function summarizeDiagnosticEvents(events, options = {}) {
  const items = Array.isArray(events) ? events.filter(Boolean) : [];
  const limit = Math.max(1, Math.floor(Number(options.limit) || 24));
  const categories = new Map();
  const levels = new Map();
  for (const item of items) {
    const category = normalizeDiagnosticCategory(item.category);
    const level = normalizeDiagnosticLevel(item.level ?? item.status);
    const levelRank = diagnosticLevelRank(level);
    const current = categories.get(category);
    if (current) {
      current.count += 1;
      if (!current.lastAt || Date.parse(item.at || 0) > Date.parse(current.lastAt || 0)) {
        current.lastAt = item.at || current.lastAt;
        current.message = item.message || current.message;
      }
      if (levelRank > current.rank) {
        current.level = level;
        current.rank = levelRank;
      }
    } else {
      categories.set(category, {
        category,
        label: diagnosticCategoryLabel(category),
        level,
        rank: levelRank,
        count: 1,
        lastAt: item.at || '',
        message: item.message || '',
      });
    }
    levels.set(level, (levels.get(level) || 0) + 1);
  }
  return {
    total: items.length,
    byLevel: DIAGNOSTIC_LEVELS
      .filter((level) => levels.has(level))
      .map((level) => ({ level, label: diagnosticLevelLabel(level), count: levels.get(level) })),
    byCategory: [...categories.values()]
      .map(({ rank, ...entry }) => entry)
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
    recent: items.slice(-limit).reverse(),
  };
}

function maskedSource(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(source)) {
    const [first, second] = source.split('.');
    return `${first}.${second}.x.x`;
  }
  if (source.includes(':')) {
    const groups = source.split(':').filter(Boolean);
    return `${groups.slice(0, 2).join(':')}::x`;
  }
  return boundedText(source, 24);
}

// 解析 Caddy JSON 访问日志，只做聚合，不回传原始 IP 和完整 URI 参数。
export function summarizeEdgeAccessLog(text, options = {}) {
  const maxLines = Math.max(1, Math.floor(Number(options.maxLines) || 4000));
  const top = Math.max(1, Math.floor(Number(options.top) || 8));
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim()).slice(-maxLines);
  const statusCounts = new Map();
  const errorPaths = new Map();
  const scannerPaths = new Map();
  const sources = new Map();
  let parsed = 0;
  let skipped = 0;
  let firstAt = '';
  let lastAt = '';
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (!entry || typeof entry !== 'object') {
      skipped += 1;
      continue;
    }
    parsed += 1;
    const status = Number(entry.status) || 0;
    const method = boundedText(entry.request?.method, 12, 'GET').toUpperCase();
    const rawUri = String(entry.request?.uri || '/');
    const uri = rawUri.split('?')[0].split('#')[0].slice(0, 200) || '/';
    const source = maskedSource(entry.request?.remote_ip || entry.request?.remote_addr || '');
    const at = Number(entry.ts)
      ? new Date(Number(entry.ts) * 1000).toISOString()
      : '';
    if (at) {
      if (!firstAt || at < firstAt) firstAt = at;
      if (!lastAt || at > lastAt) lastAt = at;
    }
    statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    if (status >= 400) {
      const key = `${status}\u0000${method}\u0000${uri}`;
      errorPaths.set(key, (errorPaths.get(key) || 0) + 1);
    }
    if (isScannerPath(uri)) {
      const key = `${method}\u0000${uri}`;
      scannerPaths.set(key, (scannerPaths.get(key) || 0) + 1);
      if (source) sources.set(source, (sources.get(source) || 0) + 1);
    }
  }
  const splitCounted = (map, keyBuilder, limit) => [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ ...keyBuilder(key), count }));
  return {
    lines: lines.length,
    parsed,
    skipped,
    firstAt,
    lastAt,
    statusCounts: [...statusCounts.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([status, count]) => ({ status, count })),
    topErrors: splitCounted(errorPaths, (key) => {
      const [status, method, uri] = key.split('\u0000');
      return { status: Number(status), method, path: uri };
    }, top),
    scanners: splitCounted(scannerPaths, (key) => {
      const [method, uri] = key.split('\u0000');
      return { method, path: uri };
    }, top),
    topSources: [...sources.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, top)
      .map(([source, count]) => ({ source, count })),
  };
}
