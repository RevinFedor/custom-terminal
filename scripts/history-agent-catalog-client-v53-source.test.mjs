// V53 SOURCE only: actual shared client, model, prepared owner, producer,
// read-plane and BOTH actual IPC bridges. Parsed synthetic source and private
// Node SQLite/in-process transport are named substitutes. No Mac/native run.
// node --max-old-space-size=64 --max-semi-space-size=2 --test --test-reporter=tap --test-isolation=none scripts/history-agent-catalog-client-v53-source.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { HistoryPrimaryRootReadModel } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import { createHistoryAgentCatalogCurrent } from '../src/renderer/utils/historyAgentCatalogCurrent.mjs';
import { createHistoryPrimaryAgentCatalogOwner } from '../src/renderer/utils/historyPrimaryAgentCatalogOwner.mjs';
import { historyPrimaryPromptAdoptionFingerprint } from '../src/renderer/utils/historyPrimaryPromptAdoption.mjs';
import { openHistoryAgentCatalog } from '../src/shared/history-agent-catalog-client.mjs';
import { historyPrimaryMetadataOrigin, historyPrimaryMetadataSubject,
  copyHistoryPrimaryMetadataOrigin } from '../src/renderer/utils/historyPrimaryMetadataOrigin.mjs';

const require = createRequire(import.meta.url);
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
const { HistoryRootController } = require('../src/main/history-root-engine/main/history-root-controller.js');
const { preparedPresentationBinding } = require('../src/main/history-root-engine/main/history-primary-prepared-presentation.js');
const { createHistoryAgentCatalogOracle } = require('./test-support/history-agent-catalog-oracle.cjs');
// Only the unchanged literal key/action/local predicates are needed here;
// full differential collector/liveness controls belong to the connected suite.
const nativePredicates = createHistoryAgentCatalogOracle({});
assert(getHeapStatistics().heap_size_limit <= 80 * 1024 ** 2, 'runtime64/semi2 source bound');
globalThis.window = { require };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fail = code => Object.assign(new Error(code), { code });
const encoding = 'history-primary-agent-catalog-v1';
const isFork = (channel, payload) => channel.endsWith('fork-read-leaf') && payload.encoding === encoding;
const isRelease = channel => channel.endsWith('release-read-root');
const control = { assertCurrent() {}, async checkpoint() { await tick(); } };
const row = (uuid, toolUseId = uuid, extra = {}) => ({ uuid, role: 'assistant', content: '', sessionId: 's',
  timestamp: '2026-10-27T01:00:00.000Z', actions: [{ tool: 'Task', toolUseId, description: toolUseId,
    subagentStatus: 'completed', startedAt: 1, ...extra }] });
const wire = () => ({ replacements: [], exclusions: [], insertions: [], live: [], context: {
  isTurnBusy: false, agentProcessAlive: false, currentSessionId: 's', currentProcessGeneration: 'g', chipToolType: 'codex',
  exactActiveSubagentsSlot: null, exactActiveBackgroundTasksSlot: null, terminalBackgroundTaskCallsSlot: null, terminalFactsSlot: null,
} });
const current = () => ({ wire: wire(), values: [], isCurrent: () => true,
  async drive(stage) { assert.equal(stage.header.phase, 'ready', 'historical-only fixture has no native continuation'); } });

