// SOURCE only: execute bounded verbatim Panel callbacks and the real producer,
// IPC adapter, shared client, model and current-live owner. Parsed synthetic
// rows, Node SQLite, a finite React/ref frame and in-process IPC substitute for
// native ingestion/Electron. This is not mounted/native acceptance.
// node --max-old-space-size=64 --max-semi-space-size=8 --test --test-isolation=none scripts/history-primary-live-panel-source.test.mjs
import test from 'node:test';
// Parent regressions below also exercise the actual Panel publication fence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import { HistoryPrimaryRootReadModel, historyPrimaryLiveClaimFingerprint, historyPrimaryColdReadWakeAllowed } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import { createHistoryPrimaryLiveCoverageOwner } from '../src/renderer/utils/historyPrimaryLiveCoverageOwner.mjs';
import { createHistoryPrimarySparsePublicationOwner } from '../src/renderer/utils/historyPrimarySparsePublication.mjs';
import { flushHistoryDurableWithRetry } from '../src/renderer/utils/historyDurableFlush.mjs';
import * as live from '../src/renderer/utils/historyLiveProjection.mjs';
import { readHistoryThroughIpc } from '../src/renderer/utils/historyReadTransport.mjs';
const require = createRequire(import.meta.url), ts = require(process.env.NOTED_TYPESCRIPT_PATH || 'typescript');
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
const { materializeHistoryCursorSync: materialize } = require('../src/main/history-root-engine/main/history-paged-store.js');
assert(getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2, 'finite total heap; use documented command');
globalThis.window = { require };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
const sha = value => createHash('sha256').update(value).digest('hex');
const panelFile = new URL('../src/renderer/components/Workspace/HistoryPanel.tsx', import.meta.url);
assert(fs.statSync(panelFile).size <= 2 * 1024 ** 2);
const panel = fs.readFileSync(panelFile, 'utf8');
function between(start, end) {
  const a = panel.indexOf(start), b = panel.indexOf(end, a + start.length);
  assert(a >= 0 && b > a && panel.indexOf(start, a + start.length) < 0, 'unique actual source markers: ' + start);
  assert(Buffer.byteLength(panel.slice(a, b)) <= 16 * 1024, 'bounded fragment, no whole Panel AST');
  return panel.slice(a, b);
}
const blocks = {
  seed: between('  const durableSourceIdentitiesRef = ', '  const presentationEntriesRef = '),
  owner: between('  const primaryLiveCoverageEnabledRef = ', '  const historyPresentationApplyGuardRef = '),
  reconcile: between('  const reconcileLiveProjectionAgainstDurable = ', '  const reconcileLiveToolResultsAgainstDurable = '),
  unmatched: between('  const hasUnmatchedLiveForOwner = ', '  const historyPayloadContextValue = '),
  flush: between('  const flushLiveHistoryToDurable = ', '  // Suppression is a temporary presentation overlay'),
  commit: between('  // Capture the actual render\'s cut before the layout effect', '  // Bind coverage to THIS render\'s committed canonical cut'),
  event: between('  // Both PTY agents expose canonical incremental transcript records.', '  // Event-driven transcript refresh.'),
  turn: between('  useEffect(() => {\n    if (isTurnBusy) return;\n    // Claude may publish a standalone thinking record', '  // Listen for scroll-to-bottom from Timeline arrow button'),
  reset: between('    liveProjectionRef.current = { ownerKey: historyOwnerKey, entries: [] };\n    liveToolResultsRef.current = ', '    setLiveEntries([]);\n    setLiveToolResults(new Map());\n    viewportPaintProbeRef.current?.cancel();'),
  receiptRetire: between('      if (identity.sourceIdentity && liveProjectionRef.current.ownerKey === historyOwnerKey) {', '      if (\n        record.queueStatus === \'application-queued\''),
};
function compile(block, result = '') {
  const output = ts.transpileModule(block, { fileName: 'bounded-live-caller.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  assert.deepEqual(output.diagnostics || [], []);
  return new Function('env', 'with (env) {\n' + output.outputText + '\n' + result + '\n}');
}
const compiled = Object.fromEntries(Object.entries(blocks).map(([name, block]) => [name, compile(block,
  name === 'seed' ? 'return durableSourceIdentitiesRef;' : name === 'owner' ? 'return { primaryLiveCoverageOwner, primaryLiveCoverageEnabledRef };'
  : name === 'reconcile' ? 'return reconcileLiveProjectionAgainstDurable;' : name === 'unmatched' ? 'return hasUnmatchedLiveForOwner;'
  : name === 'flush' ? 'return flushLiveHistoryToDurable;' : '')]));
console.log('PANEL_LIVE_SOURCE_CERTIFICATE ' + JSON.stringify({ panelSHA256: sha(panel), bytes: Buffer.byteLength(panel),
  fragments: Object.fromEntries(Object.entries(blocks).map(([name, text]) => [name, { bytes: Buffer.byteLength(text), sha256: sha(text) }])),
  node: process.version, typescript: ts.version, heapLimit: getHeapStatistics().heap_size_limit, electron: process.versions.electron || null }));
const row = (id, extra = {}) => ({ uuid: id, role: 'assistant', sessionId: 's', sourceIdentity: 'src:' + id,
  timestamp: '2026-10-27T00:00:00.000Z', content: 'body ' + id, ...extra });
const setting = (value, extra = {}) => row('setting', { role: 'slash', sourceIdentity: 'setting-source',
  settingsFact: { version: 1, provider: 'codex', kind: 'model', value }, ...extra });
const deferred = () => { let resolve; const promise = new Promise(a => { resolve = a; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

async function setup(entries, intercept = async () => undefined) {
  const f = await createPrimaryAddressFixture(null, { entries });
  let preparedSetup = true;
  const invoke = async (channel, payload) => {
    // These controls gate the live consumer after initial adoption. V52's
    // actual sparse preparation also uses prepared-domain consumer traffic;
    // that setup demand must complete before a test owns its live-reply gate.
    const result = preparedSetup ? undefined : await intercept(channel, payload, f);
    return result !== undefined ? result : channel === 'agent-transcript:cancel-read' ? { success: true } : f.invoke(channel, payload);
  };
  const model = new HistoryPrimaryRootReadModel(invoke, { ...f.transport, readHistoryThroughIpc });
  model.windowDiagnostic = () => {};
  const payload = { ...f.payload, primaryPresentation: { localEntries: [], liveEntries: [], liveToolResults: [],
    grouping: { enabled: false, responseWork: true, threshold: 2, expandedKeys: [] }, captionSelections: [], settingsPresentationKeys: [] } };
  const isLocal = entry => entry?.role === 'queued' && typeof entry.uuid === 'string' && entry.uuid.startsWith('local-prompt-');
  const sparse = createHistoryPrimarySparsePublicationOwner({ isLocal });
  let prepared;
  try { await model.open(payload, {
    prepareAdopt: candidate => candidate.preparePromptAdoptionSparse([], [], { isLocal, owns: () => true }),
    adopt: (adopted, proof) => {
      prepared = proof.materializeCompatibility(adopted.metadata.entries);
      sparse.adopt(proof, prepared, { ownerKey: 'A', generation: 1 });
    },
  }); preparedSetup = false; } catch (error) { sparse.close(); await model.close(); f.close(); throw error; }
  const canonical = materialize(f.plane.state(model.view.root, f.consumerKey).primaryPresentation.toolCoverageInputs().entries);
  // Prepared Np compatibility remains genuine. The existing finite native
  // oracle is only for legacy controls, never a retired model Nc inventory.
  const raw = canonical;
  const restore = [];
  const poison = () => {
    for (const [object, name] of [[model, 'metadata'], [model.view, 'metadata'], [model.view, 'serverMetadata']]) {
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      restore.push(() => descriptor ? Object.defineProperty(object, name, descriptor) : delete object[name]);
      Object.defineProperty(object, name, { configurable: true, get() { throw Error('MIGRATED_CALLBACK_READ_N_METADATA'); } });
    }
  };
  const unpoison = () => { while (restore.length) restore.pop()(); };
  poison();
  return { f, model, payload, canonical, prepared, raw, sparse, poison, unpoison,
    async close() { unpoison(); sparse.close(); await model.close();
      await new Promise(resolve => setImmediate(resolve)); f.close(); } };
}

function rig(x, initial = [], { primary = true, load = async () => true,
  fingerprint = historyPrimaryLiveClaimFingerprint } = {}) {
  const effects = [], cleanups = [], listeners = new Map(), logs = [], warnings = [], publications = [], queries = [], inFlight = new Set();
  const actualQuery = x.model.readLiveIdentityCoverage.bind(x.model);
  x.model.readLiveIdentityCoverage = (...args) => {
    queries.push(args); const promise = actualQuery(...args); inFlight.add(promise);
    promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise)); return promise;
  };
  let loads = 0;
  const env = { ...live, historyPrimaryLiveClaimFingerprint: fingerprint, historyPrimaryColdReadWakeAllowed, createHistoryPrimaryLiveCoverageOwner, flushHistoryDurableWithRetry,
    primaryPhysicalCandidate: primary, primaryRoot: x.model, primaryRootRef: { current: x.model },
    primaryCompositeOwnerRef: { current: '' }, primaryRootReadEnabled: true,
    historyOwnerKey: 'A', historyOwnerKeyRef: { current: 'A' }, historyOwnerGenerationRef: { current: 1 },
    primaryReceiptCommitRef: { current: null }, primaryLiveCommitRef: { current: null },
    primarySparsePublicationOwner: x.sparse, primaryPresentationDataCommitRef: { current: null },
    liveProjectionRef: { current: { ownerKey: 'A', entries: initial } }, liveToolResultsRef: { current: { ownerKey: 'A', results: new Map() } },
    entries: x.prepared, presentationEntriesRef: { current: x.prepared }, presentedOwnerKey: 'A',
    primarySurfaceWitnessRef: { current: { root: x.model, header: x.model.header, entries: new WeakRef(x.prepared) } },
    committedHistoryEntriesRef: { current: { ownerKey: '', entries: [] } },
    liveOrphanDigestRef: { current: '' }, isTurnBusyRef: { current: true }, isTurnBusy: true,
    promptHandoffMetaRef: { current: new Map() }, deferredTranscriptRefreshRef: { current: false },
    primaryColdReadFailureRef: { current: null }, loadHistoryRef: { current: null },
    sessionId: 's', toolType: 'codex', tabId: 't', fileRewriteEpoch: 0,
    useRef: value => ({ current: value }), useMemo: fn => fn(), useCallback: fn => fn,
    useEffect: fn => { effects.push(fn); }, useLayoutEffect: fn => { env.layout = fn; },
    console: { warn: (...values) => warnings.push(values) }, historyDiag: text => logs.push(text),
    setLiveEntries: rows => publications.push(rows), setLiveToolResults() {},
    isLocalPromptEntry: entry => entry?.role === 'queued' && entry.uuid.startsWith('local-prompt-'),
    consumeMaterializedPromptHandoffs() {}, consumePrimaryMaterializedPromptHandoffs() {}, keepHistoryTailPinnedAfterMutation() {},
    setHistoryRewindPreview() {}, shouldClearRewindPreviewForDurableUser: () => false,
    useUIStore: { getState: () => ({ historyRewindPreviews: {} }) },
    ipcRenderer: { on: (name, listener) => listeners.set(name, listener), removeListener: (name, listener) => { if (listeners.get(name) === listener) listeners.delete(name); } },
    loadHistory: async () => { loads++; return load(); },
  };
  env.rawServerEntriesRef = { get current() { if (primary) throw Error('MIGRATED_CALLBACK_READ_RAW_ARRAY'); return x.raw; } };
  if (primary) env.committedHistoryEntriesRef = {
    get current() { throw Error('MIGRATED_CALLBACK_READ_COMMITTED_ARRAY'); },
    set current(_value) { throw Error('MIGRATED_CALLBACK_WRITE_COMMITTED_ARRAY'); },
  };
  env.durableSourceIdentitiesRef = primary ? { get current() { throw Error('MIGRATED_CALLBACK_READ_NATIVE_ID_SET'); } }
    : { current: live.reconcileCommittedHistoryLiveProjection([], x.canonical).durableIdentities };
  Object.assign(env, compiled.owner(env));
  env.reconcileLiveProjectionAgainstDurable = compiled.reconcile(env);
  env.hasUnmatchedLiveForOwner = compiled.unmatched(env);
  env.flushLiveHistoryToDurable = compiled.flush(env);
  const install = () => { while (effects.length) { const cleanup = effects.shift()(); if (cleanup) cleanups.push(cleanup); } };
  install(); compiled.event(env); install();
  return { env, queries, logs, warnings, publications, get loads() { return loads; },
    unmatched: () => env.hasUnmatchedLiveForOwner('A'), flush: () => env.flushLiveHistoryToDurable('finite-source', 'A'),
    event: packet => listeners.get('agent-transcript:live-message')?.({}, packet),
    setLive(rows) { env.liveProjectionRef.current = { ownerKey: 'A', entries: rows }; env.primaryLiveCoverageOwner.wake('subject'); },
    captureCommit() {
      const layouts = [], primaryLocalPublicationAtRender = x.sparse.publishCompatibility(env.entries,
        { ownerKey: env.historyOwnerKeyRef.current, generation: env.historyOwnerGenerationRef.current });
      env.presentationEntriesRef.current = env.entries;
      const frame = Object.assign(Object.create(env), { entries: env.entries, primaryRoot: env.primaryRoot,
        primaryPhysicalCandidate: env.primaryPhysicalCandidate, historyOwnerKey: env.historyOwnerKey,
        presentedOwnerKey: env.presentedOwnerKey, primaryLocalPublicationAtRender, useLayoutEffect: fn => layouts.push(fn) });
      compiled.commit(frame); assert.equal(layouts.length, 2);
      return () => { for (const layout of layouts) layout(); };
    },
    commit() { this.captureCommit()(); },
    turnSettled() { env.isTurnBusy = false; env.isTurnBusyRef.current = false; compiled.turn(env); install(); },
    retireReceipt(identity) { env.identity = identity; env.record = { handoffId: 'exact-receipt' }; compiled.receiptRetire(env); },
    async close() { for (const cleanup of cleanups.reverse()) cleanup(); env.primaryLiveCoverageOwner.dispose(); await Promise.allSettled([...inFlight]); x.model.readLiveIdentityCoverage = actualQuery; },
  };
}

test('actual primary seed/reset is unproved null; legacy seed still contains the exact native identities', () => {
  const snapshot = { get entries() { throw Error('PRIMARY_SEED_READ_COMPATIBILITY_ARRAY'); } };
  const primary = compiled.seed({ primaryPhysicalCandidate: true, firstRenderSnapshot: snapshot, useRef: value => ({ current: value }), ...live });
  assert.equal(primary.current, null);
  const expected = row('one', { sourceIdentityAliases: [' alias ', ' alias '] });
  const legacy = compiled.seed({ primaryPhysicalCandidate: false, firstRenderSnapshot: { entries: [expected] }, useRef: value => ({ current: value }), ...live });
  assert.deepEqual([...legacy.current], live.historyLivePresentationIdentities(expected));
  let invalidated = 0;
  const env = { historyOwnerKey: 'B', liveProjectionRef: { current: {} }, liveToolResultsRef: { current: {} }, primaryPhysicalCandidate: true,
    durableSourceIdentitiesRef: { current: legacy.current }, primaryLiveCoverageOwner: { invalidate() { invalidated++; } },
    primaryLiveCommitRef: { current: {} }, committedHistoryEntriesRef: { current: {} }, primaryReceiptCommitRef: { current: {} },
    primaryPresentationDataCommitRef: { current: {} } };
  compiled.reset(env); assert.equal(env.durableSourceIdentitiesRef.current, null); assert.equal(env.primaryLiveCommitRef.current, null);
  assert.equal(env.primaryReceiptCommitRef.current, null); assert.equal(invalidated, 1);
});

test('actual primary no-root is UNKNOWN and still folds incoming rows; poisoned legacy controls really throw', async () => {
  const x = await setup([row('durable')]), h = rig(x, [row('current')]);
  try {
    assert.throws(() => x.model.metadata, /MIGRATED_CALLBACK_READ_N_METADATA/);
    assert.throws(() => h.env.durableSourceIdentitiesRef.current, /MIGRATED_CALLBACK_READ_NATIVE_ID_SET/);
    h.env.primaryRootRef.current = null; h.env.primaryLiveCoverageOwner.wake('subject');
    assert.equal(await h.unmatched(), null); assert.equal(h.queries.length, 0);
    h.event(assistantEvent('new', 'new-source', 'new current live value'));
    assert(h.env.liveProjectionRef.current.entries.some(entry => entry.content === 'new current live value'));
    assert.equal(await h.flush(), false); assert.equal(h.loads, 1); assert.equal(h.queries.length, 0);
    h.env.primaryLiveCoverageEnabledRef.current = false;
    await assert.rejects(h.unmatched(), /MIGRATED_CALLBACK_READ_RAW_ARRAY/, 'negative legacy arm proves array poison is active');
    h.env.primaryLiveCoverageEnabledRef.current = true;
  } finally { await h.close(); await x.close(); }
});

test('actual commit→owner→model→client→producer matches native retirement and independent plain unmatched with poisoned migrated arrays', async () => {
  const x = await setup([row('uuid-only', { sourceIdentity: undefined }), row('alias', { sourceIdentityAliases: ['shared'] }), setting('old'), setting('durable')]);
  const claims = [{ sourceIdentity: 'uuid-only' }, { sourceIdentity: 'assistant-uuid:uuid-only' }, row('live', { sourceIdentity: 'shared' }), setting('live'), { content: 'no ID' }];
  const expected = live.reconcileCommittedHistoryLiveProjection(claims, x.canonical), h = rig(x, claims);
  try {
    const pending = h.unmatched(); await tick(); assert.equal(h.queries.length, 0, 'load/prepared membership is not data commit');
    h.commit(); assert.equal(await pending, true);
    assert.deepEqual(h.env.liveProjectionRef.current.entries, expected.entries);
    assert.deepEqual(h.queries.map(args => args[0].length), [3, 2]);
    assert.equal(h.publications.length, 1); assert.equal(h.env.primaryLiveCommitRef.current.live, h.env.liveProjectionRef.current);
    assert.equal(h.env.primaryLiveCoverageOwner.peekUnmatched('A'), true);
    assert(x.f.calls.some(call => call.kind === 'primary-canonical-consumers'));
    assert.equal(x.model.window.size, 0); assert(x.f.store.stats().peakCachedPages <= 3);
  } finally { await h.close(); await x.close(); }
});

const assistantEvent = (uuid, sourceIdentity, text) => ({ tabId: 't', toolType: 'codex', sessionId: 's',
  message: { uuid, type: 'assistant', sourceIdentity, sessionId: 's', message: { role: 'assistant', content: [{ type: 'text', text }] } } });
test('actual incoming existing stream folds synchronously; old coverage cannot retire it until the next real commit', async () => {
  const x = await setup([row('stream', { sourceIdentity: 'shared' })]), h = rig(x);
  try {
    h.commit();
    h.setLive([row('stream', { sourceIdentity: 'shared', content: 'earlier stream', liveProjection: true })]);
    assert.equal(await h.unmatched(), false); assert.equal(h.env.liveProjectionRef.current.entries.length, 1);
    h.event(assistantEvent('stream', 'shared', 'latest 🧪\ud800 stream'));
    assert.equal(h.env.liveProjectionRef.current.entries[0].content, 'latest 🧪\ud800 stream', 'event never awaits query');
    assert.equal(await h.unmatched(), false); assert.equal(h.env.liveProjectionRef.current.entries.length, 1, 'old completed commit cannot retire new fold');
    const before = h.queries.length;
    h.commit(); assert.deepEqual(h.env.liveProjectionRef.current.entries, []);
    assert.equal(h.queries.length, before, 'fresh data boundary reuses the exact already prepared current-claim proof');
  } finally { await h.close(); await x.close(); }
});

test('a live event before a fresh actual commit follows the old commit-time reconciler semantics', async () => {
  const x = await setup([row('stream', { sourceIdentity: 'shared' })]), h = rig(x);
  try {
    const commit = h.captureCommit();
    h.event(assistantEvent('stream', 'shared', 'arrived between render and layout'));
    const current = h.env.liveProjectionRef.current.entries;
    const expected = live.reconcileCommittedHistoryLiveProjection(current, x.canonical).entries;
    commit(); assert.equal(await h.unmatched(), false); assert.deepEqual(h.env.liveProjectionRef.current.entries, expected);
  } finally { await h.close(); await x.close(); }
});

test('actual Codex settings exception and separate tool-result authority preserve their original owners', async () => {
  const x = await setup([setting('durable')]), h = rig(x);
  try {
    h.commit();
    h.event({ tabId: 't', toolType: 'codex', sessionId: 's', type: 'history_entry', entry: setting('live') });
    assert.equal(h.env.liveProjectionRef.current.entries.length, 1);
    h.commit(); assert.equal(await h.unmatched(), false); assert.equal(h.env.liveProjectionRef.current.entries.length, 1, 'settings conflict retained despite plain covered identity');
    h.event({ tabId: 't', toolType: 'codex', sessionId: 's', message: { uuid: 'result-record', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'exact result 🧪' }] } } });
    assert.equal(h.env.liveToolResultsRef.current.results.get('tool-1').result, 'exact result 🧪');
    assert.equal(await h.unmatched(), true); assert.equal(h.env.liveProjectionRef.current.entries.length, 1);
    h.env.liveToolResultsRef.current = { ownerKey: 'A', results: new Map() };
    assert.equal(await h.unmatched(), false, 'only the separate tool coverage owner clears tool work');
  } finally { await h.close(); await x.close(); }
});

