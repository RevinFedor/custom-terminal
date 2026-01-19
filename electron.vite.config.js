import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  main: {
    // Main process build config (using legacy main.js for now)
    build: {
      outDir: 'dist/main',
      lib: {
        entry: resolve(__dirname, 'main.js'),
        formats: ['cjs']
      },
      rollupOptions: {
        external: [
          'electron',
          'node-pty',
          'better-sqlite3',
          'fs',
          'path',
          'os',
          'crypto',
          'child_process'
        ]
      }
    }
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      lib: {
        entry: resolve(__dirname, 'src/preload/index.js'),
        formats: ['cjs']
      }
    }
  },
  renderer: {
    // Renderer process (React app)
    root: '.',
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'index.html')
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer')
      }
    }
  }
});
