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
  server: {
    proxy: {
      '/api': {
        target: process.env.DEV_API_TARGET || 'http://127.0.0.1:4173',
        configure(proxy) {
          proxy.on('error', (_error, _request, response) => {
            if (response.headersSent || typeof response.writeHead !== 'function') return;
            response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ ok: false, error: '无法连接本地后端，请先运行 npm start；自定义端口请设置 DEV_API_TARGET。' }));
          });
        },
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(release.version),
    __APP_UPDATE_LOGS__: JSON.stringify(release.updates),
  },
  build: {
    sourcemap: false,
    rolldownOptions: {
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
