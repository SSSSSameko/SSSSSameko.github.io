import path from 'node:path';

export function parseCgroupMemoryStat(text = '') {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const [name, rawValue] = line.trim().split(/\s+/, 2);
    const value = Number(rawValue);
    if (name && Number.isFinite(value)) values[name] = value;
  }
  return values;
}

export function resolveCgroupV2Directory(cgroupText = '', root = '/sys/fs/cgroup') {
  const line = String(cgroupText)
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('0::'));
  if (!line) return '';
  const relativePath = line.slice(3).trim().replace(/^[/\\]+/, '');
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)
    ? resolvedPath
    : '';
}

export function summarizeCgroupMemory({ current = 0, peak = 0, stat = {} } = {}) {
  const anon = Number(stat.anon || 0);
  const file = Number(stat.file || 0);
  const kernel = Number(stat.kernel || 0);
  const slab = Number(stat.slab || 0);
  return {
    current: Number(current) || 0,
    peak: Number(peak) || 0,
    anon,
    file,
    kernel,
    reclaimable: Math.max(0, file + Number(stat.slab_reclaimable || 0)),
    slab,
  };
}

export function parseProcMeminfo(text = '') {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s+(\d+)\s*(kB)?/i);
    if (!match) continue;
    const multiplier = match[3] ? 1024 : 1;
    values[match[1].trim()] = Number(match[2]) * multiplier;
  }
  return values;
}

export function summarizeHostMemory(values = {}) {
  const total = Number(values.MemTotal || 0);
  const free = Number(values.MemFree || 0);
  const available = Number(values.MemAvailable || free);
  const cached = Number(values.Cached || 0) + Number(values.SReclaimable || 0);
  const buffers = Number(values.Buffers || 0);
  const used = Math.max(0, total - available);
  return {
    total,
    free,
    available,
    cached,
    buffers,
    used,
    usedPercent: total ? Math.round((used / total) * 1000) / 10 : 0,
  };
}

export function analyzeMemoryTrend(samples, field = 'cgroupAnonMb') {
  const points = (Array.isArray(samples) ? samples : [])
    .map((sample) => ({
      at: Date.parse(sample?.at || ''),
      value: Number(sample?.[field]),
    }))
    .filter((point) => Number.isFinite(point.at) && Number.isFinite(point.value));
  if (points.length < 2) {
    return { status: 'insufficient', deltaMb: 0, perHourMb: 0, sampleCount: points.length };
  }
  const first = points[0];
  const last = points.at(-1);
  const hours = Math.max((last.at - first.at) / 3_600_000, 1 / 60);
  const deltaMb = Math.round((last.value - first.value) * 10) / 10;
  const perHourMb = Math.round((deltaMb / hours) * 10) / 10;
  const status = perHourMb > 8
    ? 'rising'
    : perHourMb < -8
      ? 'falling'
      : 'stable';
  return { status, deltaMb, perHourMb, sampleCount: points.length };
}
