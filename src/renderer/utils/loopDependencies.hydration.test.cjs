'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const esbuild = require('esbuild');
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-wait-client-')), file = path.join(root, 'client.cjs');
  await esbuild.build({ entryPoints: [path.join(__dirname, 'loopDependencies.mjs')], outfile: file,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  let resolve, reject, changed;
  global.window = { require: () => ({ ipcRenderer: { on: (_name, cb) => { changed = cb; },
    invoke: () => new Promise((yes, no) => { resolve = yes; reject = no; }) } }) };
  t.after(() => { delete global.window; fs.rmSync(root, { recursive: true, force: true }); });
  const client = require(file);
  return { client, snapshot: value => resolve(value), fail: () => reject(Error('read unavailable')),
    event: (entry, revision) => changed(null, { entry, revision }) };
}
function entry(id, tabId, state = 'waiting') { return { id, epoch: 'E', state, source: { tabId },
  subject: { targetExecutionContext: { provider: 'codex', sessionId: 'S', turnId: 'T' } }, dependencies: [] }; }
const queue = { loopPromptEnabled: true, loopPromptMode: 'own-turn', loopPromptEpoch: 'E' };
test('initial unknown blocks, newer event wins for its operation while older snapshot restores other waits', async t => {
  const h = await fixture(t);
  assert.equal(h.client.loopDependenciesBlock('P', queue), true);
  const init = h.client.initializeLoopDependencies(); h.event(entry('A', 'P', 'released'), 2);
  h.snapshot({ version: 1, known: true, revision: 1, entries: [entry('A', 'P'), entry('B', 'Q')] }); await init;
  assert.equal(h.client.loopDependenciesBlock('P', queue), false);
  assert.equal(h.client.loopDependenciesBlock('Q', queue), true);
  h.event(entry('A', 'P'), 1); assert.equal(h.client.loopDependenciesBlock('P', queue), false);
});
test('unavailable snapshot stays unknown; OFF/other epoch cannot display or inherit an old wait', async t => {
  const h = await fixture(t), init = h.client.initializeLoopDependencies(); h.fail(); await assert.rejects(init);
  assert.equal(h.client.loopDependenciesBlock('P', queue), true);
  const second = h.client.initializeLoopDependencies(); h.snapshot({ version: 1, known: true, revision: 1, entries: [entry('A', 'P')] }); await second;
  assert.equal(h.client.loopDependencyEntry('P', { ...queue, loopPromptEnabled: false }), null);
  assert.equal(h.client.loopDependencyEntry('P', { ...queue, loopPromptEpoch: 'new' }), null);
});
