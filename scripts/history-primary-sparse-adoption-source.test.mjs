// V52 finite SOURCE controls. Real producer/read plane/shared client/model and
// sparse planner; parsed synthetic rows, Node SQLite and in-process transport.
// Historical array poison starts AFTER the still-existing model.open decoder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import v8 from 'node:v8';
import { HistoryPrimaryRootReadModel } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import { prepareHistoryPrimarySparsePromptAdoption, historyPrimarySparsePreparedOverride,
  historyPrimarySparseCompatibilityOrdinal, selectHistoryPrimarySparsePreparedRow } from '../src/renderer/utils/historyPrimaryPromptAdoption.mjs';
const require = createRequire(import.meta.url);
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
globalThis.window = { require };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
assert(v8.getHeapStatistics().heap_size_limit <= 80 * 1024 ** 2, '64MiB old-space / bounded semi-space SOURCE control');
const time = Date.parse('2025-01-01T00:00:00Z');
const row = (uuid, content = 'other', extra = {}) => ({ role: 'user', uuid, content, timestamp: new Date(time).toISOString(), sessionId: 's', ...extra });
const local = (name, content = 'local', extra = {}) => row('local-prompt-' + name, content,
  { role: 'queued', optimisticAt: time, handoffId: name, queueStatus: 'sent', ...extra });
const isLocal = entry => entry.role === 'queued' && entry.uuid.startsWith('local-prompt-')
  || entry.role === 'rewind' && entry.uuid.startsWith('local-rewind-')
  || entry.role === 'compact-error' && entry.uuid.startsWith('local-compact-error-');
const presentation = locals => ({ localEntries: locals, liveEntries: [], liveToolResults: [],
  grouping: { enabled: false, threshold: 2, responseWork: true, expandedKeys: [] }, captionSelections: [], settingsPresentationKeys: [] });
async function withModel(entries, captured, run) {
  const fixture = await createPrimaryAddressFixture(null, { entries });
  const model = new HistoryPrimaryRootReadModel(fixture.invoke, fixture.transport);
  model.windowDiagnostic = () => {};
  try {
    await model.open({ ...fixture.payload, primaryPresentation: presentation(captured) });
    assert(model.header, 'actual model open');
    await run({ fixture, model });
  } finally { await model.close(); fixture.close(); }
}
function poison(model) {
  const original = model.view.serverMetadata.entries;
  for (const [object, key] of [[model, 'metadata'], [model.view, 'metadata'], [model.view, 'serverMetadata']])
    Object.defineProperty(object, key, { configurable: true, get() { throw new Error('POISON_HISTORICAL_ARRAY_' + key); } });
  return original;
}

test('sparse late planner replaces CURRENT locals and drops captured rows with poisoned N getters', async () => {
  const captured = local('captured', 'captured'), removed = local('removed', 'removed');
  const current = { ...captured, content: 'changed CURRENT body' };
  const late = local('late', current.content), unrelated = local('unrelated', 'genuinely late');
  await withModel([row('history')], [captured, removed], async ({ model }) => {
    const original = poison(model);
    const proof = await prepareHistoryPrimarySparsePromptAdoption(model, model.view,
      [current, late, unrelated], [captured, removed], { isLocal });
    assert(proof.isCurrent());
    assert.equal(proof.publication.replacements.length, 1);
    assert.equal(proof.publication.replacements[0].row, current);
    assert.equal(proof.publication.exclusions.length, 1);
    assert.deepEqual(proof.publication.insertions, [unrelated]);
    assert.equal(historyPrimarySparsePreparedOverride(proof.publication, proof.publication.replacements[0].ordinal), current);
    assert.equal(historyPrimarySparsePreparedOverride(proof.publication, proof.publication.exclusions[0]), false);
    const compatibility = proof.materializeCompatibility(original);
    assert(compatibility.includes(current)); assert(compatibility.includes(unrelated));
    assert(!compatibility.some(value => value.uuid === late.uuid || value.uuid === removed.uuid));
    assert(!Object.hasOwn(proof, 'entries'), 'sparse result never exposes an Np result');
    assert(!Object.hasOwn(proof.publication, 'entries'));
  });
});

test('one sparse pass reserves a matched UUID before all later local queries', async () => {
  const first = local('first', 'matches'), second = local('second', 'matches');
  await withModel([row('duplicate', 'matches'), row('duplicate', 'matches')], [], async ({ model }) => {
    const original = poison(model);
    const proof = await prepareHistoryPrimarySparsePromptAdoption(model, model.view, [first, second], [], { isLocal });
    assert.deepEqual(proof.publication.insertions, [second]);
    assert(!proof.materializeCompatibility(original).some(value => value.uuid === first.uuid));
  });
});

