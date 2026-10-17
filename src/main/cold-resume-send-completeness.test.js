'use strict';
// Actual supplied Main bodies. The first matrix controls PTY/process/parser/
// controller/audit ports. The final matrix also executes the actual Main mirror,
// write pump, xterm parser, composer grammar, physical lock and SQLite receipt
// store; provider process/output and clock remain controlled, not native acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const { createFakeClock, drainMicrotasks } = require('./fixtures/codex-draft-request-observation.cjs');
const { createAgentInputObservation, observeAgentInput } = require('./agent-input-observation');
const { createAgentSendCancellationRegistry } = require('./agent-send-cancellation');
const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const mainAst = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
const actual = name => {
  const node = mainAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, 'actual function missing: ' + name);
  return node.getText(mainAst);
};
const optionalDeclaration = name => mainAst.statements.find(node =>
  (ts.isFunctionDeclaration(node) && node.name?.text === name)
  || (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(mainAst) === name)))?.getText(mainAst) || '';
const scopeDeclarations = ['codexSendStartupFrameWaits', 'captureCodexSendStartupFrameWait',
  'codexSendStartupFrameWaitIsCurrent', 'clearCodexSendStartupFrameWait'].map(optionalDeclaration).join('\n');
const baseFunctions = ['getTerminalStopRevision', 'getTerminalInputRevision', 'bumpTerminalInputRevision',
  'captureAgentInputIdentity', 'validateAgentInputIdentity', 'agentInputObservationOwner',
  'createMainAgentInputObservation', 'agentDraftObservationResult', 'decorateAgentDraftProofIdentity',
  'agentSendExecutionFailure', 'requestTerminalCodexDraftState', 'clearCodexLaunchPayload',
  'finishCodexStartupLifecycle', '_safePasteAndSubmitInner', 'safePasteAndSubmit',
  'prepareCodexMainComposerForSend', 'ensureCodexInputReadyForExternalPrompt'];
