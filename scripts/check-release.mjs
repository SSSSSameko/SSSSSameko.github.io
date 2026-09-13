import { fileURLToPath } from 'node:url';

import { readReleaseInfo } from './release-info.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const release = readReleaseInfo(rootDir);
process.stdout.write(`Release ${release.version} (${release.rawDate}) is synchronized.\n`);
