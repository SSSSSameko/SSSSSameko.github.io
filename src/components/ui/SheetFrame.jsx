import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import useDialogStack from '../../hooks/useDialogStack.js';
import useSheetDrag from '../../hooks/useSheetDrag.js';
import { trapDialogFocus } from '../../lib/dialogFocus.js';
import { observeScrollableRegion } from '../../lib/scrollableRegion.js';
import { icons as I } from './icons.jsx';

function handleSheetBodyKeyDown(event) {
  const body = event.currentTarget;
  if (
    event.target !== body
    || event.altKey
    || event.ctrlKey
    || event.metaKey
  ) {
    return;
  }

  const maxScrollTop = body.scrollHeight - body.clientHeight;
  if (maxScrollTop <= 0) return;

  const pageStep = Math.max(1, Math.round(body.clientHeight * 0.85));
  let nextScrollTop;
  if (event.key === 'PageDown') nextScrollTop = body.scrollTop + pageStep;
  else if (event.key === 'PageUp') nextScrollTop = body.scrollTop - pageStep;
  else if (event.key === 'Home') nextScrollTop = 0;
  else if (event.key === 'End') nextScrollTop = maxScrollTop;
  else return;

  event.preventDefault();
  body.scrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
}

export default function SheetFrame({
  title,
  subtitle,
  icon,
  tone = 'blue',
  onClose,
  children,
  footer = null,
  className = '',
  initialFocusRef = null,
  returnFocusId = '',
}) {
  const backdropRef = useRef(null);
  const dialogRef = useRef(null);
  const bodyRef = useRef(null);
  const closeButtonRef = useRef(null);
  const closeTimerRef = useRef(null);
  const requestCloseRef = useRef(null);
  const closingRef = useRef(false);
  const [isClosing, setIsClosing] = useState(false);
  const [bodyScrollable, setBodyScrollable] = useState(false);
  const isTopDialog = useDialogStack(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  function requestClose(afterClose, { immediate = false } = {}) {
    if (closingRef.current) return;
    closingRef.current = true;
    if (immediate) {
      onCloseRef.current?.();
      afterClose?.();
      return;
    }
    setIsClosing(true);
    const shellMotion = dialogRef.current?.closest('.app-shell')?.dataset.motion;
    const reduceMotion = shellMotion === 'reduced'
      || (shellMotion !== 'full' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    closeTimerRef.current = window.setTimeout(() => {
      onCloseRef.current?.();
      afterClose?.();
    }, reduceMotion ? 1 : 190);
  }
  requestCloseRef.current = requestClose;
  const sheetDrag = useSheetDrag({
    sheetRef: dialogRef,
    backdropRef,
    onDismiss: () => requestCloseRef.current?.(undefined, { immediate: true }),
  });

  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const scrollContainer = document.querySelector('.root-view.is-active .root-scroll');
    const previousScrollTop = scrollContainer?.scrollTop;
    const restorePageScroll = () => {
      if (scrollContainer?.isConnected && Number.isFinite(previousScrollTop)) {
        scrollContainer.scrollTop = previousScrollTop;
      }
    };
    document.body.style.overflow = 'hidden';
    const initialFocus = initialFocusRef?.current;
    const focusTarget = initialFocus?.getClientRects().length ? initialFocus : closeButtonRef.current;
    focusTarget?.focus({ preventScroll: true });
    const handleKeyDown = (event) => {
      if (!isTopDialog()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        requestCloseRef.current?.();
      }
      trapDialogFocus(event, dialogRef.current);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      window.clearTimeout(closeTimerRef.current);
      restorePageScroll();
      window.requestAnimationFrame(() => {
        const preferredFocus = returnFocusId ? document.getElementById(returnFocusId) : null;
        if (preferredFocus?.isConnected
          && preferredFocus.getClientRects().length
          && !preferredFocus.closest?.('[inert]')) {
          preferredFocus.focus({ preventScroll: true });
          restorePageScroll();
          return;
        }
        const wasInteractive = previousFocus?.matches?.(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        );
        if (wasInteractive
          && previousFocus.isConnected
          && previousFocus.getClientRects().length
          && !previousFocus.closest?.('[inert]')) {
          previousFocus.focus({ preventScroll: true });
          restorePageScroll();
          return;
        }
      });
    };
  }, [initialFocusRef, isTopDialog, returnFocusId]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return undefined;
    return observeScrollableRegion(body, setBodyScrollable);
  }, []);

  return (
    <div ref={backdropRef} className={`flow-sheet-backdrop ${isClosing ? 'is-closing' : ''}`} onClick={() => requestClose()}>
      <div ref={dialogRef} className={`flow-sheet ${className}`} role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="flow-sheet-grabber" aria-hidden="true" {...sheetDrag} />
        <div className="flow-sheet-head">
          <div className="flow-sheet-title">
            <span data-tone={tone}>{icon}</span>
            <div>
              <h2>{title}</h2>
              {subtitle && <p>{subtitle}</p>}
            </div>
          </div>
          <button ref={closeButtonRef} type="button" aria-label={`关闭${title}`} onClick={() => requestClose()} className="flow-sheet-close">{I.close}</button>
        </div>
        <div
          ref={bodyRef}
          className="flow-sheet-body"
          role={bodyScrollable ? 'region' : undefined}
          aria-label={bodyScrollable ? `${title}内容` : undefined}
          tabIndex={bodyScrollable ? 0 : undefined}
          onKeyDown={handleSheetBodyKeyDown}
        >
          {typeof children === 'function' ? children(requestClose) : children}
        </div>
        {footer ? (
          <div className="flow-sheet-footer">
            {typeof footer === 'function' ? footer(requestClose) : footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
