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
let includedOptionalPackages = 0;
let skippedOptionalPackages = 0;
let excludedPlatformOptionalPackages = 0;

const licenseFilePattern = /^(license|licence|copying|notice|thirdpartynotices)(\..*)?$/i;
const rolldownBindingPattern = /^@rolldown\/binding-/;

function isPlatformSpecificOptional(locked) {
  return locked?.optional === true && (Array.isArray(locked.os) || Array.isArray(locked.cpu));
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function isMissingPathError(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function toPortablePath(filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

for (const packagePath of Object.keys(lock.packages || {}).sort()) {
  if (!packagePath.startsWith('node_modules/')) continue;
  const locked = lock.packages[packagePath] || {};
  const isOptional = locked.optional === true;
  if (isPlatformSpecificOptional(locked)) {
    excludedPlatformOptionalPackages += 1;
    continue;
  }

  const directory = path.join(root, packagePath);
  let files;
  try {
    files = await fs.readdir(directory);
  } catch (error) {
    if (isOptional && isMissingPathError(error)) {
      skippedOptionalPackages += 1;
      continue;
    }
    failures.push(`${packagePath}: package directory is missing or unreadable`);
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
  if (isOptional) includedOptionalPackages += 1;

  const licenseFiles = files
    .filter((name) => licenseFilePattern.test(name))
    .sort((left, right) => left.localeCompare(right, 'en'));
  let fallbackLicense = null;
  if (!licenseFiles.length && rolldownBindingPattern.test(metadata.name)) {
    const fallbackPath = path.join(root, 'node_modules', 'rolldown', 'LICENSE');
    try {
      const content = normalizeText(await fs.readFile(fallbackPath, 'utf8'));
      if (!content) {
        failures.push(`${packageKey}: fallback ${toPortablePath(fallbackPath)} is empty`);
      } else {
        fallbackLicense = {
          content,
          fileName: 'LICENSE (fallback from rolldown)',
          source: toPortablePath(fallbackPath),
        };
      }
    } catch {
      failures.push(`${packageKey}: fallback node_modules/rolldown/LICENSE is missing or unreadable`);
    }
  } else if (!licenseFiles.length) {
    failures.push(`${packageKey}: no license or notice file found`);
    continue;
  }

  const notices = [];
  const licenseEntries = fallbackLicense
    ? [fallbackLicense]
    : licenseFiles.map((fileName) => ({ fileName, source: '', content: null }));
  for (const entry of licenseEntries) {
    const content = entry.content
      ?? normalizeText(await fs.readFile(path.join(directory, entry.fileName), 'utf8'));
    if (!content) {
      failures.push(`${packageKey}: ${entry.fileName} is empty`);
      continue;
    }
    notices.push(
      `### ${entry.fileName}`,
      ...(entry.source ? [
        '',
        `License text source: \`${entry.source}\`. This explicit fallback is used because \`@rolldown/binding-*\` packages do not ship a package-local license file.`,
      ] : []),
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
    ...(isOptional ? ['Release inclusion: optional npm package installed for this release platform.'] : []),
    '',
    ...notices,
  ].join('\n'));
}

if (failures.length) {
  throw new Error(`Third-party notice generation failed:\n${failures.join('\n')}`);
}
assert.ok(sections.length, 'Third-party notice generation found no installed packages. Run npm ci first.');

const notice = [
  '# Third-Party Notices for npm Packages Installed in This Release Environment',
  '',
  'Generated from package-lock.json entries whose npm package directories are actually installed in the current release environment.',
  'Optional npm packages that declare an os/cpu platform restriction are build-time native binaries: they are not distributed with the application output and are excluded so this notice stays identical on Windows, macOS and Linux.',
  'Playwright-managed browser binaries are separate release artifacts. Deployment checks for accompanying license/copying files, but this npm notice is not by itself a complete browser-binary compliance determination.',
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
  console.log(`Verified notices for ${sections.length} installed packages (${includedOptionalPackages} optional included, ${skippedOptionalPackages} optional not installed, ${excludedPlatformOptionalPackages} platform-specific optional excluded).`);
} else {
  await Promise.all(targets.map((target) => fs.writeFile(target, notice, 'utf8')));
  console.log(`Generated notices for ${sections.length} installed packages (${includedOptionalPackages} optional included, ${skippedOptionalPackages} optional not installed, ${excludedPlatformOptionalPackages} platform-specific optional excluded).`);
}
