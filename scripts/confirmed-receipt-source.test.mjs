// Finite SOURCE control: real producer/client/model and bounded actual Panel
// callbacks. Parsed source + Node SQLite + controlled React/IPC are explicit
// substitutions; no Electron/provider/native or full Panel AST is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { HistoryPrimaryRootReadModel, historyPrimaryLiveClaimFingerprint } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import { matchesHistoryPromptExactProof, historyEntryHasExactIdentity } from '../src/renderer/utils/historyPromptPresentation.mjs';
import { captureHistoryComposerDraftOwner } from '../src/renderer/utils/historyComposerDraftOwner.mjs';
import { captureHistoryPrimaryPanelWitness } from '../src/renderer/utils/historyPrimaryPanelBindings.mjs';
import { readHistoryThroughIpc } from '../src/renderer/utils/historyReadTransport.mjs';
import { historyPrimaryPromptAdoptionFingerprint } from '../src/renderer/utils/historyPrimaryPromptAdoption.mjs';
import { checkedHistoryPrimaryCanonicalMetadataFact } from '../src/shared/history-root-read-client.mjs';
import { normalizePromptImageIdentity } from '../src/shared/prompt-image-attachments.mjs';
const require = createRequire(import.meta.url), ts = require('typescript');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const panelPath = 'src/renderer/components/Workspace/HistoryPanel.tsx';
const panel = fs.readFileSync(path.join(ROOT, panelPath), 'utf8');
const originalCallbacks = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/test-support/confirmed-receipt-before.json'), 'utf8'));
const handoffSource = fs.readFileSync(path.join(ROOT, 'src/renderer/utils/historyPromptHandoffs.ts'), 'utf8');
const { createPrimaryAddressFixture } = require('./test-support/history-primary-address-fixture.cjs');
const { materializeHistoryCursorSync: materialize } = require('../src/main/history-root-engine/main/history-paged-store.js');
assert(require('node:v8').getHeapStatistics().heap_size_limit <= 256 * 1024 ** 2);
globalThis.window = { require };
const storage = new Map();
globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
const handoffs = await import('../src/renderer/utils/historyPromptHandoffs.ts');
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const ref = current => ({ current });
function slice(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start + from.length);
  assert(start >= 0 && end > start, from); return source.slice(start, end);
}
function compile(source) {
  assert(Buffer.byteLength(source) < 40 * 1024, 'only bounded callbacks may be parsed');
  const result = ts.transpileModule(source, { reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.deepEqual(result.diagnostics, []); return result.outputText;
}
const oracleText = slice(handoffSource, 'export function durableHistorySendReceiptMatchesCanonicalEntry(', 'const normalizeDurableDraftText =');
const oracleModule = { exports: {} };
Function('exports', 'matchesHistoryPromptExactProof', compile(oracleText))(oracleModule.exports, matchesHistoryPromptExactProof);
const oracle = oracleModule.exports.durableHistorySendReceiptMatchesCanonicalEntry;
const ackText = source => slice(source, '  const acknowledgeMaterializedHistoryReceipt =', '\n  useEffect(() => {');
const receiptEffect = slice(panel, '  useEffect(() => {\n    let stopped = false;\n    let disposeRead = () => {};', '\n  useEffect(() => subscribeHistoryPromptHandoffs');
const layoutText = slice(panel, '  const primaryReceiptRootAtRender =', '\n  // Bind coverage to THIS render');
function evaluate(source, env, tail = '') {
  return Function(...Object.keys(env), compile(source + tail))(...Object.values(env));
}
function legacyAck(env) { return evaluate(ackText(panel), { ...env, useCallback: fn => fn, historyEntryHasExactIdentity }, '\nreturn acknowledgeMaterializedHistoryReceipt;'); }
const row = (uuid, extra = {}) => ({ uuid, role: 'assistant', content: 'full body\0\ud800😀'.repeat(90), sessionId: 's',
  timestamp: '2026-10-27T00:00:00.000Z', ...extra });
let sequence = 0;
const receipt = extra => ({ state: 'confirmed', surface: 'desktop-history', provider: 'codex', tabId: 'tab-' + ++sequence,
  operationKey: 'op-' + sequence, attemptId: 'attempt-' + sequence, handoffId: 'handoff-' + sequence,
  sessionId: 's', updatedAt: 10, receipt: { promptText: 'authored', entryUuid: 'old', sourceIdentity: 'source-old', sessionId: 's' }, ...extra });
const ackInput = record => ({ operationKey: record.operationKey, attemptId: record.attemptId,
  handoffId: record.handoffId, provider: record.provider, sessionId: record.receipt?.sessionId || record.sessionId,
  auditEntryUuid: record.receipt?.entryUuid || record.auditIdentity?.entryUuid,
  auditSourceIdentity: record.receipt?.sourceIdentity || record.auditIdentity?.sourceIdentity });
async function oracleAck(record, matched) {
  const calls = [];
  const ack = legacyAck({ tabId: record.tabId, historyDiag() {}, console,
    ipcRenderer: { invoke: async (channel, payload) => { calls.push({ channel, payload }); return { success: true }; } } });
  await ack(ackInput(record), matched);
  if (!calls.length) return null;
  const { tabId, ...payload } = calls[0].payload; return payload;
}
async function setup(entries, { inputs = {}, intercept = async () => undefined } = {}) {
  const f = await createPrimaryAddressFixture(null, { entries });
  const calls = [];
  const invoke = async (channel, payload) => {
    let result = await intercept(channel, payload, f);
    if (result === undefined) result = channel === 'agent-transcript:cancel-read' ? { success: true } : await f.invoke(channel, payload);
    calls.push({ channel, kind: payload?.kind, scope: payload?.scope, offset: payload?.offset,
      nodeToken: payload?.nodeToken, leaseId: payload?.leaseId, limit: payload?.limit,
      count: result?.items?.length, requestBytes: Buffer.byteLength(JSON.stringify(payload)),
      resultBytes: Buffer.byteLength(JSON.stringify(result)) });
    return result;
  };
  const model = new HistoryPrimaryRootReadModel(invoke, { ...f.transport, readHistoryThroughIpc });
  model.windowDiagnostic = () => {};
  const payload = { ...f.payload, primaryPresentation: { localEntries: [], liveEntries: [], liveToolResults: [],
    grouping: { enabled: false, threshold: 2, responseWork: true, expandedKeys: [] }, captionSelections: [], settingsPresentationKeys: [], ...inputs } };
  try { await model.open(payload); }
  catch (error) { await model.close(); f.close(); throw error; }
  const primary = f.plane.state(model.view.root, f.consumerKey).primaryPresentation;
  const canonical = materialize(primary.toolCoverageInputs().entries);
  const before = calls.length;
  Object.defineProperty(model, 'metadata', { configurable: true, get() { throw Error('NEW_PATH_READ_N_METADATA'); } });
  function bounds() {
    for (const call of calls.slice(before)) {
      assert(call.requestBytes <= 65536 && call.resultBytes <= 65536);
      assert(call.count == null || call.count <= 3);
      if (call.kind === 'leaf') assert(call.limit <= 1024);
      assert(!['agent-transcript:get-history'].includes(call.channel));
      if ([model.header.sourceMetadata.nodeToken, model.header.durableMetadata.nodeToken].includes(call.nodeToken)) {
        assert.equal(call.kind, 'primary-canonical-consumers');
      }
    }
    assert.equal(model.window.size, 0); assert(f.store.stats().peakCachedPages <= 3);
  }
  return { f, model, payload, canonical, calls, bounds, async close() { delete model.metadata; await model.close(); f.close(); } };
}

test('native predicate and ACK payload remain unchanged; shared caller cleanup is owner-qualified', () => {
  assert.equal(ackText(panel), originalCallbacks.acknowledgeMaterializedHistoryReceipt);
  const other = s => slice(s, '  const consumeMaterializedPromptHandoffs =', '\n  // Load full history');
  for (const range of [['      const legacyOrchestrationMatch =', '      if (!matched) continue;'],
    ['      void acknowledgeMaterializedHistoryReceipt({', '      }, matched).then(']]) {
    assert.equal(slice(other(panel), ...range), slice(originalCallbacks.consumeMaterializedPromptHandoffs, ...range));
  }
  assert(other(panel).includes('consumeHistoryPromptHandoffIfCurrent'), 'the shared old caller also guards reentrant cleanup');
  assert.equal(slice(handoffSource, 'export function durableHistorySendReceiptMatchesCanonicalEntry(', 'const normalizeDurableDraftText ='), oracleText);
});

test('actual canonical query matches native ordering, session/alias/type grammar and original ACK payload', async () => {
  const long = 'full\0\ud800😀:' + 'Ω\udc00'.repeat(1100);
  const x = await setup([
    row('wrong-session', { sessionId: 'foreign', sourceIdentityAliases: ['both', 'old'] }),
    row('first-source', { sourceIdentity: 'both', sourceUuidAliases: ['old', long], sourceIdentityAliases: [3, 'three'] }),
    row('later-uuid', { sourceIdentityAliases: ['both'], sourceUuidAliases: ['second'] }),
    row('missing-sid', { sessionId: undefined, sourceUuidAliases: ['no-sid'] }),
    row('local-prompt-local', { role: 'queued', sourceIdentityAliases: ['local-only'] }),
    row('live-only', { liveProjection: true, sourceIdentityAliases: ['live-only-alias'] }),
  ]);
  try {
    const cases = [
      receipt(), receipt({ receipt: { entryUuid: 'later-uuid', sourceIdentity: 'both', sessionId: 's' } }),
      receipt({ receipt: { entryUuid: long, sessionId: 's' } }),
      receipt({ receipt: { entryUuid: ' no-sid ', sessionId: 's' } }),
      receipt({ receipt: { sourceIdentity: '3', sessionId: 's' } }),
      receipt({ receipt: { sourceIdentity: 'local-only', sessionId: 's' } }),
      receipt({ receipt: { sourceIdentity: 'live-only-alias', sessionId: 's' } }),
      receipt({ receipt: { sourceIdentity: '', entryUuid: 7 }, auditIdentity: { entryUuid: 'old' } }),
      receipt({ receipt: { sourceIdentity: true, entryUuid: {} }, auditIdentity: { entryUuid: 'old', sourceIdentity: 'both' } }),
      receipt({ receipt: { sourceIdentity: 'both', entryUuid: 9, sessionId: true } }),
      receipt({ receipt: { entryUuid: '  ', sourceIdentity: 'absent' } }),
      receipt({ state: 'not-submitted' }), receipt({ presentation: {} }),
    ];
    const eligible = x.canonical.filter(entry => !(entry.role === 'queued' && entry.uuid.startsWith('local-prompt-')) && !entry.liveProjection);
    for (const record of cases) {
      const selected = eligible.find(entry => oracle(record, entry));
      const proof = await x.model.readConfirmedCanonicalReceipt(record);
      assert.equal(proof.header, x.model.header); assert.equal(proof.found, !!selected);
      assert.equal(proof.ordinal, selected ? x.canonical.indexOf(selected) : null);
      assert.deepEqual(proof.acknowledgement, selected ? await oracleAck(record, selected) : null);
    }
    assert.equal((await x.model.readConfirmedCanonicalReceipt(cases[1])).ordinal, 1, 'source match before later UUID wins');
    assert.equal((await x.model.readConfirmedCanonicalReceipt(cases[2])).ordinal, 1, 'full sourceUuidAliases UTF16, no coercion');
    assert(x.calls.some(call => call.kind === 'leaf' && call.offset >= 1024));
    x.bounds();
  } finally { await x.close(); }
});

test('dedicated zero canonical proof excludes prepared-only rows; errors never become misses', async () => {
  let tamper = null;
  const x = await setup([], { inputs: { liveEntries: [row('live', { sourceIdentityAliases: ['old'] })] },
    intercept: async (channel, payload, f) => {
      if (payload.kind === 'primary-canonical-consumers' && tamper) {
        const mode = tamper; tamper = null;
        if (mode === 'unknown') throw Object.assign(Error('unknown'), { code: 'HISTORY_READER_TRANSPORT_UNKNOWN' });
        const packet = await f.invoke(channel, payload);
        if (mode === 'generic') return { ...packet, kind: 'range' };
        return { ...packet, semanticIdentity: 'stale' };
      }
    } });
  try {
    assert.equal((await x.model.readConfirmedCanonicalReceipt(receipt())).found, false);
    assert(x.calls.some(call => call.kind === 'primary-canonical-consumers' && call.scope === 'canonical' && call.count === 0));
    for (const mode of ['generic', 'cut', 'unknown']) {
      tamper = mode; const before = x.calls.length;
      await assert.rejects(x.model.readConfirmedCanonicalReceipt(receipt()));
      assert(x.calls.length <= before + 1); x.model.view.reader.assertOpen();
    }
    x.bounds();
  } finally { await x.close(); }
});

test('full selected text digest, cancellation, and independently leased documents', async () => {
  let corrupt = false, gate = null, entered = null;
  const long = 'identity-' + 'x'.repeat(2400);
  const x = await setup([row('promoted', { sourceUuidAliases: [long] })], { intercept: async (channel, payload, f) => {
    if (gate && payload.kind === 'primary-canonical-consumers') {
      const hold = gate; gate = null; const reply = await f.invoke(channel, payload); entered.resolve(); await hold.promise; return reply;
    }
    if (corrupt && payload.kind === 'leaf' && payload.offset === 1024) {
      corrupt = false; const reply = await f.invoke(channel, payload); return { ...reply, text: '!' + reply.text.slice(1) };
    }
  } });
  try {
    const r = receipt({ receipt: { entryUuid: long, sessionId: 's' } });
    corrupt = true; await assert.rejects(x.model.readConfirmedCanonicalReceipt(r)); x.model.view.reader.assertOpen();
    corrupt = true;
    await assert.rejects(x.model.readConfirmedCanonicalReceipt(receipt({ receipt: { entryUuid: 'X' + long.slice(1), sessionId: 's' } })),
      e => e.code === 'HISTORY_PRIMARY_DOCUMENT_DIGEST', 'a prior mismatch must still verify later chunks');
    const reader = x.model.view.reader;
    const page = await reader.primaryCanonicalConsumers(x.model.header.durableMetadata, { header: x.model.header, scope: 'canonical', limit: 1 });
    const field = (await reader.project(page.items[0].row, ['content'])).items[0].value;
    const independent = await reader.forkText(field);
    gate = deferred(); entered = deferred(); const hold = gate, controller = new AbortController();
    const pending = x.model.readConfirmedCanonicalReceipt(r, { signal: controller.signal });
    await entered.promise; controller.abort(); await assert.rejects(pending, e => e.code === 'HISTORY_READ_CANCELLED');
    hold.resolve(); await tick();
    assert.equal((await x.model.readConfirmedCanonicalReceipt(r)).found, true);
    x.model.view.reader.assertOpen(); x.bounds();
    await x.model.close(); assert.equal((await independent.read(0, 4)).text, 'full'); await independent.close();
  } finally { await x.close(); }
});

function uiStore() {
  const state = { historyPromptDrafts: {}, historyPromptDraftImages: {}, historyPromptDraftChips: {},
    historyPromptDraftPendingImages: {}, historyPromptDraftUpdatedAt: {}, historyPromptReturnedSends: {},
    promptQueueInputSurfaceTabs: {}, historyRewindPreviews: {}, historyComposerAvailability: {}, promptPickerOpen: false };
  const listeners = new Set();
  return { getState: () => state, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, get listeners() { return listeners.size; } };
}
function rig(model, canonical, record, { primary = true, committed = true, query, realLocal = false, deferInitialLocal = false, acknowledge = async () => ({ success: true }) } = {}) {
  const calls = [], removed = [], hydrated = [], diagnostics = [], list = deferred(), probed = deferred(), ackEntered = deferred(), ui = uiStore();
  let queries = 0, effect, layout, consumed = 0;
  const originalQuery = model.readConfirmedCanonicalReceipt.bind(model);
  const env = { ...handoffs, captureHistoryComposerDraftOwner, primaryPhysicalCandidate: primary,
    historyOwnerKey: 'owner', historyOwnerKeyRef: ref('owner'), historyOwnerGenerationRef: ref(2),
    primaryRoot: model, primaryHeader: model.header, primaryRootRef: ref(model), primaryReceiptCommitRef: ref(null),
    primarySurfaceWitnessRef: ref(null),
    // This fixture isolates receipt/ACK. The separate live suite executes the
    // actual owner; its added layout dependencies are explicit here.
    primaryLiveCommitRef: ref(null), liveProjectionRef: ref({ ownerKey: 'owner', entries: [] }),
    historyPrimaryLiveClaimFingerprint, primaryLiveCoverageOwner: { wake(reason) {
      assert(['commit', 'subject'].includes(reason));
    } },
    entries: [], presentationEntriesRef: ref(null), rawServerEntriesRef: ref(canonical),
    committedHistoryEntriesRef: ref({ ownerKey: 'owner', entries: canonical }),
    presentedOwnerKey: 'owner', chipsFreshOwnerKey: 'owner', receiptPresentationRevision: 0, fileRewriteEpoch: 0,
    useUIStore: ui, tabId: record.tabId, toolType: 'codex', AbortController, console,
    setReceiptPresentationRevision() {}, setHistoryPromptDraft() { throw Error('confirmed receipt wrote draft'); },
    flushHistoryComposerDrafts() { throw Error('confirmed receipt flushed draft'); },
    historyDiag: message => diagnostics.push(message),
    isLocalPromptEntry: entry => entry.role === 'queued' && entry.uuid.startsWith('local-prompt-'),
    reconcileLiveProjectionAgainstDurable() {}, consumeMaterializedPromptHandoffs() {}, consumePrimaryMaterializedPromptHandoffs() {},
    removeLocalPromptEntry: (...args) => removed.push(args),
    consumeHistoryPromptHandoff: (...args) => { consumed++; return handoffs.consumeHistoryPromptHandoff(...args); },
    consumeHistoryPromptHandoffIfCurrent: (...args) => {
      const accepted = handoffs.consumeHistoryPromptHandoffIfCurrent(...args); if (accepted) consumed++; return accepted;
    },
    hydrateHistoryPromptHandoffFromDurableReceipt: value => { hydrated.push(value); return handoffs.hydrateHistoryPromptHandoffFromDurableReceipt(value); },
    ipcRenderer: { invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel === 'agent:list-send-receipts') return list.promise;
      if (channel === 'agent:acknowledge-send-receipt-presentation') { ackEntered.resolve(); return acknowledge(payload); }
      throw Error('unexpected mutation ' + channel);
    } },
    useEffect: fn => { effect = fn; }, useLayoutEffect: fn => { layout = fn; },
  };
  env.presentationEntriesRef.current = env.entries;
  env.consumeLocalPromptEntry = (handoffId, reason, expected, owns = () => true) => {
    if (!owns()) return false;
    const owner = handoffs.getHistoryPromptHandoffsSnapshot(record.tabId).find(value => value.handoffId === handoffId) || null;
    if (expected && owner && ((owner.sendOperationKey ?? null) !== (expected.operationKey ?? null)
      || (owner.sendAttemptId ?? null) !== (expected.attemptId ?? null))) return false;
    if (!env.consumeHistoryPromptHandoffIfCurrent(record.tabId, handoffId, owner)) return false;
    env.removeLocalPromptEntry(handoffId, reason); return true;
  };
  const adoptCurrent = () => {
    env.entries = model.view.metadata.entries;
    env.presentationEntriesRef.current = env.entries;
    env.primarySurfaceWitnessRef.current = captureHistoryPrimaryPanelWitness({ root: model, header: model.header,
      ownerKey: 'owner', entries: env.entries, rewind: null, presentation: { settingsPresentationKeys: [] }, fingerprint: 'fixture' });
  };
  adoptCurrent();
  let disposeLocal = () => {}, disposeAdoption = () => {}, queued = false, stateRows = env.entries;
  const updates = [];
  const flushUpdates = (reverse = false) => {
    const pending = updates.splice(0); if (reverse) pending.reverse();
    for (const update of pending) { stateRows = update(stateRows); env.entries = stateRows; }
  };
  if (realLocal) {
    Object.assign(env, { useCallback: fn => fn, useRef: ref, sessionId: 's', LOCAL_PROMPT_PREFIX: 'local-prompt-',
      historyTabIdRef: ref(record.tabId), returnPromptInflight: ref(new Set()), historyPrimaryPromptAdoptionFingerprint,
      historySnapshotOwner: {}, promptHandoffMetaRef: ref(new Map()), suppressedPromptsRef: ref(new Map()),
      persistVolatileOverlay() {}, setPrimarySuppressionRevision() {}, keepHistoryTailPinnedAfterMutation() {},
      setEntries(update) { updates.push(update); if (!queued) flushUpdates(); },
      normalizeHistoryPromptText: value => String(value || '').replace(/\r\n/g, '\n').trim(),
      normalizeComposerChips: value => value, retainHistoryDraftImages: (_text, images) => images,
      promptPreview: value => value.slice(0, 32),
      findServerPromptEntry() { throw Error('replacement without audit must not scan committed rows'); },
      resolveHistoryPromptHandoffPresentationSession: ({ auditSessionId, sessionIdHint, currentSessionId }) => ({
        exactSessionId: auditSessionId || '', presentationSessionId: auditSessionId || sessionIdHint || currentSessionId,
        belongsToCurrent: !auditSessionId || auditSessionId === currentSessionId }),
      resolveHistoryPromptHandoffSemanticTags: () => [], liveProjectionRef: ref({ ownerKey: 'owner', entries: [] }),
      retireHistoryLivePromptByExactProof: entries => entries, setLiveEntries() {},
      updateLocalPromptEntry() { throw Error('replacement begin must use actual append path'); },
    });
    const normal = slice(panel, 'const normalizeHistoryPromptText =', 'const promptPreview =');
    Object.assign(env, evaluate(normal, { normalizePromptImageIdentity },
      '\nreturn {normalizeHistoryPromptText,normalizeHistoryPromptIdentityText};'));
    if (panel.includes('  const localPromptMetaOwnersRef =')) {
      const ownerText = slice(panel, '  const localPromptMetaOwnersRef =', '\n  const appendLocalPromptEntry =');
      const adoptionEffects = [];
      Object.assign(env, evaluate(ownerText, { ...env, useEffect: fn => adoptionEffects.push(fn) },
        '\nreturn {localPromptMetaOwnersRef,getLocalPromptMetaOwner,primaryPromptPublicationFingerprint,' +
        'capturePrimaryPromptAdoption,primaryPromptAdoptionLifeRef,primaryPromptAppendPendingRef};'));
      const adoptionCleanups = adoptionEffects.map(fn => fn()).filter(fn => typeof fn === 'function');
      disposeAdoption = () => { for (const close of adoptionCleanups.reverse()) close(); };
    }
    const removalStart = panel.includes('  const captureLocalPromptRemoval =') ? '  const captureLocalPromptRemoval =' : '  const removeLocalPromptEntry =';
    const cleanupCallbacks = slice(panel, removalStart, '\n  const queueMergeIntents =');
    const cleanupEnvironment = { ...env };
    for (const name of ['removeLocalPromptEntry', 'consumeLocalPromptEntry', 'captureLocalPromptRemoval']) delete cleanupEnvironment[name];
    const actual = evaluate(cleanupCallbacks, cleanupEnvironment, '\nreturn {removeLocalPromptEntry' +
      (panel.includes('  const consumeLocalPromptEntry =') ? ',consumeLocalPromptEntry,captureLocalPromptRemoval' : '') + '};');
    Object.assign(env, actual);
    const append = slice(panel, '  const appendLocalPromptEntry =', '\n  const updateLocalPromptEntry =');
    env.appendLocalPromptEntry = evaluate(append, env, '\nreturn appendLocalPromptEntry;');
    const statusEnvironment = { ...env, serverHasPromptEntry: () => false };
    delete statusEnvironment.updateLocalPromptEntry;
    const status = slice(panel, '  const updateLocalPromptEntry =', '\n  const captureLocalPromptRemoval =');
    env.updateLocalPromptEntry = evaluate(status, statusEnvironment, '\nreturn updateLocalPromptEntry;');
    const subscriber = slice(panel, "  useEffect(() => subscribeHistoryPromptHandoffs(tabId, (snapshot, change) => {\n    if (change.type === 'presentation-control')", '\n  const appendCompactErrorEntry =');
    queued = deferInitialLocal;
    evaluate(subscriber, env); disposeLocal = effect();
    env.primarySurfaceWitnessRef.current = captureHistoryPrimaryPanelWitness({ root: model, header: model.header,
      ownerKey: 'owner', entries: env.entries, rewind: null, presentation: { settingsPresentationKeys: [] }, fingerprint: 'fixture' });
  }
  env.acknowledgeMaterializedHistoryReceipt = legacyAck(env);
  model.readConfirmedCanonicalReceipt = async (...args) => {
    queries++;
    try { if (!primary) throw Error('legacy used primary query'); return await (query ? query(...args) : originalQuery(...args)); }
    finally { probed.resolve(); }
  };
  function commit() {
    env.rawServerEntriesRef.current = canonical;
    evaluate(layoutText, env); layout();
    if (primary) {
      const poison = new Proxy([], { get() { throw Error('NEW_PANEL_PATH_READ_N_METADATA'); } });
      env.rawServerEntriesRef.current = poison;
      env.committedHistoryEntriesRef.current.entries = poison;
    }
    return env.primaryReceiptCommitRef.current;
  }
  if (committed) commit();
  evaluate(receiptEffect, env); let cleanup = effect();
  const restart = () => { cleanup(); evaluate(receiptEffect, env); cleanup = effect(); };
  return { env, calls, removed, hydrated, diagnostics, ui, commit, adoptCurrent, restart,
    queueUpdates(value) { queued = value; }, flushUpdates,
    ackEntered: ackEntered.promise, probed: probed.promise, queries: () => queries, consumed: () => consumed,
    resolveList() { list.resolve({ success: true, records: [record] }); },
    cleanup() { cleanup(); disposeLocal(); disposeAdoption(); model.readConfirmedCanonicalReceipt = originalQuery; handoffs.consumeHistoryPromptHandoff(record.tabId, record.handoffId); } };
}

