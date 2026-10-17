import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import * as shared from './lib/renderer-shared-cjs.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('DEV redirect is directory-scoped and preserves asset/query and build boundaries', () => {
  const plugin = shared.rendererSharedCjsDevPlugin(project);
  assert.equal(plugin.apply, 'serve');
  assert.equal(plugin.enforce, 'pre');
  assert.equal(shared.rendererSharedCjsIds(project).length, shared.rendererSharedCjsEntries(project).length);
  const importer = path.join(project, 'src/renderer/utils/workflowDragNavigation.mjs');
  const calls = [];
  const context = {resolve: async (...args) => { calls.push(args); return {id: 'optimized-result'}; }};
  return (async () => {
    for (const source of ['../../shared/workflow-drag.cjs?raw', '../../shared/workflow-drag.cjs?url',
      '../../other/workflow-drag.cjs', '../../shared/workflow-drag.test.cjs']) {
      assert.equal(await plugin.resolveId.call(context, source, importer, {}), null);
    }
    assert.equal(calls.length, 0);
    assert.deepEqual(await plugin.resolveId.call(context, '../../shared/workflow-drag.cjs?import', importer, {}),
      {id: 'optimized-result'});
    assert.equal(calls[0][0], '@noted/shared-cjs/workflow-drag.cjs');
    assert.equal(calls[0][2].skipSelf, true);
  })();
});

test('DEV rewrites actual relative CJS imports and re-exports through optimizer interop', {timeout: 25000}, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noted-relative-cjs-')));
  let server;
  try {
    for (const source of shared.rendererSharedCjsEntries(project)) {
      const destination = path.join(root, path.relative(project, source));
      await fs.mkdir(path.dirname(destination), {recursive: true});
      await fs.copyFile(source, destination);
    }
    await fs.mkdir(path.join(root, 'src/renderer/utils'), {recursive: true});
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
    await fs.writeFile(path.join(root, 'src/renderer/utils/entry.mjs'), `
      import contract, {applyDragLayout} from '../../shared/workflow-drag.cjs';
      export {dragPlacement} from '../../shared/workflow-drag.cjs?import';
      import {resolveWorkingDirectory} from '../../shared/working-directory.cjs';
      export const result = applyDragLayout({width:5}, {width:5}, {width:7});
      export const same = contract.applyDragLayout === applyDragLayout;
      export const cwd = resolveWorkingDirectory('~/safe', '/private/home', {join:(a,b)=>a+'/'+b});
    `);
    const include = shared.rendererSharedCjsIds?.(root) || shared.rendererSharedCjsEntries(root);
    server = await createServer({configFile: false, root, logLevel: 'silent',
      cacheDir: path.join(root, 'cache'),
      server: {middlewareMode: true, watch: null, ws: false, hmr: false},
      plugins: shared.rendererSharedCjsDevPlugin ? [shared.rendererSharedCjsDevPlugin(root)] : [],
      optimizeDeps: {noDiscovery: true, entries: [], include},
    });
    const transformed = await server.transformRequest('/src/renderer/utils/entry.mjs');
    assert.ok(transformed?.code);
    assert.doesNotMatch(transformed.code, /(?:from|import)\s*["'][^"']*\/src\/shared\/[^"']*\.cjs(?:\?import)?["']/,
      'browser must not import raw CJS as an ESM file (actual NEW04 bootstrap failure)');
    assert.match(transformed.code, /__vite__cjsImport/, 'Vite must perform named/default CJS interop');
    // Execute Vite's emitted ESM, changing only its browser-local import URLs
    // to the corresponding generated files. The CJS semantics are not mocked.
    const code = transformed.code.replace(/(["'])([^"']*\/cache\/deps\/[^"']+)\1/g, (_match, quote, url) => {
      const file = url.startsWith('/@fs/') ? '/' + url.slice(5) : path.join(root, url.slice(1));
      return quote + pathToFileURL(file.split('?')[0]).href + quote;
    });
    const entry = path.join(root, 'evaluated-entry.mjs');
    await fs.writeFile(entry, code);
    const actual = await import(pathToFileURL(entry).href);
    assert.deepEqual(actual.result, {width: 7});
    assert.equal(actual.same, true);
    assert.equal(actual.cwd, '/private/home/safe');
    assert.deepEqual(actual.dragPlacement({splitPanes: []}), {panes: [], centerStrips: {}, center: null, profiles: {}});
  } finally {
    await server?.close();
    await fs.rm(root, {recursive: true, force: true});
  }
});
