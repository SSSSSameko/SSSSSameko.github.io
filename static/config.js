// GitHub Pages / static hosting config.
// Leave empty when frontend and backend are served from the same origin.
window.WEIBO_DRAW_ALLOWED_API_BASES = window.WEIBO_DRAW_ALLOWED_API_BASES || [
  'https://111.228.11.206',
];
window.WEIBO_DRAW_API_BASE = window.WEIBO_DRAW_API_BASE
  || (window.location.hostname.endsWith('github.io') ? window.WEIBO_DRAW_ALLOWED_API_BASES[0] : '');