test('reentrant consume replacement survives actual local row/meta cleanup and queued React updater', async () => {
  const x = await setup([row('promoted', { sourceUuidAliases: ['old'], sourceIdentityAliases: ['source-old'] })]);
  try {
    for (const primary of [true, false]) for (const ordering of ['before', 'after']) for (const queued of [false, true]) for (const sameAttempt of [false, true]) {
      const r = receipt(); let h, unsubscribe = () => {}, replacement;
      const begin = (attempt, text) => handoffs.beginHistoryPromptHandoff({ tabId: r.tabId, handoffId: r.handoffId,
        sendOperationKey: r.operationKey, sendAttemptId: attempt, toolType: 'codex', text, submittedAt: 1, sessionIdHint: 's' });
      const reenter = (_snapshot, change) => {
        if (change.type === 'consume' && change.handoffId === r.handoffId && !replacement) replacement = begin(sameAttempt ? r.attemptId : 'replacement-attempt', 'new authored replacement');
      };
      begin(r.attemptId, 'old local row');
      if (ordering === 'before') unsubscribe = handoffs.subscribeHistoryPromptHandoffs(r.tabId, reenter);
      try {
        h = rig(x.model, x.canonical, r, { primary, realLocal: true });
        if (ordering === 'after') unsubscribe = handoffs.subscribeHistoryPromptHandoffs(r.tabId, reenter);
        assert(h.env.promptHandoffMetaRef.current.has(r.handoffId));
        h.queueUpdates(queued); h.resolveList(); await h.ackEntered; await tick();
        if (!primary) await tick();
        h.flushUpdates(queued);
        assert(replacement, 'real consume listener began a replacement');
        const current = handoffs.getHistoryPromptHandoffsSnapshot(r.tabId).find(value => value.handoffId === r.handoffId);
        assert.equal(current, replacement);
        assert(h.env.promptHandoffMetaRef.current.has(r.handoffId), 'old cleanup erased replacement metadata');
        const local = h.env.entries.find(entry => entry.handoffId === r.handoffId);
        assert(local, 'old cleanup erased replacement row');
        assert.equal(local.sendAttemptId, sameAttempt ? r.attemptId : 'replacement-attempt'); assert.equal(local.content, 'new authored replacement');
      } finally { unsubscribe(); h?.cleanup(); handoffs.consumeHistoryPromptHandoff(r.tabId, r.handoffId); }
    }
  } finally { await x.close(); }
});

