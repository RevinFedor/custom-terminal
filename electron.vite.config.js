import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
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
    server: {
      port: 5182
    },
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
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        { find: '@', replacement: resolve(__dirname, 'src/renderer') },
        { find: 'react', replacement: resolve(__dirname, 'node_modules/react') },
        { find: 'react-dom', replacement: resolve(__dirname, 'node_modules/react-dom') }
      ],
      dedupe: ['react', 'react-dom']
    },
    optimizeDeps: {
      include: ['react', 'react-dom']
    }
  }
});
