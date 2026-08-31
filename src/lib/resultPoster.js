import { DRAW_RANDOM_ALGORITHM, friendlyProviderText } from './appCore.js';
import { avatarProxyUrl, safeAvatarUrl } from './avatar.js';

const POSTER_WIDTH = 1080;
const POSTER_MIN_HEIGHT = 1280;
const POSTER_PADDING = 64;
const POSTER_INNER_WIDTH = POSTER_WIDTH - POSTER_PADDING * 2;
const FONT_STACK = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
const WINNER_ROW_HEIGHT = 94;
const GROUP_HEADER_HEIGHT = 88;
const GROUP_BOTTOM_PADDING = 22;
const GROUP_GAP = 22;
const POSTER_WINNER_LIMIT = 60;
const POSTER_GROUP_LIMIT = 20;
const IMAGE_CACHE_LIMIT = 80;
const imageCache = new Map();
const TONES = [
  { fill: '#fff0f4', strong: '#df6f8d', soft: '#f7a7bc' },
  { fill: '#eef5ff', strong: '#577fd8', soft: '#9bbcf7' },
  { fill: '#f3efff', strong: '#7560d8', soft: '#b5a6ef' },
  { fill: '#eafaf6', strong: '#289d87', soft: '#84d6c4' },
  { fill: '#fff5e9', strong: '#c77a3a', soft: '#f0b77d' },
];

function safeText(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function firstGrapheme(value) {
  const text = safeText(value, '?');
  if (typeof Intl?.Segmenter === 'function') {
    return [...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text)][0]?.segment || '?';
  }
  return Array.from(text)[0] || '?';
}

function safeColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : fallback;
}

function compactCode(value, empty = '未记录') {
  const text = safeText(value);
  if (!text) return empty;
  if (text.length <= 18) return text;
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
}

function posterDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date).replaceAll('/', '.');
}

export function buildResultPosterModel(payload = {}) {
  const allGroups = (Array.isArray(payload.results) ? payload.results : [])
    .filter((group) => Array.isArray(group?.winners) && group.winners.length);
  const sourceGroups = allGroups.slice(0, Math.min(POSTER_GROUP_LIMIT, POSTER_WINNER_LIMIT));
  let remaining = POSTER_WINNER_LIMIT;
  const groups = sourceGroups
    .map((group, groupIndex) => {
      const tone = TONES[groupIndex % TONES.length];
      const groupsLeft = Math.max(1, sourceGroups.length - groupIndex);
      const visibleCount = Math.min(group.winners.length, Math.max(1, Math.floor(remaining / groupsLeft)));
      remaining = Math.max(0, remaining - visibleCount);
      const winners = group.winners.slice(0, visibleCount).map((winner, winnerIndex) => {
        const name = safeText(winner?.screenName || winner?.uid, `获奖用户 ${winnerIndex + 1}`);
        return {
          name,
          uid: safeText(winner?.uid, 'UID 未记录'),
          avatar: safeText(winner?.avatar),
          initial: firstGrapheme(name),
          rank: winnerIndex + 1,
          tone: TONES[(groupIndex + winnerIndex) % TONES.length],
        };
      });
      return {
        name: safeText(group?.prize?.name, `奖项 ${groupIndex + 1}`),
        color: safeColor(group?.prize?.color, tone.strong),
        tone,
        winners,
        totalWinnerCount: group.winners.length,
      };
    })
    .filter((group) => group.winners.length);

  const winnerCount = allGroups.reduce((total, group) => total + group.winners.length, 0);
  const displayedWinnerCount = groups.reduce((total, group) => total + group.winners.length, 0);
  const provider = friendlyProviderText(payload.providerText) || '可见转发';

  return {
    title: '微博转发抽奖',
    subtitle: '开奖结果',
    drawLabel: safeText(payload.drawCount, '未计入'),
    drawnAt: posterDate(payload.drawnAt),
    source: safeText(payload.statusUrl || payload.statusId, '手动导入名单'),
    winnerCount,
    displayedWinnerCount,
    omittedWinnerCount: Math.max(0, winnerCount - displayedWinnerCount),
    groups,
    fairness: {
      candidateCount: Number(payload.candidateCount || 0),
      eligibleCount: Number(payload.eligibleCount || 0),
      provider,
      algorithm: DRAW_RANDOM_ALGORITHM,
      filterSummary: safeText(payload.filterSummary, '按当前筛选规则'),
      seed: compactCode(payload.seed),
      digest: compactCode(payload.candidateDigest),
      auditHash: compactCode(payload.auditHash),
    },
  };
}

