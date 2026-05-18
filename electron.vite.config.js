import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { codeInspectorPlugin } from 'code-inspector-plugin';
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
      rollupOptions: {
        input: {
          // Main app — keep `main` key so output stays `index.html`.
          main: resolve(__dirname, 'index.html'),
          // Global Dictation overlays — separate top-level HTML entries, each
          // loads its own React tree via the global-dictation modules. The
          // main process picks them by URL when creating the overlay windows.
          'global-dictation-chip': resolve(__dirname, 'global-dictation-chip.html'),
          'global-dictation-rec': resolve(__dirname, 'global-dictation-rec.html'),
          'global-dictation-menu': resolve(__dirname, 'global-dictation-menu.html'),
        }
      },
      commonjsOptions: {
        // Ensure single React instance in bundle
        include: [/node_modules/],
        requireReturnsDefault: 'auto'
      }
    },
    plugins: [
      // code-inspector-plugin MUST come BEFORE react() — it stamps
      // data-insp-path="src/Foo.tsx:42:6" attributes on every JSX element
      // at compile time. Works in prod via dev:()=>true override. Pure
      // build-time DOM injection — no Fiber, no sourcemap, no fetch — so
      // it survives React 19 (_debugSource gone), Electron file://, and
      // the lack of a dev server in a packaged .app.
      codeInspectorPlugin({
        bundler: 'vite',
        dev: () => true,
        // Quirk: plugin checks `server !== "close"` (string!), not boolean.
        // Passing `false` here still starts the TCP listener on :5678 and
        // hangs `vite build` because event loop never exits.
        server: 'close',
        behavior: {
          locate: false,
          copy: false, // custom formatter via `code-inspector:trackCode` event
        },
        // Shift+Opt — safe from system shortcuts (Cmd-anything conflicts
        // with paste/copy/save and triggers the inspector overlay on every
        // Cmd press, which is the wrong default UX).
        hotKeys: ['altKey', 'shiftKey'],
        pathType: 'relative',
      }),
      react(),
      tailwindcss(),
    ],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY || ''),
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
