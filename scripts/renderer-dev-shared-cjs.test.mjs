import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { optimizeDeps, resolveConfig } from 'vite';
import { rendererSharedCjsEntries } from './lib/renderer-shared-cjs.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('DEV admits shared contracts recursively, excluding tests, directories and symlinks', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'noted-cjs-entries-'));
  try {
    const shared = path.join(root, 'src/shared');
    mkdirSync(path.join(shared, 'nested'), { recursive: true });
    mkdirSync(path.join(shared, 'directory.cjs'));
    for (const name of ['a.cjs', 'a.test.cjs', 'a.spec.cjs', 'nested/b.cjs', 'esm.mjs']) {
      writeFileSync(path.join(shared, name), '');
    }
    symlinkSync(path.join(shared, 'a.cjs'), path.join(shared, 'alias.cjs'));
    assert.deepEqual(rendererSharedCjsEntries(root), [
      path.join(shared, 'a.cjs'), path.join(shared, 'nested/b.cjs'),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Vite optimizes actual shared CJS with named interop and transitive require', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'noted-cjs-vite-'));
  try {
    const entries = rendererSharedCjsEntries(projectRoot);
    const config = await resolveConfig({
      configFile: false,
      root: scratch,
      cacheDir: path.join(scratch, 'cache'),
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, entries: [], include: entries },
    }, 'serve');
    const metadata = await optimizeDeps(config, true);
    const entry = name => metadata.optimized[path.join(projectRoot, 'src/shared', name)];
    assert.equal(Object.keys(metadata.optimized).length, entries.length);
    assert.equal(entry('working-directory.cjs').needsInterop, true);
    assert.equal(entry('workflow-drag.cjs').needsInterop, true);
    const cwd = await import(pathToFileURL(entry('working-directory.cjs').file).href);
    assert.equal(cwd.default.resolveWorkingDirectory('~/source', '/private/home', path.posix),
      '/private/home/source');
    const drag = await import(pathToFileURL(entry('workflow-drag.cjs').file).href);
    assert.deepEqual(
      drag.default.applyDragLayout({ width: 5, height: 3 }, { width: 5, height: 3 }, { width: 7, height: 3 }),
      { width: 7, height: 3 },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

