import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { config } from 'dotenv';

// Load .env so renderer can access env vars at build time
const env = config({ path: resolve(__dirname, '.env') }).parsed || {};

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
      // Inline source maps so react-grab can symbolicate fiber._debugStack
      // back into /src/... paths inside the packaged .app. Required for
      // React 19.2 where _debugSource is gone and react-grab/bippy rely
      // on stack-based resolution via sourcemaps.
      sourcemap: 'inline',
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
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY || ''),
      // Force React to load its development build even in production builds.
      // This keeps `console.createTask` / `_debugStack` alive on React 19 so
      // react-grab can resolve component source paths inside the installed
      // .app. Build mode itself (minify, tree-shake) is unaffected — only
      // the React runtime entry switches. Acceptable here because this is
      // a local-only Electron app, not a redistributable bundle.
      'process.env.NODE_ENV': JSON.stringify('development'),
    },
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
