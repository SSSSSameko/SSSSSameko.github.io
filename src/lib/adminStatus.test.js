import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendKeepaliveEvent,
  formatDurationMs,
  memoryChartSeries,
} from './adminStatus.js';

test('formatDurationMs renders the 12 hour keepalive interval clearly', () => {
  assert.equal(formatDurationMs(12 * 60 * 60_000), '12 小时');
});

const memorySample = (minute, current = 100, anonymous = 50) => ({
  at: new Date(Date.UTC(2026, 10, 5, 12, minute)).toISOString(),
  cgroupCurrentMb: current,
  cgroupAnonMb: anonymous,
});

test('memory chart keeps valid channels and breaks only the unavailable series', () => {
  const chart = memoryChartSeries([memorySample(0), memorySample(5, null), memorySample(10, 0)], 200);
  assert.deepEqual(chart.current, [[{ x: 0, percent: 50 }], [{ x: 1, percent: 0 }]]);
  assert.equal(chart.anonymous[0].length, 3);
  assert.equal(chart.hasGaps, true);
});

test('memory chart uses time spacing and leaves long interruptions unconnected', () => {
  const chart = memoryChartSeries([memorySample(30), memorySample(0), memorySample(5)], 200);
  assert.equal(chart.current.length, 2);
  assert.equal(chart.current[0][1].x, 1 / 6);
  assert.equal(chart.current[1][0].x, 1);
  assert.equal(chart.hasGaps, true);
});

test('memory chart rejects missing, invalid and negative measurements without inventing zero', () => {
  const chart = memoryChartSeries([null, { at: 'invalid' }, ...[null, '', '100', -1, NaN, Infinity].map((value, index) => memorySample(index * 5, value, value))], 200);
  assert.deepEqual(chart.current, []);
  assert.deepEqual(chart.anonymous, []);
  assert.equal(chart.hasGaps, true);
  for (const limit of [null, 0, -1, Infinity]) {
    assert.equal(memoryChartSeries([memorySample(0)], limit).from, null);
  }
});

test('memory chart centers a single measurement and uses the last sample at a repeated timestamp', () => {
  const chart = memoryChartSeries([memorySample(0, 100), memorySample(0, 120)], 200);
  assert.deepEqual(chart.current, [[{ x: 0.5, percent: 60 }]]);
  assert.equal(chart.hasGaps, false);
});

test('appendKeepaliveEvent stores newest events first and caps history', () => {
  const base = {
    history: Array.from({ length: 12 }, (_, index) => ({
      at: `2026-06-22T00:${String(index).padStart(2, '0')}:00.000Z`,
      status: 'ok',
      message: `old-${index}`,
    })),
  };

  const next = appendKeepaliveEvent(base, {
    at: '2026-06-23T01:00:00.000Z',
    status: 'error',
    reason: 'scheduled-refresh',
    message: 'profile missing',
  });

  assert.equal(next.history.length, 12);
  assert.deepEqual(next.history[0], {
    at: '2026-06-23T01:00:00.000Z',
    status: 'error',
    reason: 'scheduled-refresh',
    message: 'profile missing',
  });
  assert.equal(next.history.at(-1).message, 'old-10');
});