async function rig(t, entries = [row('one')], { bridgePath } = {}) {
  const fixture = await createPrimaryAddressFixture(null, { entries });
  const calls = [], resources = [];
  let intercept, bridge, ipcDemands;
  const sender = new EventEmitter(); sender.isDestroyed = () => false;
  if (bridgePath) {
    const { createHistoryRootIpcBridge } = require(bridgePath);
    const demandPath = bridgePath.replace('history-root-ipc.js', 'history-ipc-demand.js');
    const { createHistoryIpcDemands } = require(demandPath), { currentReadControl } = require(demandPath.replace('ipc-demand', 'read-control'));
    ipcDemands = createHistoryIpcDemands();
    const controller = new HistoryRootController({ store: fixture.store,
      cache: { maxBytes: 28 * 1024 ** 2, stats: () => ({ diskBytes: 0 }) }, service: {},
      api: { projectCodexFullHistoryFromFile: async () => { throw fail('NO_SOURCE_CALL_ALLOWED'); } } });
    controller.plane = fixture.plane; controller.initializedBacking = true;
    bridge = createHistoryRootIpcBridge({ demands: ipcDemands,
      reader: { call(method, payload) {
        const options = { consumerKey: payload._historyRootConsumerKey, control: currentReadControl() };
        return method === 'openHistoryRoot' ? fixture.plane.open(payload, options)
          : controller.dispatchOwned(method, payload, options);
      }, postWorkerEvent(event) {
        if (event.event === 'release-root-consumer') controller.releaseConsumer(event.consumerKey);
        if (event.event === 'release-root-result') controller.releaseResult(event.consumerKey, event.capability);
      } } });
  }
  const forward = async (channel, payload) => {
    if (bridge) {
      if (channel.endsWith('cancel-read')) return { success: ipcDemands.cancel({ sender }, payload) };
      const method = { 'agent-transcript:get-history': 'openHistoryRoot', 'agent-transcript:read-page': 'readHistoryRootPage',
        'agent-transcript:fork-read-leaf': 'forkHistoryRootLeaf', 'agent-transcript:release-read-root': 'releaseHistoryRoot' }[channel];
      assert(method, 'only existing read-only channels');
      return bridge.run({ sender }, payload, method);
    }
    if (channel.endsWith('cancel-read')) return { success: true };
    if (isFork(channel, payload)) {
      try { return await fixture.plane.forkAgentCatalog(payload, { consumerKey: fixture.consumerKey, control }); }
      catch (error) { return { success: false, error: error.code || error.message }; }
    }
    return fixture.invoke(channel, payload);
  };
  const invoke = async (channel, payload) => {
    const call = { channel, payload }; calls.push(call);
    try { return call.response = intercept ? await intercept(channel, payload, () => forward(channel, payload)) : await forward(channel, payload); }
    catch (error) { call.error = error; throw error; }
  };
  const model = new HistoryPrimaryRootReadModel(invoke, fixture.transport);
  model.windowDiagnostic = () => {};
  t.after(async () => {
    intercept = null;
    await model.close();
    for (const resource of resources.reverse()) { try { await resource.close(); } catch {} }
    bridge?.close();
    fixture.close();
  });
  const payload = { ...fixture.payload, primaryPresentation: { localEntries: [], liveEntries: [], liveToolResults: [],
    grouping: { enabled: false, threshold: 2, responseWork: true, expandedKeys: [] }, captionSelections: [], settingsPresentationKeys: [] } };
  await model.open(payload);
  const held = model.retainPreparedPresentation(); resources.push(held);
  return { fixture, model, held, invoke, payload, calls, setIntercept(value) { intercept = value; },
    keep(value) { resources.push(value); return value; },
    async catalog() { const value = await held.openAgentCatalog(current()); resources.push(value); return value; },
  };
}

test('actual model registers immutable thin metadata provenance without a retained array registry; native clones remain CURRENT', async t => {
  const x = await rig(t, [row('one'), row('two')]);
  const entries = x.model.metadata.entries, subject = x.held.metadataSubject;
  assert(subject); assert.equal(historyPrimaryMetadataSubject(entries), subject);
  assert.equal(Object.isFrozen(entries[0]), true);
  for (const [ordinal, entry] of entries.entries()) {
    assert.deepEqual(historyPrimaryMetadataOrigin(entry), { subject, ordinal, native: false });
    assert.equal(Object.keys(entry).some(key => /origin|ordinal|subject/.test(key)), false);
  }
  const clone = { ...entries[0], promptChips: [{ value: 'original CURRENT reference' }] };
  copyHistoryPrimaryMetadataOrigin(entries[0], clone);
  assert.deepEqual(historyPrimaryMetadataOrigin(clone), { subject, ordinal: 0, native: true });
  clone.content = 'changed native field'; assert.equal(Object.isFrozen(clone), false);
  const counterfeit = {};
  for (const symbol of Object.getOwnPropertySymbols(entries[0])) Object.defineProperty(counterfeit, symbol, Object.getOwnPropertyDescriptor(entries[0], symbol));
  assert.equal(historyPrimaryMetadataOrigin(counterfeit), null, 'a copied marker is not an original same-object witness');
  await x.model.open({ ...x.payload, primaryRequestClass: 'view', primaryViewOptions: { grouping: { enabled: false }, captionSelections: [] } });
  assert.equal(x.model.metadata.entries, entries); assert.equal(x.keep(x.model.retainPreparedPresentation()).metadataSubject, subject);
});

