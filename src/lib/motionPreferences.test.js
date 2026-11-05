import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { initialMotionPreference, shouldReduceMotion } from './motionPreferences.js';

const originalWindow = globalThis.window;
let storedPreference;
let systemReducesMotion;

beforeEach(() => {
  storedPreference = '';
  systemReducesMotion = false;
  globalThis.window = {
    localStorage: { getItem: () => storedPreference },
    matchMedia: () => ({ matches: systemReducesMotion }),
  };
});

afterEach(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

test('new visitors and invalid saved values use full motion by default', () => {
  assert.equal(initialMotionPreference(), 'full');
  storedPreference = 'unknown';
  assert.equal(initialMotionPreference(), 'full');
  systemReducesMotion = true;
  assert.equal(shouldReduceMotion(initialMotionPreference()), false);
});

test('an explicit saved choice takes precedence over the system preference', () => {
  systemReducesMotion = true;
  storedPreference = 'full';
  assert.equal(initialMotionPreference(), 'full');
  assert.equal(shouldReduceMotion(initialMotionPreference()), false);
  systemReducesMotion = false;
  storedPreference = 'reduced';
  assert.equal(initialMotionPreference(), 'reduced');
  assert.equal(shouldReduceMotion(initialMotionPreference()), true);
});

test('unavailable local storage falls back to full motion', () => {
  window.localStorage.getItem = () => {
    throw new Error('Storage is disabled');
  };
  assert.equal(initialMotionPreference(), 'full');
});

test('an explicit system choice follows the device preference', () => {
  storedPreference = 'system';
  systemReducesMotion = true;
  assert.equal(shouldReduceMotion(initialMotionPreference()), true);
  systemReducesMotion = false;
  assert.equal(shouldReduceMotion(initialMotionPreference()), false);
});
