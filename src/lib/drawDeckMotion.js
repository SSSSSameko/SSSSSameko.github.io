const DECK_POSES = [
  'translate3d(-12px, 8px, -24px) rotate(-5.5deg)',
  'translate3d(12px, 5px, -12px) rotate(4deg)',
  'translate3d(0, 0, 0) rotate(0deg)',
];

const SHUFFLE_EASING = 'cubic-bezier(0.77, 0, 0.175, 1)';
const SETTLE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';

function deckCards(deck) {
  if (!deck?.querySelectorAll) return [];
  return [...deck.querySelectorAll('[data-deck-card]')].slice(0, DECK_POSES.length);
}

function supportsAnimation(card) {
  return card && typeof card.animate === 'function';
}

export function startDrawDeckMotion(deck, { reducedMotion = false } = {}) {
  if (reducedMotion) {
    return deckCards(deck).filter(supportsAnimation).map((card, index) => {
      const base = DECK_POSES[index];
      const direction = index % 2 ? 1 : -1;
      return card.animate([
        { transform: base, opacity: 0.96 },
        {
          transform: `translate3d(${direction * (8 + index * 2)}px, ${index === 2 ? -2 : 3}px, ${index === 2 ? 3 : -4}px) rotate(${direction * 0.8}deg)`,
          opacity: 0.9,
        },
        { transform: base, opacity: 0.96 },
      ], {
        duration: 960 + index * 120,
        delay: index ? -index * 90 : 0,
        iterations: Infinity,
        easing: SHUFFLE_EASING,
      });
    });
  }

  return deckCards(deck).filter(supportsAnimation).map((card, index) => {
    const travel = index === 2 ? 34 : 24;
    const direction = index % 2 ? 1 : -1;
    const base = DECK_POSES[index];

    return card.animate([
      { transform: base, opacity: index === 0 ? 0.92 : 1 },
      {
        offset: 0.32,
        transform: `translate3d(${travel * direction}px, ${index === 2 ? 4 : 0}px, ${index === 2 ? 8 : -8}px) rotate(${direction * 4}deg)`,
        opacity: 0.88,
      },
      {
        offset: 0.68,
        transform: `translate3d(${-travel * direction}px, ${index === 2 ? -3 : 6}px, ${index === 2 ? 4 : -16}px) rotate(${-direction * 3}deg)`,
        opacity: 0.96,
      },
      { transform: base, opacity: index === 0 ? 0.92 : 1 },
    ], {
      duration: 760 + index * 90,
      delay: index ? -index * 110 : 0,
      iterations: Infinity,
      easing: SHUFFLE_EASING,
    });
  });
}

export function settleDrawDeckMotion(
  deck,
  {
    reducedMotion = false,
    readTransform = (card) => globalThis.getComputedStyle?.(card)?.transform || 'none',
  } = {},
) {
  return deckCards(deck).filter(supportsAnimation).map((card, index) => {
    const base = DECK_POSES[index];
    const current = readTransform(card, index);
    return card.animate([
      { transform: current && current !== 'none' ? current : base },
      { transform: base },
    ], {
      duration: reducedMotion ? 180 : 360 + index * 35,
      easing: SETTLE_EASING,
    });
  });
}

export function cancelDrawDeckMotion(animations = []) {
  animations.forEach((animation) => animation?.cancel?.());
}
