import { readFileSync } from 'node:fs';
import {
  PathName,
  isExcludedFile,
  isJsTypeFile,
  normalizePath,
  transformCode,
} from '@code-inspector/core';

// Build-time half of the component inspector. `code-inspector-plugin` bundles
// two unrelated things: a Babel transform that stamps `data-insp-path` on every
// JSX element (the only way to carry a file:line:col into a packaged renderer
// without a dev server) and an IIFE web component whose `mousemove` handler
// calls `getBoundingClientRect()` on the whole composed path plus 16
// `getComputedStyle()` per hovered node. With 161k DOM nodes that client costs
// seconds per pointer move, so the renderer half lives in
// `src/renderer/utils/componentInspector.ts` instead and this plugin keeps the
// stamping only: no injected client, no `code-inspector-component`, no TCP
// listener on :5678, no `locate`/`copy`/IDE options.
//
// `@code-inspector/core` stays the stamping engine on purpose: its attribute
// format (`path:line:column:tag`) is what the renderer parses, and
// `scripts/lib/inspector-private-sourcemap.mjs` patches that exact function to
// return a source map for private diagnostic builds. A transform of our own
// would fork both contracts. The package is reached through the
// `code-inspector-plugin` devDependency, which is why that dependency stays in
// package.json although its own Vite plugin is no longer used.
export const INSPECTOR_STAMP_ATTRIBUTE = PathName;

/** Files Vite hands us that can never carry JSX we own. */
export function shouldStampModule(id, { exclude } = {}) {
  if (typeof id !== 'string' || !id || id.startsWith('\0')) return false;
  const [filePath] = id.split('?', 2);
  if (!filePath || filePath.startsWith('virtual:')) return false;
  const normalized = normalizePath(filePath);
  if (!isJsTypeFile(normalized)) return false;
  // `isExcludedFile` applies the upstream `/node_modules/` rule. `vendor/` and
  // `packages/` are workspace sources reached through symlinks, so Vite already
  // resolved them to real paths outside node_modules and they stay stamped.
  if (isExcludedFile(normalized, { exclude })) return false;
  return true;
}

export function inspectorStampVitePlugin({ exclude, pathType = 'relative' } = {}) {
  return {
    name: 'noted-inspector-stamp',
    // Must run before @vitejs/plugin-react: once JSX is compiled to
    // `jsx()` calls there is no JSX element left to stamp.
    enforce: 'pre',
    async transform(code, id) {
      if (!shouldStampModule(id, { exclude })) return null;
      const filePath = normalizePath(id.split('?', 2)[0]);
      // The transform re-reads the file to decide on `code-inspector-disable`
      // headers, so a module that vanished mid-build must not throw.
      try {
        readFileSync(filePath);
      } catch {
        return null;
      }
      const result = await transformCode({
        content: code,
        filePath,
        fileType: 'jsx',
        escapeTags: [],
        pathType,
      });
      // Upstream returns a string; the private-sourcemap hook returns
      // `{ code, map }` for the same input. Both are valid Vite results.
      if (result == null) return null;
      if (typeof result === 'string') return result === code ? null : result;
      return result;
    },
  };
}
