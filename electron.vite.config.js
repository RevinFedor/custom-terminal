import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      lib: {
        entry: resolve(__dirname, 'src/main/main.js'),
        formats: ['cjs']
      },
      rollupOptions: {
        external: [
          'electron',
          'node-pty',
          'better-sqlite3'
        ]
      }
    },
    resolve: {
      alias: {
        './project-manager': resolve(__dirname, 'src/main/project-manager.js'),
        './session-manager': resolve(__dirname, 'src/main/session-manager.js'),
        './database': resolve(__dirname, 'src/main/database.js')
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
      },
      commonjsOptions: {
        // Ensure single React instance in bundle
        include: [/node_modules/],
        requireReturnsDefault: 'auto'
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
        // Dev: use source directly, no need to rebuild gt-editor
        '@anthropic/markdown-editor': resolve(__dirname, '../gt-editor/packages/markdown-editor/src/index.ts'),
        // Force single React instance for all packages
        'react': resolve(__dirname, 'node_modules/react'),
        'react-dom': resolve(__dirname, 'node_modules/react-dom')
      },
      dedupe: ['react', 'react-dom']
    },
    optimizeDeps: {
      include: ['react', 'react-dom']
    }
  }
});
