import React, { useEffect, useMemo, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import {
  Bolt,
  Clock,
  Copy,
  Crown,
  Download,
  Gift,
  Image,
  Plus,
  Save,
  Settings,
  ShieldCheck,
  Star,
  Trash2,
  Trophy,
  Users,
  X,
} from 'lucide-react';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const publicAsset = (name) => `${import.meta.env.BASE_URL}${name}`;
function cleanApiBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}
function configuredApiBases() {
  const configured = [
    window.WEIBO_DRAW_API_BASE,
    ...(Array.isArray(window.WEIBO_DRAW_ALLOWED_API_BASES) ? window.WEIBO_DRAW_ALLOWED_API_BASES : []),
  ];
  return [...new Set(configured.map(cleanApiBase).filter(Boolean))];
}
function isLocalApiBase(value) {
  try {
    const url = new URL(cleanApiBase(value));
    return ['http:', 'https:'].includes(url.protocol)
      && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname);
  } catch {
    return false;
  }
}
function isTrustedApiBase(value) {
  const cleaned = cleanApiBase(value);
  if (!cleaned) return true;
  try {
    const url = new URL(cleaned);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (isLocalApiBase(cleaned)) return true;
    return configuredApiBases().includes(cleaned);
  } catch {
    return false;
  }
}
function initialApiBase() {
  const storedApi = cleanApiBase(localStorage.getItem('weibo-draw-api-base') || '');
  if (storedApi && isTrustedApiBase(storedApi)) return storedApi;
  if (storedApi) localStorage.removeItem('weibo-draw-api-base');
  return cleanApiBase(window.WEIBO_DRAW_API_BASE || '');
}
function isStaticHostedPage() {
  return /\.github\.io$/i.test(location.hostname) || location.protocol === 'file:';
}

