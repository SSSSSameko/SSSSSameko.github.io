const DECK_POSES = [
  'translate3d(-12px, 8px, -24px) rotate(-5.5deg)',
  'translate3d(12px, 5px, -12px) rotate(4deg)',
  'translate3d(0, 0, 0) rotate(0deg)',
];

const SHUFFLE_EASING = 'cubic-bezier(0.77, 0, 0.175, 1)';
const SETTLE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
const SHUFFLE_DURATION = [1040, 1120, 1200];
const SHUFFLE_DELAY = [0, -260, -520];

const SHUFFLE_PATHS = [
  [
    { transform: DECK_POSES[0], opacity: 0.92 },
    { offset: 0.28, transform: 'translate3d(-38px, 1px, -10px) rotate(-8deg) scale(0.985)', opacity: 0.98 },
    { offset: 0.62, transform: 'translate3d(16px, 10px, -30px) rotate(2deg) scale(0.975)', opacity: 0.82 },
    { transform: DECK_POSES[0], opacity: 0.92 },
  ],
  [
    { transform: DECK_POSES[1], opacity: 0.96 },
    { offset: 0.3, transform: 'translate3d(38px, 0, 2px) rotate(7deg) scale(1.005)', opacity: 1 },
    { offset: 0.64, transform: 'translate3d(-15px, 9px, -20px) rotate(-2deg) scale(0.98)', opacity: 0.86 },
    { transform: DECK_POSES[1], opacity: 0.96 },
  ],
  [
    { transform: DECK_POSES[2], opacity: 1 },
    { offset: 0.26, transform: 'translate3d(-8px, -3px, 7px) rotate(-1.2deg) scale(0.994)', opacity: 0.98 },
    { offset: 0.56, transform: 'translate3d(9px, 2px, 8px) rotate(1.2deg) scale(1.008)', opacity: 1 },
    { offset: 0.8, transform: 'translate3d(-4px, -2px, 5px) rotate(-0.6deg) scale(0.998)', opacity: 0.99 },
    { transform: DECK_POSES[2], opacity: 1 },
  ],
];

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
    return card.animate(SHUFFLE_PATHS[index], {
      duration: SHUFFLE_DURATION[index],
      delay: SHUFFLE_DELAY[index],
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
