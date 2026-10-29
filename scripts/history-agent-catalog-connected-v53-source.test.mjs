// V53 SOURCE-only connected controls. Real paged producer/read-plane/shared
// client/Root model/prepared owner/native driver; synthetic canonical fixture
// and in-process bridge. No Mac, Electron paint, provider, user DB or latency
// acceptance. Native rows are passed by original reference, never JSON cloned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import { HistoryPrimaryRootReadModel } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import { createHistoryAgentCatalogCurrent, createHistoryAgentCatalogMainFact, createHistoryAgentCatalogMainFactsMap } from '../src/renderer/utils/historyAgentCatalogCurrent.mjs';
import { createHistoryAgentCatalogSourceOwner } from '../src/renderer/utils/historyAgentCatalogSourceOwner.mjs';
import { createHistoryPrimaryAgentCatalogOwner } from '../src/renderer/utils/historyPrimaryAgentCatalogOwner.mjs';
import { buildHistoryLivePresentation } from '../src/renderer/utils/historyLiveProjection.mjs';
import { isHistoryTaskChipLive } from '../src/renderer/utils/historyBackgroundLiveness.mjs';
import { isHistoryBackgroundTaskLive } from '../src/renderer/utils/historyProcessLiveness.mjs';
import { agentRow, taskAction, catalogScope, literalCatalog, farHistoryFixture,
  fullNativeFixture, nativeGrammarFixture } from './test-support/history-agent-catalog-fixtures.mjs';

const require = createRequire(import.meta.url);
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
const { createHistoryAgentCatalogOracle } = require('./test-support/history-agent-catalog-oracle.cjs');
const { projectNativeRewindPreview } = require('../src/main/history-root-engine/main/history-primary-compat/src/renderer/utils/historyRewindPreviewOwner.ts.cjs');
const oracle = createHistoryAgentCatalogOracle({ isHistoryTaskChipLive, isHistoryBackgroundTaskLive, projectNativeRewindPreview });
globalThis.window = { require };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
assert(getHeapStatistics().heap_size_limit <= 80 * 1024 ** 2, 'old-space64/semi-space2 runtime fixture cap');
for (const path of ['src/main/history-root-engine/main/history-primary-agent-catalog.js',
  'src/shared/history-agent-catalog-client.mjs', 'src/renderer/utils/historyAgentCatalogCurrent.mjs',
  'src/renderer/utils/historyPrimaryPreparedOwner.mjs']) {
  const bytes = readFileSync(new URL('../' + path, import.meta.url));
  console.log('[V53_CONNECTED_SOURCE_PIN] ' + JSON.stringify({ path, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }));
}

async function connected(entries = []) {
  const fixture = await createPrimaryAddressFixture(null, { entries, sessionId: 'session' });
  const allocations = [], ready = [], retained = [], models = [];
  const invoke = async (channel, payload) => {
    let result;
    if (channel === 'agent-transcript:fork-read-leaf' && payload.encoding === 'history-primary-agent-catalog-v1') {
      allocations.push(payload);
      try { result = await fixture.plane.forkAgentCatalog(payload, { consumerKey: fixture.consumerKey,
        control: { assertCurrent() {}, async checkpoint() { await new Promise(resolve => setImmediate(resolve)); } } }); }
      catch (error) { fixture.errors.push(error); console.error('[V53_CATALOG_PRODUCER_ERROR]', error);
        result = { success: false, error: error.code || error.message }; }
    } else result = await fixture.invoke(channel, payload);
    if (result?.readProfile === 'history-agent-catalog-v1' && result.phase === 'ready') ready.push(result);
    return result;
  };
  const openModel = async (overrides = {}) => {
    const model = new HistoryPrimaryRootReadModel(invoke, fixture.transport);
    models.push(model); model.windowDiagnostic = () => {};
    await model.open({ ...fixture.payload, primaryPresentation: { localEntries: [], liveEntries: [], liveToolResults: [],
      grouping: { enabled: false, threshold: 2, responseWork: true, expandedKeys: [] },
      captionSelections: [], settingsPresentationKeys: [], ...overrides } });
    assert(model.view?.prepared, 'actual Root registration produced independent prepared child');
    return model;
  };
  const openCatalog = async (modelOrPrepared, { recipe = {}, context = catalogScope(), owns = () => true } = {}) => {
    const prepared = typeof modelOrPrepared.retainPreparedPresentation === 'function'
      ? modelOrPrepared.retainPreparedPresentation() : modelOrPrepared.retain();
    retained.push(prepared);
    const current = createHistoryAgentCatalogCurrent({ recipe: { replacements: [], exclusions: [], insertions: [], live: [], ...recipe },
      context, isLocalPromptEntry: oracle.isLocalPromptEntry, isTaskAction: oracle.isTaskAction,
      historyAgentKey: oracle.historyAgentKey, owns, fingerprint: () => '' });
    const reader = await prepared.openAgentCatalog(current, { owns });
    retained.push(reader);
    return { reader, current, prepared };
  };
  const close = async () => {
    for (const value of retained.reverse()) await value.close();
    for (const model of models.reverse()) await model.close();
    if (fixture.errors.length) for (const error of fixture.errors) console.error('[V53_FIXTURE_ERROR]', error);
    fixture.close();
  };
  return { fixture, allocations, ready, retained, openModel, openCatalog, close };
}

