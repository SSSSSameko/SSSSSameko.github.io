import assert from 'node:assert/strict';
import test from 'node:test';

import { listDisplayState } from './admin-list-state.js';

test('listDisplayState hides extra items until expanded', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];
  const collapsed = listDisplayState(items, { limit: 4, expanded: false });

  assert.deepEqual(collapsed.items, ['a', 'b', 'c', 'd']);
  assert.equal(collapsed.total, 6);
  assert.equal(collapsed.hiddenCount, 2);
  assert.equal(collapsed.canToggle, true);
  assert.equal(collapsed.actionLabel, '查看更多 2 条');
});

test('listDisplayState returns every item when expanded', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];
  const expanded = listDisplayState(items, { limit: 4, expanded: true });

  assert.deepEqual(expanded.items, items);
  assert.equal(expanded.hiddenCount, 2);
  assert.equal(expanded.canToggle, true);
  assert.equal(expanded.actionLabel, '收起');
});

test('listDisplayState avoids a toggle when the list is short', () => {
  const state = listDisplayState(['a', 'b'], { limit: 4 });

  assert.deepEqual(state.items, ['a', 'b']);
  assert.equal(state.hiddenCount, 0);
  assert.equal(state.canToggle, false);
});