test('owned cleanup also removes the old queued projection without requiring a replacement', async () => {
  const x = await setup([row('promoted', { sourceUuidAliases: ['old'], sourceIdentityAliases: ['source-old'] })]);
  try {
    for (const reverse of [false, true]) {
      const r = receipt(); let h;
      handoffs.beginHistoryPromptHandoff({ tabId: r.tabId, handoffId: r.handoffId, sendOperationKey: r.operationKey,
        sendAttemptId: r.attemptId, toolType: 'codex', text: 'old queued projection', submittedAt: 1, sessionIdHint: 's' });
      try {
        h = rig(x.model, x.canonical, r, { realLocal: true, deferInitialLocal: true });
        assert(!h.env.entries.some(row => row.handoffId === r.handoffId));
        const beforeMeta = h.env.promptHandoffMetaRef.current.get(r.handoffId);
        h.env.updateLocalPromptEntry(r.handoffId, 'audit-pending', 'same-owner-status', {});
        const afterMeta = h.env.promptHandoffMetaRef.current.get(r.handoffId);
        assert.notEqual(afterMeta, beforeMeta, 'actual status writer creates a metadata clone');
        assert.equal(h.env.getLocalPromptMetaOwner(afterMeta), h.env.getLocalPromptMetaOwner(beforeMeta));
        h.resolveList(); await h.ackEntered; await tick(); h.flushUpdates(reverse);
        assert(!h.env.entries.some(row => row.handoffId === r.handoffId), 'old owned queued projection was resurrected');
        assert(!h.env.promptHandoffMetaRef.current.has(r.handoffId));
      } finally { h?.cleanup(); }
    }
  } finally { await x.close(); }
});

