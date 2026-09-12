import assert from 'node:assert/strict';
import test from 'node:test';

import { isQuotaError } from './storageErrors.js';

test('isQuotaError recognizes browser quota failures only', () => {
  assert.equal(isQuotaError({ name: 'QuotaExceededError' }), true);
  assert.equal(isQuotaError({ code: 22 }), true);
  assert.equal(isQuotaError({ code: 1014 }), true);
  assert.equal(isQuotaError(new Error('The quota has been exceeded')), true);
  assert.equal(isQuotaError(new Error('storage disabled')), false);
  assert.equal(isQuotaError(null), false);
});
