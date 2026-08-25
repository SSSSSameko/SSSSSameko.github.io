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
    { offset: 0.24, transform: 'translate3d(-48px, -1px, -8px) rotate(-9deg) scale(0.99)', opacity: 0.98 },
    { offset: 0.58, transform: 'translate3d(22px, 9px, -31px) rotate(2.4deg) scale(0.974)', opacity: 0.8 },
    { offset: 0.82, transform: 'translate3d(-18px, 7px, -22px) rotate(-6deg) scale(0.986)', opacity: 0.9 },
    { transform: DECK_POSES[0], opacity: 0.92 },
  ],
  [
    { transform: DECK_POSES[1], opacity: 0.96 },
    { offset: 0.27, transform: 'translate3d(48px, -2px, 3px) rotate(8deg) scale(1.008)', opacity: 1 },
    { offset: 0.61, transform: 'translate3d(-21px, 10px, -22px) rotate(-2.5deg) scale(0.978)', opacity: 0.84 },
    { offset: 0.84, transform: 'translate3d(18px, 5px, -10px) rotate(5deg) scale(0.992)', opacity: 0.94 },
    { transform: DECK_POSES[1], opacity: 0.96 },
  ],
  [
    { transform: DECK_POSES[2], opacity: 1 },
    { offset: 0.22, transform: 'translate3d(-15px, -5px, 9px) rotate(-1.8deg) scale(0.992)', opacity: 0.97 },
    { offset: 0.5, transform: 'translate3d(17px, 2px, 11px) rotate(1.8deg) scale(1.012)', opacity: 1 },
    { offset: 0.76, transform: 'translate3d(-9px, -3px, 7px) rotate(-0.9deg) scale(0.997)', opacity: 0.99 },
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
