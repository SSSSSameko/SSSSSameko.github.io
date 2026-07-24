export function listDisplayState(items, options = {}) {
  const allItems = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Number(options.limit || 4));
  const expanded = Boolean(options.expanded);
  const total = allItems.length;
  const hiddenCount = Math.max(0, total - limit);
  return {
    items: expanded ? allItems : allItems.slice(0, limit),
    total,
    hiddenCount,
    expanded,
    canToggle: hiddenCount > 0,
    actionLabel: expanded ? '收起' : `查看更多 ${hiddenCount} 条`,
  };
}