export function measureResultPoster(model) {
  const groupsHeight = model.groups.reduce(
    (total, group) => total + GROUP_HEADER_HEIGHT + group.winners.length * WINNER_ROW_HEIGHT + GROUP_BOTTOM_PADDING + GROUP_GAP,
    0,
  );
  const fixedHeight = 64 + 160 + 252 + 128 + 166 + 58 + 364 + 90 + (model.omittedWinnerCount ? 84 : 0);
  return {
    width: POSTER_WIDTH,
    height: Math.max(POSTER_MIN_HEIGHT, fixedHeight + groupsHeight),
  };
}

function roundedPath(ctx, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
  ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
  ctx.arcTo(x, y + height, x, y, safeRadius);
  ctx.arcTo(x, y, x + width, y, safeRadius);
  ctx.closePath();
}

function roundedRect(ctx, x, y, width, height, radius, fill, stroke = '') {
  roundedPath(ctx, x, y, width, height, radius);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function glassPanel(ctx, x, y, width, height, radius = 34, fill = 'rgba(255,255,255,0.84)') {
  ctx.save();
  ctx.shadowColor = 'rgba(40, 53, 78, 0.12)';
  ctx.shadowBlur = 38;
  ctx.shadowOffsetY = 16;
  roundedRect(ctx, x, y, width, height, radius, fill, 'rgba(255,255,255,0.96)');
  ctx.restore();
  roundedRect(ctx, x + 2, y + 2, width - 4, Math.max(24, height * 0.36), Math.max(12, radius - 2), 'rgba(255,255,255,0.16)');
}

function fillText(ctx, text, x, y, {
  color = '#17181d',
  font = `500 24px ${FONT_STACK}`,
  align = 'left',
} = {}) {
  ctx.fillStyle = color;
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.fillText(text, x, y);
}

function fitText(ctx, value, maxWidth) {
  const text = safeText(value);
  if (!text || ctx.measureText(text).width <= maxWidth) return text;
  const characters = Array.from(text);
  while (characters.length && ctx.measureText(`${characters.join('')}…`).width > maxWidth) {
    characters.pop();
  }
  return characters.length ? `${characters.join('')}…` : '…';
}

function wrapLines(ctx, value, maxWidth, maxLines = Infinity) {
  const text = safeText(value);
  if (!text) return [];
  const lines = [];
  let line = '';
  for (const character of Array.from(text)) {
    const next = `${line}${character}`;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = character;
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && Array.from(text).join('') !== lines.join('')) {
    const last = lines.length - 1;
    while (ctx.measureText(`${lines[last]}…`).width > maxWidth && lines[last]) {
      lines[last] = Array.from(lines[last]).slice(0, -1).join('');
    }
    lines[last] = `${lines[last]}…`;
  }
  return lines;
}

function drawSparkle(ctx, x, y, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.bezierCurveTo(size * 0.16, -size * 0.24, size * 0.24, -size * 0.16, size, 0);
  ctx.bezierCurveTo(size * 0.24, size * 0.16, size * 0.16, size * 0.24, 0, size);
  ctx.bezierCurveTo(-size * 0.16, size * 0.24, -size * 0.24, size * 0.16, -size, 0);
  ctx.bezierCurveTo(-size * 0.24, -size * 0.16, -size * 0.16, -size * 0.24, 0, -size);
  ctx.fill();
  ctx.restore();
}

function drawInitialAvatar(ctx, winner, x, y, size, borderWidth = 4) {
  const tone = winner.tone || TONES[0];
  ctx.save();
  ctx.shadowColor = 'rgba(44, 55, 83, 0.12)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 8;
  roundedRect(ctx, x, y, size, size, size * 0.34, tone.fill, '#ffffff');
  ctx.restore();
  roundedRect(ctx, x + borderWidth / 2, y + borderWidth / 2, size - borderWidth, size - borderWidth, size * 0.3, '', 'rgba(255,255,255,0.82)');
  fillText(ctx, winner.initial, x + size / 2, y + size * 0.23, {
    color: tone.strong,
    font: `700 ${Math.round(size * 0.38)}px ${FONT_STACK}`,
    align: 'center',
  });
}

function rememberImage(key, image) {
  if (!key || !image) return;
  imageCache.delete(key);
  imageCache.set(key, image);
  while (imageCache.size > IMAGE_CACHE_LIMIT) imageCache.delete(imageCache.keys().next().value);
}

function loadImage(src, { crossOrigin = false, signal, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    if (!src || typeof window === 'undefined') {
      resolve(null);
      return;
    }
    const cacheKey = `${crossOrigin ? 'cors' : 'plain'}:${src}`;
    if (imageCache.has(cacheKey)) {
      const cached = imageCache.get(cacheKey);
      imageCache.delete(cacheKey);
      imageCache.set(cacheKey, cached);
      resolve(cached);
      return;
    }
    const image = new window.Image();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (value) rememberImage(cacheKey, value);
      resolve(value);
    };
    const abort = () => {
      image.src = '';
      finish(null);
    };
    const timer = window.setTimeout(abort, timeoutMs);
    if (crossOrigin) image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    image.src = src;
  });
}