test('actual bounded summaries do not read giant selected fields; selected detail borrows full exact UTF16 after Root/model close', async t => {
  const prompt = ('FULL\0\ud800😀' + '文'.repeat(12)).repeat(4096) + 'END';
  const x = await rig(t, [row('old-completed', 'far', { taskPrompt: prompt, result: 'rich body MUST NOT become stub precedence',
    history: [{ text: 'rich body omitted from literal stubActionSummary' }] }), row('interrupted', 'i', { subagentStatus: 'interrupted' })]);
  const catalog = await x.catalog();
  assert.equal(catalog.counts.total, 2); assert.equal(catalog.counts.completed, 1); assert.equal(catalog.counts.interrupted, 1);
  const state = x.fixture.plane.state(catalog.header, x.fixture.consumerKey);
  const root = state.agentCatalog.cursor(), promptNode = root.field('sections').field('all').at(0).field('record').field('taskPrompt');
  const promptToken = x.fixture.plane.nodeToken(state, promptNode);
  const before = x.calls.length;
  x.setIntercept((channel, payload, forward) => {
    if (channel.endsWith('read-page') && payload.kind === 'leaf' && payload.nodeToken === promptToken)
      throw fail('TEST_POISON_UNSELECTED_DETAIL');
    return forward();
  });
  const page = await catalog.readPage({ section: 'roster', limit: 1 });
  assert.equal(page.rows.length, 1); assert.equal(page.total, 2);
  assert.equal(Object.hasOwn(page.rows[0], 'taskPrompt'), false);
  assert.equal(x.calls.slice(before).some(call => isFork(call.channel, call.payload)), false);
  x.setIntercept(null);
  await x.model.close(); await x.held.close();
  assert.equal(x.fixture.plane.roots.size, 1, 'independent catalog survives both original model and held prepared retirement');
  const selected = await catalog.lookup('task:far');
  assert.equal(selected.kind, 'found'); assert.equal(selected.record.taskPrompt, prompt);
  assert.equal(selected.record.taskResult, undefined); assert.equal(selected.record.taskHistory, undefined);
  assert.equal((await catalog.lookup('task:absent')).kind, 'missing');
  assert.equal(x.calls.slice(before).some(call => call.channel.endsWith('fork-read-leaf')), false, 'selected text borrows the catalog child');
  await catalog.close(); assert.equal(catalog.releaseState, 'released'); assert.equal(x.fixture.plane.roots.size, 0);
});

test('malformed catalog receipt cannot revoke original parent or sibling; cleanup always carries captured request ID', async t => {
  const x = await rig(t), sibling = await x.catalog();
  let actual;
  x.setIntercept(async (channel, payload, forward) => {
    const result = await forward();
    if (!isFork(channel, payload)) return result;
    actual = result;
    return { ...result, ...Object.fromEntries(['leaseId','ownerKey','revision','generation'].map(key => [key, sibling.header[key]])),
      root: sibling.header.root, catalogRequestId: sibling.header.catalogRequestId };
  });
  await assert.rejects(x.held.openAgentCatalog(current()), { code: 'HISTORY_AGENT_CATALOG_HEADER' });
  await tick();
  const cleanup = x.calls.findLast(call => isRelease(call.channel) && call.payload.catalogRequestId === actual.catalogRequestId);
  assert(cleanup); assert.equal(cleanup.payload.leaseId, sibling.header.leaseId);
  assert.equal(cleanup.response.success, false); assert.equal(cleanup.response.error, 'HISTORY_AGENT_CATALOG_RELEASE_BINDING');
  assert.equal((await sibling.readPage({ section: 'roster', limit: 1 })).rows.length, 1);
  assert.equal(x.held.closed, false); assert.equal(x.model.closed, false);
  // The fixture owns the actual withheld receipt; production did not guess
  // it or falsely report successful cleanup from the malformed identity.
  x.setIntercept(null); x.fixture.plane.release(actual, { consumerKey: x.fixture.consumerKey });
});

test('cancelled allocation settles before late raw reply/cleanup ACK and retires only its own child once', async t => {
  const x = await rig(t), sibling = await x.catalog();
  const gate = deferred(), issued = deferred(); let actual, dropped = 0;
  x.setIntercept(async (channel, payload, forward) => {
    if (isFork(channel, payload)) { actual = await forward(); issued.resolve(); await gate.promise; return actual; }
    if (isRelease(channel) && payload.catalogRequestId === actual?.catalogRequestId) {
      dropped++; await forward(); return new Promise(() => {}); // raw release ACK remains UNKNOWN
    }
    return forward();
  });
  const abort = new AbortController();
  const pending = x.held.openAgentCatalog(current(), { signal: abort.signal });
  await issued.promise; abort.abort();
  await assert.rejects(pending, { code: 'HISTORY_READ_CANCELLED' });
  assert.equal(dropped, 0); assert.equal(x.fixture.plane.state(actual, x.fixture.consumerKey).released, false);
  gate.resolve(); await tick(); await tick();
  assert.equal(dropped, 1); assert.throws(() => x.fixture.plane.state(actual, x.fixture.consumerKey), { code: 'HISTORY_ROOT_RELEASED' });
  assert.equal((await sibling.lookup('task:one')).kind, 'found');
  x.setIntercept(null);
});