test('actual flush/turn-settled UNKNOWN stops without own retry; known tool work keeps its separate bounded three attempts', async () => {
  let unknown = false;
  const x = await setup([row('durable')], async (_channel, payload) => payload?.kind === 'primary-canonical-consumers' && unknown
    ? { success: false, error: 'FINITE_LIVE_UNKNOWN' } : undefined);
  const h = rig(x, [row('missing')]);
  try {
    unknown = true; h.commit();
    assert.equal(await h.flush(), false); assert.equal(h.loads, 1); assert.equal(h.queries.length, 1);
    assert(h.logs.some(text => text.includes('unmatched=unknown')));
    h.turnSettled(); await tick(); assert.equal(h.loads, 1); assert.equal(h.queries.length, 1);
    x.model.notify(); await tick(); assert.equal(h.queries.length, 1, 'body notification has no retry authority');
    h.env.liveToolResultsRef.current = { ownerKey: 'A', results: new Map([['tool', { toolUseId: 'tool', result: 'pending', isError: false }]]) };
    assert.equal(await h.flush(), false); assert.equal(h.loads, 4, 'known independent tools preserve the original three-load budget');
    assert.equal(h.queries.length, 1, 'the failed identity query was not restarted by known tools or diagnostics');
    h.env.liveToolResultsRef.current = { ownerKey: 'A', results: new Map() };
    assert.equal(await h.flush(), false); assert.equal(h.loads, 5); assert.equal(h.queries.length, 1);
  } finally { await h.close(); await x.close(); }
});

