export const MAX_DRAW_WINNERS = 500;
export const MAX_DRAW_RESULT_GROUPS = 20;

export const COLORS = ['#4f9fff', '#54c6a8', '#e6ad61', '#8f93f5', '#9bd7ff', '#ee8fa1'];
const PRIZE_NAMES = ['一等奖', '二等奖', '三等奖', '幸运奖'];
export function defaultPrize(index = 0, count = 1) {
  return {
    name: PRIZE_NAMES[index] || `奖项${index + 1}`,
    count,
    color: COLORS[index % COLORS.length],
  };
}
export const DEFAULT_PRIZES = [defaultPrize(0, 1)];
