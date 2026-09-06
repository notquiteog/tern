import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The dev server proxies /api to the Express server so cookies stay same-origin.
// In production the server serves client/dist itself; there is no separate origin.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5180,
    proxy: {
      '/api': { target: process.env.TERN_API || 'http://127.0.0.1:3080', changeOrigin: false },
      '/u': { target: process.env.TERN_API || 'http://127.0.0.1:3080' },
      '/logo': { target: process.env.TERN_API || 'http://127.0.0.1:3080' },
      '/bimi': { target: process.env.TERN_API || 'http://127.0.0.1:3080' },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
