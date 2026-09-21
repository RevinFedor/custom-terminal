'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { EventEmitter } = require('node:events');
const receiptStoreModule = require('./agent-send-receipt-store');
const { createAgentSendReceiptStore, STORE_STATES } = receiptStoreModule;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const mainPath = path.join(__dirname, 'main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const mainAst = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
const queueAst = ts.createSourceFile('usePromptQueueStore.ts', fs.readFileSync(
  path.join(__dirname, '../renderer/store/usePromptQueueStore.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const ownershipNode = queueAst.statements.find(item => ts.isFunctionDeclaration(item)
  && item.name?.text === 'queueSendTransferredOwnership');
assert.ok(ownershipNode, 'actual History/queue ownership classifier');
const ownershipContext = vm.createContext({});
vm.runInContext(ts.transpileModule(ownershipNode.getText(queueAst).replace(/^export /, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, ownershipContext);
const ownershipTransferred = result => ownershipContext.queueSendTransferredOwnership(result);

function declaration(name) {
  const node = mainAst.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, 'actual main function: ' + name);
  return node.getText(mainAst);
}

function findIpcHandler(channel) {
  const node = mainAst.statements.find(item => ts.isExpressionStatement(item)
    && ts.isCallExpression(item.expression)
    && item.expression.expression.getText(mainAst) === 'ipcMain.handle'
    && item.expression.arguments[0]?.text === channel);
  assert.ok(node, 'actual IPC handler: ' + channel);
  return node.getText(mainAst);
}

function privateDatabase(t, { failPostEnterSettle = false, failCleanupReceiptRead = false } = {}) {
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
  const store = createAgentSendReceiptStore(db);
  let failReceiptSettle = failPostEnterSettle;
  let failReceiptRead = failCleanupReceiptRead;
  db.function('test_fail_history_post_enter_settle', () => failReceiptSettle ? 1 : 0);
  db.exec(`
    CREATE TRIGGER test_fail_history_post_enter_settle
    BEFORE UPDATE ON agent_send_receipts
    WHEN OLD.state = 'enter-armed'
      AND NEW.state = 'audit-pending'
      AND test_fail_history_post_enter_settle() = 1
    BEGIN
      SELECT RAISE(ABORT, 'fixture_post_enter_sqlite_failure');
    END;
  `);
  return {
    db,
    store: (() => {
      const originalGet = store.get.bind(store);
      store.get = operationKey => {
        const record = originalGet(operationKey);
        if (failReceiptRead && record?.state === STORE_STATES.ENTER_ARMED) {
          failReceiptRead = false;
          throw new Error('fixture_post_enter_receipt_read_failure');
        }
        return record;
      };
      return store;
    })(),
    allowReceiptSettle: () => { failReceiptSettle = false; },
  };
}

function createHarness(t, options = {}) {
  const privateDb = privateDatabase(t, options);
  if (!privateDb) return null;
  const tabId = 'send-tab';
  const sessionId = 'session-A';
  const handoffId = options.handoffId || 'handoff-A';
  const writes = [];
  const busyEvents = [];
  const auditFinalizations = [];
  const handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  let harness;
  const term = {
    pid: 701,
    write(bytes) {
      writes.push(String(bytes));
      if (String(bytes) === '\r') {
        options.onPhysicalEnter?.(harness, this);
        if (options.throwOnEnter === true) throw new Error('fixture_enter_write_outcome_unknown');
      }
    },
  };
  const mirror = {
    complete: true,
    failed: false,
    generation: 'mirror-A',
    lastCommittedVisibleSnapshot: { committedFrameGeneration: 8 },
  };
  const context = vm.createContext({
    ...require('./agent-send-target-precondition'),
    ...require('./agent-history-send-receipt'),
    ...receiptStoreModule,
    ...require('./claude-prompt-audit'),
    ...require('./claude-prompt-transport'),
    ...require('./claude-composer-proof'),
    ...require('./history-prompt-presentations'),
    ...require('./prompt-queue-source'),
    ...require('./terminal-paste-profile'),
    ...require('./prompt-audit-fingerprint'),
    ...require('./pty-input-ownership'),
    AGENT_SEND_DURABLE_STATES: STORE_STATES,
    Buffer,
    Date,
    Promise,
    crypto: require('node:crypto'),
    fs,
    path,
    require,
    srcMainDir: __dirname,
    console: { log() {}, warn() {}, error() {} },
    PASTE_START: '\x1b[200~',
    PASTE_END: '\x1b[201~',
    CLAUDE_PASTE_AUDIT_TIMEOUT_MS: 12,
    CODEX_PASTE_AUDIT_TIMEOUT_MS: 12,
    terminals: new Map([[tabId, term]]),
    terminalLifecycleEpochs: new WeakMap([[term, 'terminal-instance-A']]),
    terminalStopRevisions: new WeakMap(),
    terminalCommandState: new Map([[tabId, { runSeq: 4, isRunning: true }]]),
    terminalInputRevisions: new Map([[tabId, 0]]),
    terminalProjects: new Map([[tabId, '/fixture/project']]),
    bridgeKnownSessions: new Map([[tabId, sessionId]]),
    claudeLaunchGenerationByTab: new Map(),
    aiStoppingTabs: new Map(),
    codexLateMcpProofPending: new Map(), codexTuiReadyTabs: new Set(),
    codexWatchers: new Map(), codexTurnWatchers: new Map(), codexKnownSessions: new Map(),
    codexLastRunCommandPayload: new Map(),
    nodePerformance: { now: Date.now }, resolveAiToolTypeForTab: () => 'claude',
    activityOpenIntervals: new Map(),
    responseActivityPreflights: new Map(),
    pendingPasteAudit: new Map(),
    agentSendReceiptStore: privateDb.store,
    getTerminalLifecycleGeneration: () => 'lifecycle-A',
    resolveAiToolTypeForTab: () => 'claude',
    getAiRuntimeSessionId: () => sessionId,
    broadcastAiRuntimeStatus() {},
    emitAgentReadinessChanged() {},
    getHeadlessTerminalMirror: () => mirror,
    hasLiveClaudeInTab: () => true,
    resolveClaudeSessionFileForTab: (_id, sid) => '/fixture/' + sid + '.jsonl',
    captureClaudePromptAuditBoundary: async (_file, input) => ({
      available: true,
      sessionId: input.sessionId || sessionId,
      transcriptPath: '/fixture/session-A.jsonl',
      byteOffset: 100,
      fileSize: 100,
    }),
    retainClaudePasteAuditTranscriptObserver: async () => ({ retained: false, reason: 'test-fixture' }),
    releaseClaudePasteAuditTranscriptObserver: () => false,
    enqueueClaudePasteAudit: (id, audit) => {
      const items = context.pendingPasteAudit.get(id) || [];
      items.push(audit);
      context.pendingPasteAudit.set(id, items);
    },
    finishClaudePasteAudit: (id, audit, result) => {
      auditFinalizations.push({ tabId: id, audit, result });
      audit.finished = true;
      audit.result = result;
    },
    waitForClaudePasteAudit: async (_id, audit) => {
      if (options.auditTimeout === true) {
        return {
          success: false,
          error: 'claude_user_message_audit_timeout',
          expectedLen: audit.expectedLen,
          expectedHash: audit.expectedHash,
          lateReconciliationPending: true,
        };
      }
      return new Promise(() => {});
    },
    inspectClaudePostEnterTimeoutAtWriteBoundary: async ({ audit, timeoutResult }) => ({
      ...timeoutResult,
      success: false,
      submitted: true,
      pasteWritten: true,
      enterWritten: true,
      deferUntilClaudeTurnIdle: true,
      expectedLen: audit.expectedLen,
      expectedHash: audit.expectedHash,
    }),
    waitForClaudeAuditOrTurnIdle: async () => {
      if (options.throwDeferredFinish === true) throw new Error('fixture_deferred_finish_failure');
      return undefined;
    },
    verifyClaudeComposerEmptyAtWriteBoundary: async () => {
      options.composerProofStarted?.();
      if (options.composerProofGate) await options.composerProofGate;
      return options.composerRefusal === true
        ? { valid: false, reason: 'fixture_before_enter_refusal' }
        : { valid: true, proof: { inputRevision: 1, frameGeneration: 8, mirrorGeneration: mirror.generation } };
    },
    expectedClaudePasteShape: text => ({ expectedHasText: !!text, expectedImageCount: 0, transportLength: String(text).length }),
    waitForClaudePasteReadyBeforeSubmit: async ({ attempt }) => {
      options.pasteReadyStarted?.();
      if (options.pasteReadyGate) return options.pasteReadyGate;
      return options.pasteReadyRefusal === true
        ? { ready: false, error: 'fixture_paste_ready_refusal' }
        : {
            ready: true,
            proof: { form: 'collapsed-paste-chip', committedFrameGeneration: 9,
              observedImageCount: attempt.expectedImageCount },
          };
    },
    validateClaudeComposerSubmitGeneration: () => ({ valid: true }),
    drainPtyData: async () => undefined,
    waitForRender: () => {
      const promise = Promise.resolve({ timedOut: false, elapsedMs: 1 });
      promise.markWriteTime = () => {};
      promise.cancel = () => false;
      return promise;
    },
    validatePromptQueueImageMarkers: async () => ({ success: true, missing: [] }),
    replaceUnavailableImagePathMarkers: value => value,
    agentSendCancellations: {
      isCancelled: () => false,
      wait: () => ({ promise: new Promise(() => {}), dispose() {} }),
    },
    codexSubmitDropTestFault: { consume: () => false },
    aiBoundaryTestGate: { waitIfArmed: async () => ({ claimed: false }) },
    recordComposerForensicPtyInput: () => null,
    conversationOwners: {
      noteInput() {},
      assertNone() {},
    },
    tabWorkContext: { assertContinuationScope() {} },
    _webBroadcast() {},
    activityOpenIntervals: new Map(),
    responseActivityPreflights: new Map(),
    agentSendTestFaultActive: () => false,
    mainWindow: {
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => {
        busyEvents.push({ channel, payload });
        harness?.onMainSend?.(channel, payload);
      } },
    },
    ipcMain,
  });

  const serializerStart = mainSource.indexOf('const pasteInflight = new WeakMap();');
  const serializerEnd = mainSource.indexOf('\nfunction markActivePtySubmit(', serializerStart);
  assert.ok(serializerStart >= 0 && serializerEnd > serializerStart, 'actual PTY serializer found');
  vm.runInContext(mainSource.slice(serializerStart, serializerEnd), context);
  for (const name of [
    'markActivePtySubmit',
    'findTabIdForTerm',
    'getTerminalInputRevision',
    'bumpTerminalInputRevision',
    'expectedKnownEmptySend',
    'agentSendRequestExpectedTargets',
    'readAgentSendDestinationAtWriteBoundary',
    'agentSendRequestTargetFailure',
    'assertKnownEmptySend',
    'pasteAuditHash',
    'pasteAuditPreview',
    'safePasteAndSubmit',
    '_safePasteAndSubmitInner',
    'finishSafePasteAfterWrite',
    'resolveSafePasteFailureAfterWrite',
    'handleTerminalInput',
    'getTerminalStopRevision',
    'captureAgentInputIdentity',
    'agentSendExecutionFailure',
    'markAiStopping',
    'clearAiStopping',
  ]) vm.runInContext(declaration(name), context);
  vm.runInContext(findIpcHandler('terminal:paste'), context);

  harness = {
    context, db: privateDb.db, store: privateDb.store, allowReceiptSettle: privateDb.allowReceiptSettle,
    tabId, sessionId, handoffId, term, writes, busyEvents, auditFinalizations, handlers,
    stopBounce(reason = 'fixture-stop-race') {
      const before = context.getTerminalStopRevision(tabId);
      context.markAiStopping(tabId, 'claude', reason, { publicLifecycle: false });
      context.clearAiStopping(tabId, reason, { toolType: 'claude' });
      return { before, after: context.getTerminalStopRevision(tabId) };
    },
    send(sendOptions = {}) {
      return handlers.get('terminal:paste')({}, {
        tabId,
        content: 'history prompt body',
        submit: true,
        fast: false,
        source: 'history-panel',
        handoffId,
        verifyClaudeVisibleDraftBeforePaste: true,
        awaitClaudeUserMessageAudit: true,
        presentationSnapshot: { historySessionId: sessionId },
        skipRenderWait: true,
        ...sendOptions,
      });
    },
    safePaste(sendOptions = {}) {
      return context.safePasteAndSubmit(term, 'history prompt body', {
        submit: true,
        fast: false,
        source: 'history-panel',
        handoffId,
        verifyClaudeVisibleDraftBeforePaste: true,
        awaitClaudeUserMessageAudit: true,
        presentationSnapshot: { historySessionId: sessionId },
        skipRenderWait: true,
        ...sendOptions,
      });
    },
    installConfirmedReceiptError() {
      context.mainWindow = {
        isDestroyed: () => false,
        webContents: { send: (_channel, payload) => {
          if (payload?.phase !== 'confirming' || payload?.busy !== false) return;
          const record = privateDb.store.get('history:' + tabId + ':' + handoffId);
          assert.ok(record, 'durable attempt exists at post-Enter observer boundary');
          const promoted = privateDb.store.promoteFromAudit(exactAuditFor(record, sessionId));
          assert.equal(promoted.promoted, true, JSON.stringify(promoted));
          throw new Error('fixture_renderer_observer_failed_after_exact_audit');
        } },
      };
    },
  };
  return harness;
}

function exactAuditFor(record, sessionId = record.sessionId) {
  return {
    success: true,
    operationKey: record.operationKey,
    attemptId: record.attemptId,
    provider: 'claude',
    sessionId,
    promptHash: record.promptHash,
    expectedHash: record.promptHash,
    actualHash: record.promptHash,
    entryUuid: 'exact-user-entry',
    sourceIdentity: 'fixture-source:' + record.attemptId,
    auditTimestamp: new Date(1_800_000_000_000).toISOString(),
  };
}

test('actual History PTY send converts post-Enter SQLite failure to same-attempt unknown and permits only late exact promotion', async t => {
  const h = createHarness(t, { failPostEnterSettle: true });
  if (!h) return;

  const result = await h.send();
  const operationKey = 'history:' + h.tabId + ':' + h.handoffId;
  const record = h.store.get(operationKey);
  assert.equal(h.writes.filter(value => value === '\r').length, 1,
    'one real terminal Enter was written; result=' + JSON.stringify(result));
  assert.equal(result.success, null);
  assert.equal(result.submitted, true, 'completed physical write remains distinct from refusal');
  assert.equal(result.status, 'delivery-unknown');
  assert.equal(result.deliveryUnknown, true);
  assert.equal(ownershipTransferred(result), true, 'History must not roll back as a new unsent prompt');
  assert.equal(result.handoffId, h.handoffId);
  assert.equal(result.sendOperationKey, operationKey);
  assert.equal(result.sendAttemptId, record.attemptId);
  assert.equal(record.state, STORE_STATES.ENTER_ARMED,
    'pre-Enter durable record remains replayable as unknown if post-Enter settlement itself failed');
  assert.equal(h.auditFinalizations.length, 0,
    'finally must not finish the already-written Claude audit as submit-not-sent');

  const replay = await h.send();
  assert.equal(replay.status, 'delivery-unknown');
  assert.equal(replay.sendAttemptId, record.attemptId);
  assert.equal(ownershipTransferred(replay), true, 'replay preserves the same pending History row');
  assert.equal(h.writes.filter(value => value === '\r').length, 1,
    'same handoff replays its receipt without a second Enter');

  const wrongAttempt = h.store.promoteFromAudit({
    ...exactAuditFor(record), attemptId: 'foreign-attempt',
  });
  const wrongSession = h.store.promoteFromAudit({
    ...exactAuditFor(record), sessionId: 'foreign-session',
  });
  assert.equal(wrongAttempt.promoted, false);
  assert.equal(wrongSession.promoted, false);
  assert.equal(h.store.get(operationKey).state, STORE_STATES.ENTER_ARMED);

  const lateExact = h.store.promoteFromAudit(exactAuditFor(record));
  assert.equal(lateExact.promoted, true, JSON.stringify(lateExact));
  assert.equal(h.store.get(operationKey).state, STORE_STATES.CONFIRMED);
  const confirmedReplay = await h.send();
  assert.equal(confirmedReplay.success, true);
  assert.equal(confirmedReplay.status, STORE_STATES.CONFIRMED);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
});

test('actual safePaste Enter attempt that throws is unknown, not pre-submit; staged audit is retained', async t => {
  const h = createHarness(t, { throwOnEnter: true });
  if (!h) return;
  const result = await h.send();
  const record = h.store.get('history:' + h.tabId + ':' + h.handoffId);
  assert.equal(h.writes.filter(value => value === '\r').length, 1,
    'Enter write was attempted once; result=' + JSON.stringify(result));
  assert.equal(result.success, null);
  assert.equal(result.submitted, null, 'throwing write has unknown physical completion');
  assert.equal(ownershipTransferred(result), true, 'unknown physical write is not a fresh retry');
  assert.equal(result.status, 'delivery-unknown');
  assert.equal(record.state, STORE_STATES.ENTER_ARMED);
  assert.equal(h.auditFinalizations.length, 0,
    'an attempted Enter must not turn the staged audit into claude_submit_not_sent');
});

test('receipt-read exception during inner cleanup still releases the physical paste busy signal', async t => {
  const h = createHarness(t, { failPostEnterSettle: true, failCleanupReceiptRead: true });
  if (!h) return;
  const result = await h.send();
  const record = h.store.get('history:' + h.tabId + ':' + h.handoffId);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  assert.equal(result.status, 'delivery-unknown', JSON.stringify(result));
  assert.equal(result.submitted, true);
  assert.equal(result.sendAttemptId, record.attemptId);
  assert.ok(h.busyEvents.some(event => event.channel === 'claude:paste-busy'
    && event.payload.busy === false), 'cleanup emits busy=false despite receipt read failure');
});

test('actual terminal input already queued during a throwing Enter is not a second submit', async t => {
  let queuedKey;
  const h = createHarness(t, { throwOnEnter: true,
    onPhysicalEnter: current => {
      if (!queuedKey) queuedKey = current.context.handleTerminalInput({}, current.tabId, '\r', { xtermInputOrigin: 'user' });
    },
  });
  if (!h) return;
  const result = await h.send();
  await queuedKey;
  assert.equal(result.status, 'delivery-unknown');
  assert.equal(h.writes.filter(value => value === '\r').length, 1,
    'actual raw-input serializer suppresses only the already queued second Enter');
});

test('exact confirmed receipt wins over a later observer/render exception', async t => {
  const h = createHarness(t);
  if (!h) return;
  h.installConfirmedReceiptError();
  const result = await h.send();
  const record = h.store.get('history:' + h.tabId + ':' + h.handoffId);
  assert.equal(h.writes.filter(value => value === '\r').length, 1, JSON.stringify(result));
  assert.equal(record.state, STORE_STATES.CONFIRMED);
  assert.equal(result.success, true);
  assert.equal(result.status, STORE_STATES.CONFIRMED);
  assert.equal(result.sendAttemptId, record.attemptId);
  assert.equal(h.auditFinalizations.length, 0);
});

test('real pre-Enter History refusal remains not-submitted and preserves retry authority', async t => {
  const h = createHarness(t, { composerRefusal: true });
  if (!h) return;
  const result = await h.send();
  const record = h.store.get('history:' + h.tabId + ':' + h.handoffId);
  assert.equal(result.success, false, JSON.stringify(result));
  assert.equal(result.submitted, false);
  assert.equal(ownershipTransferred(result), false, 'real no-write refusal keeps the editable prompt');
  assert.equal(result.deliveryUnknown, undefined);
  assert.equal(h.writes.length, 0);
  assert.equal(record.state, STORE_STATES.NOT_SUBMITTED);
});

test('deferred post-write finish exception is typed with the original receipt identity', async t => {
  const h = createHarness(t, { auditTimeout: true, throwDeferredFinish: true });
  if (!h) return;
  const accepted = await h.safePaste({ deferPostWriteResolution: true });
  assert.equal(accepted.submitted, true, JSON.stringify(accepted));
  assert.equal(accepted.enterWritten, true);
  const result = await accepted.finishAfterPtyWrite();
  const record = h.store.get('history:' + h.tabId + ':' + h.handoffId);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  assert.equal(result.success, null);
  assert.equal(result.submitted, true);
  assert.equal(result.status, 'delivery-unknown');
  assert.equal(result.sendOperationKey, record.operationKey);
  assert.equal(result.sendAttemptId, record.attemptId);
  assert.equal(record.state, STORE_STATES.DELIVERY_UNKNOWN);
});

test('Stop began and cleared during the pre-paste composer await fences the captured operation', async t => {
  const composerProofStarted = deferred();
  const composerProofGate = deferred();
  const h = createHarness(t, {
    composerProofStarted: () => composerProofStarted.resolve(),
    composerProofGate: composerProofGate.promise,
  });
  if (!h) return;

  const pending = h.send();
  await composerProofStarted.promise;
  assert.equal(h.writes.length, 0, 'operation is paused before its first PTY write');
  const revision = h.stopBounce();
  assert.equal(revision.after, revision.before + 1, 'clearing Stop does not restore old execution identity');
  composerProofGate.resolve();

  const result = await pending;
  assert.equal(h.writes.length, 0, JSON.stringify(result));
  assert.equal(result.submitted, false);
  assert.equal(result.pasteWritten, false);
  assert.equal(result.status, 'not-submitted');
  assert.equal(result.code, 'agent_send_execution_superseded');
  assert.equal(result.rejectionStage, 'before-paste');
});

test('Stop during the post-paste readiness await preserves paste fact but blocks Enter', async t => {
  const pasteReadyStarted = deferred();
  const pasteReadyGate = deferred();
  const h = createHarness(t, {
    pasteReadyStarted: () => pasteReadyStarted.resolve(),
    pasteReadyGate: pasteReadyGate.promise,
  });
  if (!h) return;

  const pending = h.send();
  await pasteReadyStarted.promise;
  assert.equal(h.writes.length, 1, 'exactly the bracketed paste is written before the semantic-ready await');
  assert.match(h.writes[0], /history prompt body/);
  assert.equal(h.writes.filter(value => value === '\r').length, 0);
  const revision = h.stopBounce();
  assert.equal(revision.after, revision.before + 1);
  pasteReadyGate.resolve({ ready: true, proof: {
    form: 'collapsed-paste-chip', committedFrameGeneration: 9, observedImageCount: 0,
  } });

  const result = await pending;
  assert.equal(h.writes.filter(value => value === '\r').length, 0, JSON.stringify(result));
  assert.equal(result.pasteWritten, true);
  assert.equal(result.enterWritten, false);
  assert.equal(result.submitted, false);
  assert.equal(result.status, 'not-submitted');
  assert.equal(result.code, 'agent_send_execution_superseded');
  assert.equal(result.rejectionStage, 'before-enter');
});

test('a send queued behind an existing PTY write lock cannot write after Stop clears', async t => {
  const composerProofStarted = deferred();
  const composerProofGate = deferred();
  const h = createHarness(t, {
    composerProofStarted: () => composerProofStarted.resolve(),
    composerProofGate: composerProofGate.promise,
  });
  if (!h) return;

  const first = h.send({ handoffId: 'handoff-lock-owner' });
  await composerProofStarted.promise;
  const second = h.send({ handoffId: 'handoff-queued-stale' });
  const revision = h.stopBounce('stop-during-pty-lock-queue');
  assert.equal(revision.after, revision.before + 1);
  composerProofGate.resolve();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(h.writes.length, 0, JSON.stringify({ firstResult, secondResult }));
  for (const result of [firstResult, secondResult]) {
    assert.equal(result.submitted, false);
    assert.equal(result.pasteWritten, false);
    assert.equal(result.status, 'not-submitted');
    assert.equal(result.code, 'agent_send_execution_superseded');
  }
  assert.equal(secondResult.rejectionStage, 'write-owner-admission');
});
