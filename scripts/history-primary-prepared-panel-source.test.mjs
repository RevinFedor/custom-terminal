// V52 SOURCE only: bounded verbatim current Panel effects/resize callback,
// actual model/prepared/sparse owners and V51 client/plane/store. Finite parsed
// rows, React cells, one connected scroller and an IPC reply gate substitute
// native ingestion/rendering. No mounted UI, paint, input, RSS or latency claim.
// NOTED_TYPESCRIPT_PATH=... node --max-old-space-size=64 --max-semi-space-size=2 --test --test-reporter=tap --test-isolation=none scripts/history-primary-prepared-panel-source.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import { HistoryPrimaryRootReadModel, historyPrimaryLiveClaimFingerprint } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import { createHistoryPrimarySparsePublicationOwner } from '../src/renderer/utils/historyPrimarySparsePublication.mjs';
import { createHistoryPresentationPositionOwner, createHistoryPresentationPositionQuery } from '../src/renderer/utils/historyPresentationPosition.mjs';
import { createHistoryPreparedPositionSource, canBindHistoryPreparedPositionFrame } from '../src/renderer/utils/historyPreparedPosition.mjs';
import { buildHistoryDisplayUnits } from '../src/renderer/utils/historyDisplayUnits.mjs';
import { historyLivePresentationKey } from '../src/renderer/utils/historyLiveProjection.mjs';
import { findHistoryUnitIndexByKey } from '../src/renderer/utils/historyGestureAnchor.mjs';
import { createHistoryCommitWitnessDiagnostics } from '../src/renderer/utils/uiPerformanceDiagnostics.mjs';
const require = createRequire(import.meta.url);
const ts = require(process.env.NOTED_TYPESCRIPT_PATH || 'typescript');
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
globalThis.window = { require };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
assert(getHeapStatistics().heap_size_limit <= 96 * 1024 ** 2, 'bounded source process');
const panel = fs.readFileSync(new URL('../src/renderer/components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex'), fragments = [];
function part(start, end, limit = 16 * 1024) {
  const from = panel.indexOf(start), to = panel.indexOf(end, from + start.length);
  assert(from >= 0 && to > from && panel.indexOf(start, from + start.length) < 0, 'unique current Panel slice: ' + start);
  const source = panel.slice(from, to), bytes = Buffer.byteLength(source);
  assert(bytes < limit, 'bounded callback, never whole Panel AST');
  fragments.push({ start, bytes, sha256: sha(source) }); return source;
}
function compile(source, tail = '') {
  const result = ts.transpileModule(source, { fileName: 'bounded-v52-panel.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  assert.deepEqual(result.diagnostics || [], []);
  return new Function('env', 'with(env){\n' + result.outputText + '\n' + tail + '\n}');
}
const diagnostic = compile(part("  // This render's candidate and O(1) sample are committed data", '  // Capture the actual render\'s cut before the layout effect'));
const commit = compile(part('  // Capture the actual render\'s cut before the layout effect', '  // Bind coverage to THIS render\'s committed canonical cut'));
const position = compile(part('  // Coordinates describe THIS native current projection', '  // Expand the group'),
  'return {primaryPositionOwner,primaryResizePosition,primaryAnchorPosition,primaryMountedPosition,primaryTimelinePosition,primaryPositionFrame,primaryPositionFrameRef,primaryPositionModeRef};');
const ownerText = part("    const owner = () => historyOwnerKeyRef.current + ':' + historyOwnerGenerationRef.current", '    const controller = createHistoryResizeController({');
const resize = compile('let resizeToken = 1;\n' + ownerText + '\nconst callbacks={\n'
  + part('      jumpToKey: async (key: string, uuid: string, tail = false) => {', '      onPrepare: () => {')
  + '\n};', 'return callbacks.jumpToKey;');
const audit = { schema: 'v52-prepared-panel-source-1', node: process.version, typescript: ts.version,
  heapLimitBytes: getHeapStatistics().heap_size_limit, sourcePanelSHA256: sha(panel), sourcePanelBytes: Buffer.byteLength(panel), fragments,
  boundary: 'actual bounded current Panel effects/callbacks and producer/model/sparse/V51 runtime; finite React cells/scroller/reply gate/parsed rows', fixturesCleaned: 0 };
console.log('V52_PREPARED_PANEL_SOURCE ' + JSON.stringify(audit));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const row = (uuid, extra = {}) => ({ uuid, role: 'user', content: 'full ' + uuid, sessionId: 's',
  timestamp: '2026-10-27T00:00:00.000Z', ...extra });
const isLocal = value => value.role === 'queued' && typeof value.uuid === 'string' && value.uuid.startsWith('local-prompt-');
const local = () => row('local-prompt-current', { role: 'queued', optimisticAt: Date.now(), queueStatus: 'pending',
  promptChips: [{ text: 'complete CURRENT chip' }], imagePaths: [{ path: '/finite/full-image.png' }] });
const scope = { ownerKey: 'A', generation: 1 };

function hooks() {
  const memory = [], refs = [], effects = []; let mi = 0, ri = 0, ei = 0, queued = [];
  const same = (a, b) => a?.length === b?.length && a.every((value, at) => Object.is(value, b[at]));
  return {
    begin() { mi = ri = ei = 0; queued = []; },
    useMemo(fn, deps) { const at = mi++; if (!memory[at] || !same(memory[at].deps, deps)) memory[at] = { deps: [...deps], value: fn() }; return memory[at].value; },
    useRef(value) { const at = ri++; return refs[at] || (refs[at] = { current: value }); },
    useLayoutEffect(fn, deps) { const at = ei++; if (effects[at] && same(effects[at].deps, deps)) return;
      queued.push(() => { effects[at]?.cleanup?.(); effects[at] = { deps: [...deps], cleanup: fn() }; }); },
    flush() { for (const effect of queued) effect(); queued = []; },
    dispose() { for (const effect of effects.reverse()) effect?.cleanup?.(); },
  };
}
async function waitFor(predicate, label) {
  for (let count = 0; count < 500; count++) { if (predicate()) return; await tick(); }
  assert.fail('finite source completion: ' + label);
}

async function rig(t, { rows = [row('first'), row('target')], locals = [], prepared = true, shown = true } = {}) {
  const f = await createPrimaryAddressFixture(null, { entries: rows });
  const models = [], calls = [], notes = [], writes = [], wakes = [], diagnostics = [], effects = [], positionHooks = hooks();
  let intercept = null;
  const control = { assertCurrent() {}, checkpoint: tick }, planeOptions = { consumerKey: f.consumerKey, control };
  const route = (channel, payload) => {
    if (channel.endsWith('cancel-read')) return { success: true };
    if (channel.endsWith('get-history') && payload.readProfile === 'history-presentation-position-v1') return f.plane.openPosition(payload, planeOptions);
    if (channel.endsWith('fork-read-leaf') && payload.encoding === 'history-presentation-position-query-v2') return f.plane.forkPositionQuery(payload, planeOptions);
    return f.invoke(channel, payload);
  };
  const invoke = async (channel, payload) => { const call = { channel, payload }; calls.push(call);
    return call.response = intercept ? await intercept(channel, payload, () => route(channel, payload)) : await route(channel, payload); };
  const makeModel = () => { const model = new HistoryPrimaryRootReadModel(invoke, f.transport); model.windowDiagnostic = () => {}; models.push(model); return model; };
  const model = makeModel(), sparse = createHistoryPrimarySparsePublicationOwner({ isLocal, onReleaseError: error => notes.push(error.code) });
  const witness = createHistoryCommitWitnessDiagnostics({ enabled: () => true, now: () => 1000,
    commit: (_action, _name, packet) => { diagnostics.push(packet); return true; } });
  const env = {
    primaryPhysicalCandidate: true, historyOwnerKey: 'A', presentedOwnerKey: 'A', historyOwnerVisitState: 1, fileRewriteEpoch: 0,
    historyOwnerKeyRef: { current: 'A' }, historyOwnerGenerationRef: { current: 1 },
    primaryRoot: prepared ? model : null, primaryRootRef: { current: prepared ? model : null },
    primarySparsePublicationOwner: sparse, primaryPreparedCompatibilityRef: { current: null },
    primaryPresentationDataCommitRef: { current: null }, primaryReceiptCommitRef: { current: null }, primaryLiveCommitRef: { current: null },
    primaryCanonicalDiagnosticRef: { current: null }, primarySurfaceWitnessRef: { current: null },
    presentationEntriesRef: { current: locals }, entries: locals, transcriptEntries: locals,
    liveProjectionRef: { current: { ownerKey: 'A', entries: [] } }, visibleLiveEntries: [],
    historyCommitDiagnosticsRef: { current: witness }, historyPresentationProofRef: { current: { presented: shown, visit: 1 } },
    historyPresentationVisit: 1, surfaceLoading: false, sessionId: 's', tabId: 'finite-v52-prepared',
    historyPrimaryLiveClaimFingerprint, primaryLiveCoverageOwner: { wake: reason => wakes.push(reason) },
    consumePrimaryMaterializedPromptHandoffs() {}, consumeMaterializedPromptHandoffs() { throw Error('PRIMARY_MUST_NOT_CONSUME_NC_ARRAY'); },
    reconcileLiveProjectionAgainstDurable() { throw Error('PRIMARY_MUST_NOT_RECONCILE_NC_ARRAY'); },
    isLocalPromptEntry: isLocal, ipcRenderer: { invoke }, historyDiag: value => notes.push(value),
    createHistoryPresentationPositionOwner, createHistoryPresentationPositionQuery,
    createHistoryPreparedPositionSource, canBindHistoryPreparedPositionFrame,
    mountedSearchDemandRef: { current: null },
    primaryInputsCurrent: () => false, primaryResizeAddress: { resolveKeyOrTarget() { throw Error('READY_ROOT_ADDRESS_NOT_THIS_ORIGINAL_INTENT'); } },
    historyUserGestureGenerationRef: { current: 0 }, historyRestoreInFlightRef: { current: 1 },
    virtuosoScrollerRef: { current: { isConnected: true } }, virtuosoRef: { current: { scrollToIndex: value => writes.push(value) } },
    findHistoryUnitIndexByKey,
  };
  Object.defineProperty(env, 'rawServerEntriesRef', { get() { throw Error('PRIMARY_NC_RAW_POISON'); } });
  Object.defineProperty(env, 'committedHistoryEntriesRef', { get() { throw Error('PRIMARY_NC_COMMITTED_POISON'); } });
  Object.defineProperty(env, 'displayEntryIndexByUuidRef', { get() { throw Error('PRIMARY_NATIVE_UUID_MAP_POISON'); } });
  const payload = { ...f.payload, primaryPresentation: { localEntries: locals, liveEntries: [], liveToolResults: [],
    grouping: { enabled: false, threshold: 2, responseWork: true, expandedKeys: [] }, captionSelections: [], settingsPresentationKeys: [] } };
  if (prepared) {
    let candidateMetadata;
    await model.open(payload, {
      prepareAdopt: async candidate => { candidateMetadata = candidate.metadata.entries;
        return candidate.preparePromptAdoptionSparse(locals, locals, { isLocal, owns: () => true }); },
      adopt: (_model, proof) => {
        env.entries = proof.materializeCompatibility(candidateMetadata); env.transcriptEntries = env.entries;
        env.presentationEntriesRef.current = env.entries;
        sparse.adopt(proof, env.entries, scope);
        env.primaryPreparedCompatibilityRef.current = { origin: proof.prepared.capability, entries: model.metadata.entries };
        env.primarySurfaceWitnessRef.current = { root: model, header: model.header, entries: new WeakRef(env.entries) };
        const fact = model.metadata.canonicalMetadataFact, dataSubject = model.getReceiptDataSubject();
        env.primaryCanonicalDiagnosticRef.current = { root: model, header: model.header, dataSubject, ...scope, fact };
        const attempt = witness.begin({ ...scope, sessionId: 's', presentationVisit: 1 }, 'v52-actual-cut', 'read');
        witness.adopt(attempt, { revisionToken: model.header.semanticRevisionToken, payloadGeneration: model.header.generation,
          row: fact.diagnosticTail.kind === 'row' ? fact.diagnosticTail.row : undefined });
      },
    });
  } else sparse.publishCompatibility(env.entries, scope);
  env.primaryLocalPublicationAtRender = sparse.current();
  const setDisplay = (entries, units = buildHistoryDisplayUnits(entries, { enabled: false })) => {
    const keys = units.map(unit => unit.kind === 'group' ? String(unit.key || '') : historyLivePresentationKey(unit.entry));
    Object.assign(env, { displayEntries: entries, displayUnits: units, displayUnitItemKeys: keys });
    for (const [name, value] of [['displayEntriesRef', entries], ['displayUnitsRef', units], ['displayUnitItemKeysRef', keys]]) {
      if (env[name]) env[name].current = value; else env[name] = { current: value };
    }
  };
  setDisplay(env.entries);
  const renderData = () => {
    effects.length = 0;
    const frame = Object.assign(Object.create(env), { entries: env.entries, transcriptEntries: env.transcriptEntries,
      primaryRoot: env.primaryRoot, primaryLocalPublicationAtRender: sparse.current(),
      historyOwnerKey: env.historyOwnerKey, presentedOwnerKey: env.presentedOwnerKey,
      primaryPhysicalCandidate: env.primaryPhysicalCandidate, surfaceLoading: env.surfaceLoading,
      useLayoutEffect: fn => effects.push(fn) });
    diagnostic(frame); commit(frame); assert.equal(effects.length, 3, 'actual diagnostic, shown-data, canonical-data effects');
    const captured = effects.slice(); return { diagnostic: captured[0], shown: captured[1], canonical: captured[2], all() { captured.forEach(fn => fn()); } };
  };
  const renderPosition = () => {
    positionHooks.begin();
    env.primaryLocalPublicationAtRender = sparse.current();
    const frame = Object.assign(Object.create(env), { primaryLocalPublicationAtRender: env.primaryLocalPublicationAtRender,
      entries: env.entries, displayEntries: env.displayEntries, displayUnits: env.displayUnits,
      displayUnitItemKeys: env.displayUnitItemKeys, fileRewriteEpoch: env.fileRewriteEpoch,
      historyOwnerKey: env.historyOwnerKey, historyOwnerVisitState: env.historyOwnerVisitState,
      useMemo: positionHooks.useMemo, useRef: positionHooks.useRef, useLayoutEffect: positionHooks.useLayoutEffect });
    Object.assign(env, position(frame)); positionHooks.flush(); return env.primaryPositionOwner.capture();
  };
  const gate = () => {
    const entered = deferred(), delivery = deferred(); let raw, gated = false;
    intercept = async (channel, request, forward) => {
      const result = await forward();
      if (!gated && channel.endsWith('fork-read-leaf') && request.encoding === 'history-presentation-position-query-v2') {
        gated = true; raw = result; entered.resolve(); return delivery.promise;
      }
      return result;
    };
    return { entered: entered.promise, release() { delivery.resolve(raw); }, child: () => raw };
  };
  t.after(async () => {
    positionHooks.dispose();
    for (const name of ['primaryResizePosition', 'primaryAnchorPosition', 'primaryMountedPosition', 'primaryTimelinePosition']) env[name]?.dispose();
    await env.primaryPositionOwner?.dispose(); sparse.close();
    for (const owner of models) await owner.close(); await tick();
    f.close(); audit.fixturesCleaned++;
  });
  return { f, model, models, env, calls, notes, writes, wakes, diagnostics, sparse, payload,
    renderData, renderPosition, setDisplay, gate, makeModel, jump: resize(env),
    async readyPosition() { renderPosition(); await waitFor(() => env.primaryPositionOwner.capture() !== null, 'actual async preflight publication');
      const publication = env.primaryPositionOwner.capture(); await publication.promise; assert.equal(publication.status, 'ready'); return publication; },
  };
}

test('actual Panel data commit binds the sparse shown subject separately from canonical tail and exact canonical data subject', async t => {
  const current = local(), x = await rig(t, { locals: [current] });
  const publication = x.sparse.current(), canonicalSubject = x.model.getReceiptDataSubject();
  assert.equal(x.env.primaryPresentationDataCommitRef.current, null, 'read/adopt is not React data commit');
  x.renderData().all();
  assert.equal(x.env.primaryPresentationDataCommitRef.current.publication, publication);
  assert.equal(x.env.primaryReceiptCommitRef.current.dataSubject, canonicalSubject);
  assert.equal(x.env.primaryReceiptCommitRef.current.presentationDataSubject, publication.dataSubject);
  assert.notEqual(publication.dataSubject, canonicalSubject);
  assert.equal(x.env.primaryCanonicalDiagnosticRef.current.fact, x.model.metadata.canonicalMetadataFact);
  assert.equal(x.diagnostics.length, 1); assert.equal(x.diagnostics[0].historyWitness.uuid, 'target');
  assert.equal(x.diagnostics[0].historyWitness.rowMount, 'unqualified');
  assert.equal(x.diagnostics[0].historyWitness.browserPresentation, 'unqualified');
  assert.equal(publication.rows[0], current); assert.equal(publication.rows[0].promptChips[0].text, 'complete CURRENT chip');
  assert.deepEqual(x.wakes, ['commit']);
});

test('hidden and header-null current-only data commits never fabricate canonical or painted evidence', async t => {
  const x = await rig(t, { prepared: false, shown: false, locals: [local()] });
  x.renderData().all();
  const committed = x.env.primaryPresentationDataCommitRef.current;
  assert.equal(committed.publication.kind, 'current-local-only'); assert.equal(committed.publication.prepared, null);
  assert.equal(x.env.primaryReceiptCommitRef.current, null); assert.equal(x.env.primaryLiveCommitRef.current, null);
  assert.equal(x.diagnostics.length, 0); assert.equal(x.model.header, null);
  assert.equal(x.calls.filter(call => call.channel.endsWith('get-history')).length, 0);
  const prepared = await rig(t, { shown: false });
  const publication = prepared.sparse.current(); await prepared.model.close();
  prepared.env.primaryRoot = null; prepared.env.primaryRootRef.current = null;
  prepared.renderData().all();
  assert.equal(prepared.env.primaryPresentationDataCommitRef.current.publication, publication);
  assert.equal(prepared.env.primaryReceiptCommitRef.current, null); assert.equal(prepared.diagnostics.length, 0);
  assert.equal((await publication.prepared.readMetadataOrdinal(1)).uuid, 'target');
});

test('stale equal-count render and a newly opened canonical subject cannot certify a different sparse shown publication', async t => {
  const x = await rig(t); x.renderData().all();
  const old = x.sparse.current(), stale = x.renderData(), copy = x.env.entries.slice();
  x.env.entries = copy; x.env.transcriptEntries = copy; x.env.presentationEntriesRef.current = copy;
  x.sparse.publishCompatibility(copy, scope);
  stale.all(); assert.equal(x.env.primaryPresentationDataCommitRef.current, null);
  assert.notEqual(x.sparse.current(), old);
  const next = x.makeModel(); x.f.setEntries([row('first'), row('target')]); await next.open(x.payload);
  x.env.primaryRoot = next; x.env.primaryRootRef.current = next;
  x.env.primarySurfaceWitnessRef.current = { root: next, header: next.header, entries: new WeakRef(copy) };
  x.renderData().all();
  assert.equal(x.env.primaryPresentationDataCommitRef.current.publication, x.sparse.current());
  assert.notEqual(x.sparse.current().prepared.receiptDataSubject, next.getReceiptDataSubject());
  assert.equal(x.env.primaryReceiptCommitRef.current, null, 'equal counts and a naked adopted header are not committed source authority');
});

test('actual pending resize V51 intent completes on its original shown frame across model close and new Root readiness', async t => {
  const id = 'target\0\ud800😀'.repeat(25), x = await rig(t, { rows: [row('first'), row(id)] });
  const publication = await x.readyPosition(), before = x.env.primaryPositionOwner.stats();
  assert.equal(before.unitVisits, 0, 'genuine exact prepared metadata must bind the selected adapter: ' + JSON.stringify(x.notes));
  await x.model.close(); x.env.primaryRoot = null; x.env.primaryRootRef.current = null;
  const gate = x.gate(), pending = x.jump('no-longer-physical-key', id);
  let failure; pending.catch(error => { failure = error; });
  try {
    await gate.entered;
    const next = x.makeModel(); await next.open(x.payload);
    x.env.primaryRoot = next; x.env.primaryRootRef.current = next;
    assert.equal(x.renderPosition(), publication);
    assert.equal(x.env.primaryPositionOwner.stats().registrations, before.registrations);
    for (const array of [x.env.displayUnits, x.env.displayUnitItemKeys]) for (let i = 0; i < array.length; i++) {
      Object.defineProperty(array, i, { configurable: true, get() { throw Error('NATIVE_FRAME_READ_AFTER_REGISTRATION'); } });
    }
    assert.equal(x.writes.length, 0); gate.release();
    assert.equal(await pending, true); assert.equal(failure, undefined);
    assert.deepEqual(x.writes, [{ index: 1, align: 'start', behavior: 'auto' }]);
    assert.equal(x.env.primaryPositionOwner.stats().queries - before.queries, 1);
    const selected = await x.env.primaryResizePosition.resolve(publication, id);
    assert.equal(selected.address.index, 1); assert.equal(x.env.primaryPositionOwner.entryAt(selected.address).uuid, id);
    assert.equal(x.env.primaryPositionOwner.stats().queries - before.queries, 1, 'same original lane cached the completed query');
    assert(x.calls.some(call => call.payload.operation === 'selection'));
  } finally { gate.release(); }
});

for (const change of ['frame', 'rewrite']) test('actual ' + change + ' replacement cancels the old pending selected intent before any physical write', async t => {
  const x = await rig(t), original = await x.readyPosition();
  await x.model.close(); x.env.primaryRoot = null; x.env.primaryRootRef.current = null;
  const gate = x.gate(), pending = x.jump('old-physical-key', 'target');
  try {
    await gate.entered;
    if (change === 'rewrite') x.env.fileRewriteEpoch++;
    else x.setDisplay(x.env.displayEntries.slice().reverse());
    x.renderPosition();
    await waitFor(() => x.env.primaryPositionOwner.capture() !== original, 'new exact frame publication');
    assert.equal(x.env.primaryPositionOwner.owns(original), false);
    assert.equal(await pending, true); assert.deepEqual(x.writes, []);
    gate.release();
    const next = x.env.primaryPositionOwner.capture(); await next.promise;
    assert.equal(next.status, 'ready'); assert.notEqual(next.frame, original.frame);
    const selected = await x.env.primaryResizePosition.resolve(next, 'target');
    assert.equal(selected.address.index, change === 'frame' ? 0 : 1);
    assert.deepEqual(x.writes, [], 'query readiness itself never writes or retries a gesture');
  } finally { gate.release(); }
});

test('actual preflight retains the explicitly diagnosed native compatibility adapter for an unbound shown clone', async t => {
  const x = await rig(t), clone = { ...x.env.entries[1], sourceIdentity: 'actual-unmigrated-decoration' };
  x.setDisplay([x.env.entries[0], clone]);
  const publication = await x.readyPosition();
  assert(x.notes.some(value => typeof value === 'string' && value.includes('POSITION_NATIVE_COMPATIBILITY_OPEN')));
  const selected = await x.env.primaryResizePosition.resolve(publication, 'target');
  assert.equal(selected.status, 'ready'); assert.equal(x.env.primaryPositionOwner.entryAt(selected.address), clone);
  assert.equal(x.env.primaryPositionOwner.stats().unitVisits, 2);
  assert.equal(x.calls.filter(call => call.channel.endsWith('get-history')
    && call.payload.readProfile === 'history-presentation-position-v1').length, 1, 'one chosen adapter, no fallback reopen');
});

test.after(() => console.log('V52_PREPARED_PANEL_COMPLETE ' + JSON.stringify({ fixturesCleaned: audit.fixturesCleaned,
  sourcePanelSHA256: audit.sourcePanelSHA256, boundary: audit.boundary })));
