export function selectFilesToPrune(files, options = {}) {
  const maxFiles = Math.max(1, Number(options.maxFiles || 1));
  const maxBytes = Math.max(1, Number(options.maxBytes || 1));
  let retainedBytes = files.reduce((sum, item) => sum + Number(item.size || 0), 0);
  const removals = [];

  for (let index = files.length - 1; index >= 0; index -= 1) {
    const item = files[index];
    if (index < maxFiles && retainedBytes <= maxBytes) continue;
    removals.push(item);
    retainedBytes -= Number(item.size || 0);
  }
  return { removals, retainedBytes };
}
