// V50 finite SOURCE controls. Real producer/store/read-plane/shared client/model,
// prompt prepare/adopt, diagnostic helper and bounded verbatim Panel callbacks.
// Already parsed synthetic rows, private Node SQLite, in-process IPC and a finite
// React/ref frame replace Electron/native ingestion. No mounted/paint/latency claim.
// Run alone: node --max-old-space-size=128 --max-semi-space-size=8 --test --test-isolation=none scripts/history-primary-metadata-panel-source.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import { HistoryPrimaryRootReadModel, historyPrimaryLiveClaimFingerprint } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import { captureHistoryPrimaryPanelWitness } from '../src/renderer/utils/historyPrimaryPanelBindings.mjs';
import { createHistoryCommitWitnessDiagnostics } from '../src/renderer/utils/uiPerformanceDiagnostics.mjs';
import { historyPrimaryCompositionRequestClass } from '../src/renderer/utils/historyPrimaryRequestRouting.mjs';
import { createHistoryPrimarySparsePublicationOwner } from '../src/renderer/utils/historyPrimarySparsePublication.mjs';
const require = createRequire(import.meta.url), ts = require(process.env.NOTED_TYPESCRIPT_PATH || 'typescript');
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
const { materializeHistoryCursorSync } = require('../src/main/history-root-engine/main/history-paged-store.js');
assert(getHeapStatistics().heap_size_limit <= 192 * 1024 ** 2, 'finite Node heap required');
globalThis.window = { require };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const panel = fs.readFileSync(new URL('../src/renderer/components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
function between(start, end) {
  const a = panel.indexOf(start), b = panel.indexOf(end, a + start.length);
  assert(a >= 0 && b > a && panel.indexOf(start, a + start.length) < 0, 'unique actual source: ' + start);
  const fragment = panel.slice(a, b);
  assert(Buffer.byteLength(fragment) < 16 * 1024, 'bounded callback only, no full Panel AST');
  return fragment;
}
const blocks = {
  filter: between('const filterSuppressedPromptEntries = (', 'const findServerPromptEntry = ('),
  publish: between('  const publishHistoryRows = useCallback(', '  const primaryLocalPublicationAtRender ='),
  viewGuard: between('        const viewWitness = { entries: presentationEntriesRef.current, live: liveProjectionRef.current,', '        if (!model.header) {'),
  prepare: between('          prepareAdopt: async (candidate) => {', '          adopt: (adopted, promptAdoption) => {'),
  adopt: between('          adopt: (adopted, promptAdoption) => {', '\n          });\n        } catch (error) {'),
  diagnostic: between('  // This render\'s candidate and O(1) sample are committed data', '  // Capture the actual render\'s cut before the layout effect'),
  commit: between('  // Capture the actual render\'s cut before the layout effect', '  // Bind coverage to THIS render\'s committed canonical cut'),
  cleanupDiagnostic: between('      const diagnosticAtCleanup = primaryCanonicalDiagnosticRef.current;', '      viewportPaintProbeRef.current?.cancel(viewportPaintOwner);'),
  compositeDiagnostic: between('        if (primaryCanonicalDiagnosticRef.current?.root === model)', '        void model.close();'),
  compositeTransition: between("        if (requestClass === 'view' || outcome.kind !== 'legacy' || outcome.result?.capability !== 'legacy-composite'",
    '      }\n      let result = await readHistoryThroughIpc'),
};
function compile(name, fragment) {
  const wrapped = name === 'prepare' || name === 'adopt' ? 'const options = {\n' + fragment + '\n};' : fragment;
  const output = ts.transpileModule(wrapped, { fileName: 'bounded-v50-panel.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  assert.deepEqual(output.diagnostics || [], []);
  const returned = name === 'prepare' ? 'return options.prepareAdopt;' : name === 'adopt' ? 'return options.adopt;'
    : name === 'viewGuard' ? 'return {viewWitness,viewCurrent,viewPublicationEntries};'
    : name === 'filter' ? 'return {filterSuppressedPromptEntries,isLocalPromptEntry,isLocalRewindEntry,isLocalCompactErrorEntry};'
    : name === 'publish' ? 'return publishHistoryRows;' : '';
  return new Function('env', 'with (env) {\n' + output.outputText + '\n' + returned + '\n}');
}
const compiled = Object.fromEntries(Object.entries(blocks).map(([name, fragment]) => [name, compile(name, fragment)]));
console.log('V50_PANEL_SOURCE ' + JSON.stringify({ panelSHA256: sha(panel), panelBytes: Buffer.byteLength(panel),
  fragments: Object.fromEntries(Object.entries(blocks).map(([name, text]) => [name, { bytes: Buffer.byteLength(text), sha256: sha(text) }])),
  node: process.version, typescript: ts.version, heapLimit: getHeapStatistics().heap_size_limit, electron: process.versions.electron || null }));
const row = (uuid, extra = {}) => ({ uuid, role: 'user', content: 'full value ' + uuid, sessionId: 's',
  timestamp: '2026-10-27T12:00:00.000Z', sourceIdentity: 'source:' + uuid, ...extra });
const local = () => row('local-prompt-owned', { role: 'queued', content: 'current \ud800 🧪 draft',
  handoffId: 'owned', queueStatus: 'sending', optimisticAt: Date.now(), promptChips: [{ kind: 'prompt', text: 'full chip' }],
  imagePaths: [{ id: 'image', path: '/finite/full.png' }] });

async function rig(rows, { queued = false, primary = true, shown = true, initial = [], live = [], actualViewGuard = false } = {}) {
  const f = await createPrimaryAddressFixture(null, { entries: rows });
  const model = new HistoryPrimaryRootReadModel(f.invoke, f.transport); model.windowDiagnostic = () => {};
  const diagnostics = [], wakes = [], consumption = [], legacyReconciliation = [], updates = [];
  let fingerprintCalls = 0, settingsCalls = 0, sequence = 0, liveState = live;
  const witness = createHistoryCommitWitnessDiagnostics({ enabled: () => true, now: () => 1000 + sequence,
    commit: (action, name, packet) => { diagnostics.push({ action, name, ...packet }); return true; } });
  const env = {
    primaryPhysicalCandidate: primary, primaryRoot: primary ? model : null, primaryRootRef: { current: primary ? model : null },
    historyOwnerKey: 'A', presentedOwnerKey: 'A', historyOwnerKeyRef: { current: 'A' }, historyOwnerGenerationRef: { current: 1 },
    ownerKeyAtStart: 'A', generationAtStart: 1, generation: 1, model, tabId: 't', sessionId: 's', historySnapshotOwner: {},
    requestClass: 'source', requestVersion: 1, primaryRequestVersionRef: { current: 1 },
    signal: undefined, viewCurrent: () => true, isCurrentOwner: () => env.historyOwnerKeyRef.current === 'A' && env.historyOwnerGenerationRef.current === 1,
    primarySurfaceWitnessRef: { current: null }, primaryCanonicalDiagnosticRef: { current: null },
    primaryReceiptCommitRef: { current: null }, primaryLiveCommitRef: { current: null },
    primaryPreparedCompatibilityRef: { current: null }, primaryPresentationDataCommitRef: { current: null },
    historyCommitDiagnosticsRef: { current: witness }, historyPresentationProofRef: { current: { presented: shown, visit: 1 } },
    historyPresentationVisit: 1, surfaceLoading: false, historyDiagnosticAttempt: null,
    presentationEntriesRef: { current: initial }, entries: initial, transcriptEntries: initial,
    suppressedPromptsRef: { current: new Map() }, capturedSuppressionCount: 0,
    composition: { localEntries: initial, liveEntries: [], liveToolResults: [],
      grouping: { enabled: false, responseWork: true, threshold: 2, expandedKeys: [] }, captionSelections: [], settingsPresentationKeys: [] },
    compositionFingerprint: 'finite-current-input-witness', viewWitness: { rewind: null },
    primaryCompositionAppliedRef: { current: null }, primarySuppressionCountAppliedRef: { current: null },
    liveProjectionRef: { current: { ownerKey: 'A', entries: live } }, primaryLiveCoverageOwner: { wake: reason => wakes.push(reason) },
    liveToolResultsRef: { current: { ownerKey: 'A', results: new Map() } },
    useUIStore: { getState: () => ({ historyRewindPreviews: { t: null } }) }, historyPrimaryCompositionRequestClass,
    lastServerEntryUuidsRef: { current: new Set() }, historyPresentationApplyGuardRef: { current() {} },
    payloadGenerationRef: { current: null }, physicalFileIdentityRef: { current: null }, historyRevisionRef: { current: null },
    rewindPrefixOnScreenRef: { current: null }, historyLoaderReasonRef: { current: '' }, loadSequence: 1,
    LOCAL_PROMPT_PREFIX: 'local-prompt-', LOCAL_REWIND_PREFIX: 'local-rewind-', LOCAL_COMPACT_ERROR_PREFIX: 'local-compact-error-',
    captureHistoryPrimaryPanelWitness, historyPrimaryLiveClaimFingerprint: value => { fingerprintCalls++; return historyPrimaryLiveClaimFingerprint(value); },
    entryMatchesSuppressedPrompt() { throw Error('FINITE_FILTER_EXPECTS_NO_SUPPRESSIONS'); },
    reconcileCodexEffectiveSettings(_tab, _session, empty, options) { assert.deepEqual(empty, []); assert('effective' in options); settingsCalls++; },
    persistVolatileOverlay() {}, setPayloadGeneration() {}, setPrimaryRoot(value) { env.primaryRoot = value; },
    setPrimaryRootRevision() {}, setChipsFreshOwnerKey() {}, setHistoryLoadError() {}, setLoading() {}, historyDiag() {},
    setEntries(value) { const update = () => { env.entries = typeof value === 'function' ? value(env.entries) : value; env.transcriptEntries = env.entries; };
      if (queued) updates.push(update); else update(); },
    reconcileLiveProjectionAgainstDurable(entries, owner) { legacyReconciliation.push({ entries, owner }); },
    consumeMaterializedPromptHandoffs(entries) { consumption.push({ kind: 'legacy', entries }); },
    consumePrimaryMaterializedPromptHandoffs() { consumption.push({ kind: 'primary', commit: env.primaryReceiptCommitRef.current }); },
    useLayoutEffect() {}, useCallback: fn => fn,
  };
  if (primary) {
    env.rawServerEntriesRef = { get current() { throw Error('PRIMARY_CANONICAL_RAW_READ'); }, set current(_v) { throw Error('PRIMARY_CANONICAL_RAW_WRITE'); } };
    env.committedHistoryEntriesRef = { get current() { throw Error('PRIMARY_CANONICAL_COMMITTED_READ'); }, set current(_v) { throw Error('PRIMARY_CANONICAL_COMMITTED_WRITE'); } };
  } else {
    env.rawServerEntriesRef = { current: rows };
    env.committedHistoryEntriesRef = { current: { ownerKey: '', entries: [] } };
  }
  env.primaryPresentationRef = { current: env.composition };
  if (actualViewGuard) env.composition.liveToolResults = null;
  Object.assign(env, compiled.filter(env));
  env.primarySparsePublicationOwner = createHistoryPrimarySparsePublicationOwner({
    isLocal: entry => env.isLocalPromptEntry(entry) || env.isLocalRewindEntry(entry) || env.isLocalCompactErrorEntry(entry),
    onReleaseError: error => { throw error; },
  });
  env.primarySparsePublicationOwner.publishCompatibility(initial, { ownerKey: 'A', generation: 1 });
  env.publishHistoryRows = compiled.publish(env);
  const prepare = compiled.prepare(env), adopt = compiled.adopt(env);
  const payload = { ...f.payload, primaryPresentation: env.composition };
  const nextAttempt = () => { sequence++; env.historyDiagnosticAttempt = witness.begin({ ownerKey: 'A', sessionId: 's', generation: 1,
    presentationVisit: 1 }, 'action-' + sequence, 'read'); };
  const open = async (request = payload) => { nextAttempt();
    env.requestClass = request.primaryRequestClass || 'source'; env.requestVersion = env.primaryRequestVersionRef.current;
    if (actualViewGuard) Object.assign(env, compiled.viewGuard(env));
    else {
      env.viewWitness = { entries: env.presentationEntriesRef.current, live: env.liveProjectionRef.current,
        results: env.liveToolResultsRef.current, rewind: env.useUIStore.getState().historyRewindPreviews[env.tabId] };
      env.viewPublicationEntries = { current: env.viewWitness.entries };
    }
    return model.open(request, {
    signal: env.signal, owns: () => env.isCurrentOwner() && (!actualViewGuard || env.viewCurrent()), prepareAdopt: prepare, adopt,
  }); };
  const render = () => {
    const primaryLocalPublicationAtRender = env.primarySparsePublicationOwner.publishCompatibility(env.entries, {
      ownerKey: env.historyOwnerKeyRef.current, generation: env.historyOwnerGenerationRef.current,
    });
    env.presentationEntriesRef.current = env.entries;
    const effects = [], frame = Object.assign(Object.create(env), {
      entries: env.entries, transcriptEntries: env.transcriptEntries, primaryRoot: env.primaryRoot,
      historyOwnerKey: env.historyOwnerKey, presentedOwnerKey: env.presentedOwnerKey, sessionId: env.sessionId,
      primaryPhysicalCandidate: env.primaryPhysicalCandidate, surfaceLoading: env.surfaceLoading,
      historyPresentationVisit: env.historyPresentationVisit, primaryLocalPublicationAtRender,
      useLayoutEffect: fn => effects.push(fn),
    });
    compiled.diagnostic(frame); compiled.commit(frame); assert.equal(effects.length, 3);
    return { diagnostic: effects[0], data() { effects[1](); effects[2](); }, all() { effects.forEach(effect => effect()); } };
  };
  return { f, model, env, payload, open, render, nextAttempt, witness, diagnostics, wakes, consumption, legacyReconciliation,
    get fingerprints() { return fingerprintCalls; }, get settingsCalls() { return settingsCalls; },
    flush() { while (updates.length) updates.shift()(); },
    async close() { env.primarySparsePublicationOwner.close(); await model.close();
      await new Promise(resolve => setImmediate(resolve)); f.close(); } };
}

test('actual primary prepare/adopt/diagnostic/data commit bypass poisoned Nc arrays and preserve selected tail identity', async () => {
  const own = local(), tail = row('tail', { contentRevision: 'content-revision', recordByteOffset: 37 });
  const h = await rig([row('first'), tail], { initial: [own], live: [row('stream', { liveProjection: true })] });
  try {
    await h.open(); assert.equal(h.settingsCalls, 1);
    assert.equal(h.env.entries.at(-1), own, 'current full draft/chips/images remain the owned object');
    assert.equal(h.model.metadata.entries[0].rowStub, true, 'prepared decoder is genuine');
    const selected = h.env.primaryCanonicalDiagnosticRef.current;
    assert.equal(selected.fact, h.model.metadata.canonicalMetadataFact);
    assert.equal(selected.fact.diagnosticTail.kind, 'row');
    assert.equal(h.witness.candidate().row.deref(), selected.fact.diagnosticTail.row);
    h.render().all();
    assert.equal(h.diagnostics.length, 1); assert.equal(h.diagnostics[0].historyWitness.uuid, 'tail');
    assert.equal(h.diagnostics[0].historyWitness.qualification, 'durable-row-reference');
    assert.equal(h.diagnostics[0].historyWitness.rowMount, 'unqualified');
    assert.equal(h.diagnostics[0].historyWitness.browserPresentation, 'unqualified');
    assert.equal(h.env.primaryReceiptCommitRef.current.dataSubject, h.model.getReceiptDataSubject());
    assert.equal(h.env.primaryLiveCommitRef.current.live, h.env.liveProjectionRef.current);
    assert.deepEqual(h.wakes, ['commit']); assert.equal(h.consumption[0].kind, 'primary');
    assert.equal(h.consumption[0].commit, h.env.primaryReceiptCommitRef.current);
    assert.deepEqual(h.legacyReconciliation, []); assert.equal(h.model.window.size, 0);
    assert.throws(() => h.env.rawServerEntriesRef.current, /RAW_READ/);
    assert.throws(() => h.env.committedHistoryEntriesRef.current, /COMMITTED_READ/);
  } finally { await h.close(); }
});

test('hidden/background actual data commit still publishes receipt/live and wakes handoffs without mounted or diagnostic presentation', async () => {
  const h = await rig([row('tail')], { shown: false, live: [row('stream', { liveProjection: true })] });
  try { await h.open(); h.render().all(); assert.equal(h.diagnostics.length, 0);
    assert(h.env.primaryReceiptCommitRef.current); assert(h.env.primaryLiveCommitRef.current);
    assert.deepEqual(h.wakes, ['commit']); assert.equal(h.consumption[0].kind, 'primary'); assert.equal(h.model.window.size, 0);
  } finally { await h.close(); }
});

test('selected diagnostic fields preserve the old canonical-tail helper result including omissions and live qualification', async () => {
  for (const tail of [
    row('durable', { recordByteOffset: 42, contentRevision: 'revision-\ud800' }),
    row('live', { liveProjection: true, sourceSequence: 9 }),
    row('invalid-strings', { sourceIdentity: 'x'.repeat(513), contentRevision: 'www.invalid.example', recordByteOffset: -1 }),
    row('invalid-object', { sourceIdentity: { nested: ['not a diagnostic string'] }, contentRevision: false, recordByteOffset: 0 }),
  ]) {
    const h = await rig([tail]);
    try {
      await h.open();
      // Finite legacy oracle only. Production never materializes this Nc row:
      // both the new Panel and cold model controls keep canonical access poison.
      const primary = h.f.plane.state(h.model.view.root, h.f.consumerKey).primaryPresentation;
      const oldRow = materializeHistoryCursorSync(primary.durableMetadataCursor.at(0));
      let oldPacket;
      const old = createHistoryCommitWitnessDiagnostics({ enabled: () => true, now: () => 1001,
        commit: (_action, _name, packet) => { oldPacket = packet.historyWitness; return true; } });
      const identity = { ownerKey: 'A', sessionId: 's', generation: 1, presentationVisit: 1 };
      old.adopt(old.begin(identity, 'action-1', 'read'), {
        revisionToken: h.model.header.semanticRevisionToken || h.model.header.revision,
        payloadGeneration: h.model.header.generation, row: oldRow,
      });
      old.commit(old.candidate(), identity, oldRow); h.render().diagnostic();
      assert.equal(h.diagnostics.length, 1); assert.deepEqual(h.diagnostics[0].historyWitness, oldPacket);
    } finally { await h.close(); }
  }
});

test('checked empty canonical domain commits undefined tail; unavailable primary evidence never takes that empty branch', async () => {
  const h = await rig([]);
  try { await h.open(); assert.deepEqual(h.model.metadata.canonicalMetadataFact.diagnosticTail, { kind: 'empty' });
    h.render().all(); assert.equal(h.diagnostics.length, 1); assert.equal(h.diagnostics[0].historyWitness.qualification, 'unqualified-row');
    h.env.primaryCanonicalDiagnosticRef.current = null; h.nextAttempt();
    h.witness.adopt(h.env.historyDiagnosticAttempt, { revisionToken: 'unavailable-is-not-empty', row: undefined });
    h.render().diagnostic(); assert.equal(h.diagnostics.length, 1);
    h.env.primaryRootRef.current = null; h.env.primaryRoot = null; h.render().data();
    assert.equal(h.env.primaryReceiptCommitRef.current, null);
  } finally { await h.close(); }
});

for (const mode of ['legacy', 'explicit-composite']) test('actual ' + mode + ' data commit retains real arrays and ordinary filtering', async () => {
  const durable = row('durable'), queuedRow = local(), streaming = row('stream', { liveProjection: true });
  const h = await rig([durable, queuedRow, streaming], { primary: false, initial: [durable, queuedRow, streaming] });
  try {
    if (mode === 'explicit-composite') {
      // Exercise the actual transport/model unsupported marker and the real
      // Panel transition before its next render reaches the legacy effect.
      h.model.invoke = (channel, payload) => channel === 'agent-transcript:get-history'
        ? Promise.resolve({ success: false, capability: 'legacy-composite', error: 'HISTORY_ROOT_COMPOSITE_NOT_MIGRATED' })
        : h.f.invoke(channel, payload);
      h.env.outcome = await h.model.open(h.payload);
      assert.equal(h.env.outcome.kind, 'legacy');
      h.env.requestClass = 'source'; h.env.primaryCompositeOwnerRef = { current: '' };
      h.env.primaryRootRef.current = h.model; h.env.primaryRoot = h.model;
      compiled.compositeTransition(h.env);
      assert.equal(h.env.primaryCompositeOwnerRef.current, 'A'); assert.equal(h.model.closed, true);
      assert.equal(h.env.primaryRootRef.current, null); assert.equal(h.env.primaryRoot, null);
    }
    h.nextAttempt(); h.witness.adopt(h.env.historyDiagnosticAttempt, { revisionToken: 'legacy-revision', row: streaming });
    h.render().all(); assert.equal(h.legacyReconciliation.length, 1);
    assert.equal(h.legacyReconciliation[0].entries, h.env.entries);
    assert.deepEqual(h.env.committedHistoryEntriesRef.current, { ownerKey: 'A', entries: [durable] });
    assert.equal(h.consumption[0].kind, 'legacy'); assert.deepEqual(h.consumption[0].entries, [durable]);
    assert.equal(h.env.primaryReceiptCommitRef.current, null);
  } finally { await h.close(); }
});

test('queued React adoption does not certify former prepared entries or tail before the actual commit', async () => {
  const h = await rig([row('tail')], { queued: true });
  try { await h.open(); h.render().all(); assert.equal(h.diagnostics.length, 0); assert.equal(h.env.primaryReceiptCommitRef.current, null);
    h.flush(); h.render().all(); assert.equal(h.diagnostics.length, 1); assert(h.env.primaryReceiptCommitRef.current);
  } finally { await h.close(); }
});

for (const mutation of ['owner', 'generation', 'root', 'header', 'entries']) test('captured actual diagnostic/data commit refuses moved ' + mutation, async () => {
  const h = await rig([row('tail')]);
  try { await h.open(); const effects = h.render();
    if (mutation === 'owner') h.env.historyOwnerKeyRef.current = 'B';
    if (mutation === 'generation') h.env.historyOwnerGenerationRef.current++;
    if (mutation === 'root') h.env.primaryRootRef.current = null;
    if (mutation === 'header') await h.model.open({ ...h.payload, primaryRequestClass: 'view', primaryViewOptions: { grouping: h.env.composition.grouping, captionSelections: [] } });
    if (mutation === 'entries') h.env.presentationEntriesRef.current = [local()];
    effects.all(); assert.equal(h.diagnostics.length, 0);
    assert.equal(h.env.primaryReceiptCommitRef.current, null);
  } finally { await h.close(); }
});

test('checked same-data view rebind preserves tail/data subject and receipt independently of a Panel render', async () => {
  const h = await rig([row('tail')]);
  try { await h.open(); h.render().all(); const subject = h.model.getReceiptDataSubject();
    const tail = h.model.metadata.canonicalMetadataFact.diagnosticTail.row, commit = h.env.primaryReceiptCommitRef.current;
    const header = h.model.header;
    await h.model.open({ ...h.payload, primaryRequestClass: 'view', primaryViewOptions: { grouping: { ...h.env.composition.grouping, enabled: true }, captionSelections: [] } });
    assert.notEqual(h.model.header, header); assert.equal(h.model.getReceiptDataSubject(), subject);
    assert.equal(h.model.metadata.canonicalMetadataFact.diagnosticTail.row, tail); assert.equal(h.env.primaryReceiptCommitRef.current, commit);
    assert.equal(h.diagnostics.length, 1); assert.equal(h.model.window.size, 0);
    await h.open({ ...h.payload, primaryRequestClass: 'view', primaryViewOptions: { grouping: h.env.composition.grouping, captionSelections: [] } });
    assert.equal(h.witness.candidate().row.deref(), tail); h.render().all();
    assert.equal(h.diagnostics.length, 2); assert.equal(h.env.primaryReceiptCommitRef.current.dataSubject, subject);
  } finally { await h.close(); }
});

test('verbatim actual view guard accepts only its own prepared successor and completes the adopted wakes', async () => {
  const h = await rig([row('tail')], { actualViewGuard: true });
  try {
    await h.open(); h.render().all();
    const oldHeader = h.model.header, subject = h.model.getReceiptDataSubject(), originalEntries = h.env.presentationEntriesRef.current;
    const tail = h.env.primaryCanonicalDiagnosticRef.current.fact.diagnosticTail.row;
    let metadataWakes = 0, receiptWakes = 0; const off = h.model.onMetadata(() => metadataWakes++);
    const offReceipt = h.model.onReceiptReadWake(() => receiptWakes++);
    const outcome = await h.open({ ...h.payload, primaryRequestClass: 'view', primaryViewOptions: {
      grouping: h.env.composition.grouping, captionSelections: [] } });
    assert.equal(outcome.kind, 'root');
    off(); offReceipt();
    // The original owner/non-row witnesses remain; only our exact proved
    // publication may advance the request's expected entries reference.
    assert.notEqual(h.model.header, oldHeader); assert.equal(h.env.viewCurrent(), true);
    assert.equal(h.env.viewWitness.entries, originalEntries);
    assert.notEqual(h.env.presentationEntriesRef.current, originalEntries);
    assert.equal(metadataWakes, 1); assert.equal(receiptWakes, 1);
    assert.equal(h.env.primaryCanonicalDiagnosticRef.current.header, h.model.header);
    assert.equal(h.env.primaryCanonicalDiagnosticRef.current.fact.diagnosticTail.row, tail);
    assert.equal(h.witness.candidate().row.deref(), tail);
    assert.equal(h.model.getReceiptDataSubject(), subject);
    h.render().all(); assert.equal(h.diagnostics.length, 2);
    assert.equal(h.env.primaryReceiptCommitRef.current.dataSubject, subject);
  } finally { await h.close(); }
});

test('actual post-apply view fences retain every original non-row subject after a reentrant setter', async () => {
  for (const changed of ['entries', 'request', 'root', 'live', 'results', 'rewind', 'getter-owner', 'getter-root', 'getter-header', 'getter-abort']) {
    const h = await rig([row('tail')], { actualViewGuard: true });
    try {
      await h.open(); const selected = h.env.primaryCanonicalDiagnosticRef.current, candidate = h.witness.candidate();
      const set = h.env.setEntries, controller = new AbortController();
      h.env.signal = controller.signal;
      h.env.setEntries = value => {
        set(value);
        if (changed === 'entries') h.env.presentationEntriesRef.current = [...value];
        if (changed === 'request') h.env.primaryRequestVersionRef.current++;
        if (changed === 'root') h.env.primaryRootRef.current = {};
        if (changed === 'live') h.env.liveProjectionRef.current = { ownerKey: 'A', entries: [] };
        if (changed === 'results') h.env.liveToolResultsRef.current = { ownerKey: 'A', results: new Map() };
        if (changed === 'rewind') h.env.useUIStore.getState = () => ({ historyRewindPreviews: { t: { changed: true } } });
        if (changed.startsWith('getter-')) h.env.useUIStore.getState = () => {
          if (changed === 'getter-owner') h.env.historyOwnerGenerationRef.current++;
          if (changed === 'getter-root') h.env.primaryRootRef.current = {};
          if (changed === 'getter-header') h.model.view.header = { ...h.model.header };
          if (changed === 'getter-abort') controller.abort();
          return { historyRewindPreviews: { t: null } };
        };
      };
      await assert.rejects(h.open({ ...h.payload, primaryRequestClass: 'view', primaryViewOptions: {
        grouping: h.env.composition.grouping, captionSelections: [] } }), error => error.code === 'HISTORY_READ_CANCELLED');
      assert.equal(h.env.primaryCanonicalDiagnosticRef.current, selected);
      assert.equal(h.witness.candidate(), candidate); assert.equal(h.env.viewCurrent(), false);
    } finally { await h.close(); }
  }
});

test('same-count new source gets new subject/tail and rejects old captured diagnostic commit', async () => {
  const h = await rig([row('first')]);
  try { await h.open(); const old = h.render(), subject = h.model.getReceiptDataSubject();
    const tail = h.model.metadata.canonicalMetadataFact.diagnosticTail.row;
    h.f.setEntries([row('replacement')]); await h.open(); old.diagnostic();
    assert.equal(h.diagnostics.length, 0); assert.notEqual(h.model.getReceiptDataSubject(), subject);
    assert.notEqual(h.model.metadata.canonicalMetadataFact.diagnosticTail.row, tail);
    h.render().all(); assert.equal(h.diagnostics[0].historyWitness.uuid, 'replacement');
  } finally { await h.close(); }
});

test('stale captured layout never clears a newer foreign receipt/live commit', async () => {
  const h = await rig([row('tail')]);
  try { await h.open(); const effects = h.render();
    const foreign = Object.freeze({ ownerKey: 'B' }), foreignLive = Object.freeze({ ownerKey: 'B', live: true });
    h.env.historyOwnerKeyRef.current = 'B'; h.env.historyOwnerGenerationRef.current++;
    h.env.primaryReceiptCommitRef.current = foreign; h.env.primaryLiveCommitRef.current = foreignLive;
    effects.all(); assert.equal(h.env.primaryReceiptCommitRef.current, foreign);
    assert.equal(h.env.primaryLiveCommitRef.current, foreignLive); assert.equal(h.diagnostics.length, 0);
    assert.deepEqual(h.wakes, []); assert.deepEqual(h.consumption, []);
  } finally { await h.close(); }
});

test('closed root refuses captured effects and actual owner/composite cleanup drops only its selected sample', async () => {
  const h = await rig([row('tail')]);
  try {
    await h.open(); const effects = h.render(), selected = h.env.primaryCanonicalDiagnosticRef.current;
    await h.model.close(); effects.all();
    assert.equal(h.diagnostics.length, 0); assert.equal(h.env.primaryReceiptCommitRef.current, null);
    compiled.cleanupDiagnostic(h.env); assert.equal(h.env.primaryCanonicalDiagnosticRef.current, null);
    h.env.primaryCanonicalDiagnosticRef.current = selected;
    compiled.compositeDiagnostic(h.env); assert.equal(h.env.primaryCanonicalDiagnosticRef.current, null);
    const foreign = Object.freeze({ ownerKey: 'B', generation: 2, root: {} });
    h.env.primaryCanonicalDiagnosticRef.current = foreign;
    compiled.cleanupDiagnostic(h.env); compiled.compositeDiagnostic(h.env);
    assert.equal(h.env.primaryCanonicalDiagnosticRef.current, foreign, 'older cleanup cannot release a newer sample');
  } finally { await h.close(); }
});

test('native current-live fingerprint reentry cannot publish or retain the revoked commit', async () => {
  const h = await rig([row('tail')], { live: [row('stream', { liveProjection: true })] });
  try { await h.open(); const fingerprint = h.env.historyPrimaryLiveClaimFingerprint;
    h.env.historyPrimaryLiveClaimFingerprint = value => {
      const result = fingerprint(value); h.env.historyOwnerGenerationRef.current++; return result;
    };
    h.render().data(); assert.equal(h.env.primaryReceiptCommitRef.current, null);
    assert.equal(h.env.primaryLiveCommitRef.current, null);
    assert.equal(h.consumption[0].commit, null, 'the existing handoff owner sees no authority');
  } finally { await h.close(); }
});

test('live wrapper replacement and UNKNOWN fingerprint retain independent canonical receipt authority unless its lifetime moves', async () => {
  for (const change of ['wrapper', 'unknown', 'unknown-revoked']) {
    const h = await rig([row('tail')], { live: [row('stream', { liveProjection: true })] });
    try {
      await h.open(); const fingerprint = h.env.historyPrimaryLiveClaimFingerprint;
      h.env.historyPrimaryLiveClaimFingerprint = value => {
        const result = fingerprint(value);
        if (change === 'wrapper') h.env.liveProjectionRef.current = { ownerKey: 'A', entries: [row('later-live', { liveProjection: true })] };
        else {
          if (change === 'unknown-revoked') h.env.historyOwnerGenerationRef.current++;
          throw Object.assign(new Error('unknown current live witness'), { code: 'FINITE_LIVE_UNKNOWN' });
        }
        return result;
      };
      h.render().data(); assert.equal(h.env.primaryLiveCommitRef.current, null);
      if (change === 'unknown-revoked') assert.equal(h.env.primaryReceiptCommitRef.current, null);
      else assert.equal(h.env.primaryReceiptCommitRef.current.dataSubject, h.model.getReceiptDataSubject());
      assert.equal(h.consumption[0].commit, h.env.primaryReceiptCommitRef.current);
      assert.deepEqual(h.wakes, ['commit'], 'one existing commit wake, no self retry');
    } finally { await h.close(); }
  }
});

test('actual final Panel guard after settings and apply reentry prevents stale selected-tail/data writes', async () => {
  for (const boundary of ['settings', 'apply', 'setter']) {
    const h = await rig([row('tail')]);
    try {
      const revoke = () => { h.env.historyOwnerGenerationRef.current++; };
      if (boundary === 'settings') h.env.reconcileCodexEffectiveSettings = revoke;
      else if (boundary === 'apply') h.env.historyPresentationApplyGuardRef.current = revoke;
      else { const set = h.env.setEntries; h.env.setEntries = value => { set(value); revoke(); }; }
      await assert.rejects(h.open(), error => error.code === 'HISTORY_READ_CANCELLED');
      assert.equal(h.env.primaryCanonicalDiagnosticRef.current, null);
      assert.equal(h.env.primarySurfaceWitnessRef.current, null);
      if (boundary !== 'setter') assert.deepEqual(h.env.entries, []);
      assert.equal(h.witness.candidate(), null); assert.equal(h.env.primaryReceiptCommitRef.current, null);
    } finally { await h.close(); }
  }
});

test('actual diagnostic/commit current-live fingerprints stay independent of canonical row count', async () => {
  const samples = [];
  for (const count of [1, 8]) {
    const h = await rig(Array.from({ length: count }, (_, i) => row('canonical-' + i)), { live: [row('stream', { content: 'x'.repeat(1024), liveProjection: true })] });
    try { await h.open(); const before = h.fingerprints; h.render().all();
      samples.push({ canonicalRows: count, currentPayloadUTF16: 1024, fingerprints: h.fingerprints - before });
    } finally { await h.close(); }
  }
  assert.equal(samples[0].fingerprints, samples[1].fingerprints); assert.equal(samples[0].fingerprints, 1);
  console.log('V50_PANEL_CURRENT_PAYLOAD_COST ' + JSON.stringify(samples));
});