function exactRecord(actual, expected, name) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), name + ' full property presence');
  for (const key of Object.keys(expected)) {
    // Avoid dumping giant user-contract fields on a failing assertion.
    if (typeof expected[key] === 'string') assert.equal(actual[key] === expected[key], true, name + '.' + key + ' exact UTF16');
    else assert.deepEqual(actual[key], expected[key], name + '.' + key);
  }
}
function summary(record) {
  return Object.fromEntries(['key', 'kind', 'label', 'startedAt', 'status', 'completedAt', 'durationMs'].map(key => [key, record[key]]));
}
async function allPages(reader, section, expected, limit = 7) {
  let offset = 0, count = 0;
  do {
    const page = await reader.readPage({ section, offset, limit });
    assert.equal(page.offset, offset); assert.equal(page.total, expected.length);
    assert(page.rows.length <= limit, 'bounded row publication');
    assert.equal(page.nextOffset, offset + page.rows.length);
    for (const row of page.rows) exactRecord(row, summary(expected[count++]), section + '[' + (count - 1) + ']');
    offset = page.nextOffset;
    assert.equal(page.done, offset === expected.length);
    if (page.done) break;
    assert(page.rows.length > 0, 'strict page progress');
  } while (true);
  assert.equal(count, expected.length, section + ' every completed/interrupted/running row remains reachable');
}
async function compareCatalog(reader, expected, { selected = expected.agents.map(row => row.key), pageLimit = 7 } = {}) {
  const running = expected.agents.filter(row => row.status === 'running');
  const completed = expected.agents.filter(row => row.status === 'completed');
  const interrupted = expected.agents.filter(row => row.status === 'interrupted');
  assert.deepEqual(reader.counts, { total: expected.agents.length, roster: running.length + completed.length + interrupted.length,
    running: running.length, completed: completed.length, interrupted: interrupted.length,
    background: expected.background.length, backgroundAgents: expected.background.filter(row => row.kind === 'subagent').length });
  for (const [section, rows] of [['all', expected.agents], ['running', running], ['completed', completed],
    ['interrupted', interrupted], ['roster', [...running, ...completed, ...interrupted]], ['background', expected.background]])
    await allPages(reader, section, rows, pageLimit);
  for (const key of selected) {
    const actual = await reader.lookup(key);
    assert.equal(actual.kind, 'found', key + ' proved membership');
    const original = expected.agents.find(row => row.key === key) || expected.background.find(row => row.key === key);
    exactRecord(actual.record, original, key);
  }
  assert.deepEqual(await reader.lookup('task:CURRENT-PROVED-MISSING'), { kind: 'missing', key: 'task:CURRENT-PROVED-MISSING' });
}