async function seededShuffle(items, seedMaterial) {
  const result = [...items];
  let counter = 0;
  let words = [];
  let wordIndex = 0;
  async function refillWords() {
    const input = `${seedMaterial}:${counter++}`;
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    const view = new DataView(buffer);
    words = [];
    for (let offset = 0; offset < view.byteLength; offset += 4) {
      words.push(view.getUint32(offset, false));
    }
    wordIndex = 0;
  }
  async function nextUint32() {
    if (wordIndex >= words.length) await refillWords();
    return words[wordIndex++];
  }
  for (let i = result.length - 1; i > 0; i -= 1) {
    const range = i + 1;
    const limit = Math.floor(0x100000000 / range) * range;
    let value = await nextUint32();
    while (value >= limit) value = await nextUint32();
    const j = value % range;
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
async function digestCandidates(candidates) {
  const payload = JSON.stringify(candidates.map((item) => ({
    uid: item.uid,
    screenName: item.screenName,
    repostId: item.repostId,
    text: item.text,
    createdAt: item.createdAt,
  })));
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function randomSeedHex() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function toCsv(rows) {
  const headers = ['tier', 'uid', 'screenName', 'text', 'createdAt', 'source'];
  const escape = (value) => {
    const raw = String(value ?? '');
    const safe = /^[=+\-@\t\r\n]/.test(raw.trimStart()) ? `'${raw}` : raw;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return [headers.map(escape).join(','), ...rows.map((row) => headers.map((key) => escape(row[key])).join(','))].join('\n');
}
function download(name, content, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
function downloadUrl(name, url) {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
}
function safeMentionName(value) {
  return String(value || '').replace(/^@+/, '').trim();
}
function winnerMentionText(winners) {
  return winners.map((winner) => safeMentionName(winner.screenName || winner.uid)).filter(Boolean).map((name) => `@${name}`).join(' ');
}
function winnerPostText(results, statusUrl) {
  const lines = results
    .filter((item) => item.winners.length)
    .map((item) => `${item.prize.name}：${winnerMentionText(item.winners)}`);
  const linkLine = statusUrl ? `\n原微博：${statusUrl}` : '';
  return `开奖啦！本次微博转发抽奖结果：\n${lines.join('\n')}${linkLine}\n恭喜以上用户，请留意私信～`;
}
function formatDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}
function buildFilterSummary({ keyword, mentionMin, uniqueByUser, excludePrevious }) {
  const parts = [];
  if (keyword) parts.push(`关键词：${keyword}`);
  if (Number(mentionMin || 0) > 0) parts.push(`至少 @${Number(mentionMin || 0)}`);
  if (uniqueByUser) parts.push('同一用户只保留一次');
  if (excludePrevious) parts.push('排除本轮已中奖用户');
  return parts.length ? parts.join(' / ') : '未启用额外筛选';
}
function drawRoundedRect(ctx, x, y, width, height, radius, fill, stroke = '') {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}
function wrapCanvasText(ctx, text, maxWidth) {
  const raw = String(text || '');
  const lines = [];
  for (const paragraph of raw.split('\n')) {
    let line = '';
    for (const char of paragraph) {
      const next = line + char;
      if (ctx.measureText(next).width > maxWidth && line) {
        lines.push(line);
        line = char;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines.filter((line) => line !== '');
}
function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight, color, font) {
  ctx.fillStyle = color;
  ctx.font = font;
  const lines = wrapCanvasText(ctx, text, maxWidth);
  lines.forEach((line, index) => ctx.fillText(line, x, y + index * lineHeight));
  return lines.length * lineHeight;
}
function createRecordImage(payload) {
  const width = 1080;
  const dpr = Math.min(2, window.devicePixelRatio || 2);
  const prizeHeight = payload.results.reduce((sum, item) => {
    const winnerLines = Math.max(1, item.winners.reduce((acc, winner) => acc + Math.max(1, Math.ceil(String(winner.screenName || winner.uid || '').length / 18)), 0));
    return sum + 116 + winnerLines * 34;
  }, 0);
  const auditLines = 13;
  const height = Math.max(1540, 770 + prizeHeight + auditLines * 34);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.textBaseline = 'top';

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#16070d');
  bg.addColorStop(0.48, '#090714');
  bg.addColorStop(1, '#03050b');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const hot = ctx.createRadialGradient(180, 120, 40, 180, 120, 520);
  hot.addColorStop(0, 'rgba(239,68,68,0.34)');
  hot.addColorStop(1, 'rgba(239,68,68,0)');
  ctx.fillStyle = hot;
  ctx.fillRect(0, 0, width, height);
  const glow = ctx.createRadialGradient(920, 260, 20, 920, 260, 560);
  glow.addColorStop(0, 'rgba(249,115,22,0.27)');
  glow.addColorStop(1, 'rgba(249,115,22,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  for (let x = 56; x < width; x += 56) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  for (let y = 56; y < height; y += 56) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }

  const pad = 64;
  let y = 58;
  drawRoundedRect(ctx, pad, y, width - pad * 2, 122, 30, 'rgba(255,255,255,0.055)', 'rgba(255,255,255,0.10)');
  ctx.font = '42px "Noto Sans SC", "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('微博转发抽奖助手', pad + 34, y + 28);
  ctx.font = '20px "Noto Sans SC", "Microsoft YaHei", sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.50)';
  ctx.fillText('by.sameko · 公开开奖记录', pad + 34, y + 80);
  ctx.textAlign = 'right';
  ctx.font = '22px "Noto Sans SC", "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#fbbf24';
  ctx.fillText(formatDateTime(payload.drawnAt), width - pad - 34, y + 51);
  ctx.textAlign = 'left';
  y += 172;

  ctx.font = '62px "Noto Sans SC", "Microsoft YaHei", sans-serif';
  const titleGradient = ctx.createLinearGradient(pad, y, width - pad, y);
  titleGradient.addColorStop(0, '#ffffff');
  titleGradient.addColorStop(0.5, '#d7ecff');
  titleGradient.addColorStop(1, '#5ac8fa');
  ctx.fillStyle = titleGradient;
  ctx.fillText('微博转发抽奖结果', pad, y);
  y += 86;
  y += drawWrappedText(ctx, payload.statusUrl || payload.statusId || '未记录微博链接', pad, y, width - pad * 2, 30, 'rgba(255,255,255,0.58)', '22px "Noto Sans SC", "Microsoft YaHei", sans-serif') + 24;

  const stats = [
    ['候选记录', payload.candidateCount],
    ['可抽人数', payload.eligibleCount],
    ['中奖人数', payload.winnerCount],
    ['本链接已抽', payload.drawCount],
  ];
  const statGap = 18;
  const statW = (width - pad * 2 - statGap * 3) / 4;
  stats.forEach(([label, value], index) => {
    const sx = pad + index * (statW + statGap);
    drawRoundedRect(ctx, sx, y, statW, 104, 22, 'rgba(255,255,255,0.065)', 'rgba(255,255,255,0.095)');
    ctx.font = '42px "Noto Sans SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = index === 0 ? '#007aff' : index === 1 ? '#5ac8fa' : index === 2 ? '#30d158' : '#5e5ce6';
    ctx.fillText(String(value ?? 0), sx + 24, y + 18);
    ctx.font = '18px "Noto Sans SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.52)';
    ctx.fillText(label, sx + 24, y + 70);
  });
  y += 146;

  drawRoundedRect(ctx, pad, y, width - pad * 2, 72, 22, 'rgba(255,159,202,0.16)', 'rgba(157,220,255,0.22)');
  ctx.font = '28px "Noto Sans SC", "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#fff7ed';
  ctx.fillText('中奖名单', pad + 28, y + 20);
  ctx.textAlign = 'right';
  ctx.font = '18px "Noto Sans SC", "Microsoft YaHei", sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText('每个奖项按同一随机池顺序依次开出', width - pad - 28, y + 26);
  ctx.textAlign = 'left';
  y += 96;

  payload.results.forEach((item) => {
    const names = item.winners.map((winner) => safeMentionName(winner.screenName || winner.uid) || '未命名用户');
    const rows = names.reduce((sum, name) => sum + Math.max(1, Math.ceil(name.length / 18)), 0);
    const cardH = 100 + rows * 36;
    drawRoundedRect(ctx, pad, y, width - pad * 2, cardH, 26, 'rgba(255,255,255,0.050)', 'rgba(255,255,255,0.085)');
    ctx.fillStyle = item.prize.color || '#f97316';
    ctx.beginPath();
    ctx.arc(pad + 34, y + 35, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '30px "Noto Sans SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(item.prize.name, pad + 54, y + 20);
    ctx.textAlign = 'right';
    ctx.font = '18px "Noto Sans SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.50)';
    ctx.fillText(`${item.winners.length} 人`, width - pad - 28, y + 26);
    ctx.textAlign = 'left';
    let wy = y + 70;
    names.forEach((name) => {
      const text = `@${name}`;
      const lineHeight = 30;
      const used = drawWrappedText(ctx, text, pad + 34, wy, width - pad * 2 - 68, lineHeight, '#fef3c7', '23px "Noto Sans SC", "Microsoft YaHei", sans-serif');
      wy += used + 4;
    });
    y += cardH + 18;
  });

  y += 14;
  drawRoundedRect(ctx, pad, y, width - pad * 2, 404, 28, 'rgba(15,23,42,0.62)', 'rgba(148,163,184,0.16)');
  ctx.font = '30px "Noto Sans SC", "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#bfdbfe';
  ctx.fillText('公平公开校验信息', pad + 30, y + 28);
  const auditX = pad + 30;
  let ay = y + 82;
  const auditRows = [
    ['随机方式', '公开随机种子 + SHA-256 Fisher-Yates 洗牌'],
    ['随机种子', payload.seed || '未记录'],
    ['可抽池摘要', payload.candidateDigest || '未记录'],
    ['数据来源', payload.providerText || '可见转发接口'],
    ['接口总转发', payload.totalNumber === null || payload.totalNumber === undefined ? '未返回' : `${payload.totalNumber} 条`],
    ['筛选规则', payload.filterSummary],
    ['奖项设置', payload.prizeSummary],
  ];
  auditRows.forEach(([label, value]) => {
    ctx.font = '19px "Noto Sans SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.fillText(label, auditX, ay);
    const used = drawWrappedText(ctx, String(value), auditX + 128, ay, width - pad * 2 - 164, 27, 'rgba(255,255,255,0.75)', '19px "Noto Sans SC", "Microsoft YaHei", sans-serif');
    ay += Math.max(32, used + 7);
  });
  y += 446;

  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.beginPath();
  ctx.moveTo(pad, y);
  ctx.lineTo(width - pad, y);
  ctx.stroke();
  y += 28;
  ctx.font = '18px "Noto Sans SC", "Microsoft YaHei", sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.38)';
  ctx.fillText('本图由微博转发抽奖助手生成，仅记录本次开奖快照。公开校验时请同时保留原微博、可抽池导出文件与本图信息。', pad, y);
  return canvas;
}

const COLORS = ['#007aff', '#30d158', '#ff9f0a', '#5e5ce6', '#64d2ff', '#ff375f'];
const PRIZE_NAMES = ['一等奖', '二等奖', '三等奖', '幸运奖'];
function defaultPrize(index = 0, count = 1) {
  return {
    name: PRIZE_NAMES[index] || `奖项${index + 1}`,
    count,
    color: COLORS[index % COLORS.length],
  };
}
const DEFAULT_PRIZES = [defaultPrize(0, 1)];

const I = {
  trophy: <Trophy className="w-5 h-5" strokeWidth={1.5} />,
  users: <Users className="w-[18px] h-[18px]" strokeWidth={1.5} />,
  gift: <Gift className="w-[18px] h-[18px]" strokeWidth={1.5} />,
  clock: <Clock className="w-[18px] h-[18px]" strokeWidth={1.5} />,
  trash: <Trash2 className="w-4 h-4" strokeWidth={1.8} />,
  settings: <Settings className="w-[18px] h-[18px]" strokeWidth={1.5} />,
  bolt: <Bolt className="w-5 h-5 text-[#5ac8fa]" fill="currentColor" strokeWidth={1.2} />,
  close: <X className="w-4 h-4" strokeWidth={2} />,
  plus: <Plus className="w-4 h-4" strokeWidth={2} />,
  star: <Star className="w-3.5 h-3.5" fill="currentColor" strokeWidth={0} />,
  crown: <Crown className="w-8 h-8" fill="currentColor" strokeWidth={0} />,
  shield: <ShieldCheck className="w-4 h-4" strokeWidth={1.7} />,
  download: <Download className="w-4 h-4" strokeWidth={1.8} />,
  save: <Save className="w-4 h-4" strokeWidth={1.8} />,
  copy: <Copy className="w-4 h-4" strokeWidth={1.8} />,
  image: <Image className="w-4 h-4" strokeWidth={1.8} />,
};

function StatCard({ value, label, gradient, delay }) {
  return (
    <div className={`glass stat-card px-3 py-3 text-left slide-up min-w-0 ${delay}`}>
      <div className="stat-label flex items-center gap-2 text-[10px] uppercase text-gray-500 whitespace-nowrap">
        <span className="h-1.5 w-1.5 rounded-full bg-[#007aff]" />
        {label}
      </div>
      <div className={`stat-value mt-2 text-[22px] sm:text-[26px] leading-none font-semibold bg-clip-text text-transparent bg-gradient-to-r ${gradient} truncate`}>{value}</div>
    </div>
  );
}

function RollingBox({ isRolling, name, phase }) {
  const displayName = name || '抽取中';
  return (
    <div className={`stage-shell w-full h-40 sm:h-44 flex items-center justify-center relative overflow-hidden ${isRolling ? 'is-rolling' : ''}`}>
      <div className="stage-sparkles" aria-hidden="true">
        <i /><i /><i /><i />
      </div>
      <div className="absolute inset-0 shimmer-line pointer-events-none" />
      <div className="reel-vignette" aria-hidden="true" />
      <div className="reel-center-line" aria-hidden="true" />
      {isRolling ? (
        <div className="reel-window z-10">
          <div className="reel-card roll-in" key={displayName}>
            <div className="reel-mask">
              <div className="reel-track">
                <span>{displayName}</span>
                <span>{displayName}</span>
                <span>{displayName}</span>
              </div>
            </div>
            <div className="reel-phase">{phase}</div>
          </div>
        </div>
      ) : (
        <div className="reel-idle z-10">
          <span className="reel-idle-icon">{I.star}</span>
          <span>等待幸运名单</span>
        </div>
      )}
    </div>
  );
}

function EmptyState({ icon, title, detail, compact = false }) {
  return (
    <div className={`empty-state ${compact ? 'empty-state-compact' : ''}`}>
      <div className="empty-state-icon">{icon}</div>
      <div>
        <div className="empty-state-title">{title}</div>
        {detail && <div className="empty-state-detail">{detail}</div>}
      </div>
    </div>
  );
}

function PrizeCard({ prize, winners, isNew, index }) {
  return (
    <div className={`glass overflow-hidden ${isNew ? 'reveal' : ''}`} style={isNew ? { animationDelay: `${index * 0.12}s` } : {}}>
      <div className="h-0.5" style={{ background: `linear-gradient(90deg, ${prize.color}, transparent)` }} />
      <div className="p-5">
        <div className="flex items-center gap-2.5 mb-3">
          <div className="w-2 h-2 rounded-full pulse-dot" style={{ background: prize.color }} />
          <span className="text-white font-semibold text-sm">{prize.name}</span>
          <span className="text-[11px] text-gray-500 ml-auto bg-white/5 px-2 py-0.5 rounded-full">{winners.length}人</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {winners.map((winner, j) => (
            <span key={j} className="inline-flex items-center gap-1 hard-chip px-3 py-1.5 text-[13px] text-gray-200">
              <span className="text-[#007aff]">{I.star}</span>{winner.screenName || winner.uid || `中奖用户${j + 1}`}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function WinnerModal({ results, onClose, onCopyNames, onCopyPost, onCreateShareImage, isCapturing }) {
  useEffect(() => {
    const end = Date.now() + 4200;
    const colors = COLORS;
    const fire = () => {
      confetti?.({ particleCount: 4, angle: 60, spread: 60, origin: { x: 0 }, colors, gravity: 0.8 });
      confetti?.({ particleCount: 4, angle: 120, spread: 60, origin: { x: 1 }, colors, gravity: 0.8 });
      if (Date.now() < end) requestAnimationFrame(fire);
    };
    fire();
  }, []);
  const total = results.reduce((sum, item) => sum + item.winners.length, 0);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-md" />
      <div data-share-modal className="relative glass-elevated share-capture p-6 sm:p-8 max-w-lg w-full reveal overflow-y-auto max-h-[90vh]" onClick={(event) => event.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-gray-500 hover:text-white hover:bg-white/10 transition">{I.close}</button>
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-lg bg-gradient-to-br from-[#e8f3ff] to-[#5ac8fa] mb-4 shadow-lg shadow-blue-500/15">
            <span className="text-slate-950">{I.crown}</span>
          </div>
          <h2 className="text-2xl font-bold text-white tracking-tight">开奖完成</h2>
          <p className="text-sm text-gray-400 mt-1">共 <span className="text-[#007aff] font-semibold">{total}</span> 位幸运用户</p>
        </div>
        <div className="space-y-3 mb-6">
          {results.map((item, i) => (
            <PrizeCard key={i} prize={item.prize} winners={item.winners} isNew={true} index={i} />
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
          <button onClick={onCopyNames} className="btn-ghost px-3 py-2.5 rounded-xl text-[12px] text-gray-200 font-semibold flex items-center justify-center gap-1.5">{I.copy} 复制@名单</button>
          <button onClick={onCopyPost} className="btn-ghost px-3 py-2.5 rounded-xl text-[12px] text-gray-200 font-semibold flex items-center justify-center gap-1.5">{I.copy} 复制文案</button>
          <button data-testid="modal-record-image" onClick={onCreateShareImage} disabled={isCapturing} className="btn-ghost px-3 py-2.5 rounded-xl text-[12px] text-gray-200 font-semibold flex items-center justify-center gap-1.5">{I.image} {isCapturing ? '生成中' : '开奖记录图'}</button>
        </div>
        <button onClick={onClose} className="btn-primary px-6 py-3 rounded-xl text-white font-semibold relative z-10 w-full">
          <span className="relative z-10">好的</span>
        </button>
      </div>
    </div>
  );
}

function History({ list, onClear }) {
  if (!list.length) {
    return (
      <EmptyState icon={I.clock} title="暂无开奖记录" detail="完成开奖后会自动留在这里，方便复查和保存。" compact />
    );
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[11px] text-gray-500">{list.length} 条记录</span>
        <button onClick={onClear} className="text-[11px] text-gray-500 hover:text-[#ff375f] transition flex items-center gap-1">{I.trash} 清空</button>
      </div>
      <div className="space-y-1.5 max-h-52 overflow-y-auto">
        {list.map((item, i) => (
          <div key={i} className="glass rounded-lg p-2.5 hover:bg-white/[0.03] transition">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[#007aff] text-[11px]">{item.time}</span>
              <span className="text-[10px] text-gray-600">{item.total}人中奖</span>
            </div>
            <div className="text-[11px] text-gray-500 truncate">{item.summary}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function normalizeManualItem(raw, index) {
  const values = Array.isArray(raw) ? raw : Object.values(raw || {});
  const uid = String(raw.uid || raw.UID || raw.userId || raw.user_id || values[0] || '').trim();
  const screenName = String(raw.screenName || raw.name || raw.nickname || raw['昵称'] || values[1] || `候选人 ${index + 1}`).trim();
  const text = String(raw.text || raw.content || raw['转发内容'] || values[2] || '').trim();
  const createdAt = String(raw.createdAt || raw.time || raw['时间'] || values[3] || '').trim();
  const stable = [uid, screenName, text, createdAt].filter(Boolean).join('|') || String(index);
  return { id: stable, uid, screenName, avatar: '', verified: false, followers: 0, text, createdAt, repostId: '', source: 'manual' };
}
function parseCsvLine(line, delimiter) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') { value += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { cells.push(value.trim()); value = ''; }
    else value += char;
  }
  cells.push(value.trim());
  return cells;
}
function parseManualInput(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('JSON 顶层需要是数组');
    return parsed.map(normalizeManualItem);
  }
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const delimiter = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
  const first = parseCsvLine(lines[0], delimiter);
  const headerKeys = ['uid', 'UID', '昵称', 'screenName', 'name', 'text', '转发内容', 'time', '时间'];
  const hasHeader = first.some((cell) => headerKeys.includes(cell));
  const headers = hasHeader ? first : [];
  const dataLines = hasHeader ? lines.slice(1) : lines;
  return dataLines.map((line, index) => {
    const cells = parseCsvLine(line, delimiter);
    if (!headers.length) return normalizeManualItem(cells, index);
    const row = {};
    headers.forEach((key, cellIndex) => { row[key] = cells[cellIndex] || ''; });
    cells.forEach((cell, cellIndex) => { row[cellIndex] = cell || ''; });
    return normalizeManualItem(row, index);
  });
}

function App() {
  const [source, setSource] = useState('mobile');
  const [statusUrl, setStatusUrl] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [mobileCookie, setMobileCookie] = useState('');
  const [manualInput, setManualInput] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [historyUids, setHistoryUids] = useState(new Set());
  const [prizes, setPrizes] = useState([...DEFAULT_PRIZES]);
  const [keyword, setKeyword] = useState('');
  const [mentionMin, setMentionMin] = useState(0);
  const [blocklist, setBlocklist] = useState('');
  const [uniqueByUser, setUniqueByUser] = useState(true);
  const [excludePrevious, setExcludePrevious] = useState(true);
  const [results, setResults] = useState([]);
  const [lastPool, setLastPool] = useState(null);
  const [lastAudit, setLastAudit] = useState(null);
  const [sourceMeta, setSourceMeta] = useState(null);
  const [currentStatusId, setCurrentStatusId] = useState('');
  const [currentStatusUrl, setCurrentStatusUrl] = useState('');
  const [drawCount, setDrawCount] = useState(null);
  const [drawCountLastAt, setDrawCountLastAt] = useState('');
  const [cookieInfo, setCookieInfo] = useState({ hasCookie: false, cookieCount: 0, lastValidAt: '' });
  const [status, setStatus] = useState('Cookie 模式已就绪，输入微博链接后一键载入候选。');
  const [statusTone, setStatusTone] = useState('neutral');
  const [progress, setProgress] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [rollingName, setRollingName] = useState('');
  const [phase, setPhase] = useState('');
  const [drawHistory, setDrawHistory] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [recordImageUrl, setRecordImageUrl] = useState('');
  const [recordImageName, setRecordImageName] = useState('');
  const [apiBase, setApiBase] = useState(initialApiBase);
  const [apiKey, setApiKey] = useState('');
  const prizeSettingsRef = useRef(null);
  const firstPrizeNameRef = useRef(null);

  const sourceLabels = { mobile: 'H5 / Cookie', manual: '手动导入', official: '官方 token' };
  const normalizedPrizes = useMemo(() => prizes
    .map((prize, index) => ({
      ...prize,
      name: String(prize.name || '').trim(),
      count: Math.max(0, Math.floor(Number(prize.count || 0))),
      color: prize.color || COLORS[index % COLORS.length],
    }))
    .filter((prize) => prize.name && prize.count > 0), [prizes]);
  const totalSlots = normalizedPrizes.reduce((sum, prize) => sum + prize.count, 0);

  const rules = useMemo(() => {
    const blocked = new Set(blocklist.split(/\r?\n|,/).map((item) => item.trim().toLowerCase()).filter(Boolean));
    return { keyword: keyword.trim().toLowerCase(), mentionMin: Math.max(0, Number(mentionMin || 0)), uniqueByUser, excludePrevious, blocked };
  }, [keyword, mentionMin, uniqueByUser, excludePrevious, blocklist]);

  function filterEligibleCandidates(sourceCandidates, activeRules = rules, activeHistoryUids = historyUids) {
    const seen = new Set();
    let duplicates = 0;
    const list = [];
    for (const candidate of sourceCandidates) {
      const identity = String(candidate.uid || candidate.screenName || candidate.id || '').toLowerCase();
      const name = String(candidate.screenName || '').toLowerCase();
      if (activeRules.uniqueByUser && identity) {
        if (seen.has(identity)) { duplicates += 1; continue; }
        seen.add(identity);
      }
      if (activeRules.excludePrevious && identity && activeHistoryUids.has(identity)) continue;
      if (activeRules.blocked.has(identity) || activeRules.blocked.has(name)) continue;
      if (activeRules.keyword && !String(candidate.text || '').toLowerCase().includes(activeRules.keyword)) continue;
      const mentionCount = (String(candidate.text || '').match(/@[\p{L}\p{N}_\-\u4e00-\u9fa5]+/gu) || []).length;
      if (activeRules.mentionMin && mentionCount < activeRules.mentionMin) continue;
      list.push(candidate);
    }
    return { eligible: list, duplicateCount: duplicates };
  }

  const { eligible, duplicateCount } = useMemo(() => filterEligibleCandidates(candidates), [candidates, rules, historyUids]);

  const displayPool = lastPool || eligible;
  const winners = results.flatMap((item) => item.winners);

  function apiPath(path) {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return apiBase ? `${apiBase}${cleanPath}` : cleanPath;
  }
  function apiFetch(path, options = {}) {
    if (!apiBase && isStaticHostedPage()) {
      return Promise.reject(new Error('当前是静态前端，请先在设置里填写后端 API 地址，例如 https://api.example.com'));
    }
    if (apiBase && !isTrustedApiBase(apiBase)) {
      return Promise.reject(new Error('后端 API 地址不在可信列表里，请使用当前公开后端或本地地址。'));
    }
    const headers = new Headers(options.headers || {});
    if (apiKey.trim()) headers.set('x-api-key', apiKey.trim());
    return fetch(apiPath(path), { ...options, headers });
  }
  function showStatus(message, tone = 'neutral') {
    setStatus(message);
    setStatusTone(tone);
  }
  function clearResult(message) {
    if (message && results.length) showStatus(message);
    setResults([]);
    setLastPool(null);
    setLastAudit(null);
    setRecordImageUrl('');
    setRecordImageName('');
  }
  function jumpToPrizeSettings() {
    requestAnimationFrame(() => {
      prizeSettingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(() => firstPrizeNameRef.current?.focus(), 650);
    });
  }
  function openPrizeSettings() {
    jumpToPrizeSettings();
    showStatus('填写奖项名称和中奖人数后，就可以开始开奖。');
  }
  function ensurePrizeSettingsReady() {
    if (!normalizedPrizes.length || totalSlots < 1) {
      showStatus('请先填写至少一个奖项名称和中奖人数。', 'error');
      jumpToPrizeSettings();
      return false;
    }
    return true;
  }

  async function loadCookieStatus(check = false) {
    try {
      const response = await apiFetch(`/api/weibo/cookie-status${check ? '?check=1' : ''}`);
      const json = await response.json();
      if (!json.ok) throw new Error(json.error || '服务器 Cookie 状态读取失败');
      setCookieInfo(json);
      if (check) {
        if (json.checkSkipped) {
          showStatus('服务器 Cookie 已受站长密钥保护，普通访客只能查看可用数量。');
        } else {
          showStatus(json.hasCookie
            ? `服务器端已有 ${json.cookieCount || 1} 个可用 Cookie，失效项会自动删除。`
            : '服务器端暂无可用 Cookie，粘贴有效 Cookie 后载入即可保存。');
        }
      }
    } catch (error) {
      if (check) showStatus(error.message, 'error');
    }
  }

  async function testApiConnection() {
    try {
      const response = await apiFetch('/api/health');
      const json = await response.json();
      if (!json.ok) throw new Error(json.error || '后端没有返回 ok');
      showStatus(`后端 API 连接成功：${apiBase || location.origin}`, 'success');
    } catch (error) {
      showStatus(`后端 API 连接失败：${error.message}`, 'error');
    }
  }

  async function refreshDrawCount(value = statusUrl) {
    if (source === 'manual' || !value.trim()) {
      setDrawCount(null);
      setDrawCountLastAt('');
      return;
    }
    try {
      const response = await apiFetch(`/api/weibo/draw-count?statusUrl=${encodeURIComponent(value)}`);
      const json = await response.json();
      if (!json.ok) throw new Error(json.error || '抽奖次数查询失败');
      setCurrentStatusId(json.statusId || '');
      setCurrentStatusUrl(json.statusUrl || value);
      setDrawCount(json.drawCount);
      setDrawCountLastAt(json.lastDrawnAt || '');
    } catch {
      setDrawCount(null);
      setDrawCountLastAt('');
    }
  }

  useEffect(() => { loadCookieStatus(true); }, []);
  useEffect(() => {
    const cleaned = cleanApiBase(apiBase);
    if (cleaned && isTrustedApiBase(cleaned)) localStorage.setItem('weibo-draw-api-base', cleaned);
    else localStorage.removeItem('weibo-draw-api-base');
  }, [apiBase]);
  useEffect(() => {
    const timer = setTimeout(() => refreshDrawCount(statusUrl), 420);
    return () => clearTimeout(timer);
  }, [statusUrl, source, apiBase]);

  async function fetchRepostsWithProgress(payload) {
    setProgress({ percent: 3, message: '创建抓取任务' });
    const startResponse = await apiFetch('/api/weibo/reposts/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const started = await startResponse.json();
    if (!started.ok) throw new Error(started.error || '抓取任务创建失败');
    let lastProgress = started.progress || { percent: 3, message: '任务已创建' };
    setProgress(lastProgress);
    while (true) {
      await sleep(650);
      const response = await apiFetch(`/api/weibo/reposts/jobs/${encodeURIComponent(started.jobId)}`);
      const json = await response.json();
      if (!json.ok) throw new Error(json.error || '抓取进度读取失败');
      lastProgress = json.progress || lastProgress;
      setProgress(lastProgress);
      if (json.status === 'done') return json.result;
      if (json.status === 'error') throw new Error(json.error || lastProgress.message || '抓取失败');
    }
  }

  async function loadCandidates(options = {}) {
    const { jumpAfterLoad = true } = options;
    setIsLoading(true);
    clearResult();
    try {
      if (source === 'manual') {
        const parsed = parseManualInput(manualInput);
        const freshHistory = new Set();
        setCandidates(parsed);
        setCurrentStatusId('');
        setCurrentStatusUrl('');
        setDrawCount(null);
        setDrawCountLastAt('');
        setSourceMeta({ provider: 'manual' });
        setHistoryUids(freshHistory);
        showStatus(`已导入 ${parsed.length} 位候选用户，请确认奖项设置。`, 'success');
        if (jumpAfterLoad) jumpToPrizeSettings();
        return {
          candidates: parsed,
          eligible: filterEligibleCandidates(parsed, rules, freshHistory).eligible,
          statusId: '',
          statusUrl: '',
          sourceMeta: { provider: 'manual' },
        };
      }
      if (!statusUrl.trim()) throw new Error('请先粘贴微博正文链接、mid 或 bid。');
      if (source === 'official' && !accessToken.trim()) throw new Error('官方模式需要填写 access_token。');
      showStatus(source === 'mobile'
        ? '正在用默认可见接口抓取微博转发；未填写 Cookie 时会自动使用服务器 Cookie 池。'
        : '正在通过官方接口分页抓取可见转发。');
      const json = await fetchRepostsWithProgress({
        source,
        statusUrl,
        accessToken,
        mobileCookie: source === 'mobile' ? mobileCookie : '',
      });
      if (!json.ok) throw new Error(json.error || '微博数据拉取失败');
      const loadedCandidates = json.candidates || [];
      const freshHistory = new Set();
      setCandidates(loadedCandidates);
      setCurrentStatusId(json.statusId || '');
      setCurrentStatusUrl(json.statusUrl || statusUrl.trim());
      setDrawCount(json.drawCount ?? 0);
      setDrawCountLastAt(json.lastDrawnAt || '');
      setSourceMeta({ ...(json.meta || {}), statusId: json.statusId, statusUrl: json.statusUrl });
      setHistoryUids(freshHistory);
      if (source === 'mobile') await loadCookieStatus(false);
      const pageCount = Array.isArray(json.meta?.pages) ? json.meta.pages.length : 0;
      const totalNumber = Number(json.meta?.totalNumber);
      const totalText = Number.isFinite(totalNumber) ? `接口显示总转发约 ${totalNumber} 条。` : '';
      showStatus(`已载入 ${json.candidates?.length || 0} 条可见转发，扫描 ${pageCount} 页。${totalText ? `${totalText} ` : ''}请确认奖项设置。`, 'success');
      if (jumpAfterLoad) jumpToPrizeSettings();
      return {
        candidates: loadedCandidates,
        eligible: filterEligibleCandidates(loadedCandidates, rules, freshHistory).eligible,
        statusId: json.statusId || '',
        statusUrl: json.statusUrl || statusUrl.trim(),
        sourceMeta: { ...(json.meta || {}), statusId: json.statusId, statusUrl: json.statusUrl },
      };
    } catch (error) {
      showStatus(error.message, 'error');
      throw error;
    } finally {
      setIsLoading(false);
      setTimeout(() => setProgress(null), 1200);
    }
  }

  async function recordDrawAttempt(seed, candidateDigest, drawEligible = eligible, drawCandidates = candidates, drawContext = {}) {
    if (source === 'manual') return null;
    const response = await apiFetch('/api/weibo/draw-attempts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source,
        statusId: drawContext.statusId || currentStatusId,
        statusUrl: drawContext.statusUrl || currentStatusUrl || statusUrl.trim(),
        seed,
        eligibleCount: drawEligible.length,
        candidateCount: drawCandidates.length,
        prizeCount: totalSlots,
        candidateDigest,
        rules: {
          filters: { keyword, mentionMin: Number(mentionMin || 0), uniqueByUser, excludePrevious },
          prizes: normalizedPrizes,
        },
      }),
    });
    const json = await response.json();
    if (!json.ok) throw new Error(json.error || '抽奖次数登记失败');
    setCurrentStatusId(json.statusId || currentStatusId);
    setCurrentStatusUrl(json.statusUrl || currentStatusUrl);
    setDrawCount(json.drawCount ?? drawCount);
    setDrawCountLastAt(json.lastDrawnAt || json.drawnAt || drawCountLastAt);
    return json;
  }

  async function drawAll() {
    if (isDrawing || isLoading) return;
    if (!ensurePrizeSettingsReady()) return;
    let drawCandidates = candidates;
    let drawEligible = eligible;
    let drawContext = { statusId: currentStatusId, statusUrl: currentStatusUrl };

    if (!drawEligible.length) {
      showStatus('正在先载入候选名单。');
      try {
        const loaded = await loadCandidates({ jumpAfterLoad: false });
        drawCandidates = loaded?.candidates || [];
        drawEligible = loaded?.eligible || [];
        drawContext = {
          statusId: loaded?.statusId || currentStatusId,
          statusUrl: loaded?.statusUrl || currentStatusUrl || statusUrl.trim(),
        };
      } catch {
        return;
      }
    }

    if (!drawEligible.length) {
      showStatus('没有可抽候选，请检查链接、Cookie 或筛选规则。', 'error');
      return;
    }
    if (totalSlots > drawEligible.length) {
      showStatus(`中奖总人数 ${totalSlots} 不能超过可抽人数 ${drawEligible.length}。`, 'error');
      return;
    }
    setIsDrawing(true);
    setResults([]);
    try {
      const seed = randomSeedHex();
      const candidateDigest = await digestCandidates(drawEligible);
      if (source !== 'manual') {
        showStatus('正在登记本次开始抽奖次数。');
        await recordDrawAttempt(seed, candidateDigest, drawEligible, drawCandidates, drawContext);
      }
      const pool = await seededShuffle(drawEligible, `${seed}:${candidateDigest}`);
      const rollingPool = pool.map((item) => item.screenName || item.uid || item.id).filter(Boolean);
      const all = [];
      let offset = 0;
      for (let prizeIndex = 0; prizeIndex < normalizedPrizes.length; prizeIndex += 1) {
        const prize = normalizedPrizes[prizeIndex];
        const prizeWinners = pool.slice(offset, offset + Number(prize.count || 0));
        offset += Number(prize.count || 0);
        setPhase(`正在抽取 ${prize.name}`);
        showStatus(`正在抽取 ${prize.name}。`);
        const duration = Math.min(1550, 900 + Number(prize.count || 1) * 90);
        const startedAt = Date.now();
        let tick = 0;
        while (Date.now() - startedAt < duration) {
          const index = rollingPool.length ? (prizeIndex * 19 + tick * 7 + Math.floor(tick / 3)) % rollingPool.length : 0;
          setRollingName(rollingPool[index] || `候选用户 ${tick + 1}`);
          await sleep(Math.min(96, 46 + tick * 4));
          tick += 1;
        }
        setRollingName(prizeWinners.map((winner) => winner.screenName || winner.uid).filter(Boolean).join(' / '));
        setPhase(`${prize.name} 开奖完成`);
        await sleep(380);
        all.push({ prize, winners: prizeWinners });
        setResults([...all]);
        if (prizeIndex < normalizedPrizes.length - 1) await sleep(260);
      }
      const wonIds = new Set(historyUids);
      all.flatMap((item) => item.winners).forEach((winner) => {
        const identity = String(winner.uid || winner.screenName || winner.id || '').toLowerCase();
        if (identity) wonIds.add(identity);
      });
      setHistoryUids(wonIds);
      setLastPool(drawEligible);
      setLastAudit({
        seed,
        drawnAt: new Date().toISOString(),
        statusId: drawContext.statusId || currentStatusId,
        statusUrl: drawContext.statusUrl || currentStatusUrl,
        rules: { filters: { keyword, mentionMin: Number(mentionMin || 0), uniqueByUser, excludePrevious }, prizes: normalizedPrizes },
        candidateDigest,
        eligibleCount: drawEligible.length,
      });
      const now = new Date();
      const time = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      setDrawHistory((previous) => [{
        time,
        results: all,
        total: all.reduce((sum, item) => sum + item.winners.length, 0),
        summary: all.map((item) => `${item.prize.name}: ${item.winners.map((winner) => winner.screenName || winner.uid).join('、')}`).join(' | '),
      }, ...previous].slice(0, 50));
      showStatus(`已抽出 ${all.reduce((sum, item) => sum + item.winners.length, 0)} 位中奖用户。`, 'success');
      setShowModal(true);
    } catch (error) {
      showStatus(error.message, 'error');
    } finally {
      setPhase('');
      setRollingName('');
      setIsDrawing(false);
    }
  }

  async function saveResult() {
    if (!results.length) return;
    try {
      const payload = {
        source,
        statusId: currentStatusId,
        statusUrl: currentStatusUrl,
        sourceMeta: { ...(sourceMeta || {}), statusId: currentStatusId || sourceMeta?.statusId, statusUrl: currentStatusUrl || sourceMeta?.statusUrl },
        winners,
        totalCount: candidates.length,
        eligibleCount: lastAudit?.eligibleCount || eligible.length,
        audit: lastAudit,
      };
      const response = await apiFetch('/api/draws', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await response.json();
      if (!json.ok) throw new Error(json.error || '保存失败');
      showStatus(`结果已保存：${json.file}`, 'success');
    } catch (error) {
      showStatus(error.message, 'error');
    }
  }

  async function copyToClipboard(text, successMessage) {
    if (!text.trim()) {
      showStatus('暂无中奖用户可复制。', 'error');
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      showStatus(successMessage, 'success');
    } catch (error) {
      showStatus(`复制失败：${error.message}`, 'error');
    }
  }

  function copyWinnerMentions() {
    copyToClipboard(winnerMentionText(winners), '中奖用户 @名单已复制。');
  }

  function copyWinnerPost() {
    copyToClipboard(winnerPostText(results, currentStatusUrl || statusUrl.trim()), '可直接发微博的开奖文案已复制。');
  }

  async function createShareImage() {
    if (!results.length) {
      showStatus('请先开奖，再生成开奖记录图。', 'error');
      return;
    }
    try {
      setIsCapturing(true);
      showStatus('正在生成开奖记录图。');
      await sleep(80);
      const providerText = [
        ...(Array.isArray(sourceMeta?.providers) ? sourceMeta.providers : [sourceMeta?.provider]).filter(Boolean),
        sourceMeta?.complete === false ? '未完整' : '',
      ].filter(Boolean).join(' / ');
      const canvas = createRecordImage({
        results,
        statusUrl: currentStatusUrl || statusUrl.trim(),
        statusId: currentStatusId || sourceMeta?.statusId || '',
        drawnAt: lastAudit?.drawnAt || new Date(),
        seed: lastAudit?.seed || '',
        candidateDigest: lastAudit?.candidateDigest || '',
        candidateCount: candidates.length,
        eligibleCount: lastAudit?.eligibleCount || eligible.length,
        winnerCount: winners.length,
        drawCount: drawCount ?? 0,
        totalNumber: sourceMeta?.totalNumber,
        providerText,
        filterSummary: buildFilterSummary({ keyword, mentionMin, uniqueByUser, excludePrevious }),
        prizeSummary: normalizedPrizes.map((prize) => `${prize.name} x ${prize.count}`).join(' / '),
      });
      const imageUrl = canvas.toDataURL('image/png');
      const imageName = `weibo-draw-record-${Date.now()}.png`;
      setRecordImageUrl(imageUrl);
      setRecordImageName(imageName);
      downloadUrl(imageName, imageUrl);
      showStatus('开奖记录图已生成。', 'success');
    } catch (error) {
      showStatus(`开奖记录图生成失败：${error.message}`, 'error');
    } finally {
      setIsCapturing(false);
    }
  }

  function addManualNames() {
    try {
      const parsed = parseManualInput(manualInput);
      if (!parsed.length) return;
      setCandidates((previous) => {
        const merged = [...previous];
        const seen = new Set(previous.map((item) => item.uid || item.screenName || item.id));
        parsed.forEach((item) => {
          const key = item.uid || item.screenName || item.id;
          if (!seen.has(key)) { seen.add(key); merged.push(item); }
        });
        return merged;
      });
      setManualInput('');
      showStatus(`已添加 ${parsed.length} 位候选用户。`, 'success');
    } catch (error) {
      showStatus(error.message, 'error');
    }
  }

  const drawCountText = source === 'manual'
    ? '手动名单不统计微博链接'
    : !statusUrl.trim()
      ? '输入链接后显示'
      : drawCount === null
        ? '查询中'
        : `已开始抽奖 ${drawCount} 次`;
  const drawCountMeta = drawCountLastAt
    ? `最近开始：${new Date(drawCountLastAt).toLocaleString()}`
    : currentStatusId ? `微博 mid：${currentStatusId}` : '点击开始开奖才会计数';
  const hasCandidates = displayPool.length > 0;
  const hasResults = results.length > 0;
  return (
    <div className="relative z-10 min-h-screen flex flex-col app-shell">
      <header className="glass-subtle app-header sticky top-0 z-40">
        <div className="app-header-inner max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="brand-avatar w-11 h-11 rounded-lg bg-white/80 p-1 shadow-md shadow-slate-300/50 ring-1 ring-black/10">
              <img src={publicAsset('avatar.jpg')} alt="sameko avatar" className="h-full w-full rounded-lg object-cover" />
            </div>
            <div className="leading-tight">
              <h1 className="app-brand-title text-[14px] font-semibold text-white">微博转发抽奖助手</h1>
              <div className="app-brand-subtitle text-[10px] text-gray-500">by.sameko</div>
            </div>
          </div>
          <div className="hidden md:flex items-center gap-2 text-[11px] text-gray-500">
            <span className="hard-chip px-2 py-1">接口 {apiBase ? '远程' : '本地'}</span>
            <span className="hard-chip px-2 py-1">任务 {progress ? '运行中' : '空闲'}</span>
          </div>
          <button onClick={() => setShowSettings(true)} className="btn-ghost w-9 h-9 flex items-center justify-center text-gray-400 hover:text-white">
            {I.settings}
          </button>
        </div>
      </header>

      <main className="share-capture app-main flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-8">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
          <div className="main-column lg:col-span-3 space-y-5">
            <section className="glass hero-panel hero-stage-panel p-5 sm:p-6 border-glow">
              <div className="mb-5 flex flex-col gap-4">
                <div>
                  <h2 className="hero-title text-[28px] sm:text-4xl font-semibold text-white leading-tight">微博转发抽奖助手</h2>
                </div>
                <div className="hero-metrics grid grid-cols-3 gap-2 text-[11px] text-gray-500">
                  <div className="hard-chip px-3 py-2">
                    <div>来源</div>
                    <strong className="mt-1 block text-white text-[12px]">{sourceLabels[source]}</strong>
                  </div>
                  <div className="hard-chip px-3 py-2">
                    <div>奖项</div>
                    <strong className="mt-1 block text-white text-[12px]">{prizes.length}</strong>
                  </div>
                  <div className="hard-chip px-3 py-2">
                    <div>状态</div>
                    <strong className={`mt-1 block text-[12px] ${statusTone === 'error' ? 'status-bad' : statusTone === 'success' ? 'status-ok' : 'status-warn'}`}>
                      {isLoading ? '载入中' : isDrawing ? '开奖中' : '就绪'}
                    </strong>
                  </div>
                </div>
              </div>

              <div className="stage-wrap">
                <RollingBox isRolling={isDrawing} name={rollingName} phase={phase || '开奖中'} />
              </div>
            </section>

            <section className="glass action-panel p-5 sm:p-6">
              <div className="grid gap-3">
                <label className="grid gap-2">
                  <span className="text-[12px] text-gray-500 font-semibold">微博链接 / mid / bid</span>
                  <input value={statusUrl} onChange={(event) => { setStatusUrl(event.target.value); setCurrentStatusUrl(event.target.value); }}
                    placeholder="粘贴微博链接 / mid / bid"
                    className="input-field px-4 py-3.5 text-white placeholder-gray-600 w-full text-[15px]" />
                </label>
                <div className="action-grid grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <button onClick={loadCandidates} disabled={isLoading} className={`btn-ghost action-btn action-step px-4 py-3.5 text-gray-100 font-bold whitespace-nowrap ${hasCandidates ? 'action-step-complete' : 'action-step-current'} ${isLoading ? 'action-step-active' : ''}`}>
                    <span className="action-step-dot">1</span>
                    <span className="action-icon">{I.users}</span>
                    <span>{isLoading ? '载入中...' : '载入候选'}</span>
                  </button>
                  <button onClick={openPrizeSettings} className={`btn-ghost action-btn action-step px-4 py-3.5 text-gray-100 font-bold whitespace-nowrap ${totalSlots > 0 ? 'action-step-ready' : 'action-step-current'}`}>
                    <span className="action-step-dot">2</span>
                    <span className="action-icon">{I.gift}</span>
                    <span>填写奖项</span>
                  </button>
                  <button onClick={drawAll} disabled={isDrawing || isLoading} className={`btn-primary action-btn action-step action-btn-primary px-4 py-3.5 font-bold relative z-10 breathe ${isDrawing ? 'action-step-active' : ''} ${hasResults ? 'action-step-complete' : 'action-step-current'}`}>
                    <span className="action-step-dot">3</span>
                    <span className="action-icon action-icon-primary">{I.bolt}</span>
                    <span>{isDrawing ? '抽奖中...' : isLoading ? '载入中...' : '一键开奖'}</span>
                  </button>
                  <button data-testid="hero-record-image" onClick={createShareImage} disabled={isCapturing || !hasResults} className={`btn-ghost action-btn action-step px-4 py-3.5 text-gray-100 font-bold whitespace-nowrap ${hasResults ? 'action-step-current' : 'action-step-muted'}`}>
                    <span className="action-step-dot">4</span>
                    <span className="action-icon">{I.image}</span>
                    <span>{isCapturing ? '生成中' : '记录图'}</span>
                  </button>
                </div>
              </div>

              {progress && (
                <div className="glass p-3 mt-4">
                  <div className="flex items-center justify-between text-[12px] text-gray-400 mb-2">
                    <span className="truncate">{progress.message || '处理中'}</span>
                    <strong className="text-[#007aff]">{Math.round(progress.percent || 0)}%</strong>
                  </div>
                  <div className="h-2 rounded-full bg-white/[0.05] overflow-hidden">
                    <div className="h-full rounded-full bg-gradient-to-r from-[#007aff] via-[#5ac8fa] to-[#30d158] transition-all" style={{ width: `${Math.max(0, Math.min(100, Number(progress.percent || 0)))}%` }} />
                  </div>
                </div>
              )}

              <div className="hero-stats mt-5 grid grid-cols-3 gap-2">
                <StatCard value={displayPool.length} label="可抽人数" gradient="from-[#007aff] to-[#5ac8fa]" delay="d1" />
                <StatCard value={totalSlots} label="中奖名额" gradient="from-[#5ac8fa] to-[#30d158]" delay="d2" />
                <StatCard value={drawCount ?? 0} label="本链接已抽" gradient="from-[#5e5ce6] to-[#007aff]" delay="d3" />
              </div>

              <div className={`status-line mt-4 text-[13px] ${statusTone === 'error' ? 'status-bad' : statusTone === 'success' ? 'status-ok' : 'text-gray-500'}`}>
                {status}
              </div>
            </section>

            <section className="glass pool-stats-panel p-4">
              <div className="pool-stats-grid grid grid-cols-4 gap-2">
                <StatCard value={candidates.length} label="候选" gradient="from-[#007aff] to-[#5ac8fa]" delay="d1" />
                <StatCard value={eligible.length} label="可抽" gradient="from-[#5ac8fa] to-[#30d158]" delay="d2" />
                <StatCard value={duplicateCount} label="去重" gradient="from-[#5e5ce6] to-[#007aff]" delay="d2" />
                <StatCard value={winners.length} label="中奖" gradient="from-[#30d158] to-[#ff9f0a]" delay="d3" />
              </div>
              {isDrawing && <div className="mt-3 text-[12px] text-[#007aff] truncate">{phase || '开奖中'} {rollingName ? `：${rollingName}` : ''}</div>}
            </section>

            {results.length > 0 && (
              <section className="share-capture glass p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <h3 className="text-base font-semibold text-white flex items-center gap-2"><span className="text-[#007aff]">{I.trophy}</span> 中奖结果</h3>
                  <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2">
                    <button onClick={saveResult} className="btn-ghost px-3 py-2 rounded-xl text-[12px] text-gray-300 font-semibold flex items-center gap-1.5">{I.save} 保存</button>
                    <button onClick={copyWinnerMentions} className="btn-ghost px-3 py-2 rounded-xl text-[12px] text-gray-300 font-semibold flex items-center gap-1.5">{I.copy} @名单</button>
                    <button onClick={copyWinnerPost} className="btn-ghost px-3 py-2 rounded-xl text-[12px] text-gray-300 font-semibold flex items-center gap-1.5">{I.copy} 文案</button>
                    <button data-testid="results-record-image" onClick={createShareImage} disabled={isCapturing} className="btn-ghost px-3 py-2 rounded-xl text-[12px] text-gray-300 font-semibold flex items-center gap-1.5">{I.image} {isCapturing ? '生成中' : '开奖记录图'}</button>
                    <button onClick={() => download('weibo-winners.csv', toCsv(winners))} className="btn-ghost px-3 py-2 rounded-xl text-[12px] text-gray-300 font-semibold flex items-center gap-1.5">{I.download} CSV</button>
                  </div>
                </div>
                {results.map((item, index) => <PrizeCard key={index} prize={item.prize} winners={item.winners} isNew={true} index={index} />)}
                {recordImageUrl && (
                  <div className="glass p-3 border border-white/[0.06]">
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <div>
                        <div className="text-[13px] text-white font-semibold">开奖记录图预览</div>
                        <div className="text-[11px] text-gray-500">含中奖名单、候选统计、公开种子与可抽池摘要</div>
                      </div>
                      <button onClick={() => downloadUrl(recordImageName || `weibo-draw-record-${Date.now()}.png`, recordImageUrl)} className="btn-ghost px-3 py-2 rounded-xl text-[12px] text-gray-300 font-semibold flex items-center gap-1.5">{I.download} 保存图片</button>
                    </div>
                    <img src={recordImageUrl} alt="开奖记录图预览" className="w-full rounded-xl border border-white/[0.06]" />
                  </div>
                )}
              </section>
            )}

            <section className="glass list-panel p-5">
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">{I.users} 候选列表</h3>
              <div className="max-h-72 overflow-y-auto space-y-1.5">
                {displayPool.length ? displayPool.slice(0, 160).map((candidate, index) => (
                  <div key={candidate.id || index} className="candidate-row flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-[13px] text-gray-200 font-medium truncate">{candidate.screenName || candidate.uid || `候选人 ${index + 1}`}</div>
                      <div className="text-[11px] text-gray-600 truncate">{candidate.text || candidate.uid || candidate.source}</div>
                    </div>
                    <span className="text-[10px] text-gray-500 bg-white/[0.04] rounded-full px-2 py-0.5">{candidate.source || 'manual'}</span>
                  </div>
                )) : (
                  <EmptyState icon={I.users} title="候选名单为空" detail="载入微博转发后，候选用户会按可抽规则显示在这里。" />
                )}
              </div>
              {displayPool.length > 0 && (
                <button onClick={() => download('eligible-candidates.csv', toCsv(displayPool.map((item) => ({ tier: '', ...item }))))} className="mt-3 btn-ghost px-4 py-2 rounded-xl text-[12px] text-gray-300 font-semibold flex items-center gap-1.5">{I.download} 导出候选 CSV</button>
              )}
            </section>
          </div>

          <aside className="lg:col-span-2 space-y-5">
            <section className="glass p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">{I.settings} 数据源</h3>
                <span className="hard-chip text-[11px] text-[#007aff] px-2 py-0.5">{sourceLabels[source]}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 mb-3">
                {[
                  ['mobile', 'H5', '推荐'],
                  ['manual', '导入', '每行一人'],
                  ['official', '官方', 'token'],
                ].map(([value, label, desc]) => (
                  <button key={value} onClick={() => { setSource(value); clearResult(); }}
                      className={`p-3 text-left border transition rounded-lg ${source === value ? 'border-[#007aff]/40 bg-[#007aff]/10 text-white' : 'border-white/[0.06] bg-white/[0.03] text-gray-500 hover:text-white'}`}>
                    <div className="text-[13px] font-bold">{label}</div>
                    <div className="text-[10px] opacity-70 mt-0.5">{desc}</div>
                  </button>
                ))}
              </div>
              {source === 'mobile' && (
                <div className="space-y-2">
                  <textarea value={mobileCookie} onChange={(event) => setMobileCookie(event.target.value)}
                    placeholder="微博 Cookie 可不填，服务器有可用 Cookie 时会自动使用"
                    className="input-field secret-field px-3 py-2.5 text-[13px] text-white placeholder-gray-600 w-full h-20 resize-none" />
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => loadCookieStatus(true)} className="btn-ghost px-3 py-2 rounded-lg text-gray-300 text-[12px] font-medium flex items-center gap-1.5">{I.shield} 校验服务器 Cookie</button>
                    <span className="text-[11px] text-gray-600 self-center">可用 Cookie：{cookieInfo.cookieCount || 0}</span>
                  </div>
                </div>
              )}
              {source === 'official' && (
                <input value={accessToken} onChange={(event) => setAccessToken(event.target.value)}
                  type="password" placeholder="输入 access_token"
                  className="input-field px-3 py-2.5 text-[13px] text-white placeholder-gray-600 w-full" />
              )}
              {source === 'manual' && (
                <div className="space-y-2">
                  <textarea value={manualInput} onChange={(event) => setManualInput(event.target.value)}
                    placeholder="每行一位用户，支持 CSV / TSV / JSON"
                    className="input-field px-3 py-2.5 text-[13px] text-white placeholder-gray-600 w-full h-28 resize-none" />
                  <div className="flex gap-2">
                    <button onClick={loadCandidates} className="flex-1 btn-primary px-3 py-2 rounded-lg text-white text-[13px] font-medium relative z-10"><span className="relative z-10">导入并替换</span></button>
                    <button onClick={addManualNames} className="flex-1 btn-ghost px-3 py-2 rounded-lg text-gray-300 text-[13px] font-medium">追加名单</button>
                  </div>
                </div>
              )}
            </section>

            <section ref={prizeSettingsRef} className="glass p-5 scroll-mt-8">
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">{I.gift} 奖项设置</h3>
              <div className="grid grid-cols-3 gap-2 mb-3">
                <button onClick={() => { setPrizes([defaultPrize(0, 1)]); clearResult('奖项已更新，请重新开奖。'); }} className="btn-ghost rounded-xl px-2 py-2 text-[12px] text-gray-300">一等奖 1人</button>
                <button onClick={() => { setPrizes([defaultPrize(0, 3)]); clearResult('奖项已更新，请重新开奖。'); }} className="btn-ghost rounded-xl px-2 py-2 text-[12px] text-gray-300">一等奖 3人</button>
                <button onClick={() => { setPrizes([defaultPrize(0, 10)]); clearResult('奖项已更新，请重新开奖。'); }} className="btn-ghost rounded-xl px-2 py-2 text-[12px] text-gray-300">一等奖 10人</button>
              </div>
              <div className="space-y-2">
                {prizes.map((prize, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: prize.color }} />
                    <input ref={index === 0 ? firstPrizeNameRef : null} value={prize.name} onChange={(event) => { const next = [...prizes]; next[index] = { ...next[index], name: event.target.value }; setPrizes(next); clearResult('奖项已更新，请重新开奖。'); }}
                      className="input-field rounded-lg px-2.5 py-1.5 text-[13px] text-white flex-1 bg-transparent min-w-0" />
                    <input type="number" value={prize.count} min={1} onChange={(event) => { const next = [...prizes]; next[index] = { ...next[index], count: Math.max(1, parseInt(event.target.value, 10) || 1) }; setPrizes(next); clearResult('奖项已更新，请重新开奖。'); }}
                      className="input-field rounded-lg px-2 py-1.5 text-[13px] text-white w-14 text-center bg-transparent" />
                    <button onClick={() => { if (prizes.length <= 1) return; setPrizes(prizes.filter((_, i) => i !== index)); clearResult('奖项已更新，请重新开奖。'); }} disabled={prizes.length <= 1} className={`transition flex-shrink-0 ${prizes.length <= 1 ? 'text-gray-700 cursor-not-allowed' : 'text-gray-500 hover:text-[#ff375f]'}`}>{I.trash}</button>
                  </div>
                ))}
              </div>
              <button onClick={() => { setPrizes([...prizes, defaultPrize(prizes.length, 1)]); clearResult('奖项已更新，请重新开奖。'); }}
                className="mt-2.5 w-full border border-dashed border-white/[0.06] rounded-lg py-2 text-[12px] text-gray-600 hover:text-white hover:border-white/[0.12] transition flex items-center justify-center gap-1">{I.plus} 添加奖项</button>
            </section>

            <section className="glass p-5">
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">{I.shield} 筛选规则</h3>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <button onClick={() => { setKeyword(''); setMentionMin(0); clearResult('筛选规则已更新，请重新开奖。'); }} className="btn-ghost rounded-xl px-2 py-2 text-[12px] text-gray-300">不筛选</button>
                <button onClick={() => { setKeyword('抽奖'); setMentionMin(0); clearResult('筛选规则已更新，请重新开奖。'); }} className="btn-ghost rounded-xl px-2 py-2 text-[12px] text-gray-300">含“抽奖”</button>
                <button onClick={() => { setKeyword(''); setMentionMin(1); clearResult('筛选规则已更新，请重新开奖。'); }} className="btn-ghost rounded-xl px-2 py-2 text-[12px] text-gray-300">至少 @1</button>
                <button onClick={() => { setKeyword(''); setMentionMin(2); clearResult('筛选规则已更新，请重新开奖。'); }} className="btn-ghost rounded-xl px-2 py-2 text-[12px] text-gray-300">至少 @2</button>
              </div>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <input value={keyword} onChange={(event) => { setKeyword(event.target.value); clearResult('筛选规则已更新，请重新开奖。'); }} placeholder="关键词"
                  className="input-field px-3 py-2 text-[13px] text-white placeholder-gray-600" />
                <input type="number" value={mentionMin} min="0" max="10" onChange={(event) => { setMentionMin(event.target.value); clearResult('筛选规则已更新，请重新开奖。'); }}
                  className="input-field px-3 py-2 text-[13px] text-white placeholder-gray-600" />
              </div>
              <textarea value={blocklist} onChange={(event) => { setBlocklist(event.target.value); clearResult('筛选规则已更新，请重新开奖。'); }}
                placeholder="排除名单：每行一个 UID 或昵称"
                className="input-field px-3 py-2.5 text-[13px] text-white placeholder-gray-600 w-full h-20 resize-none" />
              <label className="mt-3 flex items-center gap-2 text-[13px] text-gray-400"><input type="checkbox" checked={uniqueByUser} onChange={(event) => setUniqueByUser(event.target.checked)} className="accent-[#007aff]" /> 同一用户只保留一次</label>
              <label className="mt-2 flex items-center gap-2 text-[13px] text-gray-400"><input type="checkbox" checked={excludePrevious} onChange={(event) => setExcludePrevious(event.target.checked)} className="accent-[#007aff]" /> 排除本轮已中奖用户</label>
            </section>

            <section className="glass p-5">
              <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">{I.clock} 开奖记录</h3>
              <History list={drawHistory} onClear={() => setDrawHistory([])} />
            </section>

            <section className="glass p-5">
              <h3 className="text-sm font-semibold text-white mb-3">开奖校验</h3>
              <div className="grid gap-2 text-[12px]">
                <div className="flex justify-between gap-3"><span className="text-gray-600">公开种子</span><strong className="text-gray-300 truncate">{lastAudit?.seed || '未开奖'}</strong></div>
                <div className="flex justify-between gap-3"><span className="text-gray-600">名单摘要</span><strong className="text-gray-300 truncate">{lastAudit?.candidateDigest?.slice(0, 16) || '未生成'}</strong></div>
                <div className="flex justify-between gap-3"><span className="text-gray-600">抽奖次数</span><strong className="text-gray-300 truncate">{drawCountText}</strong></div>
                <div className="text-gray-600 truncate">{drawCountMeta}</div>
              </div>
            </section>
          </aside>
        </div>
      </main>

      <footer className="glass-subtle border-t border-white/[0.03] py-4 mt-4">
        <div className="max-w-6xl mx-auto px-4 text-center">
          <p className="text-[10px] text-gray-600 tracking-wider">微博转发抽奖助手 · 公开种子 · SHA-256 洗牌</p>
        </div>
      </footer>

      {showModal && (
        <WinnerModal
          results={results}
          onClose={() => setShowModal(false)}
          onCopyNames={copyWinnerMentions}
          onCopyPost={copyWinnerPost}
          onCreateShareImage={createShareImage}
          isCapturing={isCapturing}
        />
      )}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setShowSettings(false)}>
          <div className="absolute inset-0 bg-black/70 backdrop-blur-md" />
          <div className="relative glass-elevated p-6 max-w-md w-full border border-white/[0.08] reveal" onClick={(event) => event.stopPropagation()}>
            <button onClick={() => setShowSettings(false)} className="absolute top-4 right-4 w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-gray-500 hover:text-white hover:bg-white/10 transition">{I.close}</button>
            <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">{I.settings} 快速操作</h2>
            <button onClick={() => { setCandidates([]); setResults([]); setLastPool(null); setShowSettings(false); showStatus('已清空候选和结果。'); }} className="btn-ghost px-4 py-3 rounded-xl text-gray-300 text-sm font-semibold w-full mb-2">清空候选和结果</button>
            <button onClick={() => { setMobileCookie(''); setShowSettings(false); showStatus('已清空当前输入框里的 Cookie，服务器 Cookie 池不受影响。'); }} className="btn-ghost px-4 py-3 rounded-xl text-gray-300 text-sm font-semibold w-full mb-2">清空输入框 Cookie</button>
            <label className="grid gap-2 mt-3">
              <span className="text-[12px] text-gray-500 font-semibold">后端 API 地址</span>
              <input value={apiBase} onChange={(event) => setApiBase(cleanApiBase(event.target.value))}
                placeholder="https://api.example.com"
                className="input-field px-3 py-2.5 text-[13px] text-white placeholder-gray-600 w-full" />
            </label>
            <label className="grid gap-2 mt-3">
              <span className="text-[12px] text-gray-500 font-semibold">API Key（可选）</span>
              <input value={apiKey} onChange={(event) => setApiKey(event.target.value)}
                type="password"
                placeholder="公开模式不用填写"
                className="input-field px-3 py-2.5 text-[13px] text-white placeholder-gray-600 w-full" />
            </label>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <button onClick={testApiConnection} className="btn-ghost px-3 py-2 rounded-xl text-gray-300 text-[12px] font-semibold">测试连接</button>
              <button onClick={() => { setApiBase(''); setApiKey(''); showStatus('已改回同域后端，并清空本机 API Key。'); }} className="btn-ghost px-3 py-2 rounded-xl text-gray-300 text-[12px] font-semibold">同域模式</button>
            </div>
            <button onClick={() => setShowSettings(false)} className="mt-4 btn-primary px-6 py-2.5 rounded-xl text-white font-medium relative z-10 w-full">
              <span className="relative z-10">完成</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
