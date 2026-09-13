import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

import { readReleaseInfo } from './scripts/release-info.mjs';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const release = readReleaseInfo(rootDir);

export default defineConfig({
  plugins: [react()],
  publicDir: 'static',
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(release.version),
    __APP_UPDATE_LOGS__: JSON.stringify(release.updates),
  },
  build: {
    assetsDir: 'assets',
    sourcemap: false,
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'react';
          }
          return undefined;
        },
      },
    },
  },
});