test('actual primary thin catalog: all pages, exact counts, distant completed/interrupted selection and no demand rebuild', async () => {
  // The original 73-row full Root fixture exceeded its existing 28MiB SQLite
  // quota before catalog allocation (receipt preserved). This connected
  // control uses 17 rows and 3-item pages under that SAME quota; independent
  // larger paged-producer/oracle controls are reported separately.
  const c = await connected(farHistoryFixture(17));
  try {
    const model = await c.openModel();
    const metadata = model.view.serverMetadata.entries;
    const expected = literalCatalog(oracle, metadata);
    // Poison is AFTER actual open/validation/registration. Np decoding and
    // compatibility remain OPEN; this proves only migrated demand reads.
    const poisoned = new Proxy(metadata, { get(target, key) {
      if (key === Symbol.iterator || key === 'filter') throw Error('LEGACY_NP_POISON_CONTROL');
      return Reflect.get(target, key);
    } });
    assert.throws(() => literalCatalog(oracle, poisoned), /LEGACY_NP_POISON_CONTROL/);
    Object.defineProperty(model.view, 'serverMetadata', { get() { throw Error('MIGRATED_CATALOG_NP_READ'); } });
    const { reader, current } = await c.openCatalog(model);
    assert.equal(expected.agents.length, 17);
    await compareCatalog(reader, expected, { selected: ['task:agent-0', 'task:agent-1', 'task:agent-16'], pageLimit: 3 });
    assert.equal(current.isCurrent(), true);
    assert.equal(current.values.length, 0, 'historical-only native driver has no historical native slots/registry');
    assert.equal(c.allocations.length, 1, 'page/selection demands reuse one independent catalog');
    assert.equal(c.ready.at(-1).buildMetrics.nativeHistoricalRegistry, 0);
    assert.equal(c.ready.at(-1).buildMetrics.bodyCopies, 0);
    assert.equal(c.ready.at(-1).buildMetrics.nativeMemoryMeasured, false);
    console.log('[V53_CONNECTED_BUILD] ' + JSON.stringify(c.ready.at(-1).buildMetrics));
  } finally { await c.close(); }
});

test('actual raw-live join uses thin chips before Rewind and preserves duplicate/summary precedence', async () => {
  const source = [agentRow('before', [taskAction('dup', { startedAt: 10, result: 'DURABLE RICH BODY' })], { sourceIdentity: 'before-id' }),
    agentRow('target', [], { role: 'user' }), agentRow('future', [taskAction('dup', { startedAt: 20 })], { sourceIdentity: 'future-id' })];
  const live = [agentRow('live-duplicate', [taskAction('richer', { result: 'RAW RICH BODY MUST NOT OVERRIDE' })], { sourceIdentity: 'before-id' }),
    agentRow('live-new', [taskAction('live', { startedAt: 30, result: undefined })])];
  const context = catalogScope({ isTurnBusy: true, agentProcessAlive: true });
  const c = await connected(source);
  try {
    const model = await c.openModel({ rewindPreview: { targetUuid: 'target', opId: 'rewind', startedAt: 1 } });
    const chipSource = buildHistoryLivePresentation(model.view.serverMetadata.entries, live);
    const expected = literalCatalog(oracle, chipSource, context);
    const { reader } = await c.openCatalog(model, { recipe: { live }, context });
    await compareCatalog(reader, expected);
    assert(expected.agents.some(row => row.key === 'task:dup'));
    assert(!expected.agents.some(row => row.key === 'task:richer'));
    assert.equal(expected.agents.find(row => row.key === 'task:dup').taskResult, undefined,
      'original thin metadata, never hydrated durable result, controls historical fold');
  } finally { await c.close(); }
});

test('actual CURRENT native inherited/sparse/typed/coercion grammar and branch-sensitive optional Map', async () => {
  const c = await connected();
  try {
    const model = await c.openModel();
    const fixture = nativeGrammarFixture();
    const expected = literalCatalog(oracle, fixture.entries);
    fixture.coercions.length = 0;
    const { reader, current } = await c.openCatalog(model, { recipe: { live: fixture.entries } });
    await compareCatalog(reader, expected);
    const detail = await reader.lookup('task:native-key');
    assert.equal(detail.record.taskHistory, fixture.history, 'selected typed CURRENT object is original reference');
    assert(!fixture.coercions.includes('id:string'), 'absent terminal Map suppresses original optional argument coercion');
    assert.equal(current.isCurrent(), true);
    fixture.action.result = 'changed after last await';
    assert.equal(current.isCurrent(), false, 'unchanged original native object mutation invalidates replay');
  } finally { await c.close(); }
});