test('cancelled borrowed selected read does not close held catalog, sibling, Input or wait for absent raw ACK', async t => {
  const x = await rig(t), catalog = await x.catalog();
  const gate = deferred(), issued = deferred(); let blocked = false;
  x.setIntercept(async (channel, payload, forward) => {
    if (!blocked && channel.endsWith('read-page') && payload.catalogRequestId === catalog.header.catalogRequestId) {
      blocked = true; issued.resolve(); await gate.promise;
    }
    return forward();
  });
  const before = x.calls.length, abort = new AbortController();
  const pending = catalog.lookup('task:one', { signal: abort.signal });
  await issued.promise; abort.abort(); await assert.rejects(pending, { code: 'HISTORY_READ_CANCELLED' });
  assert.equal(catalog.closed, false); assert.equal(x.held.closed, false);
  assert.equal(x.calls.slice(before).some(call => isRelease(call.channel)), false);
  gate.resolve(); await tick(); x.setIntercept(null);
  assert.equal((await catalog.lookup('task:one')).kind, 'found');
});

test('release ACK mismatch stays UNKNOWN and never causes a second release attempt', async t => {
  const x = await rig(t), catalog = await x.catalog(); let attempts = 0;
  x.setIntercept(async (channel, payload, forward) => {
    if (!isRelease(channel) || payload.catalogRequestId !== catalog.header.catalogRequestId) return forward();
    attempts++; const result = await forward(); return { ...result, catalogRequestId: randomUUID() };
  });
  await assert.rejects(catalog.close(), { code: 'HISTORY_AGENT_CATALOG_RELEASE_UNKNOWN' });
  assert.equal(catalog.releaseState, 'unknown');
  await assert.rejects(catalog.close(), { code: 'HISTORY_AGENT_CATALOG_RELEASE_UNKNOWN' });
  assert.equal(attempts, 1); x.setIntercept(null);
});

for (const bridgePath of ['../src/main/history-root-ipc.js', '../src/main/history-root-engine/main/history-root-ipc.js']) {
  test('giant exact key traverses real demand/IPC/controller membership without cap or truncation: ' + bridgePath, async t => {
    const key = 'key\0\ud800' + '文'.repeat(40_000) + ':canonical:17';
    assert(Buffer.byteLength(key) > 65_536);
    const x = await rig(t, [row('giant-key-row', key)], { bridgePath });
    const catalog = await x.catalog(), wanted = 'task:' + key;
    const before = x.calls.length;
    assert.equal((await catalog.lookup(wanted)).record.key, wanted);
    assert.equal((await catalog.lookup(wanted + '!')).kind, 'missing');
    const queries = x.calls.slice(before).filter(call => call.payload.kind === 'primary-agent-catalog-membership');
    assert.equal(queries.length, 2); assert.equal(queries[0].payload.values[0], wanted);
    assert(Buffer.byteLength(JSON.stringify(queries[0].payload)) > 65_536, 'full selected input cost is explicitly unbounded');
    assert(Buffer.byteLength(JSON.stringify(queries[0].response)) < 4096, 'selected reply stays descriptor-bounded');
  });
  test('actual IPC final gate uses catalog allocation provenance; malformed Input/sibling stays protected: ' + bridgePath, async t => {
    const x = await rig(t), { createHistoryRootIpcBridge } = require(bridgePath);
    const controller = new HistoryRootController({ store: x.fixture.store,
      cache: { maxBytes: 28 * 1024 ** 2, stats: () => ({ diskBytes: 0 }) }, service: {},
      api: { projectCodexFullHistoryFromFile: async () => { throw fail('NO_SOURCE_CALL_ALLOWED'); } } });
    controller.plane = x.fixture.plane; controller.initializedBacking = true;
    const sender = new EventEmitter(); sender.isDestroyed = () => false;
    const events = [], refusal = fail('FINITE_FINAL_CONSUMER_REVOKED'); let reject = false, actual, substitute;
    // Original real read-plane lease belongs to this fixture consumer. The
    // bridge's independently generated owner key is captured and used for all
    // capabilities in this separate real-IPC chain, exactly as production.
    const bridge = createHistoryRootIpcBridge({
      reader: { async call(method, payload) {
        const options = { consumerKey: payload._historyRootConsumerKey, control };
        if (method === 'openHistoryRoot') return x.fixture.plane.open(payload, options);
        if (payload.encoding === 'history-primary-prepared-presentation-v1') return x.fixture.plane.forkPreparedPresentation(payload, options);
        actual = await x.fixture.plane.forkAgentCatalog(payload, options); return substitute || actual;
      }, postWorkerEvent(event) {
        events.push(event);
        if (event.event === 'release-root-result') {
          try { controller.releaseResult(event.consumerKey, event.capability); }
          catch (error) { events.push({ refused: error.code }); }
        } else if (event.event === 'release-root-consumer') controller.releaseConsumer(event.consumerKey);
      } },
      demands: { async run(event, payload, read) { const result = await read(payload); if (reject) throw refusal; return result; } },
    });
    t.after(() => bridge.close());
    const parent = await bridge.run({ sender }, x.payload, 'openHistoryRoot');
    const parentState = [...x.fixture.plane.roots.values()].find(state => state.leaseId === parent.leaseId);
    const owner = parentState.consumerKey;
    const inputText = x.fixture.plane.describe(parentState, parentState.primaryPresentation.sourceMetadataCursor.at(0).field('uuid'), { inline: false });
    const inputReceipt = await controller.input({ operation: 'prepare', source: inputText }, { consumerKey: owner, control });
    const existingInput = controller.documents.get(inputReceipt.inputDocument.documentId).document;
    assert.equal(existingInput.closed, false);
    const preparedRequest = { ...preparedPresentationBinding(x.fixture.plane, parentState),
      encoding: 'history-primary-prepared-presentation-v1', preparedRequestId: randomUUID() };
    const prepared = await bridge.run({ sender }, preparedRequest, 'forkHistoryRootLeaf');
    const preparedState = x.fixture.plane.state(prepared, owner);
    const request = { ...preparedPresentationBinding(x.fixture.plane, preparedState), encoding,
      catalogRequestId: randomUUID(), current: wire() };
    const sibling = await bridge.run({ sender }, request, 'forkHistoryRootLeaf');
    reject = true;
    const second = { ...request, catalogRequestId: randomUUID() };
    substitute = { ...sibling, inputDocument: inputReceipt.inputDocument };
    await assert.rejects(bridge.run({ sender }, second, 'forkHistoryRootLeaf'), error => error === refusal);
    const cleanup = events.find(event => event.event === 'release-root-result');
    assert.equal(cleanup.capability.kind, 'root'); assert.equal(cleanup.capability.catalogRequestId, second.catalogRequestId);
    assert.equal(events.at(-1).refused, 'HISTORY_AGENT_CATALOG_RELEASE_BINDING');
    assert.equal(x.fixture.plane.state(sibling, owner).released, false); assert.equal(x.fixture.plane.state(prepared, owner).released, false);
    assert.equal(events.some(event => event.capability?.kind === 'input'), false);
    assert.equal(existingInput.closed, false); assert.equal(controller.documents.has(inputReceipt.inputDocument.documentId), true);
    x.fixture.plane.release(actual, { consumerKey: owner });
    substitute = null;
    await assert.rejects(bridge.run({ sender }, { ...request, catalogRequestId: randomUUID() }, 'forkHistoryRootLeaf'), error => error === refusal);
    assert.throws(() => x.fixture.plane.state(actual, owner), { code: 'HISTORY_ROOT_RELEASED' });
    assert.equal(existingInput.closed, false, 'valid new catalog cancellation also preserves the original genuine Input document');
    bridge.close();
    assert.equal(existingInput.closed, true, 'only real consumer retirement closes its Input document');
  });
}