function fixture({ startup = true, mirrorComplete = true, now = 10000, provisional = false } = {}) {
  const tabId = 'cold-tab', clock = createFakeClock(now), events = new EventEmitter();
  const writes = [], trace = [], audits = [], receipts = [];
  let text = '', drainImpl = async () => {}, settingsFailure = null;
  let turn = provisional ? { available: true, kind: 'provisional-source', sessionId: 'source',
    launchId: 'L', reservation: {} } : { available: true, kind: 'turn', sessionId: 'source' };
  const term = { pid: 7, write: data => { writes.push(data); trace.push(data === '\r' ? 'enter' : 'paste'); } };
  const mirror = { generation: 'M', generationOrdinal: 1, complete: mirrorComplete,
    writeSeq: 20, flushedSeq: 20, pendingResizeWriteSeq: null,
    redrawTrace: { synchronizedOutputOpen: false }, synchronizedFrameWaiters: new Set() };
  const m = {
    terminals: new Map([[tabId, term]]), terminalHeadlessMirrors: new Map([[tabId, mirror]]),
    terminalCommandState: new Map([[tabId, { runSeq: 1, isRunning: true }]]),
    terminalInputRevisions: new Map([[tabId, 5]]), terminalStopRevisions: new WeakMap(),
    codexLastRunCommandPayload: new Map(startup ? [[tabId, { command: 'codex-c', launchId: 'L',
      terminalToken: term, lifecycleGeneration: 'G:1', runSeq: 1, startedAt: 1000, sessionId: 'source' }]] : []),
    aiStoppingTabs: new Map(), codexPreclaimedCommandGenerations: new Map(),
    codexTuiReadyTabs: new Set([tabId]), codexForkComposerSeenTabs: new Set(),
    codexStartupAutoEnter: new Map(), codexMcpStartupWatchdogs: new Map(),
    codexStartupPromptManualOwnershipTabs: new Set(), codexStartupNoStateTimeoutTabs: new Set(),
    codexTuiReadyLastNotReady: new Map(), codexTurnWatchers: new Map(), terminalProjects: new Map(),
    codexWatchers: new Map(), responseActivityPreflights: new Map(), activityOpenIntervals: new Map(),
    bridgeKnownSessions: new Map(), ptyWriteOwners: new Map(),
    codexModelEffortIntentReconcileInflight: new Map(),
  };
  if (provisional) m.codexWatchers.set(tabId, { launchId: 'L', sourceSessionId: 'source',
    provisionalSubmitReservation: turn.reservation });
  const c = vm.createContext({ ...m, ...require('./codex-runtime-contract'), ...require('./codex-draft-authority'),
    ...require('../shared/agent-input-observation.cjs'), ...require('./claude-composer-proof'),
    Date: { now: clock.now }, setTimeout: clock.setTimer, clearTimeout: clock.clearTimer,
    console: { log() {}, warn() {}, error() {} }, crypto: require('node:crypto'), Buffer,
    ipcMain: events, mainWindow: null, HEADLESS_XTERM_FLUSH_TIMEOUT_MS: 700,
    CODEX_EXTERNAL_PROMPT_READY_TIMEOUT_MS: 60000,
    CODEX_STARTUP_NO_STATE_TIMEOUT_MS: 60000, CODEX_PASTE_AUDIT_TIMEOUT_MS: 1000, CLAUDE_PASTE_AUDIT_TIMEOUT_MS: 1000,
    PASTE_START: '\x1b[200~', PASTE_END: '\x1b[201~',
    CODEX_ACTION_PROFILE_RESUMED_ACTIVE_SUBMIT: 'resumed-active-submit',
    AGENT_SEND_DURABLE_STATES: { IN_FLIGHT: 'in-flight', ENTER_ARMED: 'enter-armed',
      AUDIT_PENDING: 'audit-pending', DELIVERY_UNKNOWN: 'delivery-unknown', CONFIRMED: 'confirmed', NOT_SUBMITTED: 'not-submitted' },
    agentSendCancellations: createAgentSendCancellationRegistry(),
    getTerminalLifecycleGeneration: () => 'G:' + m.terminalCommandState.get(tabId).runSeq,
    getHeadlessTerminalMirror: id => m.terminalHeadlessMirrors.get(id), findTabIdForTerm: t => t === term ? tabId : null,
    createAgentInputObservation: options => createAgentInputObservation({ ...options, now: clock.now,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer }), observeAgentInput,
    flushHeadlessTerminalMirror: async () => ({ success: true }),
    getHeadlessCodexDraftState: () => {
      const current = m.terminalHeadlessMirrors.get(tabId);
      trace.push('read');
      const blocker = !current?.complete ? 'incomplete' : c.getCodexDraftFrameBlocker({
        synchronizedOutputOpen: current.redrawTrace.synchronizedOutputOpen,
        writeSeq: current.writeSeq, flushedSeq: current.flushedSeq, pendingResizeWriteSeq: current.pendingResizeWriteSeq });
      return { success: true, hasDraft: blocker || text === null ? null : !!text, preview: text || '',
        source: 'headless-main', frameBlocker: blocker,
        frameIdentity: { generation: current?.generation, writeSeq: current?.flushedSeq } };
    },
    agentSendTestFaultActive: () => false, reportTerminalIncident() {},
    clearCodexServiceTierLaunchCandidate() {}, clearCodexPendingModelMigration() {},
    clearCodexStartupNoStateTimeoutTimer() {}, clearCodexLaunchAcceptancePending() {},
    clearCodexLateMcpProofPending() {}, activateDeferredCodexTurnWatcher() {}, clearCodexManualActionRequired() {},
    clearCodexStartupAutoEnter() {}, clearCodexMcpStartupWatchdog() {},
    codexSettingsMutationQueue: { getUnsubmittedInput: () => null },
    codexNativeQuestionMirror: { get: () => null },
    agentSendRequestTargetFailure: () => null,
    conversationOwners: { noteInput() {} }, assertKnownEmptySend() {},
    isLocalSlashCommandPrompt: () => false, isPromptQueueSource: () => false,
    isPromptQueueAutomationSource: () => false, shouldStageClaudeUserPromptAudit: () => false,
    _webBroadcast() {}, promptPresentationHistorySessionId: () => null,
    normalizePromptPresentationSnapshot: x => x,
    captureCodexPtySubmitAdmission: (_id, _term, revision) => c.createCodexPtySubmitAdmission({
      processRunning: true, hasLiveCodexEvidence: true, runSeq: m.terminalCommandState.get(tabId).runSeq,
      inputRevision: revision }),
    revalidateCodexPtySubmitAdmission: token => c.validateCodexPtySubmitAdmission(token, {
      processRunning: m.terminalCommandState.get(tabId).isRunning, hasLiveCodexEvidence: true,
      runSeq: m.terminalCommandState.get(tabId).runSeq, inputRevision: c.getTerminalInputRevision(tabId),
      stopping: m.aiStoppingTabs.has(tabId) }),
    armCodexSubmissionObservationWithoutProof: () => turn,
    validatePromptQueueImageMarkers: async () => ({ success: true }),
    prepareCodexImagePathMarkersForPaste: (_id, content) => ({ text: content, replaced: 0, missing: [], staged: [] }),
    isDesktopHistorySendReceiptEligible: () => false,
    beginCodexPromptInFlight: () => { trace.push('inflight'); return { submitted: false }; },
    clearCodexPromptInFlight: () => trace.push('clear-inflight'),
    drainPtyData: async () => { trace.push('drain'); await drainImpl(); },
    codexImageBindings: { beginDirect() {}, resetComposer() {} },
    readAgentSendDestinationAtWriteBoundary: () => ({ toolType: 'codex', sessionId: 'source' }),
    agentSendTargetPreconditionFailure: () => null,
    captureCodexPromptAuditBoundary: () => ({ sessionId: 'source', offset: 100 }),
    createCodexImageRequestProjection: () => null,
    recordComposerForensicPtyInput: () => null,
    pasteAuditHash: value => require('node:crypto').createHash('sha256').update(value).digest('hex'),
    pasteAuditPreview: (value, start = 0) => value.slice(start, start + 80),
    captureCodexQueuedMessageAuditBaseline: () => ({}), enqueueCodexPasteAudit: (_id, audit) => audits.push(audit),
    getPendingCodexPasteAudits: () => audits, armPendingCodexNativeRewindStableSourceSubmit: () => ({ active: false }),
    hasPendingCodexPasteAudit: (_id, a) => audits.includes(a), finishCodexPasteAudit: (_id, a) => { a.finished = true; },
    invalidateCodexWriterObservations() {}, aiBoundaryTestGate: { waitIfArmed: async () => ({ claimed: false }) },
    codexSubmitDropTestFault: { consume: () => false }, markActivePtySubmit() {}, markCodexPromptSubmitted() {}, reconcileCodexWriterFromProcess: async () => ({}),
    createMainCodexActionAuthority: input => ({ success: true, authority: { ...input, phase: 'created' } }),
    transitionMainCodexActionAuthority: (authority, phase) => { authority.phase = phase; return { success: true }; },
    validateMainCodexActionAuthority: (authority, input) => ({ valid: input.phases.includes(authority.phase) }),
    codexActionAuthorityTestHoldEnabled: () => false,
    releaseCodexProvisionalSubmitReservation: (_id, reservation) => { trace.push('release-reservation'); reservation.released = true; },
    markCodexProvisionalSubmitReservationWritten() {},
    finishCodexPasteAuditAfterWrite: async () => ({ success: null, submitted: true, auditPending: true }),
    finishSafePasteAfterWrite: async (_term, _content, _options, _op, result) => result,
    resolveSafePasteFailureAfterWrite: error => { throw error; },
    withPtyWriteLock: async (_term, fn) => fn(),
    agentSendReceiptStore: {
      get: () => null, isDeliveryCancelled: () => false,
      stageAttemptContext: () => ({ ok: true }),
      markAttemptState: (...args) => { receipts.push(['arm', ...args]); return { ok: true }; },
      settleAttempt: (...args) => { receipts.push(['settle', ...args]); return { ok: true }; },
    },
  });
  vm.runInContext(scopeDeclarations + '\n' + baseFunctions.map(actual).join('\n'), c);
  const options = () => ({ source: 'codex-history-panel', handoffId: 'H', sendAttemptId: 'A', sendOperationKey: 'O',
    expectedInputRevision: c.getTerminalInputRevision(tabId), verifyCodexVisibleDraftBeforeSubmit: true,
    skipRenderWait: true, awaitCodexUserMessageAudit: true,
    settingsWriteGuard: () => settingsFailure || { allowed: true } });
  return { c, m, clock, events, tabId, term, mirror, writes, trace, audits, receipts,
    options, text(value) { text = value; }, drain(fn) { drainImpl = fn; }, settings(value) { settingsFailure = value; },
    wake() { for (const f of [...mirror.synchronizedFrameWaiters]) f(); },
    close() { mirror.redrawTrace.synchronizedOutputOpen = false; mirror.flushedSeq = ++mirror.writeSeq; this.wake(); },
    stopABA() { c.terminalStopRevisions.set(term, c.getTerminalStopRevision(tabId) + 1);
      events.emit('agent:input-owner-changed-internal', null, { tabId, reason: 'process-stopping' }); },
    read() { return c.requestTerminalCodexDraftState(null, tabId, 'agent-send-preflight:history-panel', 700,
      { waitFor: false, waitOnUnknownOnly: true, waitTimeoutMs: 2500, handoffId: 'H', attemptId: 'A' }); },
    send(extra = {}) { return c._safePasteAndSubmitInner(term, 'immutable prompt', { ...options(), ...extra }); },
    clean() { assert.equal(clock.timers.size, 0); assert.equal(mirror.synchronizedFrameWaiters.size, 0);
      assert.equal(events.listenerCount('agent:input-owner-changed-internal'), 0);
      assert.equal(events.listenerCount('agent:readiness-changed-internal'), 0); },
  };
}
async function tickUntil(predicate) {
  for (let i = 0; i < 100; i++) { await drainMicrotasks(20); if (predicate()) return; }
  assert.ok(predicate(), 'expected actual Main checkpoint was not reached');
}

