import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

// No Electron, build, ASAR creation, native module or live history access.
// The real builder's collector/copy selectors stage only the parser closure.
const source = process.env.NOTED_PACKAGING_SOURCE || fileURLToPath(new URL('../', import.meta.url));
const manifestPath = process.env.NOTED_PACKAGING_MANIFEST || path.join(source, 'package.json');
const require = createRequire(path.join(source, 'package.json'));
const { createLazyProductionDeps } = require('app-builder-lib/out/util/packageDependencies');
const { getMainFileMatchers, getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher');
const { computeNodeModuleFileSets, computeFileSets, getDestinationPath } = require('app-builder-lib/out/util/appFileCopier');
const repairPackage = 'micromark-util-subtokenize';
const localFiles = ['src/main/user-message-history.js', 'src/main/history-session-resolution.js',
  'src/shared/prompt-origin.cjs', 'src/shared/composer-chips.mjs',
  'src/shared/agent-local-command.cjs', 'src/shared/pasted-content.cjs',
  'src/shared/terminal-message-reference.mjs'];

async function parserClosure() {
  const seen = new Set();
  async function visit(name) {
    if (seen.has(name)) return;
    seen.add(name);
    const pkg = JSON.parse(await fs.readFile(path.join(source, 'node_modules', name, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies || {})) await visit(dep);
  }
  await visit('unified'); await visit('remark-parse');
  return seen;
}

async function stage(destination, config, deps) {
  const info = { config, projectDir: source, buildResourcesDir: 'build-resources',
    debugLogger: { isEnabled: false }, appInfo: { type: 'commonjs' },
    getNodeDependencyInfo: () => ({ value: Promise.resolve(deps) }) };
  const platform = { info, config, platform: {}, platformSpecificBuildOptions: {} };
  const main = getMainFileMatchers(source, destination, value => value, {}, platform, path.join(source, 'release'), false);
  const modules = getNodeModuleFileMatcher(source, destination, value => value, {}, info);
  const sets = await computeNodeModuleFileSets(platform, modules);
  // Exclude root source-tree traversal; explicit named-package mappings still
  // pass through the real builder's app file walker and exclusions.
  sets.push(...await computeFileSets(main.filter(matcher => matcher.from !== source), null, platform, false));
  for (const set of sets) for (const file of set.files) {
    const stat = set.metadata.get(file);
    if (!stat?.isFile()) continue;
    const target = getDestinationPath(file, set);
    assert.ok(target.startsWith(destination + path.sep));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(file, target);
  }
  for (const file of localFiles) {
    await fs.mkdir(path.dirname(path.join(destination, file)), { recursive: true });
    await fs.copyFile(path.join(source, file), path.join(destination, file));
  }
  await fs.writeFile(path.join(destination, 'package.json'), '{"type":"commonjs"}');
}

const exercise = String.raw`
const assert = require('node:assert/strict');
const { UserMessageHistory, classifyUserMessage } = require('./src/main/user-message-history');
const SID = '00000000-0000-4000-8000-000000000001';
(async () => {
  // Quote exclusion requires the real CommonMark parser, including subtokenize.
  const text = '<saved_prompt name="Rules">body</saved_prompt>\nDo the task';
  const quoted = '> <saved_prompt name="Quoted">body</saved_prompt>\n\nDo the task';
  const values = [text, quoted];
  const turns = values.map((_, i) => ({ kind: 'user', userUuid: 'u' + i, userTimestamp: '2026-08-01T10:00:00Z' }));
  const data = { sessionId: SID, engine: 'claude', size: 1, mtimeMs: 1, turns,
    recordMap: new Map(values.map((text, i) => ['u' + i, { text }])) };
  const service = new UserMessageHistory({ listCandidates: async () => [{ sessionId: SID, provider: 'claude', createdAt: 1 }],
    loadSession: async () => data, extractText: entry => entry?.text, logger: { log() {} } });
  const result = await service.search({ project: 'fixture', query: 'Do the task' });
  assert.equal(result.messages.length, 2);
  assert.equal(result.errors.length, 0);
  assert.equal(result.coverageComplete, true);
  assert.deepEqual((await classifyUserMessage({ text, turn: turns[0] })).prompts.map(p => p.name), ['Rules']);
  assert.deepEqual((await classifyUserMessage({ text: quoted, turn: turns[1] })).prompts, []);
  const subtokenize = await import('micromark-util-subtokenize');
  assert.equal(typeof subtokenize.subtokenize, 'function');
  console.log('SEARCH_GREEN real parser / wrapper metadata / quoted-wrapper exclusion / coverage');
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

// Resolve runtime imports in every staged JS file using Node's ESM resolver.
// This tests placement as well as package presence. JSDoc-only type packages
// are deliberately omitted by builder and are not runtime import edges.
const runtimeAudit = String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
let edges = 0;
async function walk(dir) {
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) { if (item.name !== 'dev') await walk(file); continue; }
    if (!/\.(?:js|mjs)$/.test(file)) continue;
    const source = await fs.readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      const resolved = import.meta.resolve(specifier, pathToFileURL(file).href);
      if (resolved.startsWith('node:')) continue;
      const target = fileURLToPath(resolved);
      if (!target.startsWith(process.cwd() + path.sep)) throw Error('Escaped private fixture: ' + target);
      await fs.access(target); edges++;
    }
  }
}
await walk(path.join(process.cwd(), 'node_modules'));
console.log('RUNTIME_CLOSURE_GREEN edges=' + edges);
`;

test('builder selected parser closure: OLDRED misplaced dependency; configured mapping makes real search GREEN', async () => {
  const temp = await fs.mkdtemp(path.join(process.env.NOTED_PACKAGING_ARTIFACT_ROOT || os.tmpdir(), 'noted-search-closure-'));
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const selected = await parserClosure();
    // Run the actual production collector, including all original entry roots;
    // select only the parser closure after flattening so conflicts are retained.
    const all = await createLazyProductionDeps(source, null, true).value;
    const deps = all.filter(dep => selected.has(dep.name));
    const placement = all.find(dep => dep.name === 'micromark')?.conflictDependency?.find(dep => dep.name === repairPackage);
    assert.ok(placement, 'Pinned old collector must reproduce the offending nested placement');
    const oldConfig = { ...manifest.build, files: manifest.build.files.filter(rule => typeof rule === 'string' || rule.to !== 'node_modules/' + repairPackage) };
    const mapping = manifest.build.files.find(rule => typeof rule === 'object' && rule.to === 'node_modules/' + repairPackage);
    assert.ok(mapping, 'A named-package mapping must preserve the shared root dependency');
    const old = path.join(temp, 'old'), green = path.join(temp, 'green');
    await stage(old, oldConfig, deps);
    await stage(green, { ...oldConfig, files: [...oldConfig.files, mapping] }, deps);
    const lost = path.join('node_modules', repairPackage, 'package.json');
    await assert.rejects(fs.access(path.join(old, lost)), { code: 'ENOENT' });
    await fs.access(path.join(old, 'node_modules/micromark/node_modules', repairPackage, 'package.json'));
    await fs.access(path.join(green, lost));
    const before = spawnSync(process.execPath, ['-e', exercise], { cwd: old, encoding: 'utf8', timeout: 10000 });
    assert.equal(before.status, 1);
    assert.match(before.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.match(before.stderr, /micromark-util-subtokenize/);
    assert.match(before.stderr, /micromark-core-commonmark\/lib\/content.js/);
    console.log('OLDRED: actual builder placed subtokenize only below micromark; real search rejects ERR_MODULE_NOT_FOUND');
    const after = spawnSync(process.execPath, ['-e', exercise], { cwd: green, encoding: 'utf8', timeout: 10000 });
    assert.equal(after.status, 0, after.stderr);
    console.log(after.stdout.trim());
    const audit = spawnSync(process.execPath, ['--experimental-import-meta-resolve', '--input-type=module', '-e', runtimeAudit],
      { cwd: green, encoding: 'utf8', timeout: 10000 });
    assert.equal(audit.status, 0, audit.stderr);
    console.log(audit.stdout.trim());
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