test('actual outer flush revalidates owner after the helper return before publishing its settled flag', async () => {
  const x = await setup([row('durable')]), h = rig(x);
  try {
    h.commit(); h.env.deferredTranscriptRefreshRef.current = true;
    const actualFlush = h.env.flushHistoryDurableWithRetry;
    h.env.flushHistoryDurableWithRetry = async options => {
      const outcome = await actualFlush(options);
      h.env.historyOwnerGenerationRef.current++;
      return outcome;
    };
    assert.equal(await h.flush(), false); assert.equal(h.loads, 1);
    assert.equal(h.env.deferredTranscriptRefreshRef.current, true);
    assert.equal(h.logs.filter(text => text.startsWith('TRANSCRIPT_FLUSH_')).length, 0);
  } finally { await h.close(); await x.close(); }
});

test('real same-header no-adoption external-open settlement wakes retained live observation without render or body retry', async () => {
  const entered = deferred(), release = deferred(); let hold = true, rejectOpen = false;
  const x = await setup([row('covered')], async (channel, payload, f) => {
    if (rejectOpen && channel === 'agent-transcript:get-history') throw Object.assign(Error('external source unavailable'), { code: 'FINITE_OPEN_UNKNOWN' });
    if (hold && payload?.kind === 'primary-canonical-consumers') { hold = false; const result = await f.invoke(channel, payload); entered.resolve(); await release.promise; return result; }
  });
  const h = rig(x, [row('covered')]);
  try {
    h.commit(); const old = h.unmatched(); await entered.promise;
    const header = x.model.header, subject = x.model.getReceiptDataSubject();
    rejectOpen = true; await assert.rejects(x.model.open(x.payload), error => error.code === 'FINITE_OPEN_UNKNOWN');
    assert.equal(x.model.header, header); assert.equal(x.model.getReceiptDataSubject(), subject);
    assert.equal(await old, null); const replacement = h.unmatched(); release.resolve();
    assert.equal(await replacement, false); assert.equal(h.queries.length, 2); assert.deepEqual(h.env.liveProjectionRef.current.entries, []);
    x.model.notify(); await tick(); assert.equal(h.queries.length, 2);
  } finally { release.resolve(); await h.close(); await x.close(); }
});