test('actual controller admits no-write only for authenticated ready catalog; allocating operations remain FIFO/quota class', async t => {
  const x = await rig(t), catalog = await x.catalog();
  const controller = Object.assign(Object.create(HistoryRootController.prototype), {
    plane: x.fixture.plane, store: x.fixture.store, closed: false,
  });
  const payload = { ...Object.fromEntries(['leaseId','ownerKey','revision','generation'].map(key => [key, catalog.header[key]])),
    _historyRootConsumerKey: x.fixture.consumerKey, catalogRequestId: catalog.header.catalogRequestId,
    catalogSequence: catalog.header.sequence, kind: 'primary-agent-catalog-membership', operation: 'entry', values: ['one'] };
  assert.equal(controller.installedAgentCatalogRead('readHistoryRootPage', payload), true);
  assert.equal(controller.allocates('readHistoryRootPage', payload), false);
  assert.equal(controller.allocates('forkHistoryRootLeaf', { ...payload, encoding }), true);
  assert.equal(controller.allocates('readHistoryRootPage', { ...payload, kind: 'primary-agent-catalog-step' }), true);
  for (const changed of [{ catalogRequestId: randomUUID() }, { catalogSequence: -1 }, { leaseId: x.held.header.leaseId },
    { _historyRootConsumerKey: 'foreign' }, { kind: 'unknown' }]) {
    assert.equal(controller.installedAgentCatalogRead('readHistoryRootPage', { ...payload, ...changed }), false);
    assert.equal(controller.allocates('readHistoryRootPage', { ...payload, ...changed }), true);
  }
  x.fixture.store.depth++;
  assert.equal(controller.installedAgentCatalogRead('readHistoryRootPage', payload), false);
  x.fixture.store.depth--;
});

