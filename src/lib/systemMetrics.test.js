import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  parseCgroupMemoryStat,
  resolveCgroupV2Directory,
  summarizeCgroupMemory,
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