test('missing-only sidecars decorate every duplicate with exact publication-bound origin', async () => {
  const promptChips = [{ kind: 'prompt', text: 'FULL current chip \ud800' }], imagePaths = [{ path: '/finite/selected.png' }];
  const current = local('late', 'matches', { promptChips, imagePaths });
  await withModel([row('duplicate', 'matches'), row('duplicate', 'matches')], [], async ({ model }) => {
    const original = poison(model);
    const proof = await prepareHistoryPrimarySparsePromptAdoption(model, model.view, [current], [], { isLocal });
    const compatibility = proof.materializeCompatibility(original);
    assert.equal(compatibility.length, 2);
    for (let ordinal = 0; ordinal < compatibility.length; ordinal++) {
      assert.equal(compatibility[ordinal].promptChips, promptChips);
      assert.equal(compatibility[ordinal].imagePaths, imagePaths);
      assert.equal(historyPrimarySparseCompatibilityOrdinal(proof.publication, compatibility[ordinal]), ordinal);
      assert.equal(historyPrimarySparseCompatibilityOrdinal(proof.publication, original[ordinal]), null);
      assert(Object.keys(compatibility[ordinal]).every(key => typeof key === 'string'));
      const selected = selectHistoryPrimarySparsePreparedRow(proof.publication, ordinal, original[ordinal]);
      assert.equal(selected.promptChips, promptChips); assert.equal(selected.imagePaths, imagePaths);
      assert.equal(selected.uuid, compatibility[ordinal].uuid);
    }
    assert.equal(current.promptChips, promptChips, 'genuine CURRENT object remains untouched');
  });
});

test('CURRENT suppression reads real held content after Np metadata decoder and retains full UTF16', async () => {
  const full = 'selected \ud800 \ud83d\ude42 '.repeat(700) + 'END';
  await withModel([row('prefix', full.slice(0, -3) + 'BAD'), row('hidden', full), row('keep')], [], async ({ model }) => {
    const original = poison(model);
    assert(original.every(value => !value.content), 'thin metadata is not the matcher');
    const suppression = { text: full, since: time, until: time };
    const proof = await prepareHistoryPrimarySparsePromptAdoption(model, model.view, [], [], { isLocal, suppressions: [suppression] });
    assert.deepEqual(proof.publication.exclusions, [1]);
    assert.deepEqual(proof.materializeCompatibility(original).map(value => value.uuid), ['prefix', 'keep']);
    suppression.text += 'changed';
    assert.equal(proof.isCurrent(), false, 'original complete CURRENT suppression witness survives selected awaits');
  });
});

test('sparse TTL recovery and native object identity match existing late-local policy', async () => {
  const expired = local('expired', 'absent', { queueStatus: 'failed', statusChangedAt: time });
  const recovery = local('recovery', 'absent', { queueStatus: 'failed', applicationQueueId: 9 });
  const interrupted = local('interrupted', 'absent', { queueStatus: 'cancelled', statusReason: 'history-preparation-interrupted' });
  const rewind = row('local-rewind-r', '', { role: 'rewind' });
  await withModel([], [], async ({ model }) => {
    const original = poison(model);
    const proof = await prepareHistoryPrimarySparsePromptAdoption(model, model.view,
      [expired, recovery, interrupted, rewind], [], { isLocal });
    assert.deepEqual(proof.publication.insertions, [recovery, interrupted, rewind]);
    assert.deepEqual(proof.materializeCompatibility(original), [recovery, interrupted, rewind]);
  });
});

test('sparse CURRENT mutation and same-array membership changes revoke the original proof', async () => {
  const current = local('one', 'absent'), rows = [current];
  await withModel([row('history')], [], async ({ model }) => {
    poison(model);
    const proof = await prepareHistoryPrimarySparsePromptAdoption(model, model.view, rows, [], { isLocal });
    assert(proof.isCurrent()); current.content = 'changed'; assert.equal(proof.isCurrent(), false);
    current.content = 'absent'; rows.push(local('two')); assert.equal(proof.isCurrent(), false);
  });
});

test('CURRENT suppression keeps bigint relational grammar and fresh inherited coercion witness', async () => {
  let lower = BigInt(time);
  const since = Object.create({ [Symbol.toPrimitive](hint) { assert.equal(hint, 'number'); return lower; } });
  const suppression = { text: 'body', since, until: BigInt(time) };
  await withModel([row('hidden', 'body')], [], async ({ model }) => {
    poison(model);
    const proof = await prepareHistoryPrimarySparsePromptAdoption(model, model.view, [], [], { isLocal, suppressions: [suppression] });
    assert.deepEqual(proof.publication.exclusions, [0]); assert(proof.isCurrent());
    lower += 1n;
    assert.equal(proof.isCurrent(), false, 'unchanged object graph cannot replace fresh native coercion proof');
  });
});

test('CURRENT suppression preserves native relational errors and unused-input short circuits', async () => {
  await withModel([row('body', 'body')], [], async ({ model }) => {
    poison(model);
    await assert.rejects(prepareHistoryPrimarySparsePromptAdoption(model, model.view, [], [],
      { isLocal, suppressions: [{ text: 'body', since: Symbol('native-error'), until: time }] }), TypeError);
  });
  await withModel([], [], async ({ model }) => {
    poison(model);
    const suppression = {};
    Object.defineProperty(suppression, 'text', { get() { throw new Error('EMPTY_DOMAIN_MUST_NOT_NORMALIZE'); } });
    const proof = await prepareHistoryPrimarySparsePromptAdoption(model, model.view, [], [], { isLocal, suppressions: [suppression] });
    assert.deepEqual(proof.publication.exclusions, []); assert(proof.isCurrent());
  });
});

console.log('V52_SPARSE_BOUNDARIES ' + JSON.stringify({ node: process.version,
  heapLimit: v8.getHeapStatistics().heap_size_limit,
  poisonBegins: 'after existing model.open Np decoder',
  boundaries: ['synthetic parsed rows', 'Node SQLite', 'in-process IPC', 'window.require'],
  remaining: ['Np decoder/freeze', 'compatibility causal merge', 'native geometry/topology', 'native acceptance'] }));