test('actual primary and legacy receipt effects clean every compatible partial bind owner', async () => {
  const x = await setup([row('promoted', { role: 'user', sourceUuidAliases: ['old'], sourceIdentityAliases: ['source-old'] })]);
  try {
    for (const primary of [true, false]) for (const fields of ['', 'O', 'A', 'OA']) for (const queued of [false, true]) {
      const r = receipt(); let h;
      const owner = handoffs.beginHistoryPromptHandoff({ tabId: r.tabId, handoffId: r.handoffId,
        ...(fields.includes('O') ? { sendOperationKey: r.operationKey } : {}),
        ...(fields.includes('A') ? { sendAttemptId: r.attemptId } : {}),
        toolType: 'codex', text: 'authored', submittedAt: 1, sessionIdHint: 's', requiresAuditIdentity: false });
      const recovery = handoffs.captureHistoryReceiptRecoveryOwner(r);
      try {
        assert(recovery.recoveryAllowed && recovery.isCurrent());
        assert(handoffs.historyPromptHandoffAcceptsAuditIdentity(owner, { sendOperationKey: r.operationKey, sendAttemptId: r.attemptId }));
        h = rig(x.model, x.canonical, r, { primary, realLocal: true });
        h.queueUpdates(queued); h.resolveList(); await h.ackEntered; await tick(); h.flushUpdates();
        assert.equal(h.calls.filter(call => call.channel.includes('acknowledge')).length, 1);
        assert.equal(h.queries(), primary ? 1 : 0);
        assert.equal(handoffs.getHistoryPromptHandoffsSnapshot(r.tabId).length, 0, fields || 'unbound');
        assert(!h.env.promptHandoffMetaRef.current.has(r.handoffId));
        assert(!h.env.entries.some(row => row.handoffId === r.handoffId));
      } finally { recovery.dispose(); h?.cleanup(); }
    }
  } finally { await x.close(); }
});