test('active catalog request IDs are unique even across parallel allocations; no old ID registry remains after release', async t => {
  const x = await rig(t), plane = x.fixture.plane;
  const payload = { ...preparedPresentationBinding(plane, plane.state(x.held.header, x.fixture.consumerKey)),
    encoding, catalogRequestId: randomUUID(), current: wire() };
  const options = { consumerKey: x.fixture.consumerKey, control };
  const outcomes = await Promise.allSettled([plane.forkAgentCatalog(payload, options), plane.forkAgentCatalog(payload, options)]);
  const good = outcomes.filter(value => value.status === 'fulfilled');
  const bad = outcomes.filter(value => value.status === 'rejected');
  assert.equal(good.length, 1); assert.equal(bad.length, 1);
  assert.equal(bad[0].reason.code, 'HISTORY_AGENT_CATALOG_DUPLICATE_REQUEST');
  await assert.rejects(plane.forkAgentCatalog(payload, options), { code: 'HISTORY_AGENT_CATALOG_DUPLICATE_REQUEST' });
  plane.release(good[0].value, options);
  const next = await plane.forkAgentCatalog(payload, options);
  assert.equal(next.catalogRequestId, payload.catalogRequestId, 'only active IDs are checked; no historical registry');
  assert.notEqual(next.leaseId, good[0].value.leaseId);
  plane.release(next, options);
});

test('actual controller local admission uses captured catalog allocation ID for malformed receipt and synchronous retainer cancellation', async t => {
  const x = await rig(t), sibling = await x.catalog(), plane = x.fixture.plane;
  const controller = new HistoryRootController({ store: x.fixture.store,
    cache: { maxBytes: 28 * 1024 ** 2, stats: () => ({ diskBytes: 0 }) }, service: {},
    api: { projectCodexFullHistoryFromFile: async () => { throw fail('NO_SOURCE_CALL_ALLOWED'); } } });
  controller.plane = plane; controller.initializedBacking = true;
  const payload = { ...preparedPresentationBinding(plane, plane.state(x.held.header, x.fixture.consumerKey)),
    encoding, catalogRequestId: randomUUID(), current: wire(), _historyRootConsumerKey: x.fixture.consumerKey };
  const fork = plane.forkAgentCatalog; let actual;
  plane.forkAgentCatalog = async function (...args) { actual = await fork.apply(this, args); return { ...sibling.header, success: true }; };
  try {
    await assert.rejects(controller.dispatchOwned('forkHistoryRootLeaf', payload, { control }), { code: 'HISTORY_AGENT_CATALOG_BINDING' });
    assert.equal(plane.state(sibling.header, x.fixture.consumerKey).released, false);
    assert.equal(plane.state(x.held.header, x.fixture.consumerKey).released, false);
    assert.equal(controller.maintenanceMetrics.cleanupErrors, 1, 'wrong receipt stays cleanup-unknown instead of revoking sibling');
    plane.release(actual, { consumerKey: x.fixture.consumerKey });
  } finally { plane.forkAgentCatalog = fork; }
  let cleanup, attempts = 0;
  const next = { ...payload, catalogRequestId: randomUUID() };
  await assert.rejects(controller.dispatchOwned('forkHistoryRootLeaf', next, { control, retain(release) {
    cleanup = release; attempts++; release(); next.catalogRequestId = sibling.header.catalogRequestId;
  } }), { code: 'HISTORY_ROOT_RELEASED' });
  cleanup(); assert.equal(attempts, 1); assert.equal(plane.state(sibling.header, x.fixture.consumerKey).released, false);
});

test('unchecked capability objects cannot fabricate an independent catalog admission', async () => {
  await assert.rejects(openHistoryAgentCatalog({ header: {}, reader: {} }, wire()), { code: 'HISTORY_PRIMARY_PREPARED_SUBJECT_INVALID' });
});