test('real view-only rebind reuses checked current-cut coverage without another Panel render or query', async () => {
  const x = await setup([row('durable')]), h = rig(x, [row('missing')]);
  try {
    h.commit(); assert.equal(await h.unmatched(), true);
    const header = x.model.header, subject = x.model.getReceiptDataSubject(), commit = h.env.primaryReceiptCommitRef.current;
    x.unpoison(); await x.model.open({ ...x.payload, primaryRequestClass: 'view', primaryViewOptions: {
      grouping: { ...x.payload.primaryPresentation.grouping, enabled: true }, captionSelections: [] } }); x.poison();
    assert.notEqual(x.model.header, header); assert.equal(x.model.getReceiptDataSubject(), subject);
    assert.equal(h.env.primaryReceiptCommitRef.current, commit); assert.equal(await h.unmatched(), true);
    assert.equal(h.queries.length, 1); assert.equal(h.env.liveProjectionRef.current.entries.length, 1);
  } finally { await h.close(); await x.close(); }
});

test('actual exact receipt retirement replaces current live ownership; a late identity proof cannot resurrect it', async () => {
  const entered = deferred(), release = deferred(); let hold = true;
  const x = await setup([row('durable')], async (channel, payload, f) => {
    if (hold && payload?.kind === 'primary-canonical-consumers') { hold = false; const result = await f.invoke(channel, payload); entered.resolve(); await release.promise; return result; }
  });
  const entry = row('prompt', { role: 'user', sourceIdentity: 'exact-source' }), h = rig(x, [entry]);
  try {
    h.commit(); const pending = h.unmatched(); await entered.promise;
    h.retireReceipt({ sourceIdentity: 'exact-source', auditEntryUuid: 'prompt' });
    assert.deepEqual(h.env.liveProjectionRef.current.entries, []); assert.equal(await pending, null);
    release.resolve(); await tick(); assert.deepEqual(h.env.liveProjectionRef.current.entries, []);
    assert.equal(await h.unmatched(), false); assert.equal(h.queries.length, 1);
  } finally { release.resolve(); await h.close(); await x.close(); }
});


