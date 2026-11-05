export function observeScrollableRegion(element, onChange, observers = globalThis) {
  const update = () => onChange(element.scrollHeight > element.clientHeight + 1);
  const resizeObserver = new observers.ResizeObserver(update);
  const mutationObserver = new observers.MutationObserver(update);

  update();
  resizeObserver.observe(element);
  mutationObserver.observe(element, {
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['open', 'hidden', 'class', 'style'],
    subtree: true,
  });
  element.addEventListener('load', update, { capture: true });

  return () => {
    resizeObserver.disconnect();
    mutationObserver.disconnect();
    element.removeEventListener('load', update, { capture: true });
  };
}
