import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfigFromFile } from 'vite';

const configFile = fileURLToPath(new URL('../../../electron.vite.config.js', import.meta.url));
const moduleFile = fileURLToPath(new URL('../../shared/codex-native-picker-proof.cjs', import.meta.url));
const config = (await loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile)).config.renderer;

test('actual renderer serve transform loads the shared Codex picker parser as an ES module', async () => {
  const plugin = config.plugins.find(value => value.name === 'terminal-shared-contracts-dev');
  assert.ok(plugin, 'real renderer plugin must exist');
  const original = await fs.readFile(moduleFile, 'utf8');
  const transformed = await plugin.transform(original, moduleFile);
  assert.ok(transformed?.code, 'the new shared file must take the same browser transform as other shared contracts');
  const module = await import('data:text/javascript;base64,' + Buffer.from(transformed.code).toString('base64'));
  assert.equal(typeof module.default?.parseCodexModelChangeAcknowledgement, 'function');
  assert.deepEqual(module.default.parseCodexModelChangeAcknowledgement('• Model changed to gpt-5.6-luna high'), {
    model: 'gpt-5.6-luna', effort: 'high', applicationMode: 'persistent-default', proof: 'tui-model-ack',
  });
});

test('the packaged renderer uses the same explicit CommonJS admission for the shared picker parser', () => {
  assert.ok(config.build.commonjsOptions.include.some(pattern => pattern.test(moduleFile)));
});

// Discover the actual caller imports so a future shared helper cannot silently
// work in Node tests while remaining outside the browser's explicit allowlist.
async function rendererFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? rendererFiles(path.join(dir, entry.name))
    : /\.(?:js|mjs|ts|tsx)$/.test(entry.name) ? [path.join(dir, entry.name)] : []))).flat();
}
const sharedImports = new Set();
const sharedRoot = fileURLToPath(new URL('../../shared/', import.meta.url));
const callers = [...await rendererFiles(fileURLToPath(new URL('../', import.meta.url))), ...await rendererFiles(sharedRoot)];
for (const caller of callers) {
  const text = await fs.readFile(caller, 'utf8');
  for (const match of text.matchAll(/\bfrom\s+['"]([^'"\n]+\.cjs)['"]/g)) {
    const resolved = path.resolve(path.dirname(caller), match[1]);
    if (resolved.startsWith(sharedRoot)) sharedImports.add(resolved);
  }
}

test('shared module admission does not require a new filename registration and does not include main modules', async () => {
  const plugin = config.plugins.find(value => value.name === 'terminal-shared-contracts-dev');
  const futureShared = path.join(sharedRoot, 'future-browser-contract.cjs');
  const outsideShared = path.resolve(sharedRoot, '../main/future-main-module.cjs');
  const converted = await plugin.transform('module.exports = { value: 42 };', futureShared + '?import');
  assert.ok(converted?.code);
  assert.ok(config.build.commonjsOptions.include.some(pattern => pattern.test(futureShared)));
  assert.equal(await plugin.transform('module.exports = {};', outsideShared), undefined);
  assert.equal(config.build.commonjsOptions.include.some(pattern => pattern.test(outsideShared)), false);
});
assert.ok(sharedImports.has(moduleFile), 'the scan must cover the real Codex renderer import');
for (const sharedFile of [...sharedImports].sort()) {
  test('actual renderer shared import is loadable in serve and admitted in package: ' + path.basename(sharedFile), async () => {
    const plugin = config.plugins.find(value => value.name === 'terminal-shared-contracts-dev');
    const transformed = await plugin.transform(await fs.readFile(sharedFile, 'utf8'), sharedFile);
    assert.ok(transformed?.code, sharedFile + ' must be transformed for the browser');
    const loaded = await import('data:text/javascript;base64,' + Buffer.from(transformed.code).toString('base64'));
    assert.ok(loaded.default, 'CommonJS default export survives the actual transform');
    assert.ok(config.build.commonjsOptions.include.some(pattern => pattern.test(sharedFile)), sharedFile);
  });
}