test('actual full native selected fields retain exact UTF16 and original references while pages publish summaries', async () => {
  const c = await connected();
  try {
    const model = await c.openModel(), fixture = fullNativeFixture();
    const expected = literalCatalog(oracle, fixture.entries);
    const { reader } = await c.openCatalog(model, { recipe: { live: fixture.entries } });
    await compareCatalog(reader, expected);
    const detail = await reader.lookup('task:full');
    assert.equal(detail.record.taskHistory, fixture.history);
    assert.equal(detail.record.launchSettings, fixture.launchSettings);
    assert.equal(detail.record.taskPrompt.length, fixture.full.length);
    assert.equal(detail.record.taskPrompt, fixture.full);
    const page = await reader.readPage({ limit: 1 });
    assert.deepEqual(Object.keys(page.rows[0]).sort(), Object.keys(summary(expected.agents[0])).sort());
    assert.equal(Object.hasOwn(page.rows[0], 'taskHistory'), false);
    assert.equal(Object.hasOwn(page.rows[0], 'taskPrompt'), false);
  } finally { await c.close(); }
});

test('actual prepared catalog survives original Root.close, rewritten new open and independent genuine empty', async () => {
  const c = await connected(farHistoryFixture(3));
  try {
    const old = await c.openModel(), prepared = old.retainPreparedPresentation();
    c.retained.push(prepared);
    const expected = literalCatalog(oracle, old.view.serverMetadata.entries);
    await old.close();
    c.fixture.setEntries([]);
    const next = await c.openModel();
    const { reader } = await c.openCatalog(prepared);
    await prepared.close();
    await compareCatalog(reader, expected);
    const empty = await c.openCatalog(next);
    await compareCatalog(empty.reader, { background: [], agents: [] });
    assert.equal(c.allocations.length, 2);
    assert.notEqual(reader.header.leaseId, empty.reader.header.leaseId);
    await next.close();
    assert.equal((await reader.lookup('task:agent-0')).kind, 'found');
  } finally { await c.close(); }
});

test('actual CURRENT original errors stay errors and failed catalog allocation is released', async () => {
  const c = await connected();
  try {
    const model = await c.openModel();
    const bad = agentRow('bad-current', [], { actionSummary: [undefined] });
    assert.throws(() => literalCatalog(oracle, [bad]), TypeError);
    await assert.rejects(c.openCatalog(model, { recipe: { live: [bad] } }), TypeError);
    // A following independent valid catalog demonstrates sibling/Input owner
    // survival; failed UI demand did not close its prepared parent.
    const valid = await c.openCatalog(model);
    await compareCatalog(valid.reader, { agents: [], background: [] });
  } finally { await c.close(); }
});

test('actual registered chip plan preserves shown prefix/order independently of held newer Rewind model', async () => {
  const c = await connected([
    agentRow('before', [], { rowStub: true, actionSummary: [{ toolName: 'Task', toolUseId: 'before', subagentStatus: 'completed' }] }),
    agentRow('target', [], { role: 'user' }),
    agentRow('future', [], { rowStub: true, actionSummary: [{ toolName: 'Task', toolUseId: 'future', subagentStatus: 'completed' }] }),
  ]);
  const sourceOwner = createHistoryAgentCatalogSourceOwner({ isLocal: oracle.isLocalPromptEntry });
  try {
    const old = await c.openModel(), held = old.retainPreparedPresentation(); c.retained.push(held);
    const oldEntries = old.view.serverMetadata.entries;
    const shown = sourceOwner.prepare(oldEntries, { ownerKey: 'shown-A', generation: 1 }, { prepared: held }).commit();
    const newer = await c.openModel({ rewindPreview: { targetUuid: 'target', opId: 'preview', startedAt: 1 } });
    assert.equal(newer.view.serverMetadata.entries.length, 2);
    assert.equal(oldEntries.length, 3);
    await old.close();
    const live = [agentRow('raw-live', [taskAction('live')])];
    const context = catalogScope({ isTurnBusy: true, agentProcessAlive: true });
    const expected = literalCatalog(oracle, buildHistoryLivePresentation(oldEntries, live), context);
    const { reader } = await c.openCatalog(shown.prepared, { recipe: { segments: shown.segments, live }, context });
    await compareCatalog(reader, expected);
    assert.equal((await reader.lookup('task:future')).kind, 'found', 'newer Rewind view cannot replace the actual still-shown chip cut');
    const removedRows = [oldEntries[0], oldEntries[2]];
    const removed = sourceOwner.prepare(removedRows, { ownerKey: 'shown-A', generation: 1 }).commit();
    const filtered = await c.openCatalog(removed.prepared, { recipe: { segments: removed.segments } });
    await compareCatalog(filtered.reader, literalCatalog(oracle, removedRows));
  } finally { sourceOwner.close(); await c.close(); }
});

