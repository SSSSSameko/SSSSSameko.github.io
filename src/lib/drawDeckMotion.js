const DECK_POSES = [
  'translate3d(-12px, 8px, -24px) rotate(-5.5deg)',
  'translate3d(12px, 5px, -12px) rotate(4deg)',
  'translate3d(0, 0, 0) rotate(0deg)',
];

const SHUFFLE_EASING = 'cubic-bezier(0.77, 0, 0.175, 1)';
const SETTLE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
const SHUFFLE_DURATION = [1180, 1240, 1320];
const SHUFFLE_DELAY = [0, -320, -640];

const SHUFFLE_PATHS = [
  [
    { transform: DECK_POSES[0], opacity: 0.92 },
    { offset: 0.18, transform: 'translate3d(-44px, -4px, 8px) rotate(-9.4deg) scale(1.008)', opacity: 1 },
    { offset: 0.38, transform: 'translate3d(13px, 9px, -36px) rotate(2.2deg) scale(0.968)', opacity: 0.76 },
    { offset: 0.58, transform: 'translate3d(36px, -2px, -4px) rotate(6.5deg) scale(0.995)', opacity: 0.95 },
    { offset: 0.8, transform: 'translate3d(-17px, 7px, -22px) rotate(-5.8deg) scale(0.986)', opacity: 0.9 },
    { transform: DECK_POSES[0], opacity: 0.92 },
  ],
  [
    { transform: DECK_POSES[1], opacity: 0.96 },
    { offset: 0.2, transform: 'translate3d(46px, -3px, 10px) rotate(8.5deg) scale(1.01)', opacity: 1 },
    { offset: 0.4, transform: 'translate3d(-15px, 10px, -34px) rotate(-2.1deg) scale(0.972)', opacity: 0.79 },
    { offset: 0.61, transform: 'translate3d(-37px, -1px, -2px) rotate(-6.2deg) scale(0.998)', opacity: 0.96 },
    { offset: 0.82, transform: 'translate3d(18px, 5px, -10px) rotate(4.8deg) scale(0.992)', opacity: 0.94 },
    { transform: DECK_POSES[1], opacity: 0.96 },
  ],
  [
    { transform: DECK_POSES[2], opacity: 1 },
    { offset: 0.18, transform: 'translate3d(-11px, -5px, 16px) rotate(-1.2deg) scale(0.996)', opacity: 0.98 },
    { offset: 0.39, transform: 'translate3d(13px, 2px, 22px) rotate(1.6deg) scale(1.012)', opacity: 1 },
    { offset: 0.6, transform: 'translate3d(-8px, -4px, 14px) rotate(-0.9deg) scale(0.999)', opacity: 0.99 },
    { offset: 0.8, transform: 'translate3d(7px, 1px, 9px) rotate(0.7deg) scale(1.005)', opacity: 1 },
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
      return card.animate([
        { opacity: 0.96 },
        { opacity: 0.86 },
        { opacity: 1 },
      ], {
        duration: 280 + index * 30,
        delay: index * 35,
        iterations: 1,
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
      fill: 'both',
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
    if (reducedMotion) {
      return card.animate([{ opacity: 0.96 }, { opacity: 1 }], {
        duration: 160,
        easing: SETTLE_EASING,
      });
    }
    const base = DECK_POSES[index];
    const current = readTransform(card, index);
    return card.animate([
      { transform: current && current !== 'none' ? current : base },
      { transform: base },
    ], {
      duration: 360 + index * 35,
      easing: SETTLE_EASING,
    });
  });
}

export function cancelDrawDeckMotion(animations = []) {
  animations.forEach((animation) => animation?.cancel?.());
}
