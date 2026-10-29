import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 17131,
    proxy: { '/api': { target: 'http://127.0.0.1:47822', changeOrigin: true } },
  },
});
