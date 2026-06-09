import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Local source package lives OUTSIDE mobile-web/ (../packages/claude-blocks).
// Two things are required to consume it safely:
//   1. `server.fs.allow` must include the repo root so Vite dev can read files
//      above mobile-web/.
//   2. react / react-dom MUST resolve to mobile-web's OWN copy (alias + dedupe),
//      otherwise the package — resolved from the repo root — would drag in a
//      SECOND React instance and every hook would crash with "invalid hook call".
const REPO_ROOT = resolve(__dirname, '..');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@noted/claude-blocks', replacement: resolve(REPO_ROOT, 'packages/claude-blocks/src') },
      { find: 'react', replacement: resolve(__dirname, 'node_modules/react') },
      { find: 'react-dom', replacement: resolve(__dirname, 'node_modules/react-dom') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: {
    // For local dev — proxy /api and /ws to the Electron web-server.
    // In production, the Electron main serves the built dist/ from the same
    // origin, so no proxy is needed.
    //
    // host: '0.0.0.0' is critical — default `localhost` binds 127.0.0.1 only,
    // and the phone (different IP on the LAN) cannot reach it. With 0.0.0.0
    // Vite prints both `Local: http://localhost:5180` and `Network:
    // http://<LAN-IP>:5180` in startup output — the second one is what you
    // open on the phone.
    host: '0.0.0.0',
    port: 5180,
    fs: {
      // Allow serving files from the repo root (the source package sits there).
      allow: [REPO_ROOT],
    },
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
