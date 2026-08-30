import assert from 'node:assert/strict';
import test from 'node:test';

import { dampSheetDrag, sheetDismissDuration, shouldDismissSheet } from './useSheetDrag.js';

test('sheet drag follows downward movement and resists upward movement', () => {
  assert.equal(dampSheetDrag(140, 600), 140);
  assert.equal(dampSheetDrag(-100, 600), -8);
});

test('sheet dismissal accepts either distance or a quick downward flick', () => {
  assert.equal(shouldDismissSheet({ distance: 130, velocity: 0, height: 600 }), true);
  assert.equal(shouldDismissSheet({ distance: 25, velocity: 900, height: 600 }), true);
  assert.equal(shouldDismissSheet({ distance: 60, velocity: 300, height: 600 }), false);
});

test('sheet dismissal duration follows the remaining distance and release speed', () => {
  const slowRelease = sheetDismissDuration({ distance: 130, velocity: 400, height: 600 });
  const quickFlick = sheetDismissDuration({ distance: 130, velocity: 2200, height: 600 });
  const almostClosed = sheetDismissDuration({ distance: 580, velocity: 900, height: 600 });

  assert.equal(slowRelease, 280);
  assert.ok(quickFlick < slowRelease);
  assert.ok(almostClosed < quickFlick);
  assert.ok(almostClosed >= 120);
});
