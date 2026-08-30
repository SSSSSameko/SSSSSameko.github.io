import { useEffect, useRef } from 'react';

const DISMISS_VELOCITY = 720;
const MIN_EXIT_DURATION = 120;
const MAX_EXIT_DURATION = 280;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function dampSheetDrag(distance, height) {
  if (!Number.isFinite(distance)) return 0;
  if (distance >= 0) return distance;
  return -Math.min(Math.abs(distance) * 0.08, Math.max(8, height * 0.018));
}

export function shouldDismissSheet({ distance, velocity, height }) {
  const threshold = Math.max(72, height * 0.2);
  return distance >= threshold || velocity >= DISMISS_VELOCITY;
}

export function sheetDismissDuration({ distance, velocity, height }) {
  const safeHeight = Number.isFinite(Number(height)) && Number(height) > 0 ? Number(height) : 600;
  const safeDistance = Number.isFinite(Number(distance)) ? Math.max(0, Number(distance)) : 0;
  const safeVelocity = Number.isFinite(Number(velocity)) && Number(velocity) > 0
    ? Number(velocity)
    : 560;
  const remaining = Math.max(32, safeHeight + 32 - safeDistance);
  return Math.round(clamp(
    (remaining / safeVelocity) * 1000,
    MIN_EXIT_DURATION,
    MAX_EXIT_DURATION,
  ));
}

function reducedMotionFor(element) {
  const shellMotion = element?.closest('.app-shell')?.dataset.motion;
  if (shellMotion === 'full') return false;
  if (shellMotion === 'reduced') return true;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export default function useSheetDrag({ sheetRef, backdropRef, onDismiss }) {
  const dismissRef = useRef(onDismiss);
  const dragRef = useRef(null);
  const frameRef = useRef(0);
  const timerRef = useRef(0);
  dismissRef.current = onDismiss;

  function paintDrag() {
    frameRef.current = 0;
    const drag = dragRef.current;
    const sheet = sheetRef.current;
    const backdrop = backdropRef.current;
    if (!drag || !sheet) return;

    const progress = clamp(drag.offset / Math.max(1, drag.height * 0.72), 0, 1);
    sheet.style.setProperty('--sheet-drag-y', `${drag.offset}px`);
    sheet.style.setProperty('--sheet-drag-scale', String(1 - progress * 0.012));
    backdrop?.style.setProperty('--sheet-scrim', String(0.24 * (1 - progress * 0.72)));
  }

  function schedulePaint() {
    if (!frameRef.current) frameRef.current = window.requestAnimationFrame(paintDrag);
  }

  function settleDrag(event, cancelled = false) {
    const drag = dragRef.current;
    const sheet = sheetRef.current;
    const backdrop = backdropRef.current;
    if (!drag || event.pointerId !== drag.pointerId || !sheet) return;

    if (frameRef.current) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      paintDrag();
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const releaseVelocity = performance.now() - drag.lastTime > 90 ? 0 : drag.velocity;
    const dismiss = !cancelled && shouldDismissSheet({
      distance: drag.offset,
      velocity: releaseVelocity,
      height: drag.height,
    });
    dragRef.current = null;
    sheet.classList.remove('is-dragging');
    sheet.getBoundingClientRect();

    if (dismiss) {
      const exitDuration = reducedMotionFor(sheet)
        ? 1
        : sheetDismissDuration({
          distance: drag.offset,
          velocity: releaseVelocity,
          height: drag.height,
        });
      sheet.classList.add('is-drag-dismissing');
      sheet.style.setProperty('--sheet-drag-y', `${drag.height + 32}px`);
      sheet.style.setProperty('--sheet-drag-scale', '0.985');
      sheet.style.setProperty('--sheet-exit-duration', `${exitDuration}ms`);
      backdrop?.style.setProperty('--sheet-exit-duration', `${exitDuration}ms`);
      backdrop?.style.setProperty('--sheet-scrim', '0');
      timerRef.current = window.setTimeout(
        () => dismissRef.current?.(),
        exitDuration,
      );
      return;
    }

    sheet.style.removeProperty('--sheet-exit-duration');
    backdrop?.style.removeProperty('--sheet-exit-duration');
    sheet.style.setProperty('--sheet-drag-y', '0px');
    sheet.style.setProperty('--sheet-drag-scale', '1');
    backdrop?.style.setProperty('--sheet-scrim', '0.24');
    timerRef.current = window.setTimeout(() => {
      sheet.classList.remove('is-drag-dismissing');
      sheet.style.removeProperty('--sheet-drag-y');
      sheet.style.removeProperty('--sheet-drag-scale');
      backdrop?.style.removeProperty('--sheet-scrim');
    }, 340);
  }

  const handlers = {
    onPointerDown(event) {
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      window.clearTimeout(timerRef.current);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const now = performance.now();
      dragRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        lastY: event.clientY,
        lastTime: now,
        velocity: 0,
        offset: 0,
        height: sheet.getBoundingClientRect().height,
      };
      sheet.classList.add('is-dragging');
    },
    onPointerMove(event) {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const now = performance.now();
      const elapsed = Math.max(1, now - drag.lastTime);
      const instantVelocity = ((event.clientY - drag.lastY) / elapsed) * 1000;
      drag.velocity = drag.velocity * 0.35 + instantVelocity * 0.65;
      drag.lastY = event.clientY;
      drag.lastTime = now;
      drag.offset = dampSheetDrag(event.clientY - drag.startY, drag.height);
      schedulePaint();
    },
    onPointerUp(event) {
      settleDrag(event);
    },
    onPointerCancel(event) {
      settleDrag(event, true);
    },
  };

  useEffect(() => () => {
    window.cancelAnimationFrame(frameRef.current);
    window.clearTimeout(timerRef.current);
  }, []);

  return handlers;
}
