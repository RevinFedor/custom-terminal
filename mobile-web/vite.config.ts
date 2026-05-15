import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // For local dev — proxy /api and /ws to the Electron web-server.
    // In production, the Electron main serves the built dist/ from the same
    // origin, so no proxy is needed.
    port: 5180,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7878', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:7878', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
