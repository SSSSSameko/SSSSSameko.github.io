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
