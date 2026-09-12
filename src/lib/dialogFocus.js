const FOCUSABLE_SELECTOR = [
  'a[href]',
  'summary',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function trapDialogFocus(event, dialog) {
  if (event.key !== 'Tab' || !dialog) return;
  const controls = [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)]
    .filter((element) => (
      !element.hidden
      && !element.closest('[inert]')
      && element.getClientRects().length
    ));
  if (!controls.length) return;

  const first = controls[0];
  const last = controls.at(-1);
  if (!dialog.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
