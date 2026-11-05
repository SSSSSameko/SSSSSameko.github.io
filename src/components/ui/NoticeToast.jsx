import { useEffect, useRef, useState } from 'react';
import useDialogStack from '../../hooks/useDialogStack.js';
import { trapDialogFocus } from '../../lib/dialogFocus.js';
import { icons as I } from './icons.jsx';

function ErrorNoticeDialog({ notice, onClose }) {
  const dialogRef = useRef(null);
  const actionRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const previousFocusRef = useRef(null);
  const previousNoticeIdRef = useRef(null);
  const closingRef = useRef(false);
  const closeTimerRef = useRef(null);
  const [isClosing, setIsClosing] = useState(false);
  const isTopDialog = useDialogStack(Boolean(notice), 100);
  onCloseRef.current = onClose;
  if (previousNoticeIdRef.current !== notice.id) {
    previousNoticeIdRef.current = notice.id;
    previousFocusRef.current = document.activeElement;
  }

  function dismiss() {
    if (closingRef.current) return;
    closingRef.current = true;
    setIsClosing(true);
    const mode = dialogRef.current?.closest('.app-shell')?.dataset.motion;
    const reduced =
      mode === 'reduced' ||
      (mode !== 'full' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    closeTimerRef.current = window.setTimeout(
      () => {
        onCloseRef.current();
        window.setTimeout(() => {
          const fallback = [
            ...document.querySelectorAll(
              '.receipt-backdrop .receipt-close, .flow-sheet-backdrop .flow-sheet-close',
            ),
          ].find((element) => element.getClientRects().length && !element.closest('.is-closing'));
          fallback?.focus?.({ preventScroll: true });
        }, 0);
      },
      reduced ? 1 : 160,
    );
  }

  useEffect(() => {
    actionRef.current?.focus({ preventScroll: true });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event) => {
      if (!isTopDialog()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        dismiss();
      }
      trapDialogFocus(event, dialogRef.current);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(closeTimerRef.current);
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      const previousFocus = previousFocusRef.current;
      const previousIsUsable =
        previousFocus && document.contains(previousFocus) && !previousFocus.closest('[inert]');
      if (previousIsUsable) {
        previousFocus.focus?.({ preventScroll: true });
        return;
      }
      window.setTimeout(() => {
        const fallback = [
          ...document.querySelectorAll(
            '.receipt-backdrop:not([inert]) .receipt-close, .flow-sheet-backdrop:not([inert]) .flow-sheet-close',
          ),
        ].find((element) => element.getClientRects().length);
        fallback?.focus?.({ preventScroll: true });
      }, 0);
    };
  }, [isTopDialog, notice.id]);

  return (
    <div
      className={`v3-alert-backdrop ${isClosing ? 'is-closing' : ''}`}
      role="presentation"
      onClick={dismiss}
    >
      <section
        ref={dialogRef}
        className="v3-alert-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`notice-${notice.id}`}
        aria-describedby={`notice-message-${notice.id}`}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="v3-alert-icon">{I.alert}</span>
        <h2 id={`notice-${notice.id}`}>{notice.title}</h2>
        <p id={`notice-message-${notice.id}`}>{notice.message}</p>
        <button ref={actionRef} type="button" onClick={dismiss}>
          知道了
        </button>
      </section>
    </div>
  );
}

export default function NoticeToast({ notice, onClose }) {
  const [isClosing, setIsClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    setIsClosing(false);
    if (!notice || notice.tone === 'error') return undefined;
    const dismissTimer = window.setTimeout(() => setIsClosing(true), 2800);
    const closeTimer = window.setTimeout(() => onCloseRef.current?.(), 2980);
    return () => {
      window.clearTimeout(dismissTimer);
      window.clearTimeout(closeTimer);
    };
  }, [notice?.id]);

  if (!notice) return null;
  if (notice.tone === 'error')
    return <ErrorNoticeDialog key={notice.id} notice={notice} onClose={onClose} />;
  const icon = notice.tone === 'success' ? I.check : I.alert;
  return (
    <div
      className={`flow-notice flow-notice-${notice.tone || 'neutral'} ${isClosing ? 'is-closing' : ''}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="flow-notice-icon">{icon}</span>
      <div>
        <strong>{notice.title}</strong>
        <p>{notice.message}</p>
      </div>
      <button type="button" aria-label="关闭提示" onClick={onClose}>
        {I.close}
      </button>
    </div>
  );
}
