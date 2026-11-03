import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { inspectorStampVitePlugin } from './scripts/lib/inspector-stamp.mjs';
import { resolve } from 'path';
import { config } from 'dotenv';
import { assertNotedShared } from './vendor/noted-shared/build/assert-packages.mjs';
import { buildWorkflowNativeDrag } from './scripts/build-workflow-native-drag.mjs';
import { historyVirtuosoMeasurementVitePlugin } from './scripts/lib/history-virtuoso-measurement.mjs';
import { styleModSameRulesVitePlugin } from './scripts/lib/style-mod-same-rules.mjs';
import { rendererSharedCjsDevPlugin, rendererSharedCjsIds } from './scripts/lib/renderer-shared-cjs.mjs';
import { perfBuildProvenancePlugin } from './scripts/lib/perf-build-provenance.mjs';

// Load .env so renderer can access env vars at build time
const env = config({ path: resolve(__dirname, '.env') }).parsed || {};
const SHARED_ROOT = resolve(__dirname, 'vendor/noted-shared');
// Explicit opt-in for an isolated private diagnostic build only.
const privateMaps = process.env.NOTED_PRIVATE_SOURCEMAPS === '1';
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
      ...(privateMaps ? { sourcemap: 'hidden' } : {}),
      lib: {
        entry: resolve(__dirname, 'src/main/main.js'),
        formats: ['cjs']
      },
      rollupOptions: {
        ...(privateMaps ? { output: { sourcemapExcludeSources: true } } : {}),
        external: [
          'electron',
          'node-pty',
          'better-sqlite3'
        ]
      }
    },
    plugins: privateMaps ? [perfBuildProvenancePlugin('main')] : [],
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
      ...(privateMaps ? { sourcemap: 'hidden' } : {}),
      rollupOptions: {
        ...(privateMaps ? { output: { sourcemapExcludeSources: true } } : {}),
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
      ...(privateMaps ? [perfBuildProvenancePlugin('renderer')] : []),
      rendererSharedCjsDevPlugin(__dirname),
      historyVirtuosoMeasurementVitePlugin(),
      styleModSameRulesVitePlugin(),
      // Stamps data-insp-path="src/Foo.tsx:42:6:div" on every JSX element at
      // compile time, and nothing else. MUST come BEFORE react(): once JSX is
      // compiled there is no element left to stamp. Pure build-time DOM
      // injection — no Fiber, no sourcemap, no fetch — so it survives React 19
      // (_debugSource gone), Electron file://, and a packaged .app with no dev
      // server.
      //
      // The upstream `codeInspectorPlugin()` wrapper is deliberately NOT used:
      // besides stamping it injected a `code-inspector-component` client whose
      // un-throttled `mousemove` handler forced a full style+layout recalc per
      // pointer move (16 getComputedStyle per hovered node), which cost seconds
      // in a 161k-node window. The renderer half now lives in
      // `src/renderer/utils/componentInspector.ts`; this plugin also removes
      // that wrapper's :5678 TCP listener and IDE-locate options entirely.
      inspectorStampVitePlugin({ pathType: 'relative' }),
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
