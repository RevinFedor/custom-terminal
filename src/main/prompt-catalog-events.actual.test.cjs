'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ProjectPromptCatalogService } = require('./project-prompt-catalog');
const support = require('./project-prompt-catalog.test-support.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-events-')));
  const docs = path.join(root, 'docs'), prompt = path.join(docs, 'сообщения-обновления.prompt.md');
  const plain = path.join(docs, 'notes.md');
  fs.mkdirSync(docs); fs.writeFileSync(prompt, 'original'); fs.writeFileSync(plain, 'ordinary');
  const watches = [], changes = [], counts = { scans: 0, bodies: 0, lstats: 0 };
  const row = { rootPath: root, projectId: 'N', rootId: root, enabled: true };
  const registry = { sourcesForTab: () => [row], createSourcesReader: () => () => [row],
    listSourceScopes: () => ['T', 'U'].map(tabId => ({ id: 'tab:' + tabId, tabId })),
    read: () => ({ roots: [], version: 1, revision: 0 }) };
  const db = { getProjectById: () => ({ id: 'N', name: 'workflow' }) };
  const asyncFs = { ...fs.promises,
    opendir: async (...args) => { counts.scans++; return fs.promises.opendir(...args); },
    lstat: async (...args) => { counts.lstats++; return fs.promises.lstat(...args); } };
  const fsImpl = { ...fs, readFileSync() { counts.bodies++; throw Error('body forbidden'); },
    watch(target, options, callback) { const w = new EventEmitter(); Object.assign(w, { target, callback, options });
      w.close = () => {}; watches.push(w); return w; } };
  const service = new ProjectPromptCatalogService({ db, rootRegistry: registry, fsImpl, asyncFs,
    authorityFence: support.controlledFence(db), onChanged: event => changes.push(event) });
  t.after(() => { service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, docs, prompt, plain, service, asyncFs, changes, counts,
    watch: () => watches.find(w => w.target === docs && w.options.recursive) };
}

test('400 body-change events cannot fill the shared FS queue or permanently fail the catalog', async t => {
  const f = fixture(t); await support.tab(f.service, 'T');
  const scans = f.counts.scans, entered = gate(), release = gate(), actual = f.asyncFs.lstat;
  let reads = 0;
  f.asyncFs.lstat = async file => { if (file === f.prompt) { reads++; entered.resolve(); await release.promise; } return actual(file); };
  t.after(() => release.resolve());
  for (let i = 0; i < 400; i++) f.watch().callback('change', path.basename(f.prompt));
  await entered.promise;
  assert.ok(f.service.prepared.pool.waiting <= 1, 'one source verifier, not one worker per event');
  release.resolve();
  const value = await support.tab(f.service, 'T');
  assert.equal(value.prompts[0].path, f.prompt); assert.ok(reads <= 2);
  assert.equal(f.counts.scans, scans, 'body changes do not traverse docs');
  assert.equal(f.changes.filter(e => e.state === 'preparing').length, 1);
  assert.equal(f.service.prepared.counters.failures, 0); assert.equal(f.counts.bodies, 0);
  assert.equal(f.service.prepared.pool.rejected, 0);
});

test('too many distinct changed files use one complete preparation instead of clipping or unbounded verification jobs', async t => {
  const f = fixture(t), files = Array.from({ length: 280 }, (_, i) => path.join(f.docs, 'file-' + i + '.md'));
  for (const file of files) fs.writeFileSync(file, 'body');
  await support.tab(f.service, 'T'); const scans = f.counts.scans;
  const entered = gate(), release = gate(), actual = f.asyncFs.lstat;
  f.asyncFs.lstat = async file => { if (file === files[0]) { entered.resolve(); await release.promise; } return actual(file); };
  t.after(() => release.resolve());
  for (const file of files) f.watch().callback('change', path.basename(file));
  await entered.promise;
  assert.ok(f.service.prepared.pool.waiting <= 1); assert.equal(f.service.prepared.slots.get(f.root).contentCheck, null);
  release.resolve(); assert.equal((await support.tab(f.service, 'T')).prompts[0].path, f.prompt);
  assert.equal(f.counts.scans, scans + 1); assert.equal(f.service.prepared.pool.rejected, 0);
});

test('ordinary known-file edits and repeated warm opens do not rescan source metadata', async t => {
  const f = fixture(t); const first = await support.tab(f.service, 'T'), scans = f.counts.scans;
  fs.writeFileSync(f.plain, 'new body'); f.watch().callback('change', path.basename(f.plain));
  const next = await support.tab(f.service, 'U');
  assert.deepEqual(next.prompts.map(p => p.id), first.prompts.map(p => p.id));
  for (let i = 0; i < 8; i++) await f.service.listTab('T');
  assert.equal(f.counts.scans, scans); assert.equal(f.counts.bodies, 0);
});

test('rename during a held body verification cannot publish the old snapshot', async t => {
  const f = fixture(t); await support.tab(f.service, 'T');
  const entered = gate(), release = gate(), actual = f.asyncFs.lstat;
  f.asyncFs.lstat = async file => { if (file === f.prompt) { entered.resolve(); await release.promise; } return actual(file); };
  t.after(() => release.resolve());
  f.watch().callback('change', path.basename(f.prompt)); await entered.promise;
  fs.unlinkSync(f.prompt); f.watch().callback('rename', path.basename(f.prompt)); release.resolve();
  assert.deepEqual((await support.tab(f.service, 'T')).prompts, []);
  assert.equal(f.service.prepared.counters.failures, 0);
});

test('simultaneous warm consumers share only in-flight probes, not binding authority or cached FS results', async t => {
  const f = fixture(t); await support.tab(f.service, 'T');
  const entered = gate(), release = gate(), actual = f.asyncFs.stat;
  let rootReads = 0;
  f.asyncFs.stat = async file => { if (file === f.root) { rootReads++; entered.resolve(); await release.promise; } return actual(file); };
  t.after(() => release.resolve());
  const reads = Array.from({ length: 300 }, () => f.service.listTab('T'));
  // Attach rejection handlers immediately so the negative control is bounded.
  const settled = Promise.allSettled(reads); await entered.promise;
  assert.equal(f.service.prepared.pool.waiting, 0); assert.equal(rootReads, 1); release.resolve();
  const results = await settled; assert.ok(results.every(r => r.status === 'fulfilled'));
  // Cooperative authority yields may bring some callers to FS after release;
  // those must make fresh observations rather than use a settled result.
  assert.ok(rootReads < reads.length); const beforeLateRead = rootReads;
  await f.service.listTab('T'); assert.equal(rootReads, beforeLateRead + 1, 'no TTL/probe cache');
  await tick();
});
