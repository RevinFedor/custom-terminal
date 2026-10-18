'use strict';
// Actual Main writer/serializer and real SQLite; controlled PTY, current-frame,
// image-transport and provider-observer endpoints. This is not a native run.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), Database = require('better-sqlite3');
const { createAgentSendReceiptStore, STORE_STATES } = require('../agent-send-receipt-store');
const preparation = require('../agent-send-preparation');
const { createCodexDraftRequestHarness, drainMicrotasks } = require('./codex-draft-request-observation.cjs');
const root = process.env.ACTUAL_SOURCE_DIR || path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const names = ['safePasteAndSubmit', '_safePasteAndSubmitInner', 'finishSafePasteAfterWrite',
  'writeHistorySendEnter',
  'resolveSafePasteFailureAfterWrite', 'agentSendExecutionFailure', 'withPtyWriteLock',
  'pasteInflight', 'ptyActiveWriteOperation', 'ptyLastQueuedWriteOperation', 'ptyWriteOwners'];
const source = names.map(name => {
  const node = ast.statements.find(n => (ts.isFunctionDeclaration(n) && n.name?.text === name)
    || (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === name)));
  if (!node) throw new Error('Actual declaration missing: ' + name); return node.getText(ast);
}).join('\n');

function fixture(t, { open = true, throwEnter = false, deadlineOffset = null } = {}) {
  let inputRevision = 1, stopRevision = 0, stages = 0, drains = 0, settingsCurrent = true;
  let proof = { success: true, hasDraft: open ? null : false, source: 'headless-main:cursor:10',
    ...(open ? { frameBlocker: 'synchronized-output-open' } : {}) };
  const h = createCodexDraftRequestHarness({ rendererAvailable: false, getDraft: () => proof });
  const ctx = h.context, writes = [], events = [], audits = [];
  const term = { write(data) { writes.push(data); if (data === '\r' && throwEnter) throw Error('controlled Enter throw'); } };
  const db = new Database(':memory:'), store = createAgentSendReceiptStore(db);
  const identity = { operationKey: 'history:T:H', tabId: 'T', handoffId: 'H', provider: 'codex',
    surface: 'desktop-history', requestFingerprint: 'immutable', promptHash: 'hash', promptLength: 6 };
  const attempt = store.beginAttempt(identity);
  const scope = preparation.createSendPreparationScope({ ...identity, attemptId: attempt.attemptId }, h.clock.now());
  const ownedAttachments = { version: 1, refs: [{ assetId: 'frozen-A', path: '/controlled/A.png' }] };
  store.stageAttemptContext(identity.operationKey, attempt.attemptId, { preflightScope: scope, ownedAttachments });
  const initialOwner = () => ({ terminalToken: term, terminalRunSeq: 1, terminalLifecycleGeneration: 'L1',
    terminalStopRevision: stopRevision, inputRevision, mirrorToken: h.mirror, mirrorGeneration: h.mirror.generation });
  ctx.terminals.set('T', term); ctx.terminalCommandState.set('T', { runSeq: 1, isRunning: true });
  const startup = deadlineOffset === null ? null : { launchId: 'COLD', terminalToken: term,
    lifecycleGeneration: 'L1', runSeq: 1, stopRevision: 0, startedAt: h.clock.now() - (60000 - deadlineOffset),
    deadlineAt: h.clock.now() + deadlineOffset };
  Object.assign(ctx, { ...preparation, agentSendReceiptStore: store, AGENT_SEND_DURABLE_STATES: STORE_STATES,
    ...require('../agent-send-enter-timing'),
    queueMicrotask,
    readAgentSendPreparation: (s, tab, opts, cold) => preparation.readAgentSendPreparation(s, tab, opts, cold, h.clock.now),
    findTabIdForTerm: () => 'T', captureAgentInputIdentity: initialOwner,
    getTerminalInputRevision: () => inputRevision, getTerminalStopRevision: () => stopRevision,
    bumpTerminalInputRevision: () => { inputRevision++; h.setOwner({ inputRevision }); return inputRevision; },
    reserveClaudeExactEmptyEvidence: () => null, isLocalSlashCommandPrompt: () => false,
    assertKnownEmptySend() {}, conversationOwners: { noteInput() {} },
    codexSettingsMutationQueue: { getUnsubmittedInput: () => null }, codexModelEffortIntentReconcileInflight: new Map(),
    mainWindow: null, terminalProjects: new Map(), bridgeKnownSessions: new Map(), promptQueueAssetStore: {},
    isPromptQueueSource: () => false, isPromptQueueAutomationSource: () => false,
    shouldStageClaudeUserPromptAudit: () => false,
    activityOpenIntervals: new Map(), responseActivityPreflights: new Map(),
    promptPresentationHistorySessionId: () => null, normalizePromptPresentationSnapshot: x => x,
    prepareOwnedAttachmentTransport: async ({ record, prompt }) => { stages++; events.push(['stage', record.attemptId]);
      return { text: prompt, imageRefs: [] }; }, leasePromptQueueAssetRefs() {},
    prepareCodexImagePathMarkersForPaste: (_tab, text) => ({ text, staged: [], missing: [], replaced: 0 }),
    isDesktopHistorySendReceiptEligible: () => false,
    createCodexImageRequestProjection: () => null,
    captureCodexPromptAuditBoundary: () => null,
    resolveCodexImageRequestProjection: () => null,
    codexImageBindings: { beginDirect() {}, resetComposer() {} },
    beginCodexPromptInFlight: () => ({ submitted: false }), clearCodexPromptInFlight() {},
    drainPtyData: async () => { drains++; },
    agentSendCancellations: { isCancelled: () => false },
    PASTE_START: '\x1b[200~', PASTE_END: '\x1b[201~',
    CLAUDE_PASTE_AUDIT_TIMEOUT_MS: 8000, CODEX_PASTE_AUDIT_TIMEOUT_MS: 8000,
    recordComposerForensicPtyInput() {}, recordAgentPromptPresentation() {},
    pasteAuditHash: require('../prompt-audit-fingerprint').promptAuditFingerprint,
    pasteAuditPreview: (text, start = 0) => text.slice(start, start + 80),
    captureCodexQueuedMessageAuditBaseline: () => null,
    enqueueCodexPasteAudit: (_tab, audit) => audits.push(audit),
    getPendingCodexPasteAudits: () => audits,
    hasPendingCodexPasteAudit: (_tab, audit) => audits.includes(audit),
    finishCodexPasteAudit: (_tab, audit, result) => { audit.finished = true; audit.result = result; },
    armPendingCodexNativeRewindStableSourceSubmit: () => ({ active: false }),
    invalidateCodexWriterObservations() {}, markCodexPromptSubmitted() {},
    publishAgentSendReceiptRecord() {},
    _webBroadcast() {}, aiBoundaryTestGate: { waitIfArmed: async () => null },
    codexSubmitDropTestFault: { consume: () => false },
    markActivePtySubmit() {}, notifyPromptSubmitWritten() {},
    terminalIoProgress: { input() {} },
    reconcileCodexWriterFromProcess: async () => ({}),
  });
  ctx.console.error = (...args) => h.logs.push(args.join(' '));
  vm.runInContext(source, ctx);
  vm.runInContext('globalThis.held = () => ptyWriteOwners.has(terminals.get("T"));', ctx);
  const opts = { source: 'codex-controlled', submit: true, skipRenderWait: true,
    handoffId: 'H', sendOperationKey: identity.operationKey, sendAttemptId: attempt.attemptId,
    codexSubmissionPreflight: false, verifyCodexVisibleDraftBeforeSubmit: true,
    codexStartupFrameWait: startup,
    settingsWriteGuard: () => ({ allowed: settingsCurrent, reason: 'settings-changed' }) };
  t.after(async () => { stopRevision++; h.setOwner({ terminalStopRevision: stopRevision }); h.notifyFrame();
    await drainMicrotasks(100); db.close(); });
  return { ...h, ctx, term, store, identity, attempt, scope, ownedAttachments, writes, events, opts,
    start: more => ctx.safePasteAndSubmit(term, 'frozen', { ...opts, ...more }),
    get stages() { return stages; }, get drains() { return drains; }, get inputRevision() { return inputRevision; },
    frame(hasDraft = false) { proof = { success: true, hasDraft, source: 'headless-main:cursor:10',
      frameIdentity: { generation: 'G1', writeSeq: 40 } }; h.notifyFrame(); },
    open() { proof = { success: true, hasDraft: null, frameBlocker: 'synchronized-output-open' }; h.notifyFrame(); },
    change(what) {
      if (what === 'input') { inputRevision++; h.setOwner({ inputRevision }); }
      if (what === 'stop') { stopRevision++; h.setOwner({ terminalStopRevision: stopRevision }); }
      if (what === 'owner') { ctx.terminals.set('T', { write() { throw Error('successor must not receive input'); } }); h.setOwner({ terminalLifecycleGeneration: 'L2' }); }
      if (what === 'settings') settingsCurrent = false;
      if (what === 'cancel') store.cancelDelivery({ ...identity, attemptId: attempt.attemptId });
      h.notifyFrame();
    },
  };
}
module.exports = { fixture, drainMicrotasks };
