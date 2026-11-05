import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants as zlibConstants } from 'node:zlib';

const gzipBuffer = promisify(gzip);
const brotliBuffer = promisify(brotliCompress);
const COMPRESSIBLE_TYPE = /^(?:text\/|application\/(?:javascript|json|manifest\+json|xml)|image\/svg\+xml)/;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

export function staticContentType(filePath) {
  return CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream';
}

function entryBytes(entry) {
  return entry.raw.length + (entry.gzip?.length || 0) + (entry.brotli?.length || 0);
}

export class StaticAssetCache {
  #entries = new Map();
  #loads = new Map();
  #bytes = 0;
  #maxEntries;
  #maxBytes;

  constructor({ maxEntries = 64, maxBytes = 48 * 1024 * 1024 } = {}) {
    this.#maxEntries = maxEntries;
    this.#maxBytes = maxBytes;
  }

  async load(filePath) {
    const stat = await fs.stat(filePath);
    const cached = this.#entries.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      this.#entries.delete(filePath);
      this.#entries.set(filePath, cached);
      return cached;
    }

    const pending = this.#loads.get(filePath);
    if (pending) {
      const entry = await pending;
      if (entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) return entry;
      return this.load(filePath);
    }

    const operation = this.#read(filePath, stat);
    this.#loads.set(filePath, operation);
    try {
      return await operation;
    } finally {
      this.#loads.delete(filePath);
    }
  }

  async #read(filePath, stat) {
    const raw = await fs.readFile(filePath);
    const contentType = staticContentType(filePath);
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const entry = { raw, size: stat.size, mtimeMs: stat.mtimeMs, contentType, etag };
    if (raw.length >= 1024 && COMPRESSIBLE_TYPE.test(contentType)) {
      [entry.gzip, entry.brotli] = await Promise.all([
        gzipBuffer(raw, { level: 6 }),
        brotliBuffer(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }),
      ]);
    }

    const previous = this.#entries.get(filePath);
    if (previous) this.#bytes -= entryBytes(previous);
    this.#entries.delete(filePath);
    this.#entries.set(filePath, entry);
    this.#bytes += entryBytes(entry);
    while (this.#entries.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#bytes -= entryBytes(this.#entries.get(oldest));
      this.#entries.delete(oldest);
    }
    return entry;
  }
}

function encodingQualities(value) {
  const qualities = new Map();
  for (const part of String(value || '').toLowerCase().split(',')) {
    const [rawToken, ...parameters] = part.trim().split(';');
    const token = rawToken.trim();
    if (!['br', 'gzip', 'identity', '*'].includes(token)) continue;
    const parameter = parameters.map((entry) => entry.trim()).find((entry) => /^q\s*=/.test(entry));
    const quality = parameter ? Number(parameter.slice(parameter.indexOf('=') + 1).trim()) : 1;
    qualities.set(token, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
  }
  return {
    brotli: qualities.get('br') ?? qualities.get('*') ?? 0,
    gzip: qualities.get('gzip') ?? qualities.get('*') ?? 0,
    identity: qualities.get('identity') ?? (qualities.get('*') === 0 ? 0 : 1),
    identityExplicit: qualities.has('identity'),
  };
}

export function staticResponseBody(req, entry) {
  const quality = encodingQualities(req.headers['accept-encoding']);
  const brotliQuality = entry.brotli ? quality.brotli : 0;
  const gzipQuality = entry.gzip ? quality.gzip : 0;
  // Unspecified identity remains an acceptable fallback; an explicit weight participates in ranking.
  if (quality.identityExplicit && quality.identity > Math.max(brotliQuality, gzipQuality)) {
    return { body: entry.raw, encoding: '' };
  }
  if (brotliQuality > 0 && brotliQuality >= gzipQuality) return { body: entry.brotli, encoding: 'br' };
  if (gzipQuality > 0) return { body: entry.gzip, encoding: 'gzip' };
  if (quality.identity === 0) return null;
  return { body: entry.raw, encoding: '' };
}

export function staticRequestNotModified(req, etag) {
  const header = String(req.headers['if-none-match'] || '');
  return header.split(',').some((item) => {
    const tag = item.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag;
  });
}

export function staticCacheHeaders(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const name = path.basename(filePath);
  if (name === 'index.html' || name === 'config.js') return { 'cache-control': 'no-cache' };
  if (normalized.includes('/assets/')) return { 'cache-control': 'public, max-age=31536000, immutable' };
  if (/\.(?:avif|gif|jpe?g|png|webp)$/i.test(name)) return { 'cache-control': 'public, max-age=2592000' };
  return { 'cache-control': 'public, max-age=3600' };
}