function drawCoverImage(ctx, image, x, y, width, height, radius) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const cropWidth = width / scale;
  const cropHeight = height / scale;
  ctx.save();
  roundedPath(ctx, x, y, width, height, radius);
  ctx.clip();
  ctx.drawImage(
    image,
    (sourceWidth - cropWidth) / 2,
    (sourceHeight - cropHeight) / 2,
    cropWidth,
    cropHeight,
    x,
    y,
    width,
    height,
  );
  ctx.restore();
}

function drawAvatar(ctx, winner, imageMap, x, y, size, borderWidth = 4) {
  const avatar = safeAvatarUrl(winner.avatar);
  const image = avatar ? imageMap.get(avatar) : null;
  if (!image) {
    drawInitialAvatar(ctx, winner, x, y, size, borderWidth);
    return;
  }
  ctx.save();
  ctx.shadowColor = 'rgba(44, 55, 83, 0.16)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 8;
  drawCoverImage(ctx, image, x, y, size, size, size * 0.34);
  ctx.restore();
  roundedRect(ctx, x + borderWidth / 2, y + borderWidth / 2, size - borderWidth, size - borderWidth, size * 0.3, '', 'rgba(255,255,255,0.9)');
}

async function loadWinnerAvatars(model, apiBase) {
  const urls = [...new Set(model.groups
    .flatMap((group) => group.winners)
    .map((winner) => safeAvatarUrl(winner.avatar))
    .filter(Boolean))];
  const imageMap = new Map();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 9000);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(6, urls.length) }, async () => {
    while (cursor < urls.length && !controller.signal.aborted) {
      const avatar = urls[cursor];
      cursor += 1;
      const proxy = avatarProxyUrl(avatar, apiBase);
      let image = await loadImage(proxy, {
        crossOrigin: true,
        signal: controller.signal,
        timeoutMs: 2500,
      });
      if (!image && !controller.signal.aborted && proxy !== avatar) {
        image = await loadImage(avatar, {
          crossOrigin: true,
          signal: controller.signal,
          timeoutMs: 2000,
        });
      }
      if (image) imageMap.set(avatar, image);
    }
  });
  try {
    await Promise.all(workers);
  } finally {
    window.clearTimeout(timeout);
  }
  return imageMap;
}

