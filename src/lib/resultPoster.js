import { DRAW_RANDOM_ALGORITHM, friendlyProviderText } from './appCore.js';
import { avatarProxyUrl, safeAvatarUrl } from './avatar.js';
import { formatDateTime } from './dateTime.js';

const POSTER_WIDTH = 680;
const POSTER_MIN_HEIGHT = 1480;
const POSTER_PADDING = 40;
const POSTER_INNER_WIDTH = POSTER_WIDTH - POSTER_PADDING * 2;
const FONT_STACK = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
const WINNER_ROW_HEIGHT = 82;
const GROUP_HEADER_HEIGHT = 76;
const GROUP_BOTTOM_PADDING = 18;
const GROUP_GAP = 16;
const POSTER_WINNER_LIMIT = 60;
const POSTER_GROUP_LIMIT = 20;
const IMAGE_CACHE_LIMIT = 80;
const imageCache = new Map();
const TONES = [
  { fill: '#fff0f3', strong: '#b83f62', soft: '#ef9db4' },
  { fill: '#edf4fb', strong: '#315f8b', soft: '#8eb8dc' },
  { fill: '#f1effa', strong: '#6656ae', soft: '#a99ce0' },
  { fill: '#eaf7f4', strong: '#227b6f', soft: '#77c6ba' },
  { fill: '#fff4e8', strong: '#a86431', soft: '#dba16c' },
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
    drawnAt: formatDateTime(payload.drawnAt, { useCurrentTime: true }),
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
  const fixedHeight = 48 + 140 + 228 + 112 + 142 + 54 + 318 + 80 + (model.omittedWinnerCount ? 72 : 0);
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
  ctx.shadowColor = 'rgba(34, 43, 60, 0.07)';
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 8;
  roundedRect(ctx, x, y, width, height, radius, fill, 'rgba(31, 38, 52, 0.08)');
  ctx.restore();
  roundedRect(ctx, x + 1, y + 1, width - 2, 1, radius, 'rgba(255,255,255,0.78)');
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
  background.addColorStop(0, '#f7f7fa');
  background.addColorStop(0.58, '#f2f2f7');
  background.addColorStop(1, '#fafafd');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
}

function drawBrandHeader(ctx, model, y, brandImage) {
  glassPanel(ctx, POSTER_PADDING, y, POSTER_INNER_WIDTH, 116, 30, 'rgba(255,255,255,0.96)');
  const iconX = POSTER_PADDING + 20;
  const iconY = y + 20;
  const iconSize = 76;
  if (brandImage) {
    drawCoverImage(ctx, brandImage, iconX, iconY, iconSize, iconSize, 24);
    roundedRect(ctx, iconX, iconY, iconSize, iconSize, 24, '', 'rgba(255,255,255,0.92)');
  } else {
    roundedRect(ctx, iconX, iconY, iconSize, iconSize, 24, '#f2f2f7', 'rgba(60, 60, 67, 0.1)');
    fillText(ctx, 'S', iconX + iconSize / 2, iconY + 20, {
      color: '#3a3a3c',
      font: `700 34px ${FONT_STACK}`,
      align: 'center',
    });
  }

  fillText(ctx, model.title, iconX + 96, y + 27, {
    font: `700 27px ${FONT_STACK}`,
  });
  fillText(ctx, 'by.sameko', iconX + 96, y + 68, {
    color: '#737884',
    font: `500 16px ${FONT_STACK}`,
  });

  const pillWidth = 190;
  const pillX = POSTER_WIDTH - POSTER_PADDING - pillWidth - 18;
  roundedRect(ctx, pillX, y + 33, pillWidth, 50, 16, '#eef5ff', 'rgba(10, 124, 255, 0.1)');
  ctx.font = `650 17px ${FONT_STACK}`;
  fillText(ctx, fitText(ctx, model.drawLabel, pillWidth - 22), pillX + pillWidth / 2, y + 46, {
    color: '#1268c4',
    font: `650 17px ${FONT_STACK}`,
    align: 'center',
  });
}