test('shared queued-source retirement carries the removed owner and preserves a reentrant second-source replacement', () => {
  const tabId = 'merge-source-' + ++sequence, ids = ['first', 'second'].map(suffix => tabId + '-' + suffix);
  const operations = ids.map(id => `history:${tabId}:${id}`);
  const owners = ids.map((handoffId, index) => handoffs.beginHistoryPromptHandoff({ tabId, handoffId,
    sendOperationKey: operations[index], sendAttemptId: null, toolType: 'codex', text: 'queued source', submittedAt: 1, sessionIdHint: 's' }));
  let replacement; const events = [];
  const unsubscribe = handoffs.subscribeHistoryPromptHandoffs(tabId, (_snapshot, change) => {
    if (change.type !== 'consume') return;
    events.push(change);
    if (change.handoffId === ids[0]) replacement = handoffs.beginHistoryPromptHandoff({ tabId, handoffId: ids[1],
      sendOperationKey: operations[1], sendAttemptId: 'new-source-attempt', toolType: 'codex', text: 'replacement', submittedAt: 2, sessionIdHint: 's' });
  });
  try {
    assert.equal(handoffs.applyHistoryQueuedMessageMerge({ success: true, version: 1, tabId,
      receiptRetired: true, record: null, sourceHandoffIds: ids, sourceOperationKeys: operations }), true);
    assert.equal(events.length, 1); assert.equal(events[0].removedOwner, owners[0]);
    assert.equal(handoffs.getHistoryPromptHandoffsSnapshot(tabId).find(value => value.handoffId === ids[1]), replacement);
  } finally { unsubscribe(); ids.forEach(id => handoffs.consumeHistoryPromptHandoff(tabId, id)); }
  const missing = ids.map(id => id + '-missing'), missingEvents = [];
  const off = handoffs.subscribeHistoryPromptHandoffs(tabId, (_snapshot, change) => { if (change.type === 'consume') missingEvents.push(change); });
  try {
    const op = missing.map(id => `history:${tabId}:${id}`);
    assert.equal(handoffs.applyHistoryQueuedMessageMerge({ success: true, version: 1, tabId,
      receiptRetired: true, record: null, sourceHandoffIds: missing, sourceOperationKeys: op }), true);
    assert.deepEqual(missingEvents.map(event => [event.removedOwner, event.operationKey, event.attemptId]), op.map(key => [null, key, null]));
  } finally { off(); }
});