test('actual Panel witness work stays bounded across historical signed-read guards', async () => {
  const observations = [];
  for (const count of [0, 8]) {
    const x = await setup(Array.from({ length: count }, (_, i) => row('canonical-' + i)));
    let calls = 0;
    const h = rig(x, [row('current-only', { content: 'x'.repeat(1024) })], {
      fingerprint: value => { calls += 1; return historyPrimaryLiveClaimFingerprint(value); },
    });
    try {
      calls = 0; h.commit();
      assert.equal(await h.unmatched(), true);
      assert.equal(h.env.liveProjectionRef.current.entries.length, 1);
      assert(calls > 0 && calls <= 64, 'actual Panel/owner payload witnesses grew with historical guards: ' + calls);
      observations.push({ canonicalRows: count, currentPayloadUTF16: 1024, frontendFingerprints: calls });
    } finally { await h.close(); await x.close(); }
  }
  assert.equal(observations[0].frontendFingerprints, observations[1].frontendFingerprints);
  console.log('ACTUAL_PANEL_PAYLOAD_WITNESS_BOUND ' + JSON.stringify(observations));
});

test('actual Panel cannot publish a subset after disposal during its own remaining-row fingerprint', async () => {
  const x = await setup([row('canonical', { sourceIdentity: 'covered' })]);
  let inPublication = false, revoked = false, h;
  const identity = [], prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, 'join', { value() {
    if (inPublication && !revoked) { revoked = true; h.env.primaryLiveCoverageOwner.dispose(); }
    return 'missing';
  } });
  Object.setPrototypeOf(identity, prototype);
  const remaining = row('current-missing', { sourceIdentity: identity }); remaining.self = remaining;
  const initial = [row('current-covered', { sourceIdentity: 'covered' }), remaining];
  h = rig(x, initial);
  const fold = h.env.liveProjectionRef.current;
  h.env.isTurnBusyRef.current = false;
  h.env.historyDiag = value => { h.logs.push(value); if (value.startsWith('LIVE_ORPHANS ')) inPublication = true; };
  try {
    h.commit();
    assert.equal(await h.unmatched(), null);
    assert.equal(revoked, true, 'positive control: reentry occurred inside actual Panel publication');
    assert.deepEqual(h.publications, []);
    assert.equal(h.env.liveProjectionRef.current, fold);
    assert.deepEqual(h.env.liveProjectionRef.current.entries, initial);
  } finally { await h.close(); await x.close(); }
});