function drawHero(ctx, model, y, avatarImages) {
  ctx.save();
  ctx.shadowColor = 'rgba(35, 40, 52, 0.08)';
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 10;
  roundedRect(ctx, POSTER_PADDING, y, POSTER_INNER_WIDTH, 208, 34, '#ffffff', 'rgba(60, 60, 67, 0.1)');
  ctx.restore();
  roundedRect(ctx, POSTER_PADDING + 24, y + 24, 112, 36, 18, '#e8f7f0');
  fillText(ctx, '开奖完成', POSTER_PADDING + 80, y + 32, {
    color: '#1f7a5d',
    font: `650 15px ${FONT_STACK}`,
    align: 'center',
  });

  fillText(ctx, `${model.winnerCount} 位中奖用户`, POSTER_PADDING + 24, y + 75, {
    color: '#1d1d1f',
    font: `760 46px ${FONT_STACK}`,
  });
  fillText(ctx, `${model.groups.length} 个奖项 · ${model.drawnAt}`, POSTER_PADDING + 26, y + 145, {
    color: '#6e6e73',
    font: `500 17px ${FONT_STACK}`,
  });

  const visibleWinners = model.groups.flatMap((group) => group.winners).slice(0, 3);
  const remaining = model.winnerCount - visibleWinners.length;
  const avatarSize = 60;
  const overlap = 14;
  const stackItems = visibleWinners.length + (remaining > 0 ? 1 : 0);
  const stackWidth = stackItems
    ? avatarSize + (stackItems - 1) * (avatarSize - overlap)
    : 0;
  const stackX = POSTER_WIDTH - POSTER_PADDING - 24 - stackWidth;
  visibleWinners.forEach((winner, index) => {
    drawAvatar(ctx, winner, avatarImages, stackX + index * (avatarSize - overlap), y + 78, avatarSize);
  });
  if (remaining > 0) {
    const moreX = stackX + visibleWinners.length * (avatarSize - overlap);
    roundedRect(ctx, moreX, y + 78, avatarSize, avatarSize, 21, '#f1efff', '#ffffff');
    fillText(ctx, `+${remaining}`, moreX + avatarSize / 2, y + 97, {
      color: '#5e5ce6',
      font: `700 20px ${FONT_STACK}`,
      align: 'center',
    });
  }
}

function drawSource(ctx, model, y) {
  glassPanel(ctx, POSTER_PADDING, y, POSTER_INNER_WIDTH, 92, 26, 'rgba(255,255,255,0.94)');
  fillText(ctx, '微博来源', POSTER_PADDING + 24, y + 15, {
    color: '#858a96',
    font: `500 14px ${FONT_STACK}`,
  });
  ctx.font = `560 17px ${FONT_STACK}`;
  const lines = wrapLines(ctx, model.source, POSTER_INNER_WIDTH - 48, 2);
  lines.forEach((line, index) => {
    fillText(ctx, line, POSTER_PADDING + 24, y + 39 + index * 23, {
      color: '#343842',
      font: `560 17px ${FONT_STACK}`,
    });
  });
}

function drawStats(ctx, model, y) {
  const values = [
    ['载入候选', model.fairness.candidateCount.toLocaleString('zh-CN'), TONES[1]],
    ['符合规则', model.fairness.eligibleCount.toLocaleString('zh-CN'), TONES[3]],
    ['中奖人数', model.winnerCount.toLocaleString('zh-CN'), TONES[0]],
  ];
  glassPanel(ctx, POSTER_PADDING, y, POSTER_INNER_WIDTH, 116, 28, 'rgba(255,255,255,0.94)');
  const cellWidth = POSTER_INNER_WIDTH / values.length;
  values.forEach(([label, value, tone], index) => {
    const x = POSTER_PADDING + index * cellWidth;
    if (index) {
      ctx.fillStyle = 'rgba(31,31,38,0.08)';
      ctx.fillRect(x, y + 24, 1.5, 68);
    }
    fillText(ctx, label, x + cellWidth / 2, y + 22, {
      color: '#8b909b',
      font: `500 14px ${FONT_STACK}`,
      align: 'center',
    });
    fillText(ctx, value, x + cellWidth / 2, y + 49, {
      color: tone.strong,
      font: `730 32px ${FONT_STACK}`,
      align: 'center',
    });
  });
}

