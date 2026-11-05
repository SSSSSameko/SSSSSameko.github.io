import { cleanApiBase, readStoredValue, writeStoredValue } from './appCore.js';
import { isResponseBodyTimeout, readResponseTextWithin } from './apiResponse.js';

const API_FETCH_TIMEOUT_MS = 45_000;
const API_RESPONSE_MAX_BYTES = 24 * 1024 * 1024;
const apiResponseLifecycles = new WeakMap();

function configuredApiBases() {
  const configured = [
    window.WEIBO_DRAW_API_BASE,
    ...(Array.isArray(window.WEIBO_DRAW_ALLOWED_API_BASES) ? window.WEIBO_DRAW_ALLOWED_API_BASES : []),
  ];
  return [...new Set(configured.map(cleanApiBase).filter(Boolean))];
}

function isLocalApiBase(value) {
  try {
    const url = new URL(cleanApiBase(value));
    return ['http:', 'https:'].includes(url.protocol)
      && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export function isTrustedApiBase(value) {
  const cleaned = cleanApiBase(value);
  if (!cleaned) return true;
  try {
    const url = new URL(cleaned);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (isLocalApiBase(cleaned)) return true;
    return configuredApiBases().includes(cleaned);
  } catch {
    return false;
  }
}

export function initialApiBase() {
  const storedApi = cleanApiBase(readStoredValue('weibo-draw-api-base'));
  if (storedApi && isTrustedApiBase(storedApi)) return storedApi;
  if (storedApi) writeStoredValue('weibo-draw-api-base', '');
  return cleanApiBase(window.WEIBO_DRAW_API_BASE || '');
}

export function presetApiBase() {
  return cleanApiBase(window.WEIBO_DRAW_API_BASE || '');
}

export function isPresetApiBase(value) {
  const cleaned = cleanApiBase(value);
  return Boolean(cleaned) && configuredApiBases().includes(cleaned);
}
// 预置服务地址不对访客展示，输入框只保留用户自己填过的自定义地址。
export function initialApiBaseInput() {
  const stored = cleanApiBase(readStoredValue('weibo-draw-api-base'));
  if (!stored || !isTrustedApiBase(stored) || isPresetApiBase(stored)) return '';
  return stored;
}

export function initialApiKey() {
  const injected = String(window.WEIBO_DRAW_API_KEY || '').trim();
  const stored = readStoredValue('weibo-draw-api-key').trim();
  const storedApiBase = cleanApiBase(readStoredValue('weibo-draw-api-base'));
  if (injected && !storedApiBase) return injected;
  return stored || injected;
}

let cachedClientId = '';
function requestClientId() {
  if (cachedClientId) return cachedClientId;
  const stored = readStoredValue('weibo-draw-client-id').trim();
  if (/^[A-Za-z0-9._:-]{8,64}$/.test(stored)) {
    cachedClientId = stored;
    return cachedClientId;
  }
  const generated = String(window.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`)
    .replace(/-/g, '')
    .slice(0, 32);
  writeStoredValue('weibo-draw-client-id', generated);
  cachedClientId = generated;
  return cachedClientId;
}

export function isStaticHostedPage() {
  return /\.github\.io$/i.test(location.hostname) || location.protocol === 'file:';
}

export function apiError(message, status) {
  const error = new Error(message);
  const code = Number(status);
  if (Number.isFinite(code)) error.status = code;
  return error;
}

export async function readApiResponse(response, label = '服务') {
  const lifecycle = apiResponseLifecycles.get(response);
  let text;
  try {
    text = await readResponseTextWithin(response, {
      timeoutMs: API_FETCH_TIMEOUT_MS,
      maxBytes: API_RESPONSE_MAX_BYTES,
      signal: lifecycle?.signal,
    });
  } catch (error) {
    if (lifecycle?.timedOut() || isResponseBodyTimeout(error)) {
      throw new Error(`${label}响应超时，请稍后重试。`);
    }
    throw error;
  } finally {
    lifecycle?.cleanup();
    apiResponseLifecycles.delete(response);
  }
  if (!text.trim()) {
    throw apiError(`${label}暂时不可用（HTTP ${response.status}），请检查后端连接后重试。`, response.status);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw apiError(`${label}返回格式异常（HTTP ${response.status}），请稍后重试。`, response.status);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw apiError(`${label}返回格式异常（HTTP ${response.status}），请稍后重试。`, response.status);
  }
  if (!response.ok) {
    throw apiError(data?.error || `${label}请求失败（HTTP ${response.status}）。`, response.status);
  }
  return data;
}

export async function requestApi(path, options = {}, { apiBase = '', apiKey = '' } = {}) {
  const requestBase = apiBase;
  if (!requestBase && isStaticHostedPage()) {
    throw new Error('当前是静态前端，请先在设置里确认后端接口地址。');
  }
  if (requestBase && !isTrustedApiBase(requestBase)) {
    throw new Error('后端接口地址不在可信列表里，请使用当前公开后端或本地地址。');
  }
  const headers = new Headers(options.headers || {});
  if (apiKey.trim()) headers.set('x-api-key', apiKey.trim());
  headers.set('x-client-id', requestClientId());
  const controller = new AbortController();
  let timedOut = false;
  const relayAbort = () => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) relayAbort();
    else options.signal.addEventListener('abort', relayAbort, { once: true });
  }
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_FETCH_TIMEOUT_MS);
  const requestPath = requestBase
    ? `${requestBase}${path.startsWith('/') ? path : `/${path}`}`
    : path;
  const cleanup = () => {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', relayAbort);
  };
  try {
    const response = await fetch(requestPath, {
      ...options,
      redirect: 'error',
      headers,
      signal: controller.signal,
    });
    apiResponseLifecycles.set(response, {
      signal: controller.signal,
      timedOut: () => timedOut,
      cleanup,
    });
    return response;
  } catch (error) {
    cleanup();
    if (timedOut) throw new Error('服务响应超时，请稍后重试。');
    if (error instanceof TypeError && !controller.signal.aborted) {
      throw new Error('无法连接后端，请检查网络与服务地址后重试。');
    }
    throw error;
  }
}
