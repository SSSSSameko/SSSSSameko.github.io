import { readFileSync } from 'node:fs';
import path from 'node:path';

function parseReleaseDate(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(value || '').trim();
  return `${match[1]} 年 ${Number(match[2])} 月 ${Number(match[3])} 日`;
}

export function parseChangelog(markdown) {
  const releases = [];
  let current = null;
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const heading = line.match(/^##\s+([^\s·]+)\s*·\s*(.+?)\s*$/);
    if (heading) {
      current = {
        version: heading[1],
        date: parseReleaseDate(heading[2]),
        rawDate: heading[2].trim(),
        title: '',
        items: [],
      };
      releases.push(current);
      continue;
    }
    if (!current) continue;
    const title = line.match(/^###\s+(.+?)\s*$/);
    if (title) {
      current.title = title[1];
      continue;
    }
    const item = line.match(/^[-*]\s+(.+?)\s*$/);
    if (item) {
      current.items.push(item[1]);
      continue;
    }
    const description = line.trim();
    if (!current.title && description && !description.startsWith('#')) {
      current.title = description;
    }
  }
  return releases;
}

export function readReleaseInfo(rootDir) {
  const packagePath = path.join(rootDir, 'package.json');
  const changelogPath = path.join(rootDir, 'docs', 'CHANGELOG.md');
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
  const releases = parseChangelog(readFileSync(changelogPath, 'utf8'));
  const current = releases.at(-1);
  if (!current) throw new Error('docs/CHANGELOG.md 中没有找到版本记录');
  if (current.version !== metadata.version) {
    throw new Error(
      `版本不一致：package.json 为 ${metadata.version}，docs/CHANGELOG.md 最新版本为 ${current.version}`,
    );
  }
  if (!current.title) {
    throw new Error(`docs/CHANGELOG.md 的 ${current.version} 缺少版本标题`);
  }
  return {
    version: metadata.version,
    date: current.date,
    rawDate: current.rawDate,
    title: current.title,
    updates: [...releases].reverse().map((release, index) => ({
      ...release,
      label: index === 0 ? '当前版本' : '历史版本',
    })),
  };
}
