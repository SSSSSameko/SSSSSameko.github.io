import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const RETRY_DELAYS_MS = [25, 50, 100, 200, 400];
const WINDOWS_BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

// Windows readers and scanners can briefly prevent replacing an existing file.
// Retrying rename preserves atomicity: never unlink the destination to make room.
export async function replaceFileAtomically(source, destination, {
  platform = process.platform,
  renameFile = fs.rename,
  wait = delay,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(source, destination);
      return;
    } catch (error) {
      if (platform !== 'win32'
        || !WINDOWS_BUSY_CODES.has(error.code)
        || attempt >= RETRY_DELAYS_MS.length) throw error;
      await wait(RETRY_DELAYS_MS[attempt]);
    }
  }
}
