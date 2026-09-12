import { buildFilterSummary, DRAW_RANDOM_ALGORITHM, safeMentionName } from './appCore.js';
import { formatDateTime } from './dateTime.js';
import { drawCountCopy, normalizeDrawReceipt } from './drawReceipts.js';

export const DRAW_ANNOUNCEMENT_TEMPLATES = Object.freeze([
  { value: 'concise', label: '简洁版', hint: '奖项与获奖用户' },
  { value: 'grouped', label: '分组版', hint: '按奖项列出序号' },
  { value: 'record', label: '记录版', hint: '附时间、范围与随机规则' },
]);

function winnerName(winner, index) {
  return safeMentionName(winner?.screenName || winner?.uid) || `中奖用户 ${index + 1}`;
}

function winnerMention(winner, index) {
  const name = winnerName(winner, index);
  return name.startsWith('@') ? name : `@${name}`;
}

function drawLabel(receipt) {
  if (receipt.recordState === 'practice') return '本地演练 · 不计入开奖次数';
  if (receipt.drawNumber) {
    return drawCountCopy({
      source: receipt.source,
      count: receipt.drawNumber,
      completed: true,
    });
  }
  return '';
}

function groupedLines(receipt, numbered = false) {
  return receipt.results
    .filter((group) => group.winners.length)
    .flatMap((group) => {
      const names = group.winners.map((winner, index) => (
        numbered
          ? `${index + 1}. ${winnerMention(winner, index)}`
          : winnerMention(winner, index)
      ));
      return numbered
        ? [group.prize.name, ...names]
        : [`${group.prize.name}：${names.join(' ')}`];
    });
}

function recordDetails(receipt) {
  const filterText = receipt.rules?.filters
    ? buildFilterSummary(receipt.rules.filters)
    : '未记录';
  const label = drawLabel(receipt);
  return [
    label,
    `开奖时间：${formatDateTime(receipt.drawnAt, { fallback: '时间未记录' })}`,
    `候选范围：载入 ${receipt.candidateCount} 人 · 可抽 ${receipt.eligibleCount} 人`,
    `筛选规则：${filterText}`,
    `随机规则：${DRAW_RANDOM_ALGORITHM}`,
  ].filter(Boolean);
}

export function buildAnnouncementText(input = {}, template = 'concise') {
  const receipt = normalizeDrawReceipt(input);
  const selected = DRAW_ANNOUNCEMENT_TEMPLATES.some((item) => item.value === template)
    ? template
    : 'concise';
  const groups = groupedLines(receipt, selected === 'grouped' || selected === 'record');
  if (!groups.length) return '';

  const lines = ['微博转发抽奖结果'];
  if (selected === 'record') {
    lines.push(...recordDetails(receipt));
  } else if (selected === 'grouped' && drawLabel(receipt)) {
    lines.push(drawLabel(receipt));
  }
  lines.push('', ...groups, '', '请获奖用户留意私信。');
  if (receipt.statusUrl) lines.push('', `原微博：${receipt.statusUrl}`);
  return lines.join('\n');
}
