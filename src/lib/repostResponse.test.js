import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knownDrawCount, validateRepostResult } from './repostResponse.js';

test('unknown or invalid draw counts never become zero', () => {
  for (const value of [
    null,
    undefined,
    '',
    ' ',
    false,
    true,
    {},
    [],
    -1,
    1.2,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(knownDrawCount(value), null);
  }
  assert.equal(knownDrawCount(0), 0);
  assert.equal(knownDrawCount('12'), 12);
});

test('reject malformed candidates before they reach React or the draw pool', () => {
  for (const candidates of [
    null,
    {},
    'bad',
    [null],
    [{}],
    [{ uid: {} }],
    [{ uid: '1', screenName: [] }],
  ]) {
    assert.throws(() => validateRepostResult({ ok: true, candidates }), /名单格式异常/);
  }
  assert.throws(() => validateRepostResult({ ok: true, candidates: [], meta: [] }), /名单格式异常/);
  const result = { ok: true, candidates: [{ uid: '1', screenName: '候选' }], drawCount: null };
  assert.equal(validateRepostResult(result), result);
  assert.equal(validateRepostResult({ ok: true, candidates: [] }).candidates.length, 0);
});