function drawBackground(ctx, width, height) {
  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, '#f8f8fc');
  background.addColorStop(0.38, '#eef5ff');
  background.addColorStop(0.7, '#fff4f7');
  background.addColorStop(1, '#f1f8f6');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  const light = ctx.createLinearGradient(0, 0, width, 0);
  light.addColorStop(0, 'rgba(255,255,255,0.78)');
  light.addColorStop(0.48, 'rgba(255,255,255,0.16)');
  light.addColorStop(1, 'rgba(255,255,255,0.68)');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = 'rgba(255,255,255,0.38)';
  ctx.fillRect(0, 0, width, 7);
}

function drawBrandHeader(ctx, model, y, brandImage) {
  glassPanel(ctx, POSTER_PADDING, y, POSTER_INNER_WIDTH, 132, 38, 'rgba(255,255,255,0.78)');
  const iconX = POSTER_PADDING + 24;
  const iconY = y + 24;
  const iconSize = 84;
  if (brandImage) {
    drawCoverImage(ctx, brandImage, iconX, iconY, iconSize, iconSize, 28);
    roundedRect(ctx, iconX, iconY, iconSize, iconSize, 28, '', 'rgba(255,255,255,0.92)');
  } else {
    const iconFill = ctx.createLinearGradient(iconX, iconY, iconX + iconSize, iconY + iconSize);
    iconFill.addColorStop(0, '#fff0f4');
    iconFill.addColorStop(0.48, '#eef5ff');
    iconFill.addColorStop(1, '#f0edff');
    roundedRect(ctx, iconX, iconY, iconSize, iconSize, 28, iconFill, '#ffffff');
    drawSparkle(ctx, iconX + iconSize / 2, iconY + iconSize / 2, 22, '#7767ed');
  }

  fillText(ctx, model.title, iconX + 110, y + 31, {
    font: `700 30px ${FONT_STACK}`,
  });
  fillText(ctx, 'by.sameko', iconX + 110, y + 76, {
    color: '#737884',
    font: `500 18px ${FONT_STACK}`,
  });

  const pillWidth = 210;
  const pillX = POSTER_WIDTH - POSTER_PADDING - pillWidth - 22;
  roundedRect(ctx, pillX, y + 39, pillWidth, 54, 27, 'rgba(245,241,255,0.88)', 'rgba(255,255,255,0.96)');
  ctx.font = `650 19px ${FONT_STACK}`;
  fillText(ctx, fitText(ctx, model.drawLabel, pillWidth - 24), pillX + pillWidth / 2, y + 52, {
    color: '#6655cc',
    font: `650 19px ${FONT_STACK}`,
    align: 'center',
  });
}

function drawHero(ctx, model, y, avatarImages) {
  glassPanel(ctx, POSTER_PADDING, y, POSTER_INNER_WIDTH, 232, 38, 'rgba(255,255,255,0.82)');
  roundedRect(ctx, POSTER_PADDING + 28, y + 28, 126, 42, 21, '#eafaf6');
  fillText(ctx, '开奖完成', POSTER_PADDING + 91, y + 38, {
    color: '#218b78',
    font: `650 17px ${FONT_STACK}`,
    align: 'center',
  });
  drawSparkle(ctx, POSTER_PADDING + 178, y + 49, 10, '#ee8fa1');

  fillText(ctx, `${model.winnerCount} 位中奖用户`, POSTER_PADDING + 28, y + 91, {
    font: `760 54px ${FONT_STACK}`,
  });
  fillText(ctx, `${model.groups.length} 个奖项 · ${model.drawnAt}`, POSTER_PADDING + 30, y + 164, {
    color: '#7e8390',
    font: `500 19px ${FONT_STACK}`,
  });

  const visibleWinners = model.groups.flatMap((group) => group.winners).slice(0, 5);
  const remaining = model.winnerCount - visibleWinners.length;
  const avatarSize = 68;
  const overlap = 18;
  const stackItems = visibleWinners.length + (remaining > 0 ? 1 : 0);
  const stackWidth = stackItems
    ? avatarSize + (stackItems - 1) * (avatarSize - overlap)
    : 0;
  const stackX = POSTER_WIDTH - POSTER_PADDING - 30 - stackWidth;
  visibleWinners.forEach((winner, index) => {
    drawAvatar(ctx, winner, avatarImages, stackX + index * (avatarSize - overlap), y + 92, avatarSize);
  });
  if (remaining > 0) {
    const moreX = stackX + visibleWinners.length * (avatarSize - overlap);
    roundedRect(ctx, moreX, y + 92, avatarSize, avatarSize, 23, '#f3efff', '#ffffff');
    fillText(ctx, `+${remaining}`, moreX + avatarSize / 2, y + 113, {
      color: '#7560d8',
      font: `700 22px ${FONT_STACK}`,
      align: 'center',
    });
  }
}