test('actual producer/native driver/presentation owner rejects queued getter reentry and releases unpublished child', async () => {
  const c = await connected(), updates = [];
  let rendered = null, reenter = false, owner;
  try {
    const model = await c.openModel(), prepared = model.retainPreparedPresentation(); c.retained.push(prepared);
    const action = taskAction('reentry', { result: 'done' });
    Object.defineProperty(action, 'description', { get() { if (reenter) { reenter = false; owner.close(); } return 'original label'; } });
    const rows = [agentRow('native-reentry', [action])];
    const current = createHistoryAgentCatalogCurrent({ recipe: { replacements: [], exclusions: [], insertions: [], live: rows },
      context: catalogScope(), isLocalPromptEntry: oracle.isLocalPromptEntry, isTaskAction: oracle.isTaskAction,
      historyAgentKey: oracle.historyAgentKey, owns: () => true, fingerprint: () => '' });
    owner = createHistoryPrimaryAgentCatalogOwner({ onChange: update => updates.push(update) });
    owner.update({ ownerKey: 'A', generation: 1, prepared, current, fullWitness: () => true, ownerFence: () => true });
    // This bounded wait exercises actual source work under the owner's own
    // original 30s deadline; it does not renew or replace that deadline.
    const stopAt = Date.now() + 30000;
    while (owner.state().running || owner.state().pending) {
      assert(Date.now() < stopAt, 'actual owner lane completed under its original deadline'); await new Promise(resolve => setImmediate(resolve));
    }
    assert(c.ready.length > 0, 'actual paged child reached ready before queued publication');
    reenter = true;
    for (const update of updates.splice(0)) rendered = update(rendered);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(owner.state().closed, true);
    assert.equal(owner.snapshot(), null);
    assert.notEqual(rendered?.status, 'ready', 'reentrant old candidate never publishes ready');
    assert.equal(c.allocations.length, 1);
  } finally { owner?.close(); await c.close(); }
});

test('actual intrinsic Main facts preserve CURRENT action getters; custom facts profile rejects explicitly', async () => {
  const c = await connected(), trace = [];
  try {
    const model = await c.openModel();
    const proof = createHistoryAgentCatalogMainFact({ provider: 'codex', startedAt: 40 });
    const facts = createHistoryAgentCatalogMainFactsMap([['call', proof]]);
    const action = taskAction('call');
    Object.defineProperty(action, 'description', { configurable: true,
      get() { trace.push('original-CURRENT-getter'); return 'label'; } });
    const rows = [agentRow('native-call', [action])];
    const context = catalogScope({ isTurnBusy: true, agentProcessAlive: true, exactActiveSubagents: facts });
    const expected = literalCatalog(oracle, rows, context), original = trace.splice(0);
    assert(original.length > 0, 'literal collector visited the original CURRENT action getter');
    const { reader, current } = await c.openCatalog(model, { recipe: { live: rows }, context });
    await compareCatalog(reader, expected);
    assert.deepEqual(trace, [...original, ...original], 'CURRENT getter keeps literal read and one proof replay');
    assert.equal(current.hasIntrinsicReadAuthority(), true);
    Object.defineProperty(facts, 'get', { configurable: true,
      get() { throw Error('UNAUTHENTICATED_GETTER_MUST_NOT_RUN'); } });
    assert.equal(current.hasIntrinsicReadAuthority(), false);
    assert.equal(current.isCurrent(), false, 'same-object method mutation revokes provenance without invoking getter');
    assert.throws(() => createHistoryAgentCatalogCurrent({ recipe: {}, context,
      isLocalPromptEntry: oracle.isLocalPromptEntry, isTaskAction: oracle.isTaskAction,
      historyAgentKey: oracle.historyAgentKey, fingerprint: () => '' }), { code: 'HISTORY_AGENT_CATALOG_MAIN_FACTS_PROFILE' });
    // The new API has an explicit intrinsic Main profile; old collectors keep
    // their broader native Map/property contract for legacy/composite paths.
    const legacyFacts = new Map([['call', { provider: 'codex', startedAt: 40 }]]);
    Object.defineProperty(legacyFacts, 'get', { get() { trace.push('legacy-map-get'); return Map.prototype.get; } });
    assert.equal(literalCatalog(oracle, rows, { ...context, exactActiveSubagents: legacyFacts }).agents.length, 1);
    assert(trace.includes('legacy-map-get'));
  } finally { await c.close(); }
});
