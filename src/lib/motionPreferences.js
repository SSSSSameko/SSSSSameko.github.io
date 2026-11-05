import { readStoredValue } from './appCore.js';

export const MOTION_OPTIONS = [
  { value: 'full', label: '完整' },
  { value: 'system', label: '跟随系统' },
  { value: 'reduced', label: '减少' },
];

export function initialMotionPreference() {
  const stored = readStoredValue('weibo-draw-motion');
  return MOTION_OPTIONS.some((option) => option.value === stored) ? stored : 'full';
}

export function shouldReduceMotion(preference) {
  if (preference === 'full') return false;
  if (preference === 'reduced') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