test('actual Panel commit + query + ACK chain: no paint requirement or metadata read, audited pre-promotion payload intact', async () => {
  const x = await setup([row('promoted', { sourceUuidAliases: ['old'], sourceIdentityAliases: ['source-old'] })]);
  const r = receipt(); let harness;
  try {
    harness = rig(x.model, x.canonical, r); harness.resolveList();
    await harness.probed; await tick();
    const ack = harness.calls.find(c => c.channel.includes('acknowledge')); assert(ack);
    assert.deepEqual(ack.payload, { ...await oracleAck(r, x.canonical[0]), tabId: r.tabId });
    assert.equal(harness.removed.length, 1); assert.equal(harness.consumed(), 1); assert.equal(harness.hydrated.length, 0);
    assert.equal(harness.queries(), 1); x.bounds();
  } finally { harness?.cleanup(); await x.close(); }
});

test('actual Panel refuses query before data commit and handles old-commit/new-commit ABA and late ACK', async () => {
  const x = await setup([row('promoted', { sourceUuidAliases: ['old'], sourceIdentityAliases: ['source-old'] })]);
  try {
    const cold = rig(x.model, x.canonical, receipt(), { committed: false }); cold.resolveList(); await tick();
    assert.equal(cold.queries(), 0); assert.equal(cold.hydrated.length, 0); cold.cleanup();
    for (const phase of ['query', 'ack']) {
      const gate = deferred(), entered = deferred(), r = receipt();
      const actual = x.model.readConfirmedCanonicalReceipt.bind(x.model);
      const h = rig(x.model, x.canonical, r, {
        query: async (...args) => { const proof = await actual(...args); if (phase === 'query') { entered.resolve(); await gate.promise; } return proof; },
        acknowledge: async () => { if (phase === 'ack') { entered.resolve(); await gate.promise; } return { success: true }; },
      });
      try {
        h.resolveList(); await entered.promise; const old = h.env.primaryReceiptCommitRef.current;
        h.env.primaryReceiptCommitRef.current = null; h.commit();
        assert.notEqual(h.env.primaryReceiptCommitRef.current, old); gate.resolve(); await tick();
        assert.equal(h.removed.length, 0); assert.equal(h.consumed(), 0); assert.equal(h.hydrated.length, 0);
        if (phase === 'query') assert(!h.calls.some(c => c.channel.includes('acknowledge')));
      } finally { gate.resolve(); h.cleanup(); }
    }
  } finally { await x.close(); }
});

test('actual Panel UNKNOWN/malformed proof and malformed truthy ACK selector never hydrate a fake miss or retry', async () => {
  const x = await setup([row('promoted', { sourceUuidAliases: ['old'], sourceIdentityAliases: ['source-old'] })]);
  try {
    for (const query of [async () => { throw Object.assign(Error('UNKNOWN'), { code: 'UNKNOWN' }); }, async () => null,
      async () => ({ header: x.model.header, found: 'yes', ordinal: null, acknowledgement: null })]) {
      const h = rig(x.model, x.canonical, receipt(), { query });
      try { h.resolveList(); await h.probed; await tick(); assert.equal(h.queries(), 1); assert.equal(h.hydrated.length, 0); assert.equal(h.removed.length, 0); }
      finally { h.cleanup(); }
    }
    const r = receipt({ receipt: { entryUuid: true, sourceIdentity: 7 }, auditIdentity: { entryUuid: 'old', sourceIdentity: 'source-old' } });
    const h = rig(x.model, x.canonical, r);
    try {
      h.resolveList();
      await h.probed; await tick();
      assert.equal((await x.model.readConfirmedCanonicalReceipt(r)).found, true);
      assert.equal((await x.model.readConfirmedCanonicalReceipt(r)).acknowledgement, null);
      assert(!h.calls.some(c => c.channel.includes('acknowledge'))); assert.equal(h.hydrated.length, 0); assert.equal(h.removed.length, 0);
    } finally { h.cleanup(); }
  } finally { await x.close(); }
});