test('baseline control: whole actual Codex writer pastes and enters once', async () => {
  const h = fixture(); const r = await h.send();
  assert.equal(r.submitted, true); assert.deepEqual(h.writes, ['\x1b[200~immutable prompt\x1b[201~', '\r']); h.clean();
});

test('ready cleanup must not discard the original frame deadline', async () => {
  const h = fixture(); h.c.finishCodexStartupLifecycle(h.tabId);
  assert.equal(h.m.codexLastRunCommandPayload.has(h.tabId), false, 'do not retain launch settings payload');
  h.mirror.redrawTrace.synchronizedOutputOpen = true;
  let done = false; const p = h.read().then(r => { done = true; return r; });
  await drainMicrotasks(30); h.clock.advance(5500); await drainMicrotasks(30);
  const premature = done; h.close(); await p; h.clean();
  assert.equal(premature, false, 'ready cleanup may not replace the original launch deadline with 2500ms');
});

for (const change of ['open-frame', 'real-draft', 'mirror-replaced']) {
  test('whole actual writer: drain changes ' + change + ' after old pre-paste proof', async () => {
    const h = fixture();
    h.drain(async () => {
      if (change === 'open-frame') h.mirror.redrawTrace.synchronizedOutputOpen = true;
      if (change === 'real-draft') h.text('user-owned draft');
      if (change === 'mirror-replaced') h.m.terminalHeadlessMirrors.set(h.tabId,
        { ...h.mirror, generation: 'other-mirror', synchronizedFrameWaiters: new Set() });
    });
    let done = false; const p = h.send().then(r => { done = true; return r; });
    await drainMicrotasks(100);
    const earlyWrites = [...h.writes];
    if (!done && change === 'open-frame') h.close();
    const result = await p; h.clean();
    assert.deepEqual(earlyWrites, [], 'no paste or Enter may use the frame from before the drain');
    if (change === 'open-frame') { assert.equal(result.submitted, true); assert.equal(h.writes.length, 2); }
    else assert.equal(result.submitted, false);
  });
}

test('same-run launch replacement cannot settle an old cold observation', async () => {
  const h = fixture(); h.mirror.redrawTrace.synchronizedOutputOpen = true;
  const p = h.read(); await drainMicrotasks(30);
  h.m.codexLastRunCommandPayload.set(h.tabId, { ...h.m.codexLastRunCommandPayload.get(h.tabId), launchId: 'L2' });
  h.close(); const r = await p; h.clean();
  assert.equal(r.hasDraft, null); assert.equal(r.observation.status, 'superseded');
});

for (const change of ['stop', 'cancel', 'input', 'settings']) {
  test('whole writer preserves ' + change + ' during cold frame wait', async () => {
    const h = fixture(); h.mirror.redrawTrace.synchronizedOutputOpen = true;
    const p = h.send(); await tickUntil(() => h.mirror.synchronizedFrameWaiters.size > 0);
    if (change === 'stop') h.stopABA();
    if (change === 'cancel') h.c.agentSendCancellations.cancel(h.tabId, 'H', { attemptId: 'A' });
    if (change === 'input') h.c.bumpTerminalInputRevision(h.tabId);
    if (change === 'settings') h.settings({ allowed: false, reason: 'settings-owner-changed' });
    h.close(); const r = await p; h.clean();
    assert.equal(r.submitted, false); assert.equal(h.writes.length, 0); assert.equal(h.receipts.length, 0);
  });
}

