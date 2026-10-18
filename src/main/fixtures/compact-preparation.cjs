'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore } = require('../agent-send-receipt-store');
const { createCompactOperationRegistry } = require('../compact-operation-state');
const { createCodexSettingsMutationQueue } = require('../codex-settings-mutation-queue');
const preparation = require('../agent-send-preparation');
const { createCodexDraftRequestHarness, drainMicrotasks: tick } = require('./codex-draft-request-observation.cjs');
const main = fs.readFileSync(path.join(process.env.ACTUAL_SOURCE_DIR || path.join(__dirname, '..'), 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const names = ['executeCodexLiveSlashCommandRequest', 'sendCodexLiveSlashCommand', 'sendCodexSlashCommand',
  'writeHistorySendEnter',
  'readCodexPickerWriteRefusal', 'captureCodexOwnedSlashDraftIdentity', 'validateCodexOwnedSlashDraftIdentity',
  'validateCodexOwnedModelInputIdentity', 'retainCodexOwnedModelInput', 'releaseCodexOwnedModelInput',
  'readCodexOwnedModelInputDecision', 'waitForCodexOwnedModelPaste', 'isCodexOwnedSlashSubmitReady',
  'reconcileCodexOwnedModelInputAtWriteBoundary', 'settleCodexOwnedModelInput',
  'inspectCodexOwnedSlashDraft', 'rollbackCodexOwnedSlashDraft',
  'readCodexCompactSubmitOwnership', 'observeCodexCompactPostEnter', 'submitCodexCompactSlashCommandWithProof',
  'withPtyWriteLock', 'pasteInflight', 'ptyActiveWriteOperation', 'ptyLastQueuedWriteOperation', 'ptyWriteOwners'];
const source = names.map(name => {
  const n = ast.statements.find(n => (ts.isFunctionDeclaration(n) && n.name?.text === name)
    || (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === name)));
  if (!n) throw Error('missing actual ' + name); return n.getText(ast);
}).join('\n');
function fixture(t, { capturedDraft = false, immediate = false, throwEnter = false, autoStart = true } = {}) {
  let input = 1, stop = 0, proofText = capturedDraft ? 'original author' : '', open = false, seq = 10, restores = 0;
  const currentProof = () => ({ success: true, hasDraft: open ? null : !!proofText,
    preview: open ? '' : proofText, source: 'headless-main:cursor:3',
    ...(open ? { frameBlocker: 'synchronized-output-open' } : { frameIdentity: { generation: 'G1', writeSeq: seq } }) });
  const h = createCodexDraftRequestHarness({ rendererAvailable: false, getDraft: currentProof });
  const ctx = h.context, writes = [], publications = [], subscribers = new Set();
  Object.assign(h.mirror, { writeSeq: seq, terminal: { buffer: { active: { baseY: 0, cursorY: 3 } } } });
  const db = new Database(':memory:'), store = createAgentSendReceiptStore(db);
  const identity = { operationKey: 'history:T:H', tabId: 'T', handoffId: 'H', provider: 'codex',
    surface: 'desktop-history', requestFingerprint: 'compact-request', promptHash: 'compact', promptLength: 8 };
  const begun = store.beginAttempt(identity);
  const scope = preparation.createSendPreparationScope({ ...identity, attemptId: begun.attemptId }, h.clock.now());
  store.stageAttemptContext(identity.operationKey, begun.attemptId, { preflightScope: scope });
  const registry = createCompactOperationRegistry({ now: h.clock.now, publish: event => {
    publications.push(event); for (const cb of [...subscribers]) cb(event);
  } });
  const settingsQueue = createCodexSettingsMutationQueue();
  const captured = { text: 'original author', images: 1, imagePaths: [{ assetId: 'same-asset', path: '/controlled/A.png' }] };
  const term = { write(bytes) {
    writes.push(bytes);
    if (bytes.includes('\x1b[200~')) {
      proofText = '/compact'; open = !immediate; seq++; h.mirror.writeSeq = seq;
      if (immediate) queueMicrotask(() => h.notifyFrame());
    } else if (bytes === '\r') {
      if (throwEnter) throw Error('controlled Enter throw');
      if (autoStart) queueMicrotask(lateStart);
    } else if (bytes === '\x01\x0b' || bytes === '\x03') {
      proofText = ''; open = false; seq++; h.mirror.writeSeq = seq;
      queueMicrotask(() => h.notifyFrame());
    }
  } };
  const owner = () => ({ tabId: 'T', sessionId: 'S', generation: 'L1', terminal: term });
  const lateStart = () => registry.confirmStart({ ...owner(), provider: 'codex', operationId: 'codex:api:H',
    eventSequence: 6, sourceByteOffset: 20, proof: 'controlled-exact-post-boundary-task-start' });
  ctx.terminals.set('T', term); ctx.terminalCommandState.set('T', { runSeq: 1, isRunning: true });
  Object.assign(ctx, { ...preparation, ...require('../codex-runtime-contract'), ...require('../codex-model-picker'),
    ...require('../agent-send-enter-timing'), mainWindow: null,
    ...require('../codex-compact-slash-submit'), ...require('../codex-slash-input-diagnostics'),
    readAgentSendPreparation: (s, tab, opts, cold) => preparation.readAgentSendPreparation(s, tab, opts, cold, h.clock.now),
    createInputPreparation: (deadline, why) => preparation.createInputPreparation(deadline, why, h.clock.now),
    getTerminalInputRevision: () => input, getTerminalStopRevision: () => stop,
    codexPickerQueue: new Map(), codexModelEffortIntentReconcileInflight: new Map(),
    codexSettingsMutationQueue: settingsQueue, codexTuiReadyTabs: new Set(['T']), codexLateMcpProofPending: new Map(),
    codexRuntimePolicies: { read: () => null }, agentSendReceiptStore: store,
    agentSendCancellations: { isCancelled: (_tab, _handoff, attempt) => store.isDeliveryCancelled(identity.operationKey, attempt) },
    isOwnedDesktopHistorySendSource: () => true,
    codexHasLivePtySubmitEvidence: () => true, isCodexTuiEffectivelyReady: () => true,
    hasCodexPromptOrTurnInFlight: () => false, terminalProjects: new Map(),
    getHeadlessVisibleBufferSnapshot: () => ({ success: true, authoritativeFrameCommitted: !open,
      synchronizedOutputOpen: open, writeSeq: seq, flushedSeq: open ? seq - 1 : seq,
      committedFrameGeneration: seq - 9 }),
    captureCodexManualCompactBoundary: () => ({ ...owner(), promptSeq: 1, boundaryEventSequence: 5, sourceByteOffset: 10 }),
    readCodexManualInputOwner: owner, sameCodexManualCompactOwner: (a, b) => a.terminal === b.terminal && a.generation === b.generation,
    compactOperations: registry,
    subscribeCompactOperationChanges: cb => { subscribers.add(cb); return () => subscribers.delete(cb); },
    cancelCodexManualCompactPending: (_tab, reason, operationId) => registry.cancelPending({ ...owner(), provider: 'codex', operationId, reason }),
    recordComposerForensicPtyInput() {},
    emitAgentReadinessChanged: () => h.notifyFrame(),
    getCurrentCodexServiceTierProofIdentity: () => ({ ownerId: 'S' }),
    createCodexPickerDraftCapture: () => null,
    stashCodexDraftForPicker: async () => { proofText = ''; return { success: true, draftSnapshot: captured }; },
    restoreCodexDraftAfterPicker: async (_term, { writeGuard }) => {
      const check = writeGuard('restore-captured-draft');
      if (!check.allowed) return { success: false, error: 'codex_input_ownership_changed', manualTakeover: true };
      restores++; return { success: true };
    },
    codexNativeDraftTransfer: (_tab, snapshot) => snapshot,
    PASTE_START: '\x1b[200~', PASTE_END: '\x1b[201~', CODEX_SYNC_MARKER: '\x1b[?2026l',
    queueMicrotask,
  });
  ctx.console.error = (...a) => h.logs.push(a.join(' '));
  vm.runInContext(source, ctx);
  vm.runInContext('globalThis.held = () => ptyWriteOwners.has(terminals.get("T"));', ctx);
  t.after(async () => { stop++; h.setOwner({ terminalStopRevision: stop }); h.notifyFrame(); await tick(100);
    const retained = settingsQueue.getUnsubmittedInput(term); retained?.unsubscribe?.(); db.close(); });
  return { ...h, ctx, term, store, identity, begun, scope, registry, settingsQueue, writes, publications, captured,
    get restores() { return restores; },
    start: () => ctx.executeCodexLiveSlashCommandRequest({ sender: null, tabId: 'T', command: '/compact',
      handoffId: 'H', sendOperationKey: identity.operationKey, sendAttemptId: begun.attemptId, source: 'history-panel' }),
    frame(text = '/compact') { open = false; proofText = text; seq++; h.mirror.writeSeq = seq; h.notifyFrame(); },
    open() { open = true; seq++; h.mirror.writeSeq = seq; h.notifyFrame(); },
    change(what) {
      if (what === 'input') { input++; h.setOwner({ inputRevision: input }); }
      if (what === 'stop') { stop++; h.setOwner({ terminalStopRevision: stop }); }
      if (what === 'owner') { ctx.terminals.set('T', { write() { throw Error('successor'); } }); h.setOwner({ terminalLifecycleGeneration: 'L2' }); }
      if (what === 'cancel') store.cancelDelivery({ ...identity, attemptId: begun.attemptId });
      h.notifyFrame();
    }, lateStart,
  };
}
module.exports = { fixture, tick };