test('sealed CURRENT slot table preserves native mutable references and rejects queued getter retargeting', async t => {
  const x = await rig(t, []), updates = [];
  let rendered = null, driver, targetSlot = -1, retarget = false, attempts = 0;
  const nativeResult = { answer: 'original native result' }, substitute = { answer: 'wrong native result' };
  const nativeRow = row('current-slot-row', 'slot-table', { result: nativeResult });
  Object.defineProperty(nativeRow.actions[0], 'description', { enumerable: true, configurable: true,
    get() {
      if (retarget) { attempts++; driver.values[targetSlot] = substitute; }
      return 'original native label';
    } });
  const rows = [nativeRow], context = wire().context;
  const originalWitness = historyPrimaryPromptAdoptionFingerprint([rows, context]);
  driver = createHistoryAgentCatalogCurrent({ recipe: { live: rows }, context,
    isLocalPromptEntry: nativePredicates.isLocalPromptEntry, isTaskAction: nativePredicates.isTaskAction,
    historyAgentKey: nativePredicates.historyAgentKey, fingerprint: historyPrimaryPromptAdoptionFingerprint });
  const owner = x.keep(createHistoryPrimaryAgentCatalogOwner({ onChange: update => updates.push(update) }));
  const drain = () => { for (const update of updates.splice(0)) rendered = update(rendered); };
  const settle = async () => {
    const stopAt = Date.now() + 30_000;
    while (owner.state().running || owner.state().pending) {
      assert(Date.now() < stopAt, 'actual owner job completed under its unchanged 30s deadline'); await tick();
    }
  };
  owner.update({ ownerKey: 'table-owner', generation: 1, prepared: x.held, current: driver,
    fullWitness: () => historyPrimaryPromptAdoptionFingerprint([rows, context]) === originalWitness,
    ownerFence: () => true });
  owner.select('task:slot-table');
  await settle(); drain();
  assert.equal(rendered.status, 'ready');
  assert.equal(rendered.selected.kind, 'found');
  assert.equal(rendered.selected.record.taskResult, nativeResult, 'actual selected decoder restores original CURRENT reference');
  assert.equal(Object.isFrozen(driver.values), true, 'only the compiler-owned slot table is sealed');
  assert.equal(Object.isFrozen(nativeResult), false, 'native payload object is not frozen');
  assert.equal(Object.isFrozen(nativeRow), false, 'native source row is not frozen');
  nativeResult.probe = 'still mutable';
  assert.equal(rendered.selected.record.taskResult.probe, 'still mutable');
  delete nativeResult.probe;
  assert.equal(historyPrimaryPromptAdoptionFingerprint([rows, context]), originalWitness, 'temporary mutability probe restored original full caller witness');
  targetSlot = driver.values.indexOf(nativeResult);
  assert(targetSlot >= 0, 'original result is a real recorded native field reference');
  assert.equal(Reflect.set(driver.values, targetSlot, substitute), false);
  owner.requestMembership({ entries: ['current-slot-row'] });
  await settle();
  assert(updates.length > 0, 'ready replacement query is queued before native getter reentry');
  retarget = true; drain(); retarget = false;
  assert.equal(attempts, 1, 'one queued replay visits the reentrant native getter and rejects its write');
  assert.equal(driver.values[targetSlot], nativeResult, 'the selected slot cannot retarget to a different native object');
  assert.equal(rendered.status, 'error'); assert.equal(rendered.errorStage, 'presentation');
  assert.equal(rendered.selected.kind, 'unknown', 'rejected proof does not claim missing');
  assert.equal(rendered.selected.record.taskResult, nativeResult, 'same-owner Inspector retains its original selected detail');
  assert.equal(x.calls.filter(call => isFork(call.channel, call.payload)).length, 1, 'query proof rejection does not allocate another historical catalog');
  owner.close(); await tick();
});

