const DEFAULT_RESPONSE_TIMEOUT_MS = 20_000;
const DEFAULT_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

function timeoutError(timeoutMs) {
  const error = new Error(`服务器响应超时（${Math.ceil(timeoutMs / 1000)} 秒）`);
  error.name = 'TimeoutError';
  error.code = 'RESPONSE_BODY_TIMEOUT';
  return error;
}

function tooLargeError(maxBytes) {
  const error = new Error(`服务器响应超过 ${Math.ceil(maxBytes / 1024 / 1024)} MB 限制`);
  error.code = 'RESPONSE_BODY_TOO_LARGE';
  return error;
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  error.code = 'RESPONSE_BODY_ABORTED';
  return error;
}

function cancelBody(response, reader, reason) {
  try {
    const result = reader?.cancel ? reader.cancel(reason) : response?.body?.cancel?.(reason);
    Promise.resolve(result).catch(() => {});
  } catch {
  }
}

function responseLimits(options) {
  const configuredTimeout = Number(options.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS);
  const configuredMaxBytes = Number(options.maxBytes ?? DEFAULT_RESPONSE_MAX_BYTES);
  return {
    timeoutMs: Number.isFinite(configuredTimeout)
      ? Math.max(1, configuredTimeout)
      : DEFAULT_RESPONSE_TIMEOUT_MS,
    maxBytes: Number.isFinite(configuredMaxBytes)
      ? Math.max(1, Math.floor(configuredMaxBytes))
      : DEFAULT_RESPONSE_MAX_BYTES,
  };
}

export async function readResponseTextWithin(response, options = {}) {
  const { timeoutMs, maxBytes } = responseLimits(options);
  const signal = options.signal;
  const declaredLength = Number(response?.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = tooLargeError(maxBytes);
    cancelBody(response, null, error);
    throw error;
  }

  const reader = response?.body?.getReader?.();
  let timer;
  let stop;
  const stopped = new Promise((_resolve, reject) => {
    stop = reject;
  });
  stopped.catch(() => {});
  const abort = () => {
    const error = abortError(signal);
    stop(error);
    cancelBody(response, reader, error);
  };
  timer = setTimeout(() => {
    const error = timeoutError(timeoutMs);
    stop(error);
    cancelBody(response, reader, error);
  }, timeoutMs);
  if (signal) {
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  }

  try {
    if (!reader) {
      const bodyPromise = Promise.resolve().then(() => response.text());
      bodyPromise.catch(() => {});
      const text = await Promise.race([bodyPromise, stopped]);
      if (new TextEncoder().encode(String(text || '')).byteLength > maxBytes) {
        throw tooLargeError(maxBytes);
      }
      return text;
    }

    const decoder = new TextDecoder();
    const chunks = [];
    let received = 0;
    while (true) {
      const read = reader.read();
      read.catch(() => {});
      const { done, value } = await Promise.race([read, stopped]);
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || []);
      received += chunk.byteLength;
      if (received > maxBytes) {
        const error = tooLargeError(maxBytes);
        cancelBody(response, reader, error);
        throw error;
      }
      chunks.push(decoder.decode(chunk, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    try {
      reader?.releaseLock?.();
    } catch {
    }
  }
}

export async function readJsonResponse(response, options = {}) {
  const {
    fallback = {},
    strict = false,
  } = options;
  const text = await readResponseTextWithin(response, options);
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch (cause) {
    if (!strict) return fallback;
    const error = new Error('服务器返回格式异常');
    error.code = 'INVALID_RESPONSE_JSON';
    error.cause = cause;
    throw error;
  }
}
