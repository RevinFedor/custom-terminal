import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { codeInspectorPlugin } from 'code-inspector-plugin';
import { resolve } from 'path';
import { config } from 'dotenv';
import { assertNotedShared } from './vendor/noted-shared/build/assert-packages.mjs';
import { buildWorkflowNativeDrag } from './scripts/build-workflow-native-drag.mjs';
import { historyVirtuosoMeasurementVitePlugin } from './scripts/lib/history-virtuoso-measurement.mjs';
import { styleModSameRulesVitePlugin } from './scripts/lib/style-mod-same-rules.mjs';
import { rendererSharedCjsDevPlugin, rendererSharedCjsIds } from './scripts/lib/renderer-shared-cjs.mjs';

// Load .env so renderer can access env vars at build time
const env = config({ path: resolve(__dirname, '.env') }).parsed || {};
const SHARED_ROOT = resolve(__dirname, 'vendor/noted-shared');
// Browser-reachable shared contracts may use CJS for the main process too.
// Renderer bundles these files; packaged main loads them through its existing
// `srcSharedDir` runtime path because static local require paths are preserved
// relative to dist/main. Admission remains a directory rule, not a filename list.
const SHARED_CJS_RE = /\/src\/shared\/[^?]+\.cjs(?:\?|$)/;

assertNotedShared({
  sharedRoot: SHARED_ROOT,
  consumerRoot: __dirname,
  consumer: 'custom-terminal',
  packages: ['structured-dnd', 'file-explorer'],
  expectedVersion: '0.2.0',
});

buildWorkflowNativeDrag();

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
      // Isolated Electron E2E leases can run beside a developer's normal
      // :5182 instance without attaching to or restarting the wrong renderer.
      host: process.env.NOTED_RENDERER_HOST || 'localhost',
      port: Number(process.env.NOTED_RENDERER_PORT || 5182),
      // Generated test workspaces can contain intentional symlink loops.
      // They are not renderer inputs and must not enter Vite's watcher.
      watch: { ignored: ['**/docs/tmp/**'] },
      fs: { allow: ['.', SHARED_ROOT] }
    },
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: {
          // Main app — keep `main` key so output stays `index.html`.
          main: resolve(__dirname, 'index.html'),
        }
      },
      commonjsOptions: {
        // Ensure single React instance in bundle
        include: [/node_modules/, SHARED_CJS_RE],
        requireReturnsDefault: 'auto'
      }
    },
    plugins: [
      rendererSharedCjsDevPlugin(__dirname),
      historyVirtuosoMeasurementVitePlugin(),
      styleModSameRulesVitePlugin(),
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
      'process.env.GEMINI_API_KEY': JSON.stringify(''),
    },
    resolve: {
      alias: [
        // Local source package — Vite компилит TSX из исходника напрямую
        // (без dist/rsync/prebundle, как обычный файл проекта). Один find
        // покрывает и бару `@noted/claude-blocks` (→ src/index.ts), и
        // `@noted/claude-blocks/styles.css` (→ src/styles.css). Ставится
        // ПЕРЕД '@' ради приоритета. React внутри пакета резолвится через
        // alias ниже → единый инстанс.
        { find: '@noted/claude-blocks', replacement: resolve(__dirname, 'packages/claude-blocks/src') },
        { find: '@noted/structured-dnd', replacement: resolve(SHARED_ROOT, 'packages/structured-dnd/src') },
        { find: '@noted/file-explorer', replacement: resolve(SHARED_ROOT, 'packages/file-explorer/src') },
        { find: '@', replacement: resolve(__dirname, 'src/renderer') },
        { find: 'react', replacement: resolve(__dirname, 'node_modules/react') },
        { find: 'react-dom', replacement: resolve(__dirname, 'node_modules/react-dom') },
        { find: 'lucide-react', replacement: resolve(__dirname, 'node_modules/lucide-react') },
        { find: 'react-icons', replacement: resolve(__dirname, 'node_modules/react-icons') }
      ],
      dedupe: ['react', 'react-dom', 'lucide-react', 'react-icons']
    },
    optimizeDeps: {
      // A source-only CJS transform exports only default and leaves relative
      // require calls unresolved. Use Vite's normal CJS interop for DEV too.
      include: ['react', 'react-dom', ...rendererSharedCjsIds(__dirname)]
    }
  }
});
