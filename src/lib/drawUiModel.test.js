import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getAccountStatusText,
  getCandidateFreshnessText,
  getDrawActionState,
  getDrawCountText,
  getIntakeState,
  getNextDrawText,
} from './drawUiModel.js';

test('accountStatusText follows health, verification and fallback priority', () => {
  assert.equal(getAccountStatusText({
    cookieHealth: 'error',
    verifiedAccountCount: 2,
    tryableAccountCount: 3,
    hasFallbackCookie: true,
  }), '登录态状态暂不可用');
  assert.equal(getAccountStatusText({
    cookieHealth: 'ready',
    verifiedAccountCount: 2,
  }), '2 个已验证服务器登录态');
  assert.equal(getAccountStatusText({
    cookieHealth: 'ready',
    tryableAccountCount: 3,
  }), '服务器登录态已保存');
  assert.equal(getAccountStatusText({
    cookieHealth: 'ready',
    hasFallbackCookie: true,
  }), '已填写备用 Cookie');
});

test('draw count labels distinguish manual, unknown and active records', () => {
  assert.equal(getNextDrawText({
    source: 'mobile',
    previousDrawCount: null,
  }), '本链接下一次开奖（次数待核实）');
  assert.equal(getNextDrawText({
    source: 'manual',
    previousDrawCount: 2,
  }), '本机第 3 次手动开奖');
  assert.equal(getDrawCountText({
    activeReceipt: { source: 'mobile', drawNumber: 4 },
  }), '本链接第 4 次开奖');
  assert.equal(getDrawCountText({
    source: 'mobile',
    statusUrl: 'https://weibo.com/1/status',
    status: 'ready',
    count: null,
  }), '暂未获取到开奖次数');
});

test('candidate freshness prefers errors and pending source changes', () => {
  assert.equal(getCandidateFreshnessText({
    loadError: 'failed',
    sourceMeta: { delivery: 'recent-snapshot', snapshotAgeMs: 1000 },
  }), '上次载入未完成，等待重新载入');
  assert.equal(getCandidateFreshnessText({
    candidateCount: 2,
    sourceReady: false,
  }), '来源已修改，等待重新载入');
  assert.equal(getCandidateFreshnessText({
    source: 'mobile',
    sourceMeta: { delivery: 'recent-snapshot', snapshotAgeMs: 2500 },
  }), '复用 3 秒内名单');
});

test('intake state keeps error and empty-check states distinct', () => {
  assert.equal(getIntakeState({
    loading: false,
    loadError: 'failed',
    hasCandidates: true,
    drawState: 'ready',
  }), 'error');
  assert.equal(getIntakeState({
    loadCompleted: true,
    hasCandidates: false,
  }), 'checked-empty');
  assert.equal(getIntakeState({
    statusUrl: '123456',
  }), 'link-ready');
});

test('draw action follows reload, filter, confirmation and setup priority', () => {
  assert.equal(getDrawActionState({
    loadError: 'failed',
    hasCandidates: true,
  }).kind, 'load');
  assert.equal(getDrawActionState({
    hasCandidates: true,
    sourceReady: true,
    eligibleCount: 0,
  }).kind, 'filter');
  assert.equal(getDrawActionState({
    hasCandidates: true,
    sourceReady: true,
    eligibleCount: 4,
    setupConfirmed: true,
    nextDrawLabel: '本链接第 1 次开奖',
    totalSlots: 1,
  }).kind, 'draw');
  assert.equal(getDrawActionState({
    hasCandidates: true,
    sourceReady: true,
    eligibleCount: 4,
    prizeCount: 2,
    totalSlots: 3,
  }).kind, 'setup');
});
