import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  analyzeMemoryTrend,
  parseCgroupMemoryStat,
  parseProcMeminfo,
  resolveCgroupV2Directory,
  summarizeCgroupMemory,
  summarizeHostMemory,
} from './systemMetrics.js';

test('parseCgroupMemoryStat reads numeric counters', () => {
  assert.deepEqual(parseCgroupMemoryStat('anon 4096\nfile 8192\ninvalid nope\n'), {
    anon: 4096,
    file: 8192,
  });
});

test('resolveCgroupV2Directory stays under the cgroup root', () => {
  assert.equal(
    resolveCgroupV2Directory('0::/system.slice/example.service\n', '/sys/fs/cgroup'),
    path.resolve('/sys/fs/cgroup', 'system.slice/example.service'),
  );
  assert.equal(resolveCgroupV2Directory('2:memory:/legacy\n'), '');
  assert.equal(resolveCgroupV2Directory('0::/../../tmp\n', '/sys/fs/cgroup'), '');
});

test('summarizeCgroupMemory separates anonymous and reclaimable memory', () => {
  assert.deepEqual(summarizeCgroupMemory({
    current: 30_000,
    peak: 50_000,
    stat: {
      anon: 10_000,
      file: 15_000,
      kernel: 3_000,
      slab: 2_000,
      slab_reclaimable: 1_500,
    },
  }), {
    current: 30_000,
    peak: 50_000,
    anon: 10_000,
    file: 15_000,
    kernel: 3_000,
    reclaimable: 16_500,
    slab: 2_000,
  });
});

test('host memory uses MemAvailable instead of treating cache as occupied', () => {
  const values = parseProcMeminfo([
    'MemTotal:        2048000 kB',
    'MemFree:          300000 kB',
    'MemAvailable:    1500000 kB',
    'Buffers:           20000 kB',
    'Cached:           700000 kB',
    'Slab:              90000 kB',
    'SReclaimable:      50000 kB',
    'SUnreclaim:        40000 kB',
    'AnonPages:        120000 kB',
  ].join('\n'));
  const summary = summarizeHostMemory(values);

  assert.equal(summary.total, 2048000 * 1024);
  assert.equal(summary.used, 548000 * 1024);
  assert.equal(summary.usedPercent, 26.8);
  assert.equal(summary.cached, 750000 * 1024);
  assert.equal(summary.slab, 90000 * 1024);
  assert.equal(summary.slabReclaimable, 50000 * 1024);
  assert.equal(summary.slabUnreclaimable, 40000 * 1024);
  assert.equal(summary.anon, 120000 * 1024);
});

test('memory trend distinguishes a plateau from sustained growth', () => {
  const stable = analyzeMemoryTrend([
    { at: '2026-07-25T00:00:00.000Z', cgroupAnonMb: 40 },
    { at: '2026-07-25T01:00:00.000Z', cgroupAnonMb: 44 },
  ]);
  const rising = analyzeMemoryTrend([
    { at: '2026-07-25T00:00:00.000Z', cgroupAnonMb: 40 },
    { at: '2026-07-25T01:00:00.000Z', cgroupAnonMb: 58 },
  ]);

  assert.equal(stable.status, 'stable');
  assert.equal(rising.status, 'rising');
  assert.equal(rising.perHourMb, 18);
});

test('memory trend ignores cold-start growth after repeated keepalive runs plateau', () => {
  const summary = analyzeMemoryTrend([
    { at: '2026-07-25T00:00:00.000Z', cgroupAnonMb: 14 },
    { at: '2026-07-25T00:01:00.000Z', cgroupAnonMb: 56 },
    { at: '2026-07-25T00:02:00.000Z', cgroupAnonMb: 49.5 },
    { at: '2026-07-25T00:03:00.000Z', cgroupAnonMb: 53 },
    { at: '2026-07-25T00:04:00.000Z', cgroupAnonMb: 53.7 },
  ]);

  assert.equal(summary.status, 'stable');
  assert.equal(summary.perHourMb, 0);
  assert.equal(summary.sampleCount, 4);
});