function drawSource(ctx, model, y) {
  glassPanel(ctx, POSTER_PADDING, y, POSTER_INNER_WIDTH, 108, 30, 'rgba(255,255,255,0.72)');
  roundedRect(ctx, POSTER_PADDING + 22, y + 22, 64, 64, 22, '#fff0f4', '#ffffff');
  ctx.strokeStyle = '#df6f8d';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(POSTER_PADDING + 50, y + 54, 12, Math.PI * 0.28, Math.PI * 1.72);
  ctx.arc(POSTER_PADDING + 59, y + 54, 12, Math.PI * 1.28, Math.PI * 0.72);
  ctx.stroke();
  fillText(ctx, '微博来源', POSTER_PADDING + 108, y + 20, {
    color: '#858a96',
    font: `500 16px ${FONT_STACK}`,
  });
  ctx.font = `560 20px ${FONT_STACK}`;
  const lines = wrapLines(ctx, model.source, POSTER_INNER_WIDTH - 158, 2);
  lines.forEach((line, index) => {
    fillText(ctx, line, POSTER_PADDING + 108, y + 49 + index * 26, {
      color: '#343842',
      font: `560 20px ${FONT_STACK}`,
    });
  });
}

function drawStats(ctx, model, y) {
  const values = [
    ['载入候选', model.fairness.candidateCount.toLocaleString('zh-CN'), TONES[1]],
    ['符合规则', model.fairness.eligibleCount.toLocaleString('zh-CN'), TONES[3]],
    ['中奖人数', model.winnerCount.toLocaleString('zh-CN'), TONES[0]],
  ];
  glassPanel(ctx, POSTER_PADDING, y, POSTER_INNER_WIDTH, 128, 32, 'rgba(255,255,255,0.76)');
  const cellWidth = POSTER_INNER_WIDTH / values.length;
  values.forEach(([label, value, tone], index) => {
    const x = POSTER_PADDING + index * cellWidth;
    if (index) {
      ctx.fillStyle = 'rgba(31,31,38,0.08)';
      ctx.fillRect(x, y + 28, 1.5, 72);
    }
    fillText(ctx, label, x + cellWidth / 2, y + 27, {
      color: '#8b909b',
      font: `500 16px ${FONT_STACK}`,
      align: 'center',
    });
    fillText(ctx, value, x + cellWidth / 2, y + 56, {
      color: tone.strong,
      font: `730 34px ${FONT_STACK}`,
      align: 'center',
    });
  });
}

function drawSectionTitle(ctx, model, y) {
  fillText(ctx, '中奖名单', POSTER_PADDING + 2, y, {
    font: `730 34px ${FONT_STACK}`,
  });
  fillText(ctx, `共 ${model.winnerCount} 人`, POSTER_WIDTH - POSTER_PADDING - 2, y + 8, {
    color: '#858a96',
    font: `520 18px ${FONT_STACK}`,
    align: 'right',
  });
}

