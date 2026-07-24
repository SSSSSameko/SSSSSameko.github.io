import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cancelDrawDeckMotion,
  settleDrawDeckMotion,
  startDrawDeckMotion,
} from './drawDeckMotion.js';

function fakeDeck() {
  const calls = [];
  const cards = Array.from({ length: 3 }, (_, index) => ({
    animate(keyframes, options) {
      const animation = {
        cancelCalled: false,
        cancel() {
          this.cancelCalled = true;
        },
      };
      calls.push({ index, keyframes, options, animation });
      return animation;
    },
  }));
  return {
    calls,
    cards,
    deck: {
      querySelectorAll(selector) {
        assert.equal(selector, '[data-deck-card]');
        return cards;
      },
    },
  };
}

test('startDrawDeckMotion gives three cards independent continuous 3D motion', () => {
  const { deck, calls } = fakeDeck();
  const animations = startDrawDeckMotion(deck);

  assert.equal(animations.length, 3);
  assert.deepEqual(calls.map(({ options }) => options.duration), [760, 850, 940]);
  assert.deepEqual(calls.map(({ options }) => options.delay), [0, -110, -220]);
  assert.ok(calls.every(({ options }) => options.iterations === Infinity));
  assert.ok(calls.every(({ keyframes }) => keyframes.every((frame) => 'transform' in frame)));
});

test('draw deck motion uses a gentler shuffle when reduced motion is requested', () => {
  const { deck, calls } = fakeDeck();
  const animations = startDrawDeckMotion(deck, { reducedMotion: true });

  assert.equal(animations.length, 3);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ options }) => options.duration >= 960));
  assert.ok(calls.every(({ keyframes }) => keyframes.length === 3));
  assert.ok(calls.every(({ keyframes }) => !String(keyframes[1].transform).includes('rotate(4deg)')));
});

test('settleDrawDeckMotion returns cards to their resting poses', () => {
  const { deck, calls } = fakeDeck();
  const animations = settleDrawDeckMotion(deck, {
    readTransform: (_, index) => `matrix-${index}`,
  });

  assert.equal(animations.length, 3);
  assert.deepEqual(calls.map(({ keyframes }) => keyframes[0].transform), [
    'matrix-0',
    'matrix-1',
    'matrix-2',
  ]);
  assert.equal(calls[2].options.easing, 'cubic-bezier(0.32, 0.72, 0, 1)');
});

test('cancelDrawDeckMotion cancels every active animation', () => {
  const { deck } = fakeDeck();
  const animations = startDrawDeckMotion(deck);
  cancelDrawDeckMotion(animations);
  assert.ok(animations.every((animation) => animation.cancelCalled));
});
