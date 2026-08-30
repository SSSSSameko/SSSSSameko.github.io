import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const checkOnly = process.argv.includes('--check');
const sections = [];
const seen = new Set();
const failures = [];

function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

for (const packagePath of Object.keys(lock.packages || {}).sort()) {
  if (!packagePath.startsWith('node_modules/')) continue;
  const locked = lock.packages[packagePath] || {};
  if (locked.optional === true) continue;

  const directory = path.join(root, packagePath);
  let files;
  try {
    files = await fs.readdir(directory);
  } catch {
    failures.push(`${packagePath}: package directory is missing`);
    continue;
  }

  let metadata;
  try {
    metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  } catch {
    failures.push(`${packagePath}: package.json is missing or invalid`);
    continue;
  }

  const packageKey = `${metadata.name}@${metadata.version}`;
  if (seen.has(packageKey)) continue;
  seen.add(packageKey);

  const licenseFiles = files
    .filter((name) => /^(license|licence|copying|notice|thirdpartynotices)(\..*)?$/i.test(name))
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (!licenseFiles.length) {
    failures.push(`${packageKey}: no license or notice file found`);
    continue;
  }

  const notices = [];
  for (const fileName of licenseFiles) {
    const content = normalizeText(await fs.readFile(path.join(directory, fileName), 'utf8'));
    if (!content) {
      failures.push(`${packageKey}: ${fileName} is empty`);
      continue;
    }
    notices.push(
      `### ${fileName}`,
      '',
      '```text',
      content,
      '```',
      '',
    );
  }
  sections.push([
    `## ${metadata.name} ${metadata.version}`,
    `Declared license: ${metadata.license || 'See license text'}`,
    '',
    ...notices,
  ].join('\n'));
}

if (failures.length) {
  throw new Error(`Third-party notice generation failed:\n${failures.join('\n')}`);
}
assert.ok(sections.length, 'Third-party notice generation found no installed packages. Run npm ci first.');

const notice = [
  '# Third-Party Notices',
  '',
  'Generated from the non-optional package versions in package-lock.json.',
  'Optional platform-specific build binaries are not distributed with the application output and are excluded.',
  '',
  ...sections,
].join('\n');
const targets = [
  path.join(root, 'THIRD_PARTY_NOTICES.md'),
  path.join(root, 'static', 'third-party-notices.txt'),
];

if (checkOnly) {
  for (const target of targets) {
    const existing = normalizeText(await fs.readFile(target, 'utf8'));
    assert.equal(existing, normalizeText(notice), `${path.relative(root, target)} is out of date; run npm run licenses`);
  }
  console.log(`Verified notices for ${sections.length} installed packages.`);
} else {
  await Promise.all(targets.map((target) => fs.writeFile(target, notice, 'utf8')));
  console.log(`Generated notices for ${sections.length} installed packages.`);
}
