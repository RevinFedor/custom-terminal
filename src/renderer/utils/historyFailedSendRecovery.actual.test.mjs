// SOURCE callbacks + private actual handoff/sparse owners. React scheduling,
// receipt IPC, clipboard and storage are finite adapters; no native UI/PTY claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as composer from './composerChips.mjs';
import * as image from './promptImageAttachments.mjs';
import { buildHistoryMessageClipboardPayload } from './composerClipboard.mjs';
import { historySendPresentationAction } from './historySendReturn.mjs';
import * as presentation from './historyPromptPresentation.mjs';
import { captureHistoryComposerDraftOwner } from './historyComposerDraftOwner.mjs';
import { buildHistoryLivePresentation, retireHistoryLivePromptByExactProof } from './historyLiveProjection.mjs';
import { copyHistoryPrimaryMetadataOrigin } from './historyPrimaryMetadataOrigin.mjs';
import { compileHistoryFixture as compile, installHistoryPromptPanelRows,
  privateHistoryPromptHandoffs } from './test-helpers/historyPromptPanelFixture.mjs';

const panel = fs.readFileSync(process.env.HISTORY_RECOVERY_PANEL_SOURCE || new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('HistoryPanel.tsx', panel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function variable(name) {
  let found;
  function visit(node) {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(ast) === name)) found = node;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(found, name); return found.getText(ast);
}
const moduleFixture = () => privateHistoryPromptHandoffs(process.env.HISTORY_RECOVERY_HANDOFF_SOURCE);
const now = 100000;
const record = () => ({ tabId: 'private-recovery', handoffId: 'H', operationKey: 'history:private-recovery:H',
  attemptId: 'physical-A', provider: 'codex', surface: 'desktop-history', sessionId: 'S', state: 'not-submitted',
  createdAt: 1000, updatedAt: 80000, applicationQueue: { version: 1, id: 9, position: 7, state: 'failed', queuedAt: 1000 },
  receipt: { code: 'agent_send_readiness_timeout', source: 'history-panel', submitted: false, pasteWritten: false, enterWritten: false,
    promptText: '  original [imagePath: /synthetic/exact.png]\n',
    presentationSnapshot: { historySessionId: 'S', imagePaths: [{ id: 1, path: '/synthetic/exact.png' }] },
    authoringSnapshot: { editorText: '  original [Image #1]\n',
      chips: [{ id: 'exact-chip', kind: 'prompt', text: 'EXACT body', label: 'Own', sourceKey: 'exact-source' }],
      imagePaths: [{ id: 1, path: '/synthetic/exact.png', assetId: 'exact' }] } } });

function presentationFixture(t, { canonicalReady = false, records = [] } = {}) {
  const handoffs = moduleFixture(), calls = [], notices = [], clipboard = [], persisted = [], warnings = [];
  const cleanups = [];
  let readResult;
  const context = vm.createContext({ ...handoffs, ...composer, ...image, ...presentation, captureHistoryComposerDraftOwner,
    AbortController, primaryPhysicalCandidate: false, primaryRoot: null, primaryHeader: null,
    primaryRootRef: { current: null }, primaryReceiptCommitRef: { current: null }, console: { log() {}, warn: (...args) => warnings.push(args) },
    Date: class extends Date { static now() { return now; } },
    tabId: 'private-recovery', sessionId: 'S', toolType: 'codex', historyOwnerKey: 'owner',
    historyOwnerKeyRef: { current: 'owner' }, historySnapshotOwner: { tabId: 'private-recovery', sessionId: 'S' },
    historyOwnerGenerationRef: { current: 1 }, historyTabIdRef: { current: 'private-recovery' }, fileRewriteEpoch: 1,
    LOCAL_PROMPT_PREFIX: 'local-prompt-', LOCAL_PROMPT_FAILURE_TTL_MS: 15000,
    LOCAL_REWIND_STALE_TTL_MS: 10000, promptHandoffMetaRef: { current: new Map() },
    suppressedPromptsRef: { current: new Map() }, rawServerEntriesRef: { current: [] },
    committedHistoryEntriesRef: { current: { ownerKey: 'owner', entries: [] } },
    liveProjectionRef: { current: { ownerKey: 'owner', entries: [] } }, returnPromptInflight: { current: new Set() },
    useCallback: fn => fn, useEffect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
    historyDiag() {}, promptPreview: text => text.slice(0, 8),
    retainHistoryDraftImages: image.retainPromptImageRefsForText,
    resolveHistoryPromptHandoffSemanticTags: () => [],
    buildHistoryLivePresentation, retireHistoryLivePromptByExactProof, copyHistoryPrimaryMetadataOrigin,
    primaryLiveCoverageOwner: { wake() { throw Error('empty live fixture must not retire a live row'); } },
    setLiveEntries() { throw Error('empty live fixture must not publish live rows'); },
    keepHistoryTailPinnedAfterMutation() {}, setPrimarySuppressionRevision() {},
    setReceiptPresentationRevision() {},
    historyVolatileOverlayCache: { set: (_owner, value) => { persisted.push(value); return true; } },
    presentedOwnerKey: canonicalReady ? 'owner' : 'cold', chipsFreshOwnerKey: canonicalReady ? 'owner' : '',
    receiptPresentationRevision: 0,
    ipcRenderer: { invoke: async (channel, payload) => { calls.push({ channel, payload });
      if (channel === 'agent:list-send-receipts') return readResult ? await readResult : { success: true, records };
      throw Error('unexpected mutation ' + channel);
    } },
    useUIStore: { getState: () => ({ historyPromptDrafts: { 'private-recovery': 'NEW draft' }, showToast: value => notices.push(value) }),
      subscribe: () => () => {} },
    flushHistoryComposerDrafts() { throw Error('cold failure may not overwrite composer'); },
    setHistoryPromptDraft() { throw Error('cold failure may not overwrite composer'); },
    acknowledgeMaterializedHistoryReceipt() { throw Error('empty canonical fixture cannot ACK materialization'); },
  });
  const install = name => Object.assign(context, vm.runInContext(compile('(() => {\n' + variable(name)
    + '\nreturn {' + name + '};\n})()'), context));
  install('persistVolatileOverlay');
  const rowFixture = installHistoryPromptPanelRows(context, panel, { adoptionOwners: true });
  for (const name of ['entryMatchesSuppressedPrompt', 'findServerPromptEntry', 'serverHasPromptEntry',
    'appendLocalPromptEntry', 'updateLocalPromptEntry', 'mergeServerAndLocalEntries']) install(name);
  t.after(() => { for (const close of cleanups.splice(0).reverse()) close(); rowFixture.close(); });
  const subscriptionStart = panel.indexOf('useEffect(() => subscribeHistoryPromptHandoffs(tabId, (snapshot, change) => {',
    panel.indexOf('const acknowledgeMaterializedHistoryReceipt ='));
  const subscriptionEnd = panel.indexOf('\n\n  const appendCompactErrorEntry', subscriptionStart);
  const readStart = panel.indexOf('  useEffect(() => {\n    let stopped = false;', panel.indexOf('const acknowledgeMaterializedHistoryReceipt ='));
  const readEnd = panel.indexOf('\n\n  useEffect(() => subscribeHistoryPromptHandoffs', readStart);
  assert.ok(subscriptionStart > 0 && subscriptionEnd > subscriptionStart && readStart > 0 && readEnd > readStart);
  return { handoffs, calls, notices, clipboard, persisted, warnings, context,
    rows: rowFixture.rows, sparseOwner: rowFixture.owner,
    subscribe() { vm.runInContext(compile(panel.slice(subscriptionStart, subscriptionEnd)), context); return cleanups.at(-1); },
    read() { vm.runInContext(compile(panel.slice(readStart, readEnd)), context); return cleanups.at(-1); },
    pending(promise) { readResult = promise; },
    copy(row) {
      Object.assign(context, { entry: row, copyOwnerRef: { current: row },
        researchReply: null, buildHistoryMessageClipboardPayload,
        copiedTimerRef: { current: null }, setCopied() {}, setTimeout() {}, clearTimeout() {},
        writeElectronComposerSnapshotClipboard: value => { clipboard.push(value); return { textCopied: true, snapshotCopied: true }; } });
      vm.runInContext(compile(variable('copyPrompt') + '\nglobalThis.copyActual = copyPrompt;'), context);
      return context.copyActual({ preventDefault() {}, stopPropagation() {} });
    },
    merge() { return rowFixture.commit(context.mergeServerAndLocalEntries([], rowFixture.rows())); },
    overlay() { context.persistVolatileOverlay(context.historySnapshotOwner, rowFixture.rows()); return persisted.at(-1); },
  };
}
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

test('actual receipt → failed subscriber → append → aged merge/overlay retain exact action and authoring identity', t => {
  const h = presentationFixture(t); const unsubscribe = h.subscribe();
  assert.equal(h.handoffs.hydrateHistoryPromptHandoffFromDurableReceipt(record()).hydrated, true);
  assert.equal(h.rows().length, 1);
  const row = h.rows()[0];
  const meta = h.context.promptHandoffMetaRef.current.get('H');
  assert.equal(meta.sendOperationKey, record().operationKey);
  assert.equal(meta.sendAttemptId, 'physical-A');
  const metaOwner = h.context.getLocalPromptMetaOwner(meta);
  assert.ok(metaOwner);
  assert.equal(h.sparseOwner.current().rows[0], row);
  assert.equal(h.sparseOwner.current().entries.deref(), h.rows());
  assert.equal(row.applicationQueueId, 9); assert.equal(row.applicationQueuePosition, 7);
  assert.equal(row.sendOperationKey, record().operationKey); assert.equal(row.sendAttemptId, 'physical-A');
  assert.equal(row.authoringSnapshot.editorText, record().receipt.authoringSnapshot.editorText);
  assert.equal(row.statusChangedAt, 80000, 'failure time is not click/hydration time');
  assert.equal(h.merge().length, 1); assert.equal(h.overlay().entries.length, 1);
  assert.equal(h.context.getLocalPromptMetaOwner(h.context.promptHandoffMetaRef.current.get('H')), metaOwner);
  assert.equal(h.sparseOwner.current().entries.deref(), h.rows());
  assert.deepEqual(historySendPresentationAction(row), { kind: 'dismiss', enabled: true });
  const copied = buildHistoryMessageClipboardPayload({ text: row.content, authoringSnapshot: row.authoringSnapshot });
  assert.equal(copied.snapshot.text, record().receipt.authoringSnapshot.editorText);
  assert.equal(copied.snapshot.chips[0].id, 'exact-chip');
  assert.equal(copied.snapshot.imagePaths[0].assetId, 'exact');
  unsubscribe();
});

test('actual cold receipt effect restores a failed admitted card without canonical History or changing NEW draft', async t => {
  const h = presentationFixture(t, { records: [record()] }); const unsubscribe = h.subscribe(), dispose = h.read();
  await tick(); assert.equal(h.rows().length, 1);
  assert.deepEqual(h.warnings, []);
  assert.equal(h.rows()[0].queueStatus, 'failed');
  assert.equal(h.sparseOwner.current().rows[0], h.rows()[0]);
  assert.equal(h.sparseOwner.current().entries.deref(), h.rows());
  assert.equal(h.handoffs.getHistoryPromptHandoffsSnapshot('private-recovery')[0].sendAttemptId, 'physical-A');
  assert.deepEqual(h.calls.map(call => call.channel), ['agent:list-send-receipts']);
  dispose(); unsubscribe();
});

test('confirmed/legacy/external receipts keep the canonical/surface gate', async t => {
  const original = record();
  for (const row of [{ ...original, state: 'confirmed' }, { ...original, applicationQueue: null },
    { ...original, surface: 'project-api' }]) {
    const h = presentationFixture(t, { records: [row] }); const unsubscribe = h.subscribe(), dispose = h.read();
    await tick(); assert.deepEqual(h.warnings, []); assert.equal(h.rows().length, 0); dispose(); unsubscribe();
  }
});

test('successful exact X invalidates an already fetched list; old list cannot resurrect after control eviction', async t => {
  const h = presentationFixture(t);
  const read = h.handoffs.beginHistorySendReceiptRead?.('private-recovery');
  assert.ok(read, 'Main control needs an active-read lease, not just a bounded tombstone');
  const hidden = { ...record(), receipt: { presentationDismissedAt: now, presentationDismissedSurface: 'desktop-history' } };
  assert.equal(h.handoffs.recordHistorySendPresentationDismissal(hidden), true);
  assert.equal(read.isCurrent(), false); read.close();
  assert.equal(h.handoffs.hydrateHistoryPromptHandoffFromDurableReceipt(record()).hydrated, false);
  const next = { ...record(), attemptId: 'physical-B' };
  assert.equal(h.handoffs.hydrateHistoryPromptHandoffFromDurableReceipt(next).hydrated, true, 'A dismissal is not B authority');
  const store = new h.handoffs.HistoryPromptHandoffStore({ maxTabs: 1, maxHandoffs: 1, maxBytes: 100000 });
  const active = store.beginReceiptRead('private-recovery');
  assert.equal(store.recordPresentationDismissal(hidden), true);
  for (let i = 0; i < 260; i++) store.observeDeliveryControl({ ...hidden, handoffId: 'other-' + i, operationKey: 'other-' + i });
  assert.equal(active.isCurrent(), false, 'bounded metadata eviction cannot validate a pre-X active read');
  active.close();
});

test('actual cold async effect rechecks owner and dismissal after list await', async t => {
  for (const replacement of ['dismiss', 'owner', 'generation']) {
    const h = presentationFixture(t); const unsubscribe = h.subscribe();
    let release; h.pending(new Promise(resolve => { release = resolve; })); const dispose = h.read();
    if (replacement === 'owner') h.context.historyOwnerKeyRef.current = 'foreign';
    else if (replacement === 'generation') h.context.historyOwnerGenerationRef.current++;
    else assert.equal(h.handoffs.recordHistorySendPresentationDismissal?.({ ...record(), receipt: {
      presentationDismissedAt: now, presentationDismissedSurface: 'desktop-history' } }), true);
    release({ success: true, records: [record()] }); await tick();
    assert.deepEqual(h.warnings, []);
    assert.equal(h.rows().length, 0, replacement); dispose(); unsubscribe();
  }
});

test('bounded handoff eviction keeps exact row action identity and original Copy snapshot', t => {
  const h = presentationFixture(t); const store = new h.handoffs.HistoryPromptHandoffStore({ maxTabs: 1, maxHandoffs: 1, maxBytes: 100000 });
  const input = { tabId: 'private-recovery', handoffId: 'H', toolType: 'codex', text: 'display', source: 'history-panel',
    sendOperationKey: record().operationKey, sendAttemptId: 'physical-A', applicationQueueId: 9,
    authoringText: '  exact original\n', authoringChips: [], authoringImagePaths: [] };
  const handoff = store.begin(input);
  assert.ok(h.handoffs.historyPromptHandoffRecoveryFields, 'projection must carry fields before eviction');
  const fields = h.handoffs.historyPromptHandoffRecoveryFields(handoff);
  store.begin({ ...input, handoffId: 'OTHER', sendOperationKey: 'history:private-recovery:OTHER', sendAttemptId: 'B' });
  assert.equal(store.getSnapshot('private-recovery').some(row => row.handoffId === 'H'), false);
  assert.equal(fields.sendAttemptId, 'physical-A');
  const copied = buildHistoryMessageClipboardPayload({ text: 'display', authoringSnapshot: fields.authoringSnapshot });
  assert.equal(copied.snapshot.text, '  exact original\n');
});

test('actual failed Copy reads one exact receipt after payload eviction instead of reconstructing trimmed display', async t => {
  const h = presentationFixture(t, { records: [record()] });
  const row = { uuid: 'local-prompt-private-H', role: 'queued', queueStatus: 'failed',
    handoffId: 'H', sendOperationKey: record().operationKey, sendAttemptId: 'physical-A', content: 'trimmed display' };
  await h.copy(row);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].payload.operationKey, row.sendOperationKey);
  assert.equal(h.clipboard.length, 1);
  assert.equal(h.clipboard[0].snapshot.text, record().receipt.authoringSnapshot.editorText);
  assert.equal(h.clipboard[0].snapshot.chips[0].sourceKey, 'exact-source');
  assert.equal(h.clipboard[0].snapshot.imagePaths[0].assetId, 'exact');
});

test('foreign receipt or replaced Copy owner cannot write somebody else’s snapshot', async t => {
  const row = { uuid: 'local-prompt-private-H', role: 'queued', queueStatus: 'failed',
    handoffId: 'H', sendOperationKey: record().operationKey, sendAttemptId: 'physical-A', content: 'trimmed display' };
  const wrong = presentationFixture(t, { records: [{ ...record(), attemptId: 'B' }] });
  await wrong.copy(row); assert.equal(wrong.clipboard.length, 0);
  const changed = presentationFixture(t); let release;
  changed.pending(new Promise(resolve => { release = resolve; }));
  const pending = changed.copy(row);
  changed.context.copyOwnerRef.current = { ...row, sendAttemptId: 'B' };
  release({ success: true, records: [record()] }); await pending;
  assert.equal(changed.clipboard.length, 0);
});