test('fresh committed snapshot proof rejects same-object native mutation and reentrant demand/input without rebuilding', async t => {
  const x = await rig(t), updates = [], trace = [];
  let rendered = null, nativeLabel = 'original label', onFull = null;
  const nativeResult = { untouchedByFold: 'original native payload' };
  const nativeRow = row('fresh-proof-row', 'fresh-proof', { result: nativeResult });
  Object.defineProperty(nativeRow.actions[0], 'description', { enumerable: true, configurable: true,
    get() { return nativeLabel; } });
  const rows = [nativeRow], context = wire().context;
  const originalWitness = historyPrimaryPromptAdoptionFingerprint([rows, context]);
  const driver = createHistoryAgentCatalogCurrent({ recipe: { live: rows }, context,
    isLocalPromptEntry: nativePredicates.isLocalPromptEntry, isTaskAction: nativePredicates.isTaskAction,
    historyAgentKey: nativePredicates.historyAgentKey, fingerprint: historyPrimaryPromptAdoptionFingerprint });
  const owner = x.keep(createHistoryPrimaryAgentCatalogOwner({ onChange: update => updates.push(update) }));
  const drain = () => { for (const update of updates.splice(0)) rendered = update(rendered); };
  const settle = async () => {
    const stopAt = Date.now() + 30_000;
    while (owner.state().running || owner.state().pending) {
      assert(Date.now() < stopAt, 'existing job remains finite'); await tick();
    }
    drain();
  };
  const originalInput = { ownerKey: 'fresh-owner', generation: 1, prepared: x.held, current: driver,
    replay() { trace.push('replay'); return driver.isCurrent(); },
    fullWitness() {
      trace.push('full'); const callback = onFull; onFull = null; callback?.();
      return historyPrimaryPromptAdoptionFingerprint([rows, context]) === originalWitness;
    },
    ownerFence() { trace.push('fence'); return true; } };
  owner.update(originalInput); owner.select('task:missing'); await settle();
  const originalSnapshot = owner.snapshot();
  assert.equal(originalSnapshot, rendered); assert.equal(originalSnapshot.status, 'ready');
  assert.equal(originalSnapshot.selected.kind, 'missing', 'initial missing evidence is actual indexed producer membership');
  trace.length = 0;
  let before = x.calls.length;
  assert.equal(owner.isCurrent(originalSnapshot), true);
  assert.equal(x.calls.length, before, 'fresh proof performs no source/selected read');
  assert(trace.indexOf('replay') >= 0 && trace.indexOf('replay') < trace.indexOf('full'));
  assert(trace.slice(trace.indexOf('full') + 1).includes('fence'), 'cheap original owner fence follows replay and FULL witness');
  assert.equal(owner.isCurrent(null), false);
  assert.equal(owner.isCurrent({ ...originalSnapshot }), false, 'identical values cannot fabricate the committed snapshot identity');
  nativeResult.untouchedByFold = 'late same-object mutation';
  trace.length = 0;
  assert.equal(driver.isCurrent(), true, 'opaque selected payload mutation requires original FULL caller witness');
  assert.equal(owner.isCurrent(originalSnapshot), false);
  assert(trace.includes('replay') && trace.includes('full'));
  assert.equal(x.calls.length, before, 'same-object mutation failure neither reads nor retries');
  nativeResult.untouchedByFold = 'original native payload';
  assert.equal(owner.isCurrent(originalSnapshot), true);
  nativeLabel = 'late stateful getter value'; trace.length = 0;
  assert.equal(owner.isCurrent(originalSnapshot), false);
  assert(trace.includes('replay')); assert.equal(trace.includes('full'), false, 'failed native replay stops before FULL proof');
  nativeLabel = 'original label';
  owner.requestPage({ section: 'roster', offset: 1, limit: 64 });
  before = x.calls.length;
  assert.equal(owner.isCurrent(originalSnapshot), false, 'page demand revokes old evidence before its pending React updater');
  assert.equal(x.calls.length, before);
  await settle(); const nextSnapshot = owner.snapshot();
  assert.notEqual(nextSnapshot, originalSnapshot); assert.equal(owner.isCurrent(originalSnapshot), false);
  assert.equal(owner.isCurrent(nextSnapshot), true);
  onFull = () => owner.select('task:one');
  assert.equal(owner.isCurrent(nextSnapshot), false, 'selection reentry during FULL witness fails repeated demand/key fence');
  await settle(); const selectedSnapshot = owner.snapshot();
  assert.equal(selectedSnapshot.selected.key, 'task:one'); assert.equal(owner.isCurrent(selectedSnapshot), true);
  onFull = () => owner.update({ ...originalInput, prepared: null, subject: {}, sourceError: fail('SOURCE_REPLACED_DURING_CLEANUP') });
  before = x.calls.length;
  assert.equal(owner.isCurrent(selectedSnapshot), false, 'same owner/generation with a new input revision cannot reuse old evidence');
  assert.equal(x.calls.length, before, 'new source error starts no historical or selected read');
  await settle(); assert.equal(owner.snapshot().status, 'error'); assert.equal(owner.snapshot().errorStage, 'source');
  assert.equal(owner.isCurrent(owner.snapshot()), false);
  assert.equal(x.calls.filter(call => isFork(call.channel, call.payload)).length, 1, 'all synchronous proof failures leave original single allocation count');
  owner.close();
  assert.equal(owner.isCurrent(selectedSnapshot), false); assert.equal(owner.isCurrent(null), false);
  await tick();
});

console.log('V53_CATALOG_CLIENT_BOUNDARIES ' + JSON.stringify({ node: process.version,
  heapLimit: getHeapStatistics().heap_size_limit, scope: 'SOURCE synthetic parsed input; actual client/model/producer/read-plane/IPC; private Node SQLite',
  pins: Object.fromEntries(['src/shared/history-root-read-client.mjs', 'src/shared/history-agent-catalog-client.mjs', 'src/renderer/utils/historyPrimaryPreparedOwner.mjs',
    'src/renderer/utils/historyPrimaryRootReadModel.mjs', 'src/renderer/utils/historyPrimaryMetadataOrigin.mjs',
    'src/renderer/utils/historyAgentCatalogCurrent.mjs', 'src/renderer/utils/historyPrimaryAgentCatalogOwner.mjs',
    'src/renderer/utils/historyPrimaryPromptAdoption.mjs', 'scripts/test-support/history-agent-catalog-oracle.cjs',
    'src/main/history-root-ipc.js', 'src/main/history-root-engine/main/history-root-ipc.js',
    'src/main/history-root-engine/main/history-root-controller.js', 'src/main/history-root-engine/main/history-primary-agent-catalog.js',
    'scripts/history-agent-catalog-client-v53-source.test.mjs']
    .map(path => [path, createHash('sha256').update(fs.readFileSync(new URL('../' + path, import.meta.url))).digest('hex')])),
  notProven: ['native Electron acceptance', 'Mac source IO', 'cold decoder retirement', 'global/RSS memory', 'native77 performance'] }));