function loadSendIpc(h) {
  const node = mainAst.statements.find(n => ts.isExpressionStatement(n)
    && n.getText(mainAst).startsWith("ipcMain.handle('codex:send-command'"));
  assert.ok(node); let handler;
  Object.assign(h.c, {
    ipcMain: { handle: (_name, fn) => { handler = fn; } }, nodePerformance: { now: h.clock.now },
    isCodexOperationalInputReady: () => false,
  });
  vm.runInContext(node.getText(mainAst), h.c);
  return handler;
}

test('actual send IPC must not rebase across Stop ABA during external readiness', async () => {
  const h = fixture(); const handler = loadSendIpc(h); let resume;
  h.c.ensureCodexInputReadyForExternalPrompt = () => new Promise(r => { resume = r; });
  let dispatched = false;
  // The real transaction implementation is not supplied. This port counts
  // whether the old IPC is permitted to reach it, rather than simulating it.
  h.c.safePasteAndSubmit = async () => { dispatched = true; return { success: true, submitted: true }; };
  const p = handler({}, h.tabId, 'immutable prompt', { source: 'history-panel' });
  await tickUntil(() => !!resume); h.stopABA(); resume({ success: true });
  const r = await p;
  assert.equal(dispatched, false); assert.equal(r.submitted, false);
  assert.equal(r.code, 'agent_send_execution_superseded');
});

for (const retained of [false, true]) {
  test('ready cleanup (late MCP retained=' + retained + ') keeps only the original deadline', async () => {
    const h = fixture({ now: 60000 });
    h.c.finishCodexStartupLifecycle(h.tabId, 'ready', { preserveLateMcpRecovery: retained });
    assert.equal(h.m.codexLastRunCommandPayload.has(h.tabId), retained);
    h.mirror.redrawTrace.synchronizedOutputOpen = true;
    const p = h.read(); await drainMicrotasks(50);
    const due = [...h.clock.timers.values()].map(t => t.dueAt);
    h.clock.advance(2500); const r = await p; h.clean();
    assert.deepEqual(due, [61000]); assert.equal(r.hasDraft, null); assert.equal(r.observation.budgetMs, 1000);
  });
}

test('one Send crossing the launch deadline in the existing write queue cannot acquire another 2500ms', async () => {
  const h = fixture({ now: 60500 }); h.mirror.redrawTrace.synchronizedOutputOpen = true;
  let release; h.c.withPtyWriteLock = (_t, fn) => new Promise(r => { release = () => r(fn()); });
  const p = h.c.safePasteAndSubmit(h.term, 'immutable prompt', h.options());
  h.clock.advance(1000); release(); await drainMicrotasks(80);
  const timers = h.clock.timers.size;
  h.clock.advance(2500); const result = await p; h.clean();
  assert.equal(timers, 0); assert.equal(result.codexDraftGuard.observation.budgetMs, 0);
  assert.equal(result.submitted, false); assert.equal(h.writes.length, 0);
});

test('new warm send after expiry still has the ordinary bounded frame wait', async () => {
  const h = fixture({ now: 62000 }); h.mirror.redrawTrace.synchronizedOutputOpen = true;
  const p = h.send(); await drainMicrotasks(60);
  assert.deepEqual([...h.clock.timers.values()].map(t => t.dueAt), [64500]);
  h.close(); assert.equal((await p).submitted, true); h.clean();
});

test('foreign cancellation does not settle the exact final cold attempt', async () => {
  const h = fixture(); h.mirror.redrawTrace.synchronizedOutputOpen = true;
  let done = false; const p = h.send().then(r => { done = true; return r; });
  await tickUntil(() => h.mirror.synchronizedFrameWaiters.size > 0);
  h.c.agentSendCancellations.cancel(h.tabId, 'H', { attemptId: 'foreign' });
  await drainMicrotasks(50); assert.equal(done, false);
  h.close(); assert.equal((await p).submitted, true); h.clean();
});

test('existing provisional-source reservation survives the cold wait and is armed only once', async () => {
  const h = fixture({ provisional: true }); h.mirror.redrawTrace.synchronizedOutputOpen = true;
  const p = h.send(); await tickUntil(() => h.mirror.synchronizedFrameWaiters.size > 0);
  h.close(); const r = await p; h.clean();
  assert.equal(r.submitted, true); assert.equal(h.writes.length, 2);
  assert.equal(h.receipts.filter(r => r[0] === 'arm').length, 1);
  assert.equal(h.trace.includes('release-reservation'), false);
  assert.equal(h.audits[0].submitWritten, true);
});

test('provisional-source cancellation releases the existing reservation without Enter', async () => {
  const h = fixture({ provisional: true }); h.mirror.redrawTrace.synchronizedOutputOpen = true;
  const p = h.send(); await tickUntil(() => h.mirror.synchronizedFrameWaiters.size > 0);
  h.c.agentSendCancellations.cancel(h.tabId, 'H', { attemptId: 'A' });
  const r = await p; h.close(); h.clean();
  assert.equal(r.submitted, false); assert.equal(h.writes.length, 0);
  assert.equal(h.trace.filter(v => v === 'release-reservation').length, 1);
});

test('busy manual Codex send is not converted into waiting for turn completion', async () => {
  const h = fixture({ startup: false }); h.m.codexTurnWatchers.set(h.tabId, { busy: true });
  const r = await h.send({ queuedAtSubmit: true }); h.clean();
  assert.equal(r.submitted, true); assert.equal(h.writes.filter(x => x === '\r').length, 1);
  assert.equal(h.audits[0].queuedAtSubmit, true);
});

test('Enter write throws after durable arm: original attempt remains unknown, with no second Enter', async () => {
  const h = fixture(); const write = h.term.write;
  h.term.write = data => { write(data); if (data === '\r') throw new Error('controlled write outcome unknown'); };
  const r = await h.send(); h.clean();
  assert.equal(r.deliveryUnknown, true); assert.equal(r.submitted, null);
  assert.equal(r.operationKey, 'O'); assert.equal(r.attemptId, 'A');
  assert.equal(h.writes.filter(x => x === '\r').length, 1);
  assert.equal(h.receipts.filter(x => x[0] === 'arm').length, 1);
  assert.equal(h.receipts.filter(x => x[0] === 'settle').length, 0);
});