test('actual H/O/A/list lease rejects return/consume ABA while ACK awaits; legacy helper still executes its original path', async () => {
  const x = await setup([row('promoted', { sourceUuidAliases: ['old'], sourceIdentityAliases: ['source-old'] })]);
  try {
    for (const mutation of ['return', 'hide', 'attempt', 'absence-aba']) {
      const r = receipt(), gate = deferred(), entered = deferred();
      if (mutation !== 'absence-aba') handoffs.beginHistoryPromptHandoff({ tabId: r.tabId, handoffId: r.handoffId,
        sendOperationKey: r.operationKey, sendAttemptId: r.attemptId, toolType: 'codex', text: 'authored', submittedAt: 1, sessionIdHint: 's' });
      const h = rig(x.model, x.canonical, r, { acknowledge: async () => { entered.resolve(); await gate.promise; return { success: true }; } });
      try {
        h.resolveList(); await entered.promise;
        if (mutation === 'return') handoffs.recordHistorySendReturnControl({ version: 1, tabId: r.tabId, handoffId: r.handoffId, token: 'return', state: 'returned', returnedAt: 3 });
        else if (mutation === 'hide') handoffs.hydrateHistoryPromptHandoffFromDurableReceipt({ ...r,
          deliveryControl: { version: 1, cancelledAt: 5, presentationDismissed: true } });
        else {
          handoffs.beginHistoryPromptHandoff({ tabId: r.tabId, handoffId: r.handoffId, sendOperationKey: r.operationKey,
            sendAttemptId: mutation === 'attempt' ? 'new-attempt' : r.attemptId, toolType: 'codex', text: 'new', submittedAt: 2, sessionIdHint: 's' });
          if (mutation === 'absence-aba') handoffs.consumeHistoryPromptHandoff(r.tabId, r.handoffId);
        }
        gate.resolve(); await tick(); assert.equal(h.removed.length, 0); assert.equal(h.consumed(), 0);
      } finally { gate.resolve(); h.cleanup(); }
    }
    const legacy = rig(x.model, x.canonical, receipt(), { primary: false });
    try { legacy.resolveList(); await tick(); assert.equal(legacy.queries(), 0); assert.equal(legacy.removed.length, 1); }
    finally { legacy.cleanup(); }
  } finally { await x.close(); }
});

test('one-item producer cap and strict synchronous owner preserve complete proof; failed ACK leaves the card', async () => {
  const x = await setup([row('promoted', { sourceUuidAliases: ['old'], sourceIdentityAliases: ['source-old'] })]);
  let h;
  try {
    x.f.plane.maxItems = 1;
    await assert.rejects(x.model.readConfirmedCanonicalReceipt(receipt(), { owns: () => Promise.resolve(true) }), e => e.code === 'HISTORY_READ_CANCELLED');
    assert.equal((await x.model.readConfirmedCanonicalReceipt(receipt())).found, true);
    const r = receipt(); h = rig(x.model, x.canonical, r, { acknowledge: async () => ({ success: false, reason: 'stale-attempt' }) });
    h.resolveList(); await h.probed; await tick();
    assert.equal(h.removed.length, 0); assert.equal(h.hydrated.length, 0); assert.equal(h.queries(), 1);
    assert(h.diagnostics.some(message => message.includes('reason=stale-attempt')));
    x.bounds();
  } finally { h?.cleanup(); await x.close(); }
});

test('actual successful-adoption wake rebinds UNKNOWN without a Panel render or a new data commit', async () => {
  const x = await setup([row('promoted', { sourceUuidAliases: ['old'], sourceIdentityAliases: ['source-old'] })]);
  let h;
  try {
    let first = true;
    const actual = x.model.readConfirmedCanonicalReceipt.bind(x.model);
    h = rig(x.model, x.canonical, receipt(), { query: (...args) => {
      if (first) { first = false; throw Object.assign(Error('unknown'), { code: 'UNKNOWN' }); }
      return actual(...args);
    } });
    h.resolveList(); await h.probed; await tick();
    assert.equal(h.queries(), 1); assert.equal(h.hydrated.length, 0);
    x.model.notify(); await tick(); assert.equal(h.queries(), 1, 'body notification never retries UNKNOWN');
    const header = x.model.header, subject = x.model.getReceiptDataSubject(), commit = h.env.primaryReceiptCommitRef.current;
    const canonicalFact = x.model.view.serverMetadata.canonicalMetadataFact, presented = h.env.entries;
    assert.equal(checkedHistoryPrimaryCanonicalMetadataFact(canonicalFact, header), canonicalFact);
    assert.equal(canonicalFact.kind, 'validated-canonical-metadata');
    assert.equal(canonicalFact.diagnosticTail.kind, 'row');
    await x.model.open({ ...x.payload, primaryRequestClass: 'view', primaryViewOptions: {
      grouping: { ...x.payload.primaryPresentation.grouping, enabled: true }, captionSelections: [] } });
    await h.ackEntered; await tick();
    assert.notEqual(x.model.header, header); assert.notEqual(x.model.header.leaseId, header.leaseId);
    assert.equal(x.model.getReceiptDataSubject(), subject);
    assert.equal(x.model.view.serverMetadata.canonicalMetadataFact.diagnosticTail, canonicalFact.diagnosticTail);
    assert.notEqual(x.model.view.serverMetadata.canonicalMetadataFact, canonicalFact, 'new lease has a newly checked fact');
    assert.equal(h.env.entries, presented, 'no Panel render/adopt/commit was simulated');
    assert.equal(h.env.primaryReceiptCommitRef.current, commit, 'same committed data, not a new paint certificate');
    assert.equal(h.queries(), 2); assert.equal(h.removed.length, 1); assert.equal(h.consumed(), 1);
  } finally { h?.cleanup(); assert.equal(x.model.metadataListeners.size, 0); assert.equal(x.model.receiptWakeListeners.size, 0); await x.close(); }
});

test('external open no-adopt abort/failure/recompose settlement wakes the current retained receipt observation', async () => {
  for (const outcome of ['abort', 'failure', 'recompose']) {
    const queryGate = deferred(), queryEntered = deferred(), externalGate = deferred(), externalEntered = deferred();
    let queryHeld = false, armExternal = false;
    const x = await setup([row('promoted', { sourceUuidAliases: ['old'], sourceIdentityAliases: ['source-old'] })], {
      intercept: async (channel, payload, f) => {
        if (channel === 'agent-transcript:get-history' && armExternal) {
          armExternal = false; externalEntered.resolve(); await externalGate.promise;
          if (outcome === 'failure') throw Object.assign(Error('external open failed'), { code: 'EXTERNAL_OPEN_FAILED' });
          return { success: false, error: 'HISTORY_PRIMARY_VIEW_RECOMPOSE_REQUIRED', requiredClass: 'semantic', reason: 'fixture-view-miss' };
        }
        if (!queryHeld && payload.kind === 'primary-canonical-consumers') {
          queryHeld = true; const result = await f.invoke(channel, payload); queryEntered.resolve(); await queryGate.promise; return result;
        }
      } });
    let h, off, metadataOff;
    try {
      const events = []; let metadata = 0;
      off = x.model.onReceiptReadWake(event => events.push(event)); metadataOff = x.model.onMetadata(() => metadata++);
      h = rig(x.model, x.canonical, receipt()); h.resolveList(); await queryEntered.promise;
      const retained = x.model.header, subject = x.model.getReceiptDataSubject();
      const controller = new AbortController(); armExternal = true;
      const open = x.model.open({ ...x.payload, primaryRequestClass: 'view', primaryViewOptions: x.payload.primaryPresentation }, { signal: controller.signal });
      await externalEntered.promise;
      if (outcome === 'abort') controller.abort(); externalGate.resolve();
      if (outcome === 'recompose') assert.equal((await open).kind, 'recompose-required');
      else await assert.rejects(open);
      await h.ackEntered; queryGate.resolve(); await tick();
      assert.equal(x.model.header, retained); assert.equal(x.model.getReceiptDataSubject(), subject);
      assert.equal(metadata, 0, 'failed/cancelled read did not become metadata adoption');
      assert.deepEqual(events.map(event => event.kind), ['settled']);
      assert.equal(h.queries(), 2); assert.equal(h.calls.filter(call => call.channel.includes('acknowledge')).length, 1);
      assert.equal(h.removed.length, 1); assert.equal(h.hydrated.length, 0);
      x.model.notify(); await tick(); assert.equal(h.queries(), 2);
    } finally { queryGate.resolve(); externalGate.resolve(); h?.cleanup(); off?.(); metadataOff?.(); await x.close(); }
  }
});

