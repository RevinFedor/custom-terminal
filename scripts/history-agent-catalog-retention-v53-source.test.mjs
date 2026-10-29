// SOURCE WeakRef qualification with actual model/prepared/catalog/read-plane.
// Parsed synthetic source + private Node SQLite + in-process transport only.
// node --expose-gc --max-old-space-size=64 --max-semi-space-size=2 --test --test-reporter=tap --test-isolation=none scripts/history-agent-catalog-retention-v53-source.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import fs from 'node:fs';
import { HistoryPrimaryRootReadModel } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
const require = createRequire(import.meta.url);
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
assert.equal(typeof globalThis.gc, 'function', '--expose-gc is required; unobserved collection is not a pass');
assert(getHeapStatistics().heap_size_limit <= 80 * 1024 ** 2, 'runtime64/semi2 source bound');
globalThis.window = { require };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
const tick = () => new Promise(resolve => setImmediate(resolve));
const control = { assertCurrent() {}, async checkpoint() { await tick(); } };

// The fixture adapter itself has no lexical model/decoded-array binding.
function retainedInvoke(fixture) {
  return (channel, payload) => channel.endsWith('fork-read-leaf') && payload.encoding === 'history-primary-agent-catalog-v1'
    ? fixture.plane.forkAgentCatalog(payload, { consumerKey: fixture.consumerKey, control })
    : fixture.invoke(channel, payload);
}
async function detachedCatalog() {
  const fixture = await createPrimaryAddressFixture(null, { entries: [{ uuid: 'one', role: 'assistant', content: '', sessionId: 's',
    timestamp: '2026-10-27T00:00:00.000Z', actions: [{ tool: 'Task', toolUseId: 'one', description: 'one',
      subagentStatus: 'completed', startedAt: 1, taskPrompt: ('full\0\ud800😀').repeat(4096) }] }] });
  const model = new HistoryPrimaryRootReadModel(retainedInvoke(fixture), fixture.transport);
  model.windowDiagnostic = () => {};
  try {
    await model.open({ ...fixture.payload, primaryPresentation: { localEntries: [], liveEntries: [], liveToolResults: [],
      grouping: { enabled: false }, captionSelections: [], settingsPresentationKeys: [] } });
    const prepared = model.retainPreparedPresentation();
    const current = { wire: { replacements: [], exclusions: [], insertions: [], live: [], context: {
      isTurnBusy: false, agentProcessAlive: false, currentSessionId: 's', currentProcessGeneration: 'g', chipToolType: 'codex',
      exactActiveSubagentsSlot: null, exactActiveBackgroundTasksSlot: null, terminalBackgroundTaskCallsSlot: null, terminalFactsSlot: null,
    } }, values: [], isCurrent: () => true, async drive(stage) { assert.equal(stage.header.phase, 'ready'); } };
    const weak = { model: new WeakRef(model), metadata: new WeakRef(model.metadata.entries),
      metadataRow: new WeakRef(model.metadata.entries[0]), currentDriver: new WeakRef(current), recipe: new WeakRef(current.wire) };
    const reader = await prepared.openAgentCatalog(current);
    await model.close(); await prepared.close();
    assert.equal(fixture.plane.roots.size, 1);
    return { fixture, reader, weak };
  } catch (error) { await model.close(); fixture.close(); throw error; }
}
async function discardedSelection(reader) {
  const selected = await reader.lookup('task:one');
  assert.equal(selected.kind, 'found'); assert(selected.record.taskPrompt.endsWith('😀'));
  return { result: new WeakRef(selected), record: new WeakRef(selected.record) };
}
async function collect(weak) {
  let alive = [];
  for (let turn = 0; turn < 40; turn++) {
    await tick(); globalThis.gc(); await tick();
    alive = Object.keys(weak).filter(key => weak[key].deref() !== undefined);
    if (!alive.length) return;
  }
  assert.deepEqual(alive, [], 'retained catalog must not retain retired native arrays/model/driver or previous selected result');
}

test('held catalog survives while original model, Np graph, transient driver/recipe and discarded selected records collect', async t => {
  const x = await detachedCatalog();
  t.after(async () => { await x.reader.close(); x.fixture.close(); });
  await collect(x.weak);
  const selected = await discardedSelection(x.reader);
  await collect(selected);
  assert.equal((await x.reader.readPage({ section: 'roster', limit: 1 })).rows[0].key, 'task:one');
  assert.equal(x.reader.closed, false);
  assert.equal(x.fixture.plane.roots.size, 1);
});

console.log('V53_RETENTION_SOURCE_BOUNDARIES ' + JSON.stringify({ node: process.version,
  heapLimit: getHeapStatistics().heap_size_limit, gc: 'explicit --expose-gc; 40 finite opportunities; WeakRefs asserted dead',
  scope: 'actual source model/prepared/catalog; in-process synthetic fixture; not native acceptance/global memory',
  pins: Object.fromEntries(['src/shared/history-root-read-client.mjs', 'src/shared/history-agent-catalog-client.mjs',
    'src/renderer/utils/historyPrimaryPreparedOwner.mjs', 'src/renderer/utils/historyPrimaryRootReadModel.mjs',
    'src/renderer/utils/historyPrimaryMetadataOrigin.mjs', 'src/main/history-root-engine/main/history-primary-agent-catalog.js',
    'src/main/history-root-engine/main/history-root-read-plane.js', 'scripts/history-agent-catalog-retention-v53-source.test.mjs']
    .map(path => [path, createHash('sha256').update(fs.readFileSync(new URL('../' + path, import.meta.url))).digest('hex')])) }));