test('no-write refusal never stages a durable Enter or canonical audit', async () => {
  const h = fixture(); h.text('do not overwrite'); const r = await h.send(); h.clean();
  assert.equal(r.submitted, false); assert.equal(h.receipts.length, 0);
  assert.equal(h.audits.length, 0); assert.equal(h.writes.length, 0);
});

function rendererDeclarations(file, names) {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/utils', file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const selected = names.map(name => {
    const node = ast.statements.find(n => (ts.isFunctionDeclaration(n) && n.name?.text === name)
      || (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === name)));
    assert.ok(node, 'actual renderer declaration missing: ' + name); return node.getText(ast);
  }).join('\n').replace(/\bexport /g, '');
  return ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS } }).outputText;
}
async function rendererFixture(h) {
  const handlers = new Map();
  // Keep the real emitter methods for Main observations while installing the
  // actual supplied IPC handlers. No Electron process is instantiated.
  h.events.handle = (name, fn) => handlers.set(name, fn);
  for (const name of ['codex:get-draft-state', 'codex:send-command']) {
    const node = mainAst.statements.find(n => ts.isExpressionStatement(n)
      && n.getText(mainAst).startsWith("ipcMain.handle('" + name + "'"));
    vm.runInContext(node.getText(mainAst), h.c);
  }
  h.c.nodePerformance = { now: h.clock.now };
  h.c.isCodexOperationalInputReady = () => true;
  const ipcCalls = [];
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = async (name, ...args) => {
    ipcCalls.push([name, ...args]);
    assert.ok(handlers.has(name), 'unexpected external IPC: ' + name);
    return handlers.get(name)({}, ...args);
  };
  const draftContract = await import('../renderer/utils/agentDraftPreflight.mjs');
  const { readCodexDraftAuthority } = await import('../renderer/utils/codexDraftAuthority.mjs');
  const c = vm.createContext({ ...draftContract, ...require('../shared/agent-send-target-precondition.cjs'),
    manualActionContract: require('../shared/agent-manual-action.cjs'), ipcRenderer, AbortController,
    Date: { now: h.clock.now }, setTimeout: h.clock.setTimer, clearTimeout: h.clock.clearTimer,
    console: { log() {}, warn() {}, error() {} },
    useWorkspaceStore: { getState: () => ({ clearInterruptedState() {} }) },
    terminalRegistry: { getCodexDraftState: () => ({ hasDraft: null, source: 'no-terminal' }) },
    findTabRuntimeContext: () => ({ tab: {}, projectId: 'project' }),
    isStandaloneCodexLocalSlashCommand: () => false,
    resolveCodexSettingsRuntimeProof: () => ({ activeWriterSessionId: null, currentSettingsOwnerId: null }),
    // Local CURRENT contains this normalizer, which Pro's bundle lacked.
    readCodexDraftAuthority,
    normalizeAgentSendOutcome: () => 'controlled-not-delivery-proof',
    isCoordinatedAgentSendCancellationRequested: () => false,
  });
  vm.runInContext([
    rendererDeclarations('historyAgentRuntimes.ts', ['probeCodexDraft', 'sendCodexPrompt', 'isSubmittedCodexAuditTimeout',
      'codexSendInflight', 'shortTab', 'errorText']),
    rendererDeclarations('agentSendPreparation.ts', ['needsExactDraftCapture', 'proveAgentComposerForSend',
      'createAgentReadyWait', 'prepareAgentRuntimeForSend']),
    rendererDeclarations('agentSendProviderContract.ts', ['CODEX_SEND_CONTRACT', 'CLAUDE_SEND_CONTRACT', 'getAgentSendProviderContract']),
    rendererDeclarations('agentSendAdapter.ts', ['createAgentSendAdapter']),
  ].join('\n'), c);
  const runtime = { toolType: 'codex', label: 'Codex', readyEvent: 'codex:tui-ready',
    probeDraft: c.probeCodexDraft, sendPrompt: c.sendCodexPrompt };
  const adapter = c.createAgentSendAdapter({ tabId: h.tabId, toolType: 'codex', runtime, assertSendNotCancelled() {} });
  return { c, runtime, adapter, ipcRenderer, ipcCalls, handlers };
}

test('Main proof -> actual renderer adapter/transport -> final Main guard keeps the original expired budget', async () => {
  const h = fixture({ now: 60000 }); const r = await rendererFixture(h);
  const composer = await r.adapter.proveComposer({ statusForSend: 'active', source: 'history-panel',
    handoffId: 'H', sendAttemptId: 'A' });
  h.c.finishCodexStartupLifecycle(h.tabId);
  h.clock.advance(1500); h.mirror.redrawTrace.synchronizedOutputOpen = true;
  let done = false;
  const pending = r.adapter.runProviderOperation({ prompt: 'immutable prompt', handoffId: 'H',
    sendAttemptId: 'A', sendOperationKey: 'O', source: 'history-panel', statusForSend: 'active',
    submitCapability: 'direct', settingsIntent: { kind: 'unchanged' }, composer })
    .then(x => { done = true; return x; });
  await drainMicrotasks(200); const immediate = done;
  for (let i = 0; i < 4 && !done; i++) { h.clock.advance(2500); await drainMicrotasks(100); }
  const result = await pending; h.clean();
  assert.equal(composer.codexStartupFrameWaitId, 'L'); assert.equal(immediate, true);
  const send = r.ipcCalls.find(call => call[0] === 'codex:send-command');
  assert.equal(send[3].codexStartupFrameWaitId, 'L'); assert.equal(send[3].sendAttemptId, 'A');
  assert.equal(result.submitted, false); assert.equal(result.codexDraftGuard.observation.budgetMs, 0);
  assert.equal(h.writes.length, 0);
});

