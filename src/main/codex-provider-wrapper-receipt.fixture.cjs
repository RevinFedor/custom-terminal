'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const queueProof = require('./codex-queued-message-proof');

const mainSource = process.env.CODEX_TARGET_BASELINE_ASAR
  ? require('@electron/asar').extractFile(process.env.CODEX_TARGET_BASELINE_ASAR, 'dist/main/main.js').toString()
  : fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
function declaration(name) {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, 'actual function: ' + name);
  return node.getText(ast);
}
const style = { firstTextStyle: 'fg=1:8,bg=0:-1,dim', hasDim: true,
  allTextDim: true, hasNonDefaultFg: true };
const line = (row, text, extra = {}) => ({ row, text, wrapped: false, ...extra });
function frame(frameNumber, queueRows = []) {
  return { success: true, authoritativeFrameCommitted: true,
    mirrorGeneration: 'mirror-a', committedFrameGeneration: frameNumber, writeSeq: frameNumber * 2,
    preViewportLines: [], lines: [
      line(1, '• Messages to be submitted after next tool call', style),
      line(2, '  (press esc to interrupt and send immediately)', style),
      ...queueRows.map((text, index) => line(3 + index, text, style)),
      line(3 + queueRows.length, ''), line(4 + queueRows.length, '› Ask Codex to do anything'),
    ] };
}
const enrichedPrompt = ('[Noted Terminal context update]\n'
  + 'Working state for this session changed.\n\n'
  + '[Orchestration] Completed fixture run; read its result.\n').padEnd(2130, 'x');
const enrichedQueueRows = ['  ↳ [Noted Terminal contex', '    t update]',
  '    Working state for this session changed.', '    …'];

