import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { build } from 'vite';
import { inspectorStampVitePlugin, shouldStampModule } from './lib/inspector-stamp.mjs';

// Guards the BUILD half of the component inspector: every JSX element must
// carry `data-insp-path="path:line:column:tag"` in the emitted bundle, because
// that attribute is the only source location available in a packaged renderer.
// The renderer half is covered by
// `src/renderer/utils/componentInspector.actual.test.mjs`.
//
// Two upstream traps stay covered here:
//  - the removed `code-inspector-component` client (an un-throttled mousemove
//    handler, 16 getComputedStyle per hovered node) must not come back into
//    either the HTML or the JS, directly or through the plugin's entry/HTML
//    injection;
//  - `code-inspector-plugin` only honoured `server: 'close'` as a string, so a
//    stray TCP listener on :5678 kept `vite build` hanging after
//    "✓ built in Xs". Our plugin opens no socket at all, and any `listen()`
//    during the build fails this test.

const root = resolve(import.meta.dirname, '..');
const config = await readFile(join(root, 'electron.vite.config.js'), 'utf8');
assert.match(config, /inspectorStampVitePlugin\(\{ pathType: 'relative' \}\)/);
// The upstream wrapper may be named in a comment, but never imported or called.
const activeConfig = config.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n');
assert.doesNotMatch(activeConfig, /codeInspectorPlugin/);
assert.doesNotMatch(activeConfig, /from 'code-inspector-plugin'/);
// Order matters: once @vitejs/plugin-react compiles JSX there is no element to
// stamp.
const stampCall = activeConfig.indexOf('inspectorStampVitePlugin({');
const reactCall = activeConfig.indexOf('react(),');
assert.ok(stampCall > 0 && reactCall > 0 && stampCall < reactCall,
  `stamping plugin must precede react(): stamp@${stampCall}, react@${reactCall}`);

const entry = await readFile(join(root, 'src/renderer/main.tsx'), 'utf8');
assert.match(entry, /installComponentInspector\(\)/);
assert.doesNotMatch(entry, /code-inspector:trackCode/);

// Module admission: workspace sources stay stamped, dependencies and
// non-JS inputs never enter the transform.
assert.equal(shouldStampModule(join(root, 'src/renderer/App.tsx')), true);
assert.equal(shouldStampModule(join(root, 'vendor/markdown-editor/dist/index.js')), true);
assert.equal(shouldStampModule(join(root, 'packages/claude-blocks/src/Block.tsx')), true);
assert.equal(shouldStampModule(join(root, 'node_modules/react/index.js')), false);
assert.equal(shouldStampModule(join(root, 'src/renderer/styles/globals.css')), false);
assert.equal(shouldStampModule('\0virtual:module'), false);
assert.equal(shouldStampModule('virtual:nuxt:thing.tsx'), false);
assert.equal(shouldStampModule(''), false);
assert.equal(shouldStampModule(null), false);

// The fixture lives INSIDE the repo on purpose: `pathType: 'relative'` strips
// the git toplevel, so only a repo-local file proves that stamps stay relative
// and do not leak an absolute /Users/... path into the bundle.
await mkdir(join(root, 'docs/tmp'), { recursive: true });
const temp = await realpath(await mkdtemp(join(root, 'docs/tmp', 'noted-inspector-stamp-')));
const originalCwd = process.cwd();
const originalListen = net.Server.prototype.listen;
let listenCalls = 0;
net.Server.prototype.listen = function () { listenCalls++; throw new Error('unexpected TCP listener'); };
try {
  const fixture = join(temp, 'app');
  await mkdir(join(fixture, 'src'), { recursive: true });
  await writeFile(join(fixture, 'index.html'), '<html><head></head><body><script type="module" src="/src/main.tsx"></script></body></html>');
  await writeFile(join(fixture, 'src/main.tsx'), [
    'import { Child } from "./child";',
    'const node = <div className="root"><span>Hello fixture</span><Child /></div>;',
    'console.log(node);',
  ].join('\n'));
  await writeFile(join(fixture, 'src/child.tsx'), 'export const Child = () => <button type="button">Go</button>;\n');
  // A root-level `main.js` used to make the upstream plugin inject its client
  // into the HTML. Keep the trap present in the fixture.
  await writeFile(join(fixture, 'main.js'), '// incidental root artifact\n');
  process.chdir(fixture);

  const result = await build({
    configFile: false,
    root: fixture,
    logLevel: 'error',
    plugins: [inspectorStampVitePlugin({ pathType: 'relative' })],
    esbuild: { jsx: 'transform', jsxFactory: 'h' },
    build: { write: false, minify: false, reportCompressedSize: false },
  });
  const outputs = result.output;
  const html = outputs.find(chunk => chunk.fileName === 'index.html').source;
  const js = outputs.filter(chunk => chunk.type === 'chunk').map(chunk => chunk.code).join('\n');

  // A component's own root element receives the stamp as an expression
  // (`__codeInspectorProps["data-insp-path"] || "src/child.tsx:1:28:button"`)
  // so a parent can pass its own location down; plain elements get a literal.
  // Both forms end in the same `path:line:column:tag` string.
  const stamps = [...js.matchAll(/["']((?:src|docs)\/[^"']+?\.tsx:\d+:\d+:[A-Za-z][\w.-]*)["']/g)].map(match => match[1]);
  // Four JSX elements in the fixture: div, span, <Child/> and the button.
  assert.equal(stamps.length, 4, `expected four stamps, got ${stamps.length}: ${stamps.join(', ')}`);
  const relative = fixture.slice(root.length + 1);
  for (const stamp of stamps) {
    assert.ok(stamp.startsWith(`${relative}/src/`), `stamp must be repo-relative: ${stamp}`);
  }
  assert.ok(stamps.some(stamp => stamp.endsWith(':div')));
  assert.ok(stamps.some(stamp => stamp.endsWith(':Child')));
  assert.ok(stamps.some(stamp => stamp.endsWith(':button')));
  assert.match(js, /__codeInspectorProps\s*&&\s*__codeInspectorProps\[/,
    'a component root keeps the inherited-location form');
  // `pathType: 'relative'` must not leak an absolute /Users/... path.
  assert.ok(!js.includes(root), 'stamps must not carry an absolute path');

  const clientMarkers = /code-inspector-component|code-inspector:trackCode|getPropertyValue\("border-top-width"\)/;
  assert.doesNotMatch(String(html), clientMarkers, 'no inspector client in the HTML');
  assert.doesNotMatch(js, clientMarkers, 'no inspector client in the JS');
  assert.equal(listenCalls, 0);
  console.log(JSON.stringify({ stamps, listenCalls }));
  console.log('PASS: build-time stamps only; no injected client, no TCP listener');
} finally {
  net.Server.prototype.listen = originalListen;
  process.chdir(originalCwd);
  await rm(temp, { recursive: true, force: true });
}