function drawWinnerGroup(ctx, group, groupIndex, y, avatarImages) {
  const height = GROUP_HEADER_HEIGHT + group.winners.length * WINNER_ROW_HEIGHT + GROUP_BOTTOM_PADDING;
  glassPanel(ctx, POSTER_PADDING, y, POSTER_INNER_WIDTH, height, 34, 'rgba(255,255,255,0.86)');
  roundedRect(ctx, POSTER_PADDING + 24, y + 22, 54, 54, 18, group.tone.fill, '#ffffff');
  fillText(ctx, String(groupIndex + 1), POSTER_PADDING + 51, y + 34, {
    color: group.color,
    font: `720 22px ${FONT_STACK}`,
    align: 'center',
  });
  ctx.font = `680 27px ${FONT_STACK}`;
  fillText(ctx, fitText(ctx, group.name, POSTER_INNER_WIDTH - 230), POSTER_PADDING + 98, y + 25, {
    font: `680 27px ${FONT_STACK}`,
  });
  fillText(ctx, `${group.totalWinnerCount} 名`, POSTER_WIDTH - POSTER_PADDING - 26, y + 34, {
    color: '#858a96',
    font: `520 18px ${FONT_STACK}`,
    align: 'right',
  });

  group.winners.forEach((winner, winnerIndex) => {
    const rowY = y + GROUP_HEADER_HEIGHT + winnerIndex * WINNER_ROW_HEIGHT;
    if (winnerIndex) {
      ctx.fillStyle = 'rgba(31,31,38,0.075)';
      ctx.fillRect(POSTER_PADDING + 104, rowY, POSTER_INNER_WIDTH - 132, 1.5);
    }
    drawAvatar(ctx, winner, avatarImages, POSTER_PADDING + 24, rowY + 13, 66);
    ctx.font = `650 24px ${FONT_STACK}`;
    fillText(ctx, fitText(ctx, winner.name, POSTER_INNER_WIDTH - 220), POSTER_PADDING + 112, rowY + 16, {
      font: `650 24px ${FONT_STACK}`,
    });
    ctx.font = `500 16px ${FONT_STACK}`;
    const uid = winner.uid === 'UID 未记录' ? winner.uid : `UID ${winner.uid}`;
    fillText(ctx, fitText(ctx, uid, POSTER_INNER_WIDTH - 220), POSTER_PADDING + 112, rowY + 52, {
      color: '#8b909b',
      font: `500 16px ${FONT_STACK}`,
    });
    fillText(ctx, String(winner.rank).padStart(2, '0'), POSTER_WIDTH - POSTER_PADDING - 28, rowY + 30, {
      color: group.color,
      font: `700 18px ${FONT_STACK}`,
      align: 'right',
    });
  });
  return height;
}

function drawOmittedWinners(ctx, displayedCount, omittedCount, y) {
  glassPanel(ctx, POSTER_PADDING, y, POSTER_INNER_WIDTH, 62, 22, 'rgba(255,255,255,0.72)');
  fillText(ctx, `结果图展示 ${displayedCount} 位，另有 ${omittedCount} 位请在开奖记录中查看`, POSTER_WIDTH / 2, y + 19, {
    color: '#737884',
    font: `520 17px ${FONT_STACK}`,
    align: 'center',
  });
}