test('old external settlements, owner loss and close cannot resurrect a receipt observation', async () => {
  for (const mode of ['old-settlement', 'owner-loss', 'foreign-address', 'close']) {
    const entered = [deferred(), deferred()], gates = [deferred(), deferred()]; let armed = false, reads = 0;
    const x = await setup([row('promoted', { sourceUuidAliases: ['old'], sourceIdentityAliases: ['source-old'] })], {
      intercept: async (channel, payload) => {
        if (armed && channel === 'agent-transcript:get-history') {
          const index = reads++; entered[index].resolve(); await gates[index].promise;
          throw Object.assign(Error('external failed'), { code: 'EXTERNAL_OPEN_FAILED' });
        }
      } });
    let h, off;
    try {
      const events = []; off = x.model.onReceiptReadWake(event => events.push(event));
      const actual = x.model.readConfirmedCanonicalReceipt.bind(x.model); let first = true;
      h = rig(x.model, x.canonical, receipt(), { query: (...args) => {
        if (first) { first = false; throw Object.assign(Error('UNKNOWN'), { code: 'UNKNOWN' }); } return actual(...args);
      } });
      h.resolveList(); await h.probed; await tick(); assert.equal(h.queries(), 1);
      armed = true;
      const openA = x.model.open(mode === 'foreign-address' ? { ...x.payload, tabId: 'other-tab' } : x.payload).catch(error => error); await entered[0].promise;
      if (mode === 'old-settlement') {
        const openB = x.model.open(x.payload).catch(error => error); await entered[1].promise;
        gates[0].resolve(); await openA; await tick(); assert.equal(events.length, 0); assert.equal(h.queries(), 1);
        gates[1].resolve(); await openB; await h.ackEntered; await tick();
        assert.deepEqual(events.map(event => event.kind), ['settled']); assert.equal(h.queries(), 2);
      } else {
        if (mode === 'owner-loss') h.env.historyOwnerGenerationRef.current++;
        else if (mode === 'close') await x.model.close();
        gates[0].resolve(); await openA; await tick();
        assert.equal(h.queries(), 1); assert.equal(h.removed.length, 0);
        if (mode === 'close' || mode === 'foreign-address') assert.equal(events.length, 0);
      }
    } finally { gates.forEach(gate => gate.resolve()); h?.cleanup(); off?.(); await x.close(); }
  }
});

test('successful adoption publishes one receipt wake and no second settlement wake', async () => {
  const x = await setup([row('one')]); const events = [];
  const off = x.model.onReceiptReadWake(event => events.push(event));
  try {
    await x.model.open({ ...x.payload, primaryRequestClass: 'view', primaryViewOptions: x.payload.primaryPresentation });
    assert.deepEqual(events.map(event => event.kind), ['adopted']);
    x.model.notify(); await tick(); assert.equal(events.length, 1);
  } finally { off(); await x.close(); }
});

test('new view during an awaited proof cancels old observation and uses the actual current cut once', async () => {
  const x = await setup([row('promoted', { sourceUuidAliases: ['old'], sourceIdentityAliases: ['source-old'] })]);
  const gate = deferred(), entered = deferred(); let h;
  try {
    let first = true;
    const actual = x.model.readConfirmedCanonicalReceipt.bind(x.model);
    h = rig(x.model, x.canonical, receipt(), { query: async (...args) => {
      const proof = await actual(...args);
      if (first) { first = false; entered.resolve(); await gate.promise; }
      return proof;
    } });
    h.resolveList(); await entered.promise; const header = x.model.header;
    await x.model.open({ ...x.payload, primaryRequestClass: 'view', primaryViewOptions: {
      grouping: { ...x.payload.primaryPresentation.grouping, threshold: 3 }, captionSelections: [] } });
    await h.ackEntered; gate.resolve(); await tick();
    assert.notEqual(x.model.header, header);
    assert.equal(h.calls.filter(c => c.channel.includes('acknowledge')).length, 1);
    assert.equal(h.queries(), 2); assert.equal(h.removed.length, 1); assert.equal(h.hydrated.length, 0);
  } finally { gate.resolve(); h?.cleanup(); await x.close(); }
});

test('changed canonical/metadata subject cannot borrow old rows or ACK before the actual adopter commit', async () => {
  const x = await setup([row('promoted', { sourceUuidAliases: ['old'], sourceIdentityAliases: ['source-old'] })]);
  let h;
  try {
    let first = true;
    const actual = x.model.readConfirmedCanonicalReceipt.bind(x.model);
    h = rig(x.model, x.canonical, receipt(), { query: (...args) => {
      if (first) { first = false; throw Object.assign(Error('unknown'), { code: 'UNKNOWN' }); }
      return actual(...args);
    } });
    h.resolveList(); await h.probed; await tick();
    const subject = x.model.getReceiptDataSubject();
    await x.model.open({ ...x.payload, primaryRequestClass: 'source' }); await tick();
    assert.notEqual(x.model.getReceiptDataSubject(), subject);
    assert.equal(h.queries(), 1, 'adoption alone cannot certify changed data');
    h.commit(); assert.equal(h.env.primaryReceiptCommitRef.current, null, 'old entries/adopter cannot certify a naked new header');
    h.restart(); await tick(); assert.equal(h.queries(), 1);
    h.adoptCurrent(); h.commit(); h.restart(); await h.ackEntered; await tick();
    assert.equal(h.queries(), 2); assert.equal(h.removed.length, 1);
  } finally { h?.cleanup(); await x.close(); }
});
