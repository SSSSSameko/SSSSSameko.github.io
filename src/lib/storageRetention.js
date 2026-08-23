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

export function retainLatestLines(lines, options = {}) {
  const maxLines = Math.max(1, Number(options.maxLines || 1));
  const maxBytes = Math.max(1, Number(options.maxBytes ?? Number.MAX_SAFE_INTEGER));
  const items = (Array.isArray(lines) ? lines : [])
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .slice(-maxLines);

  while (items.length > 1 && Buffer.byteLength(`${items.join('\n')}\n`, 'utf8') > maxBytes) {
    items.shift();
  }
  return items;
}