test('actual ready preparation carries the followed launch into the composer phase after ready clears startupWait', async () => {
  const h = fixture(); const r = await rendererFixture(h);
  let presence = { status: 'starting', inputReady: false, runtimeSnapshot: {
    startupWait: { launchId: 'L', lifecycleGeneration: 'G:1', startedAt: 1000, deadlineAt: 61000 },
    sendTarget: { toolType: 'codex', sessionId: 'source', launchId: 'L' },
  } };
  r.runtime.getPresence = async () => presence;
  const pending = r.c.prepareAgentRuntimeForSend({ tabId: h.tabId, runtime: r.runtime,
    providerContract: r.c.getAgentSendProviderContract('codex', r.runtime), sessionId: 'source',
    launchAdmission: { cancel() {}, finish() {} } });
  await tickUntil(() => r.ipcRenderer.listenerCount('agent:readiness-changed') > 0);
  presence = { ...presence, status: 'active', inputReady: true,
    runtimeSnapshot: { ...presence.runtimeSnapshot, startupWait: null } };
  h.c.finishCodexStartupLifecycle(h.tabId);
  r.ipcRenderer.emit('agent:readiness-changed', null, { tabId: h.tabId, toolType: 'codex' });
  const ready = await pending; h.clean();
  assert.equal(ready.codexStartupFrameWaitId, 'L'); assert.equal(ready.submitCapability, 'direct');
  assert.equal(r.ipcRenderer.listenerCount('agent:readiness-changed'), 0);
});

test('actual provider contracts still admit manual busy Codex and Claude sends as queue', async () => {
  const h = fixture(); const r = await rendererFixture(h);
  for (const toolType of ['codex', 'claude']) {
    const contract = r.c.getAgentSendProviderContract(toolType, { toolType });
    assert.equal(contract.classifySubmitCapability({ status: 'busy', inputReady: true }), 'queue');
  }
});

function readyFixture(options = {}) {
  const h = fixture(options);
  let state = { inputReady: false }, readImpl = async () => state, pokes = 0;
  Object.assign(h.c, {
    getCodexTuiReadyState: () => readImpl(),
    hasCodexEstablishedComposerLifecycle: () => true,
    probeCodexStartupFromRawBuffer: () => { pokes++; return { ready: false }; },
  });
  return { ...h, state(value) { state = value; }, reads(fn) { readImpl = fn; }, pokes: () => pokes,
    wait() { return h.c.ensureCodexInputReadyForExternalPrompt(h.tabId, {
      handoffId: 'H', attemptId: 'A', sendOperationKey: 'O', timeoutMs: 60000,
    }); },
    notify() { h.events.emit('agent:readiness-changed-internal', null, { tabId: h.tabId, toolType: 'codex' }); },
  };
}

test('actual external readiness: original deadline bounds even the initial hung read', async () => {
  const h = readyFixture(); let release;
  h.reads(() => new Promise(resolve => { release = resolve; }));
  let done = false; const p = h.wait().then(r => { done = true; return r; });
  await tickUntil(() => !!release);
  h.clock.advance(51000); await drainMicrotasks(100); const bounded = done;
  release({ inputReady: true }); const r = await p; h.clean();
  assert.equal(bounded, true); assert.equal(r.success, false); assert.equal(r.reason, 'deadline');
  assert.equal(h.pokes(), 0, 'late read cannot start another startup continuation');
});

test('bounded readiness publishes one scalar outcome for the exact attempt, without prompt text', async () => {
  const h = readyFixture(), logs = [];
  h.c.console.warn = line => logs.push(line);
  const pending = h.wait(); await drainMicrotasks(100);
  h.c.agentSendCancellations.cancel(h.tabId, 'H', { attemptId: 'A' });
  const result = await pending; h.clean();
  assert.equal(result.code, 'agent_send_cancelled');
  assert.equal(logs.filter(line => line.startsWith('[CodexReadyWait] settled')).length, 1);
  assert.match(logs[0], /attempt=A.*success=false.*code=agent_send_cancelled/);
  assert.doesNotMatch(logs.join('\n'), /immutable prompt|user-owned draft/);
});

test('actual external readiness: near-expiry read does not get a new readiness timeout', async () => {
  const h = readyFixture({ now: 60000 }); const p = h.wait(); await drainMicrotasks(100);
  const due = [...h.clock.timers.values()].map(x => x.dueAt);
  h.clock.advance(60000); const r = await p; h.clean();
  assert.deepEqual(due, [61000]); assert.equal(r.success, false);
  assert.equal(h.pokes(), 1, 'deadline must not issue another raw-buffer/startup poke');
});

for (const change of ['cancel', 'stop']) {
  test('actual external readiness: ' + change + ' stops the same pending read before its late reply', async () => {
    const h = readyFixture(); let release;
    h.reads(() => new Promise(resolve => { release = resolve; }));
    let done = false; const p = h.wait().then(r => { done = true; return r; });
    await tickUntil(() => !!release);
    if (change === 'cancel') h.c.agentSendCancellations.cancel(h.tabId, 'H', { attemptId: 'A' });
    else h.stopABA();
    await drainMicrotasks(100); const revoked = done;
    release({ inputReady: true }); const r = await p; h.clean();
    assert.equal(revoked, true); assert.equal(r.success, false); assert.equal(h.pokes(), 0);
    assert.equal(r.code, change === 'cancel' ? 'agent_send_cancelled' : 'agent_send_execution_superseded');
  });
}