function drawSectionTitle(ctx, model, y) {
  fillText(ctx, '中奖名单', POSTER_PADDING + 2, y, {
    font: `730 30px ${FONT_STACK}`,
  });
  fillText(ctx, `共 ${model.winnerCount} 人`, POSTER_WIDTH - POSTER_PADDING - 2, y + 7, {
    color: '#858a96',
    font: `520 17px ${FONT_STACK}`,
    align: 'right',
  });
}

function drawWinnerGroup(ctx, group, groupIndex, y, avatarImages) {
  const height = GROUP_HEADER_HEIGHT + group.winners.length * WINNER_ROW_HEIGHT + GROUP_BOTTOM_PADDING;
  glassPanel(ctx, POSTER_PADDING, y, POSTER_INNER_WIDTH, height, 26, 'rgba(255,255,255,0.96)');
  roundedRect(ctx, POSTER_PADDING + 20, y + 18, 48, 48, 16, group.tone.fill, '#ffffff');
  fillText(ctx, String(groupIndex + 1), POSTER_PADDING + 44, y + 28, {
    color: group.color,
    font: `720 20px ${FONT_STACK}`,
    align: 'center',
  });
  ctx.font = `680 24px ${FONT_STACK}`;
  fillText(ctx, fitText(ctx, group.name, POSTER_INNER_WIDTH - 190), POSTER_PADDING + 84, y + 21, {
    font: `680 24px ${FONT_STACK}`,
  });
  fillText(ctx, `${group.totalWinnerCount} 名`, POSTER_WIDTH - POSTER_PADDING - 22, y + 28, {
    color: '#858a96',
    font: `520 17px ${FONT_STACK}`,
    align: 'right',
  });

  group.winners.forEach((winner, winnerIndex) => {
    const rowY = y + GROUP_HEADER_HEIGHT + winnerIndex * WINNER_ROW_HEIGHT;
    if (winnerIndex) {
      ctx.fillStyle = 'rgba(31,31,38,0.075)';
      ctx.fillRect(POSTER_PADDING + 88, rowY, POSTER_INNER_WIDTH - 112, 1.5);
    }
    drawAvatar(ctx, winner, avatarImages, POSTER_PADDING + 20, rowY + 11, 58);
    ctx.font = `650 22px ${FONT_STACK}`;
    fillText(ctx, fitText(ctx, winner.name, POSTER_INNER_WIDTH - 184), POSTER_PADDING + 92, rowY + 12, {
      font: `650 22px ${FONT_STACK}`,
    });
    ctx.font = `500 15px ${FONT_STACK}`;
    const uid = winner.uid === 'UID 未记录' ? winner.uid : `UID ${winner.uid}`;
    fillText(ctx, fitText(ctx, uid, POSTER_INNER_WIDTH - 184), POSTER_PADDING + 92, rowY + 44, {
      color: '#8b909b',
      font: `500 15px ${FONT_STACK}`,
    });
    fillText(ctx, String(winner.rank).padStart(2, '0'), POSTER_WIDTH - POSTER_PADDING - 22, rowY + 25, {
      color: group.color,
      font: `700 17px ${FONT_STACK}`,
      align: 'right',
    });
  });
  return height;
}

function drawOmittedWinners(ctx, displayedCount, omittedCount, y) {
  glassPanel(ctx, POSTER_PADDING, y, POSTER_INNER_WIDTH, 56, 20, 'rgba(255,255,255,0.78)');
  fillText(ctx, `结果图展示 ${displayedCount} 位，另有 ${omittedCount} 位请在开奖记录中查看`, POSTER_WIDTH / 2, y + 17, {
    color: '#737884',
    font: `520 16px ${FONT_STACK}`,
    align: 'center',
  });
}

