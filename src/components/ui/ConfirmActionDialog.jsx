import { useEffect, useRef, useState } from 'react';
import useDialogStack from '../../hooks/useDialogStack.js';
import { trapDialogFocus } from '../../lib/dialogFocus.js';
import { shouldReduceMotion } from '../../lib/motionPreferences.js';
import { icons as I } from './icons.jsx';

export default function ConfirmActionDialog({ action, motionPreference, onClose, onConfirm }) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const timerRef = useRef(null);
  const closingRef = useRef(false);
  const [isClosing, setIsClosing] = useState(false);
  const isTopDialog = useDialogStack(Boolean(action));

  function close(afterClose) {
    if (closingRef.current) return;
    closingRef.current = true;
    setIsClosing(true);
    timerRef.current = window.setTimeout(() => {
      onClose();
      afterClose?.();
    }, shouldReduceMotion(motionPreference) ? 1 : 160);
  }

  useEffect(() => {
    const previousFocus = document.activeElement;
    cancelRef.current?.focus({ preventScroll: true });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event) => {
      if (!isTopDialog()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      }
      trapDialogFocus(event, dialogRef.current);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      window.clearTimeout(timerRef.current);
      const previousIsUsable = previousFocus
        && previousFocus.isConnected
        && previousFocus.getClientRects?.().length
        && !previousFocus.closest?.('[inert]');
      if (previousIsUsable) {
        previousFocus.focus({ preventScroll: true });
      } else {
        document.querySelector('.root-navbar button')?.focus({ preventScroll: true });
      }
    };
  }, [isTopDialog]);

  return (
    <div className={`v3-alert-backdrop ${isClosing ? 'is-closing' : ''}`} role="presentation" onClick={() => close()}>
      <section ref={dialogRef} className="v3-alert-dialog v3-confirm-action-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`confirm-${action.kind}`} aria-describedby={`confirm-message-${action.kind}`} onClick={(event) => event.stopPropagation()}>
        <span className="v3-alert-icon">{I.trash}</span>
        <h2 id={`confirm-${action.kind}`}>{action.title}</h2>
        <p id={`confirm-message-${action.kind}`}>{action.message}</p>
        <div className="v3-confirm-action-buttons">
          <button ref={cancelRef} type="button" onClick={() => close()}>取消</button>
          <button className="is-destructive" type="button" onClick={() => close(onConfirm)}>{action.confirmLabel || '清空'}</button>
        </div>
      </section>
    </div>
  );
}