// Real Codex IPC wrapper -> full safePaste/_inner -> real SQLite receipt store
// -> real committed-frame matcher/acceptor -> real audit resolution. Physical
// PTY, process/readiness and the no-image transport boundary are fixture-only.
function harness(t, { source = 'orchestration-completion:fixture-run', ready = true,
  frameFault = null, explicit = false, prompt = enrichedPrompt,
  initialWriterSessionId = 'session-a', acceptedResumeSourceSessionId = null,
  beforeDrain = null, lineageSourceSessionId = null, writerUnconfirmed = false,
  synchronousObservationMissing = false, revalidateTarget = null } = {}) {
  let db;
  try { db = new Database(':memory:'); }
  catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI; run with ELECTRON_RUN_AS_NODE=1');
      return null;
    }
    throw error;
  }
  t.after(() => db.close());
  let attempts = 0, targetReads = 0;
  const store = createAgentSendReceiptStore(db, { randomUUID: () => 'attempt-' + ++attempts });
  const tabId = 'wrapper-tab';
  const handoffId = 'fixture-handoff';
  const writes = [], proofs = [], publications = [], audits = [];
  const mirror = { generation: 'mirror-a', lastCommittedVisibleSnapshot: frame(10) };
  if (frameFault === 'no-growth') mirror.lastCommittedVisibleSnapshot = frame(10, enrichedQueueRows);
  const commands = new Map([[tabId, { runSeq: 7, isRunning: true }]]);
  const revisions = new Map([[tabId, 11]]);
  const launches = new Map();
  const turnWatchers = new Map();
  let generation = 'lifecycle-a';
  let context;
  const term = { write(text) {
    writes.push({ text, states: store.list().map(record => record.state) });
    if (text === '\r') queueMicrotask(() => {
      const snapshot = frame(11, enrichedQueueRows);
      if (frameFault === 'old-frame') snapshot.committedFrameGeneration = 10;
      if (frameFault === 'mirror') snapshot.mirrorGeneration = 'other-mirror';
      if (frameFault === 'input') revisions.set(tabId, revisions.get(tabId) + 1);
      if (frameFault === 'run') commands.get(tabId).runSeq++;
      mirror.lastCommittedVisibleSnapshot = snapshot;
      context.observeCodexQueuedMessageCommittedFrame(tabId, mirror, snapshot);
    });
  } };
  let writer;
  const setWriter = (sessionId, acceptedSource = null) => {
    writer = { sessionId, sourceSessionId: acceptedSource, launchId: 'launch-a',
      terminalToken: term, runSeq: commands.get(tabId).runSeq, lifecycleGeneration: generation };
    turnWatchers.set(tabId, { sessionId, busy: true });
    if (acceptedSource) launches.set(tabId, { command: 'codex-c', materializedFresh: false,
      sessionId: acceptedSource, launchId: 'launch-a', terminalToken: term,
      runSeq: commands.get(tabId).runSeq, lifecycleGeneration: generation });
    else launches.delete(tabId);
  };
  setWriter(initialWriterSessionId, acceptedResumeSourceSessionId || (writerUnconfirmed ? initialWriterSessionId : null));
  if (lineageSourceSessionId) writer.sourceSessionId = lineageSourceSessionId;
  let explicitRecord;
  if (explicit) {
    explicitRecord = store.beginAttempt({ operationKey: 'project:explicit-operation', surface: 'project-api',
      tabId, handoffId, requestFingerprint: 'explicit-request', provider: 'codex', sessionId: 'session-a',
      promptHash: promptAuditFingerprint(prompt), promptLength: prompt.length });
  }
  context = vm.createContext({
    ...require('./agent-history-send-receipt'),
    ...require('./prompt-queue-source'),
    ...require('./claude-prompt-audit'),
    ...require('./claude-composer-proof'),
    ...require('./codex-runtime-contract'),
    ...require('./history-prompt-presentations'),
    ...require('./codex-image-request-projection'),
    ...require('./agent-send-target-precondition'),
    ...queueProof, promptAuditFingerprint,
    Buffer, Date, Promise, setTimeout, clearTimeout, crypto: require('node:crypto'),
    console: { log() {}, warn() {}, error() {} },
    _webBroadcast() {},
    CODEX_PASTE_AUDIT_TIMEOUT_MS: 15, CLAUDE_PASTE_AUDIT_TIMEOUT_MS: 15,
    AGENT_SEND_DURABLE_STATES: STORE_STATES,
    PASTE_START: '\x1b[200~', PASTE_END: '\x1b[201~',
    terminals: new Map([[tabId, term]]), terminalCommandState: commands,
    terminalLifecycleEpochs: new WeakMap([[term, 'terminal-instance-a']]),
    terminalStopRevisions: new WeakMap(),
    bridgeKnownSessions: new Map(),
    terminalInputRevisions: revisions, terminalProjects: new Map([[tabId, '/fixture']]),
    getTerminalLifecycleGeneration: () => generation,
    getHeadlessTerminalMirror: () => mirror,
    nodePerformance: { now: Date.now }, aiStoppingTabs: new Map(),
    mainWindow: { isDestroyed: () => false, webContents: {
      send: (channel, value) => publications.push({ channel, value }),
    } },
    agentSendReceiptStore: store,
    codexSettingsMutationQueue: require('./codex-settings-mutation-queue').createCodexSettingsMutationQueue(),
    codexModelEffortIntentReconcileInflight: new Map(),
    tabWorkContext: { assertContinuationScope() {} },
    conversationOwners: { assertNone() {}, noteInput() {} },
    isCodexTuiEffectivelyReady: () => ready,
    // The writer/send evidence below is fixture state; the renderer-to-main
    // wrapper still executes main's real operational-input predicate. Only the
    // broader policy projection is fixture-owned here.
    getCodexPublicRuntimeProjection: () => ({ inputReady: ready }),
    ensureCodexInputReadyForExternalPrompt: async () => ({ success: false, error: 'codex_not_input_ready' }),
    codexHasLivePtySubmitEvidence: () => true,
    getCodexRuntimeSessionSnapshot: async () => ({ liveLifecycle: true,
      sessionStatus: 'active', inputReady: true, busy: false }),
    armCodexSubmissionObservationWithoutProof: () => ({ available: true, kind: 'writer',
      sessionId: synchronousObservationMissing ? null : writer.sessionId }),
    ensureCodexSubmissionWatcher: async () => {
      targetReads++;
      return revalidateTarget ? revalidateTarget({
        context,
        confirmWriter: sid => { writerUnconfirmed = false; setWriter(sid); },
        touchInput: () => revisions.set(tabId, revisions.get(tabId) + 1),
        tabId,
      }) : { available: false, writerStatus: 'unknown' };
    },
    getCodexWriterProofSnapshot: () => writerUnconfirmed ? null : writer,
    codexLastRunCommandPayload: launches,
    getCodexResumeReadIdentityLeaseForTab: () => null,
    prepareCodexImagePathMarkersForPaste: (_tab, text) => ({ text, replaced: 0, missing: [], staged: [] }),
    validatePromptQueueImageMarkers: async () => ({ success: true }),
    beginCodexPromptInFlight: () => ({ submitted: false }),
    markCodexPromptSubmitted: (_tab, state) => { state.submitted = true; },
    clearCodexPromptInFlight() {},
    requestTerminalCodexDraftState: async () => ({ success: true, hasDraft: false }),
    drainPtyData: async () => { if (beforeDrain) beforeDrain(setWriter); },
    recordComposerForensicPtyInput: () => null,
    captureCodexPromptAuditBoundary: () => ({ sessionId: writer.sessionId, byteOffset: 42, fileSize: 42 }),
    enqueueCodexPasteAudit: (_tab, audit) => audits.push(audit),
    getPendingCodexPasteAudits: () => audits.filter(audit => !audit.finished),
    hasPendingCodexPasteAudit: (_tab, audit) => audits.includes(audit) && !audit.finished,
    holdPasteAuditCompletionForTest: () => false,
    removePendingCodexPasteAudit() {},
    publishAgentPromptAuditResult() {},
    armPendingCodexNativeRewindStableSourceSubmit: () => ({ active: false }),
    codexTurnWatchers: turnWatchers,
    agentSendCancellations: { isCancelled: () => false },
    aiBoundaryTestGate: { waitIfArmed: async () => ({ claimed: false }) },
    agentSendTestFaultActive: () => false,
    codexSubmitDropTestFault: { consume: () => false },
    codexImageBindings: { resetComposer() {} },
    reconcileCodexWriterFromProcess: async () => ({}),
    invalidateCodexWriterObservations() {},
    activityOpenIntervals: new Map(), responseActivityPreflights: new Map(),
    retryCodexEnterAfterAuditTimeout: async () => ({ retried: false }),
    classifyCodexQueuedMessageFrame: input => {
      const result = queueProof.classifyCodexQueuedMessageFrame(input);
      proofs.push(result);
      return result;
    },
    ipcMain: { handle: (_channel, handler) => { context.sendHandler = handler; } },
  });
  for (const name of ['pasteInflight', 'ptyWriteOwners', 'ptyActiveWriteOperation', 'ptyLastQueuedWriteOperation']) {
    const node = ast.statements.find(item => ts.isVariableStatement(item)
      && item.declarationList.declarations.some(d => d.name.getText(ast) === name));
    assert.ok(node, 'actual PTY lock state: ' + name);
    vm.runInContext(node.getText(ast), context);
  }
  vm.runInContext(declaration('withPtyWriteLock'), context);
  for (const name of ['getTerminalInputRevision', 'bumpTerminalInputRevision', 'findTabIdForTerm',
    'getTerminalStopRevision', 'captureAgentInputIdentity', 'agentSendExecutionFailure',
    'markActivePtySubmit', 'pasteAuditHash', 'pasteAuditPreview', 'captureCodexPtySubmitAdmission',
    'revalidateCodexPtySubmitAdmission', 'safePasteAndSubmit', '_safePasteAndSubmitInner',
    'finishSafePasteAfterWrite', 'resolveSafePasteFailureAfterWrite',
    'finishCodexPasteAuditAfterWrite', 'captureCodexQueuedMessageAuditBaseline',
    'codexProviderQueueAcceptedResult', 'publishCodexProviderQueueAccepted', 'acceptCodexQueuedMessageAudit',
    'observeCodexQueuedMessageCommittedFrame', 'waitForCodexPasteAudit', 'markCodexAuditDeliveryUnknown',
    'finishCodexPasteAudit', 'currentCodexAcceptedResumeSourceProof', 'readAgentSendDestinationAtWriteBoundary']) {
    vm.runInContext(declaration(name), context);
  }
  for (const name of ['expectedKnownEmptySend', 'assertKnownEmptySend']) {
    vm.runInContext(declaration(name), context);
  }
  vm.runInContext(declaration('isCodexOperationalInputReady'), context);
  for (const name of ['agentSendRequestExpectedTargets', 'agentSendRequestTargetFailure']) {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    if (node) vm.runInContext(node.getText(ast), context);
  }
  const handler = ast.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'ipcMain.handle'
    && node.expression.arguments[0]?.text === 'codex:send-command');
  assert.ok(handler, 'actual Codex source-wrapping handler');
  vm.runInContext(handler.getText(ast), context);
  return {
    store, writes, proofs, publications, audits, setWriter, attempts: () => attempts,
    targetReads: () => targetReads,
    readTarget: () => context.readAgentSendDestinationAtWriteBoundary(tabId, 'codex'),
    firstOsc: () => { commands.get(tabId).runSeq++; generation = 'same-launch-next-run';
      writer.runSeq = commands.get(tabId).runSeq; writer.lifecycleGeneration = generation;
      if (launches.has(tabId)) Object.assign(launches.get(tabId), { runSeq: writer.runSeq, lifecycleGeneration: generation }); },
    replaceLaunch: () => { if (launches.has(tabId)) launches.get(tabId).launchId = 'other-launch'; writer.launchId = 'other-launch'; },
    replaceTerminal: () => { const replacement = { write: text => writes.push({ text, replacement: true, states: [] }) };
      context.terminals.set(tabId, replacement); context.terminalLifecycleEpochs.set(replacement, 'terminal-instance-b'); },
    setGeneration: value => { generation = value; writer.lifecycleGeneration = value;
      if (launches.has(tabId)) launches.get(tabId).lifecycleGeneration = value; },
    send: (overrides = {}) => context.sendHandler({ sender: {} }, tabId, prompt, {
      source, handoffId, queue: true, statusAtSend: 'busy', promptQueueAction: 'send-now',
      ...(explicit ? { sendOperationKey: explicitRecord.record.operationKey,
        sendAttemptId: explicitRecord.attemptId } : {}),
      ...overrides,
    }),
  };
}


module.exports = { harness, enrichedPrompt };