function drawFairness(ctx, model, y) {
  ctx.save();
  ctx.shadowColor = 'rgba(35, 40, 52, 0.07)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 9;
  roundedRect(ctx, POSTER_PADDING, y, POSTER_INNER_WIDTH, 292, 30, '#ffffff', 'rgba(60, 60, 67, 0.1)');
  ctx.restore();
  roundedRect(ctx, POSTER_PADDING + 20, y + 20, 56, 56, 18, '#f2f2f7', 'rgba(60, 60, 67, 0.1)');
  fillText(ctx, 'SHA', POSTER_PADDING + 48, y + 39, {
    color: '#636366',
    font: `700 14px ${FONT_STACK}`,
    align: 'center',
  });
  fillText(ctx, '随机过程记录', POSTER_PADDING + 94, y + 20, {
    color: '#1d1d1f',
    font: `700 27px ${FONT_STACK}`,
  });
  fillText(ctx, model.drawLabel, POSTER_PADDING + 94, y + 55, {
    color: '#6e6e73',
    font: `520 16px ${FONT_STACK}`,
  });

  const cells = [
    ['数据来源', model.fairness.provider],
    ['筛选规则', model.fairness.filterSummary],
    ['随机算法', model.fairness.algorithm],
    ['开奖时间', model.drawnAt],
  ];
  const gridX = POSTER_PADDING + 20;
  const gridY = y + 98;
  const cellWidth = (POSTER_INNER_WIDTH - 40) / 2;
  const cellHeight = 68;
  cells.forEach(([label, value], index) => {
    const x = gridX + (index % 2) * cellWidth;
    const cellY = gridY + Math.floor(index / 2) * cellHeight;
    fillText(ctx, label, x, cellY, {
      color: '#8e8e93',
      font: `500 14px ${FONT_STACK}`,
    });
    ctx.font = `600 17px ${FONT_STACK}`;
    const lines = wrapLines(ctx, value, cellWidth - 22, 2);
    lines.forEach((line, lineIndex) => {
      fillText(ctx, line, x, cellY + 23 + lineIndex * 20, {
        color: '#2c2c2e',
        font: `600 17px ${FONT_STACK}`,
      });
    });
  });

  ctx.fillStyle = 'rgba(60,60,67,0.1)';
  ctx.fillRect(POSTER_PADDING + 20, y + 226, POSTER_INNER_WIDTH - 40, 1.5);
  fillText(ctx, `随机种子 ${model.fairness.seed}`, POSTER_PADDING + 20, y + 240, {
    color: '#8e8e93',
    font: `500 13px ${FONT_STACK}`,
  });
  fillText(ctx, `名单指纹 ${model.fairness.digest}`, POSTER_WIDTH - POSTER_PADDING - 20, y + 240, {
    color: '#8e8e93',
    font: `500 13px ${FONT_STACK}`,
    align: 'right',
  });
  fillText(ctx, `过程哈希 ${model.fairness.auditHash}`, POSTER_PADDING + 20, y + 264, {
    color: '#6e6e73',
    font: `540 13px ${FONT_STACK}`,
  });
}

function drawFooter(ctx, model, y) {
  ctx.fillStyle = 'rgba(31,31,38,0.09)';
  ctx.fillRect(POSTER_PADDING, y, POSTER_INNER_WIDTH, 1.5);
  fillText(ctx, '微博转发抽奖助手 · by.sameko', POSTER_PADDING, y + 28, {
    color: '#737884',
    font: `560 16px ${FONT_STACK}`,
  });
  fillText(ctx, model.drawnAt, POSTER_WIDTH - POSTER_PADDING, y + 28, {
    color: '#9297a3',
    font: `500 16px ${FONT_STACK}`,
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
  let y = 48;
  drawBrandHeader(ctx, model, y, brandImage);
  y += 140;
  drawHero(ctx, model, y, avatarImages);
  y += 228;
  drawSource(ctx, model, y);
  y += 112;
  drawStats(ctx, model, y);
  y += 142;
  drawSectionTitle(ctx, model, y);
  y += 54;
  model.groups.forEach((group, index) => {
    y += drawWinnerGroup(ctx, group, index, y, avatarImages) + GROUP_GAP;
  });
  if (model.omittedWinnerCount) {
    drawOmittedWinners(ctx, model.displayedWinnerCount, model.omittedWinnerCount, y);
    y += 72;
  }
  drawFairness(ctx, model, y);
  y += 318;
  drawFooter(ctx, model, y);
  return canvas;
}