test('actual external readiness: a current policy menu returns on its wake rather than timing out', async () => {
  const h = readyFixture(); let done = false; const p = h.wait().then(r => { done = true; return r; });
  await tickUntil(() => h.events.listenerCount('agent:readiness-changed-internal') > 0);
  await drainMicrotasks(100);
  h.state({ inputReady: false, manualActionRequired: true, manualActionType: 'resume-goal' }); h.notify();
  await drainMicrotasks(100); const immediate = done;
  h.clock.advance(60000); const r = await p; h.clean();
  assert.equal(immediate, true); assert.equal(r.error, 'codex_manual_action_required');
  assert.equal(r.reason, 'resume-goal'); assert.equal(h.writes.length, 0);
});

test('actual external readiness: foreign attempt cancellation cannot cancel the original ready wait', async () => {
  const h = readyFixture(); let done = false; const p = h.wait().then(r => { done = true; return r; });
  await drainMicrotasks(100);
  h.c.agentSendCancellations.cancel(h.tabId, 'H', { attemptId: 'foreign' });
  await drainMicrotasks(100); assert.equal(done, false);
  h.state({ inputReady: true }); h.notify(); const r = await p; h.clean();
  assert.equal(r.success, true); assert.equal(h.writes.length, 0);
});

test('actual external readiness: a current operational input is returned without a startup poke', async () => {
  const h = readyFixture({ startup: false }); h.state({ inputReady: true, operationalReady: true });
  const r = await h.wait(); h.clean();
  assert.equal(r.success, true); assert.equal(r.waitedMs, 0); assert.equal(h.pokes(), 0);
});

test('actual get-ready cannot publish its old inputReady after Stop ABA during current-screen inspection', async () => {
  const h = fixture(); let release;
  Object.assign(h.c, {
    observeCurrentCodexStartupGoalFrame() {}, captureAiProcessLookupScope: () => ({}),
    aiProcessLookupScopeCurrent: () => true,
    codexLateMcpProofPending: new Map(), codexManualActionRequired: new Map(),
    codexTuiReadyMeta: new Map(), codexLifecycleWarnings: new Map(),
    isCodexTuiEffectivelyReady: () => true, getCodexMcpStartupStatus: () => null,
    inspectCurrentCodexMcpStartupScreenWithTierIdentity: () => new Promise(resolve => { release = resolve; }),
    reconcileCodexMcpStartupWatchdogFromCurrentScreen() {}, resolveCodexVerifiedCurrentFrameSettings: () => null,
    inspectAiDescendantProcessesByTabCached: async () => ({}),
    resolveProcessPresence: () => ({ present: true, lookupUnknown: false }),
    isCodexOperationalInputReady: () => true,
    projectCodexPolicyRuntime: state => state, codexRuntimePolicies: { read: () => null },
  });
  vm.runInContext(actual('getCodexTuiReadyState'), h.c);
  const p = h.c.getCodexTuiReadyState(h.tabId); await tickUntil(() => !!release);
  h.stopABA(); release({ success: true, inspected: { blockers: [] } });
  const r = await p; h.clean();
  assert.equal(r.inputReady, false); assert.equal(r.code, 'codex_readiness_observation_superseded');
});

test('actual external readiness consumes frame/readiness wakes without renewing its clock', async () => {
  const h = readyFixture(); const p = h.wait(); await drainMicrotasks(100);
  for (let i = 0; i < 3; i++) {
    h.clock.advance(1000); h.notify(); await drainMicrotasks(100);
  }
  const due = [...h.clock.timers.values()].map(x => x.dueAt);
  h.clock.advance(60000); const r = await p; h.clean();
  assert.deepEqual(due, [61000]); assert.equal(r.success, false); assert.equal(h.pokes(), 1);
});


test('image-binding preparation is not committed when the final guard finds a user draft', async () => {
  const h = fixture(); h.text('owned draft'); let bindings = 0;
  h.c.prepareCodexImagePathMarkersForPaste = () => ({ text: 'image and text', replaced: 1, missing: [],
    staged: [{ path: '/controlled/image.png' }], segments: [{ kind: 'image', text: '/controlled/image.png' },
      { kind: 'text', text: 'immutable prompt' }] });
  h.c.codexImageBindings.beginDirect = () => { bindings++; };
  const r = await h.send(); h.clean();
  assert.equal(r.submitted, false); assert.equal(bindings, 0); assert.equal(h.writes.length, 0);
});

