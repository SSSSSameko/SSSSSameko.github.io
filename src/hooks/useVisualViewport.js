import { useEffect } from 'react';

// iOS resizes the visual viewport for the keyboard without resizing 100dvh.
export default function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      frame = 0;
      // Keep normal page magnification available; never fit the layout to a pinch.
      if (Math.abs(viewport.scale - 1) > 0.01) return;
      root.style.setProperty('--visual-viewport-height', `${viewport.height}px`);
      root.style.setProperty('--visual-viewport-top', `${viewport.offsetTop}px`);
      const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
      root.dataset.keyboardOpen = String(Boolean(editing && window.innerHeight - viewport.height > 120));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
      root.style.removeProperty('--visual-viewport-height');
      root.style.removeProperty('--visual-viewport-top');
      delete root.dataset.keyboardOpen;
    };
  }, []);
}