function drawFairness(ctx, model, y) {
  glassPanel(ctx, POSTER_PADDING, y, POSTER_INNER_WIDTH, 330, 36, 'rgba(255,255,255,0.8)');
  roundedRect(ctx, POSTER_PADDING + 24, y + 24, 62, 62, 22, '#eafaf6', '#ffffff');
  drawSparkle(ctx, POSTER_PADDING + 55, y + 55, 17, '#289d87');
  fillText(ctx, '随机过程记录', POSTER_PADDING + 106, y + 25, {
    font: `700 29px ${FONT_STACK}`,
  });
  fillText(ctx, model.drawLabel, POSTER_PADDING + 106, y + 63, {
    color: '#7f8490',
    font: `520 17px ${FONT_STACK}`,
  });

  const cells = [
    ['数据来源', model.fairness.provider],
    ['筛选规则', model.fairness.filterSummary],
    ['随机算法', model.fairness.algorithm],
    ['开奖时间', model.drawnAt],
  ];
  const gridX = POSTER_PADDING + 24;
  const gridY = y + 112;
  const cellWidth = (POSTER_INNER_WIDTH - 48) / 2;
  const cellHeight = 76;
  cells.forEach(([label, value], index) => {
    const x = gridX + (index % 2) * cellWidth;
    const cellY = gridY + Math.floor(index / 2) * cellHeight;
    fillText(ctx, label, x, cellY, {
      color: '#9196a1',
      font: `500 15px ${FONT_STACK}`,
    });
    ctx.font = `600 18px ${FONT_STACK}`;
    const lines = wrapLines(ctx, value, cellWidth - 26, 2);
    lines.forEach((line, lineIndex) => {
      fillText(ctx, line, x, cellY + 26 + lineIndex * 22, {
        color: '#343842',
        font: `600 18px ${FONT_STACK}`,
      });
    });
  });

  ctx.fillStyle = 'rgba(31,31,38,0.075)';
  ctx.fillRect(POSTER_PADDING + 24, y + 260, POSTER_INNER_WIDTH - 48, 1.5);
  fillText(ctx, `随机种子 ${model.fairness.seed}`, POSTER_PADDING + 24, y + 276, {
    color: '#8b909b',
    font: `500 14px ${FONT_STACK}`,
  });
  fillText(ctx, `名单指纹 ${model.fairness.digest}`, POSTER_WIDTH - POSTER_PADDING - 24, y + 276, {
    color: '#8b909b',
    font: `500 14px ${FONT_STACK}`,
    align: 'right',
  });
  fillText(ctx, `过程哈希 ${model.fairness.auditHash}`, POSTER_PADDING + 24, y + 303, {
    color: '#737884',
    font: `540 14px ${FONT_STACK}`,
  });
}

function drawFooter(ctx, model, y) {
  ctx.fillStyle = 'rgba(31,31,38,0.09)';
  ctx.fillRect(POSTER_PADDING, y, POSTER_INNER_WIDTH, 1.5);
  fillText(ctx, '微博转发抽奖助手 · by.sameko', POSTER_PADDING, y + 28, {
    color: '#737884',
    font: `560 17px ${FONT_STACK}`,
  });
  fillText(ctx, model.drawnAt, POSTER_WIDTH - POSTER_PADDING, y + 28, {
    color: '#9297a3',
    font: `500 17px ${FONT_STACK}`,
    align: 'right',
  });
}

export async function createResultPoster(payload, {
  brandAssetUrl = '',
  avatarProxyBase = '',
} = {}) {
  if (typeof document === 'undefined') throw new Error('结果图只能在浏览器中生成');
  const model = buildResultPosterModel(payload);
  const layout = measureResultPoster(model);
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器无法生成结果图');

  drawBackground(ctx, layout.width, layout.height);
  const [brandImage, avatarImages] = await Promise.all([
    loadImage(brandAssetUrl),
    loadWinnerAvatars(model, avatarProxyBase),
  ]);
  let y = 64;
  drawBrandHeader(ctx, model, y, brandImage);
  y += 160;
  drawHero(ctx, model, y, avatarImages);
  y += 252;
  drawSource(ctx, model, y);
  y += 128;
  drawStats(ctx, model, y);
  y += 166;
  drawSectionTitle(ctx, model, y);
  y += 58;
  model.groups.forEach((group, index) => {
    y += drawWinnerGroup(ctx, group, index, y, avatarImages) + GROUP_GAP;
  });
  if (model.omittedWinnerCount) {
    drawOmittedWinners(ctx, model.displayedWinnerCount, model.omittedWinnerCount, y);
    y += 84;
  }
  drawFairness(ctx, model, y);
  y += 364;
  drawFooter(ctx, model, y);
  return canvas;
}
