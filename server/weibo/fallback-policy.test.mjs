import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideRepostFallback } from './fallback-policy.mjs';

function attempt(provider, visibleNumber, totalNumber, overrides = {}) {
  return { provider, visibleNumber, totalNumber, addedCount: provider === 'mobile' ? 0 : visibleNumber,
    status: 'ok', scanStopReason: 'declared-end', identityUncertainCount: 0,
    paginationError: null, totalChanged: false, headRefreshFailed: false, ...overrides };
}
function decide(count, total, changes = {}) {
  return decideRepostFallback({ count, total, attempts: [attempt('desktop-cookie', count, total), attempt('mobile', count, total)], ...changes });
}

test('a verified zero-gain second provider can exempt a bounded twenty-percent small gap', () => {
  for (const [count, total, missing] of [[24,29,5], [40,50,10], [80,100,20]]) {
    const outcome = decide(count,total);
    assert.equal(outcome.stop, missing <= 10);
    assert.equal(outcome.complete, false);
    if (missing <= 10) assert.equal(outcome.stopReason, 'stable-small-gap');
  }
});

test('small absolute gaps cannot exempt large percentages, zero results, or unknown totals', () => {
  for (const [count,total] of [[12,18],[9,12],[0,164],[39,50]]) assert.equal(decide(count,total).stop, false);
  const unknown = decide(24,null);
  assert.notEqual(unknown.stopReason, 'stable-small-gap');
  assert.equal(unknown.complete, false);
});

test('same counts do not imply no gain, same sets or a stable total', () => {
  for (const overrides of [{ addedCount: 1 }, { visibleNumber: 23 }, { totalNumber: 28 }, { totalChanged: true }]) {
    assert.equal(decide(24,29,{ attempts: [attempt('desktop-cookie',24,29),attempt('mobile',24,29,overrides)] }).stop, false);
  }
});

test('errors, incomplete scans and unreliable identities never qualify for the extended exemption', () => {
  for (const overrides of [
    { paginationError: { page: 2 } }, { status: 'error' }, { identityUncertainCount: 1 },
    { scanStopReason: 'page-limit' }, { scanStopReason: 'repeated-pages' },
    { scanStopReason: 'empty-pages' }, { headRefreshFailed: true },
  ]) {
    assert.equal(decide(24,29,{ attempts: [attempt('desktop-cookie',24,29,overrides),attempt('mobile',24,29)] }).stop, false);
  }
  assert.equal(decide(24,29,{ attempts: [attempt('desktop-cookie',24,29)] }).stop, false);
});

test('the existing ten-percent stop rule is separate from actual count completeness', () => {
  const partial = decide(90,100,{ attempts: [attempt('desktop-cookie',90,100)] });
  assert.equal(partial.stop, true);
  assert.equal(partial.complete, false);
  assert.equal(partial.stopReason, 'within-tolerance');
  assert.equal(partial.missingCount, 10);
  const errorAttempt = attempt('desktop-cookie',90,100,{ paginationError: { page: 2 } });
  assert.equal(decide(90,100,{ attempts: [errorAttempt] }).stop, false);
  assert.equal(decide(100,100,{ attempts: [errorAttempt,attempt('mobile',10,100,{ addedCount:10 })] }).complete, true);
  assert.equal(decide(100,100,{ limitReason:'count' }).complete, false);
  assert.equal(decide(0,0).complete, true);
});

test('lists of at least 200 allow twenty percent only after healthy scans', () => {
  for (const [count,total,stop] of [[179,199,true],[178,199,false],[160,200,true],[159,200,false],[800,1000,true],[799,1000,false],[328,392,true],[1194,2044,false]]) {
    const outcome = decide(count,total,{ attempts:[attempt('desktop-cookie',count,total)] });
    assert.equal(outcome.stop,stop, `${count}/${total}`);
    assert.equal(outcome.complete,false);
    if (stop && total >= 200) assert.equal(outcome.stopReason,'large-list-tolerance');
  }
  for (const overrides of [{ paginationError:{page:2} },{ status:'error' },{ scanStopReason:'page-limit' },{ scanStopReason:'repeated-pages' },{ scanStopReason:'empty-pages' },{ headRefreshFailed:true }]) {
    assert.equal(decide(160,200,{ attempts:[attempt('desktop-cookie',160,200,overrides)] }).stop,false);
  }
});
