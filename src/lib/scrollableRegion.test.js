import assert from 'node:assert/strict';
import { test } from 'node:test';

import { observeScrollableRegion } from './scrollableRegion.js';

function createRegion() {
  const element = new EventTarget();
  element.clientHeight = 200;
  element.scrollHeight = 200;
  const observers = {};
  const instances = {};
  observers.ResizeObserver = class {
    constructor(callback) { instances.resize = this; this.callback = callback; }
    observe(target) { this.target = target; }
    disconnect() { this.target = null; }
    resize() { if (this.target) this.callback(); }
  };
  observers.MutationObserver = class {
    constructor(callback) { instances.mutation = this; this.callback = callback; }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.target = null; }
    changeAttribute(name) {
      if (this.target && this.options.attributes && this.options.attributeFilter.includes(name)) this.callback();
    }
  };
  return { element, observers, instances };
}

test('native details expansion updates a fixed-height region without resizing its box', () => {
  const { element, observers, instances } = createRegion();
  const changes = [];
  const stop = observeScrollableRegion(element, (scrollable) => changes.push(scrollable), observers);
  assert.deepEqual(changes, [false]);
  element.scrollHeight = 350;
  instances.mutation.changeAttribute('open');
  assert.equal(changes.at(-1), true);
  element.scrollHeight = 180;
  instances.mutation.changeAttribute('open');
  assert.equal(changes.at(-1), false);
  stop();
});

test('media load rechecks overflow and cleanup disconnects every observer', () => {
  const { element, observers, instances } = createRegion();
  const changes = [];
  const stop = observeScrollableRegion(element, (scrollable) => changes.push(scrollable), observers);
  element.scrollHeight = 300;
  element.dispatchEvent(new Event('load'));
  assert.equal(changes.at(-1), true);
  element.clientHeight = 400;
  instances.resize.resize();
  assert.equal(changes.at(-1), false);
  const count = changes.length;
  stop();
  element.dispatchEvent(new Event('load'));
  instances.resize.resize();
  instances.mutation.changeAttribute('open');
  assert.equal(changes.length, count);
});