function actualFrameFixture(t) {
  const h = fixture();
  Object.assign(h.c, require('./terminal-redraw-diagnostics'), require('./codex-tui-readiness'),
    require('./codex-model-picker'), require('./codex-manual-rewind'),
    require('./terminal-composer-forensics'), require('./terminal-replay-journal'), {
      HeadlessXTerminal: require('@xterm/headless').Terminal, HeadlessSerializeAddon: null,
      HEADLESS_XTERM_SCROLLBACK: 100, terminalHeadlessGenerationCounter: 0,
      createXtermWritePump: require('../shared/xterm-write-pump.cjs').createXtermWritePump,
      claudeLaunchGenerationByTab: new Map(), terminalHistoryPreviewController: { observeFrame() {} },
      observeCodexLateMcpProofAfterHeadlessFlush() {}, observeClaudeSynchronizedFrameFlushed() {},
      logTerminalComposerForensicError() {},
      logHeadlessTerminalMirrorError(_tab, _state, phase, error) { throw new Error(phase + ': ' + error?.message); },
    });
  // Downstream publishers do not provide the composer proof. The actual
  // commit-before-notify order, parser, snapshots and draft grammar run below.
  for (const name of ['observeCodexNativeSettingsIntentFrame', 'observeCommittedTerminalComposerForensics',
    'observeClaudeProviderFatalCommittedFrame', 'observeCodexModelCapacityCommittedFrame',
    'observeCodexQueuedMessageCommittedFrame', 'observeCodexInputControlReadinessFrame',
    'observeCodexSettingsActivityFrame', 'observeCodexStartupGoalCommittedFrame',
    'observeCodexStartupComposerCommittedFrame', 'observeClaudeTrustFolderPromptCommittedFrame',
    'observeClaudeAutoModeDefaultPromptCommittedFrame']) h.c[name] = () => {};
  h.c.codexNativeQuestionMirror.observeFrame = () => {};
  vm.runInContext(['CODEX_EMPTY_COMPOSER_HINT_RE', 'CODEX_NON_DRAFT_LINE_RE']
    .map(optionalDeclaration).join('\n') + '\n' + [
    'readHeadlessCursorMetrics', 'describeXtermCellStyle', 'xtermStyleHasNonDefaultBg',
    'xtermStyleHasNonDefaultFg', 'summarizeXtermLineStyles', 'summarizeXtermLineGeometry',
    'getLogicalLineSnapshotAt', 'extractCodexDraftFromLine', 'extractCodexDraftAfterEmptyPrompt',
    'describeCodexDraftProbeRow', 'buildCodexProbeDebug', 'getHeadlessVisibleBufferSnapshot',
    'commitHeadlessVisibleBufferSnapshot', 'createHeadlessTerminalMirror', 'getHeadlessTerminalMirror',
    'writeHeadlessTerminalMirror', 'flushHeadlessTerminalMirror', 'getHeadlessCodexDraftState',
  ].map(actual).join('\n'), h.c);
  h.m.terminalHeadlessMirrors.delete(h.tabId);
  const mirror = h.c.createHeadlessTerminalMirror(h.tabId, 90, 12);
  assert.ok(mirror);
  t.after(() => { mirror.writePump.dispose(); mirror.terminal.dispose(); });
  vm.runInContext(['pasteInflight', 'ptyWriteOwners', 'ptyActiveWriteOperation', 'ptyLastQueuedWriteOperation']
    .map(optionalDeclaration).join('\n') + '\n' + actual('withPtyWriteLock'), h.c);
  const db = new (require('better-sqlite3'))(':memory:');
  t.after(() => db.close());
  const store = require('./agent-send-receipt-store').createAgentSendReceiptStore(db,
    { randomUUID: () => 'A', now: h.clock.now });
  store.beginAttempt({ operationKey: 'O', tabId: h.tabId, handoffId: 'H', provider: 'codex',
    surface: 'desktop-history', requestFingerprint: 'request-H', sessionId: 'source',
    promptHash: h.c.pasteAuditHash('immutable prompt'), promptLength: 16 });
  h.c.agentSendReceiptStore = store;
  const write = async text => {
    h.c.writeHeadlessTerminalMirror(h.tabId, text);
    await mirror.writePump.drain();
    assert.equal(mirror.failed, false);
  };
  const paint = text => '\x1b[2J\x1b[H' + text + '\r\n\x1b[2mgpt-6 high · Context 10% used\x1b[0m';
  return { ...h, liveMirror: mirror, store, write, paint,
    send: () => h.c.safePasteAndSubmit(h.term, 'immutable prompt', h.options()),
  };
}

for (const ending of ['empty', 'draft', 'picker', 'missing-close']) {
  test('actual mirror/pump/grammar/lock/SQLite: cold frame resolves as ' + ending, { timeout: 5000 }, async t => {
    const h = actualFrameFixture(t), mirror = h.liveMirror;
    const empty = h.paint('› \x1b[2mAsk Codex to do anything\x1b[0m');
    await h.write(empty);
    const common = await h.read();
    assert.equal(common.hasDraft, false, JSON.stringify(common));
    h.c.finishCodexStartupLifecycle(h.tabId);
    assert.equal(h.m.codexLastRunCommandPayload.has(h.tabId), false);
    // Actual onData path opens the frame during the pre-paste drain, after
    // common empty and after ready cleanup have already happened.
    let opened;
    const openFrameFlushed = new Promise(resolve => { opened = resolve; });
    h.drain(async () => { await h.write('\x1b[?2026h' + h.paint('partial repaint')); opened(); });
    let settled = false;
    const pending = h.send().then(r => { settled = true; return r; });
    await openFrameFlushed;
    await drainMicrotasks(100);
    assert.ok(mirror.synchronizedFrameWaiters.size > 0);
    h.clock.advance(3000); await drainMicrotasks(80);
    assert.equal(settled, false, 'same operation waits past 2500 ms, under original deadline');
    assert.equal(h.writes.length, 0);
    if (ending === 'missing-close') {
      h.clock.advance(60000); await pending;
    } else {
      const content = ending === 'empty' ? empty : ending === 'draft'
        ? h.paint('› user-owned draft')
        : h.paint('Select Model\r\n› 1. gpt-6\r\nEnter to confirm · Esc to go back');
      let parsed, release;
      const parsedPromise = new Promise(resolve => { parsed = resolve; });
      const originalWrite = mirror.terminal.write.bind(mirror.terminal);
      mirror.terminal.write = (data, done) => originalWrite(data, () => { release = done; parsed(); });
      h.c.writeHeadlessTerminalMirror(h.tabId, content + '\x1b[?2026l');
      await parsedPromise;
      assert.ok(mirror.writeSeq > mirror.flushedSeq, 'close parsed, final flush callback still held');
      assert.equal(h.c.getHeadlessCodexDraftState(h.tabId).hasDraft, null);
      assert.equal(h.writes.length, 0);
      mirror.terminal.write = originalWrite; release();
      if (ending === 'picker') {
        await drainMicrotasks(100);
        assert.equal(h.c.getHeadlessCodexDraftState(h.tabId).hasDraft, null,
          'a real picker frame is not an empty composer');
        h.clock.advance(60000);
      }
    }
    const result = await pending;
    assert.equal(h.writes.filter(x => x === '\r').length, ending === 'empty' ? 1 : 0);
    assert.equal(result.submitted, ending === 'empty');
    assert.equal(h.store.get('O').attemptId, 'A');
    assert.equal(h.store.get('O').state, ending === 'empty' ? 'audit-pending' : 'in-flight');
    assert.equal(mirror.synchronizedFrameWaiters.size, 0);
    h.clean();
  });
}
