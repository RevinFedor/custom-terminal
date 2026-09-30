'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const authorityApi = require('./codex-action-authority');
const postEnterApi = require('./codex-rewind-post-enter');
const captureApi = require('./agent-input-capture-protocol');
const promptApi = require('./codex-prompt-audit');
const { hashCodexRewindTargetText } = require('./codex-rewind-target-proof');
const { hasCodexWriterHandoffActionBoundary } = require('./codex-writer-ownership');

const mainPath = path.join(__dirname, 'main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const beforeFixturePath = path.join(__dirname, 'fixtures/codex-rewind-post-enter-before.cjs');
const frozenMainPath = process.env.CODEX_REWIND_FROZEN_MAIN || beforeFixturePath;

function sourceReader(source, filename) {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const nodes = [];
  const functionCache = new Map();
  let hookCache;
  let authorityFinallyCache;
  const visit = node => { nodes.push(node); ts.forEachChild(node, visit); };
  visit(tree);
  const text = node => source.slice(node.getStart(tree), node.end);
  return {
    function(name) {
      if (functionCache.has(name)) return functionCache.get(name);
      const matches = nodes.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
      assert.ok(matches.length, 'actual function exists: ' + name + ' in ' + filename);
      // Both providers have normalizeCandidate; the later one belongs to Codex.
      const source = text(matches.at(-1));
      functionCache.set(name, source);
      return source;
    },
    hookBody() {
      if (hookCache) return hookCache;
      const matches = nodes.filter(node => ts.isArrowFunction(node)
        && text(node).includes('pending.preparedDraft =')
        && text(node).includes('agentInputCaptureProtocol.authorize('));
      assert.ok(matches.length, 'actual prepared-draft/authorize callback exists');
      hookCache = text(matches.sort((a, b) => (a.end - a.pos) - (b.end - b.pos))[0]);
      return hookCache;
    },
    authorityFinally() {
      if (authorityFinallyCache) return authorityFinallyCache;
      const matches = nodes.filter(node => ts.isIfStatement(node)
        && text(node.expression).startsWith('rewindActionAuthority\n')
        && text(node).includes('codexRewindOperationResult')
        && text(node).includes('transitionMainCodexActionAuthority'));
      assert.equal(matches.length, 1, 'one actual final authority policy');
      authorityFinallyCache = text(matches[0]);
      return authorityFinallyCache;
    },
  };
}

const actual = sourceReader(mainSource, mainPath);
const frozen = sourceReader(fs.readFileSync(frozenMainPath, 'utf8'), frozenMainPath);
const flush = () => new Promise(resolve => setImmediate(resolve));
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function fixture(t, {
  startup = false, legacy = false, expiredWatcher = false, autoHelper = true,
  realCaptureProtocol = false, releaseFromFrozen = false,
} = {}) {
  const tabId = 'tab-post-enter-actual';
  const projectId = 'project-post-enter';
  const sourceSessionId = 'source-post-enter';
  const actionGeneration = 'codex-writer-handoff-existing';
  const expectedText = '/tmp/native-rewind-context/selected-prompt-with-a-long-path.md\n'
    + 'Preserve the exact original context-file prompt. '.repeat(8);
  const events = [];
  const writes = [];
  const outcomes = new Map();
  const state = new Map();
  const pendingTimers = new Set();
  const ipcMain = new EventEmitter();
  let inputRevision = 0;
  let lifecycle = 'physical-epoch:2';
  let binding = sourceSessionId;
  let effectiveReady = !startup;
  let helperReturn = { ready: true };
  let failPhase = null;
  let failAppliedProof = false;
  let receipt = { committed: false, available: false };
  let beforeProcessReturn = null;
  let beforeTargetReturn = null;
  let settleAction = null;
  let helperBody;
  let context;
  let captureCounter = 0;
  let composer = expectedText;
  let helperPromise = null;
  let finalized = 0;
  const watcherRestarts = [];
  const captureDirectory = realCaptureProtocol
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'noted-rewind-capture-release-test-')) : null;
  const diskProtocol = captureDirectory
    ? new captureApi.AgentInputCaptureProtocol({ directory: captureDirectory, ownerId: 'main-fixture-owner' }) : null;
  if (captureDirectory) t.after(() => fs.rmSync(captureDirectory, { recursive: true, force: true }));
  const term = {
    pid: 123456,
    _notedGrabTerminalId: 'exact-physical-terminal',
    write(bytes) {
      writes.push(bytes);
      events.push('pty:' + JSON.stringify(bytes));
      assert.equal(bytes, '\x07', 'this continuation can never write Enter/Send/launch/navigation');
      assert.ok(context.ptyWriteOwners.get(term)?.active, 'the existing shared serializer owns Ctrl+G');
      if (autoHelper) queueMicrotask(() => { helperPromise = runHelper(); });
    },
  };
  const mirror = {
    generation: 'mirror-original', writeSeq: 10, flushedSeq: 10,
    synchronizedFrameWaiters: new Set(), redrawTrace: {},
  };
  function emitFrame({ mcp = false, committed = true, ready = true } = {}) {
    mirror.writeSeq += 1;
    mirror.flushedSeq = mirror.writeSeq;
    mirror.lastCommittedVisibleSnapshot = {
      success: true, authoritativeFrameCommitted: committed,
      writeSeq: mirror.writeSeq,
      lines: [{ text: expectedText.split('\n')[0], fixtureReady: ready, fixtureMcp: mcp }],
    };
    for (const listener of mirror.synchronizedFrameWaiters) listener();
  }
  emitFrame({ mcp: startup });
  const target = {
    targetUuid: 'codex-user-source-post-enter-44', targetPhysicalSessionId: sourceSessionId,
    targetSourceLine: 44, targetTextHash: hashCodexRewindTargetText(expectedText),
  };
  const identity = {
    terminalToken: term, projectId, tabId, lifecycleGeneration: lifecycle, runSeq: 2,
    launchId: 'codex-original-launch', sourceSessionId, persistedSessionId: sourceSessionId,
    inputRevision: 0, operationId: 'scenario-original-operation', requestId: 'codex-original-request',
  };
  const created = authorityApi.createCodexActionAuthority({
    authorityId: 'native-rewind-original-authority', profile: 'native-rewind', identity, target,
  });
  assert.equal(created.success, true);
  const authority = created.authority;
  authorityApi.transitionCodexActionAuthority(authority, 'armed');
  authorityApi.bindCodexActionAuthorityGeneration(authority, actionGeneration);
  authorityApi.transitionCodexActionAuthority(authority, 'consumed');
  if (legacy) authorityApi.transitionCodexActionAuthority(authority, 'revoked', { reason: 'codex_input_not_ready' });
  const journalKey = 'codex.pending-writer-handoff.v1:' + tabId;
  const journal = {
    version: 2, phase: 'confirm-enter-boundary', projectId, originProjectId: projectId,
    tabId, cwd: '/tmp/native-rewind-fixture', sourceSessionId, expectedBindingSessionId: sourceSessionId,
    sourceBindingMode: 'confirmed-writer', sourceLifecycleGeneration: lifecycle, sourceRunSeq: 2,
    operationId: identity.operationId, requestId: identity.requestId,
    actionGeneration, actionStartedAtMs: Date.now() - 20,
    ...target, rollbackTurns: 1, targetUserOrdinal: 0, targetDerivation: null,
  };
  state.set(journalKey, clone(journal));
  const observer = {
    sourceMode: 'writer-handoff', sourceSessionId, launchId: actionGeneration,
    expectedBindingSessionId: sourceSessionId, sourceFilePath: '/tmp/native-source.jsonl',
    sourceTerminalToken: term, sourceLifecycleGeneration: lifecycle, sourceRunSeq: 2,
    handoffActionGeneration: actionGeneration, handoffActionStartedAtMs: journal.actionStartedAtMs,
    handoffTerminalToken: term, handoffRunSeq: 2, actionAuthority: authority,
  };
  const retainedIntent = { ...observer };
  delete retainedIntent.sourceTerminalToken; // Exact expired production shape.
  delete retainedIntent.actionAuthority;
  delete retainedIntent.handoffTerminalToken;
  const protocol = {
    arm(args) {
      events.push('capture:arm');
      assert.equal(args.generation.inputRevision, 0);
      captureCounter += 1;
      return diskProtocol ? diskProtocol.arm(args)
        : { ...args, protocol: 2, operationId: 'capture-' + captureCounter, ownerId: 'main-fixture-owner' };
    },
    authorize(operation, envelope, current) {
      assert.equal(captureApi.operationMatches(operation, envelope), true);
      if (!current) return { decision: 'cancel' };
      const durable = state.get('codex.rewind-post-enter.v1:' + tabId + ':' + actionGeneration);
      assert.equal(durable?.phase, 'capture-prepared', 'exact capture is durable BEFORE helper clear');
      assert.equal(durable.preparedDraft.capturedText, composer);
      assert.equal(durable.preparedDraft.capturedText, expectedText, 'not a first-row/prefix preview');
      if (diskProtocol) {
        const decision = diskProtocol.authorize(operation, envelope, current);
        assert.equal(decision.decision, 'commit');
      }
      events.push('helper:authorize');
      composer = '';
      events.push('helper:clear');
      const outcome = { ...operation, applied: true, helperId: envelope.helperId, helperPid: envelope.pid };
      outcomes.set(operation.operationId, outcome);
      if (diskProtocol) fs.writeFileSync(path.join(operation.operationDir, 'outcome.json'), JSON.stringify(outcome));
      return { decision: 'commit' };
    },
    cancel(operation, reason) {
      events.push('capture:cancel:' + reason);
      return diskProtocol ? diskProtocol.cancel(operation, reason) : { decision: 'cancel', reason };
    },
    release(operation, proof) {
      events.push('protocol:release');
      if (!diskProtocol) return true;
      const released = diskProtocol.release(operation, proof);
      if (released) {
        assert.equal(fs.existsSync(path.join(operation.operationDir, 'outcome.json')), false);
        events.push('outcome:deleted');
      }
      return released;
    },
    reconcileReturned() { return false; },
  };
  context = vm.createContext({
    tabId,
    codexSettingsMutationQueue: require('./codex-settings-mutation-queue').createCodexSettingsMutationQueue(),
    ...authorityApi, ...promptApi, ...postEnterApi,
    hashCodexRewindTargetText,
    hasCodexWriterHandoffActionBoundary,
    buildAgentDraftTransfer: captureApi.buildAgentDraftTransfer,
    captureOperationMatches: captureApi.operationMatches,
    CAPTURE_HELPER_BASENAME: captureApi.CAPTURE_HELPER_BASENAME,
    CODEX_NATIVE_REWIND_HANDOFF_KEY_PREFIX: 'codex.pending-writer-handoff.v1:',
    CODEX_WATCHER_TTL_MS: 600000,
    CLAUDE_HOOK_SOCK: '/unused-fixture.sock',
    AI_PROCESS_LOOKUP_STATUS: { FOUND: 'found', ABSENT: 'absent', UNKNOWN: 'unknown' },
    console: { log() {}, warn() {}, error() {} },
    process: { kill(pid, signal) { assert.equal(pid, 123457); assert.equal(signal, 0); } },
    setTimeout(callback, ms) { const timer = { callback, ms }; pendingTimers.add(timer); return timer; },
    clearTimeout(timer) { pendingTimers.delete(timer); },
    clearInterval(timer) { pendingTimers.delete(timer); },
    queueMicrotask,
    ipcMain,
    terminals: new Map([[tabId, term]]),
    terminalStopRevisions: new WeakMap(),
    ...require('../shared/agent-input-observation.cjs'),
    terminalCommandState: new Map([[tabId, { runSeq: 2, isRunning: true }]]),
    codexLastRunCommandPayload: new Map([[tabId, { launchId: identity.launchId }]]),
    codexWatchers: new Map(expiredWatcher ? [] : [[tabId, observer]]),
    codexSessionDiscoveryIntents: new Map([[tabId, retainedIntent]]),
    codexActionAuthorities: new Map([['native-rewind:' + tabId, authority]]),
    codexRewindPostEnterOperations: new Map(),
    aiStoppingTabs: new Map(), codexTurnWatchers: new Map(), grabInputPending: new Map(),
    pasteInflight: new WeakMap(), ptyActiveWriteOperation: new WeakMap(),
    ptyLastQueuedWriteOperation: new WeakMap(), ptyWriteOwners: new WeakMap(),
    getHeadlessTerminalMirror: () => mirror,
    getTerminalLifecycleGeneration: () => lifecycle,
    getTerminalInputRevision: () => inputRevision,
    bumpTerminalInputRevision: () => ++inputRevision,
    resolveAuthoritativeTabProjectId: () => projectId,
    codexSessionIdFromDb: () => binding,
    isCodexTuiEffectivelyReady: () => effectiveReady,
    inspectCodexInputReadyVisibleText: (_text, _source, { lines }) => ({
      ready: lines[0].fixtureReady,
      ignoredBlockers: lines[0].fixtureMcp ? ['mcp-startup'] : [],
    }),
    waitForCodexRewindInitializedComposer: options => postEnterApi.waitForCodexRewindInitializedComposer({
      ...options, timeoutMs: 100,
    }),
    projectManager: { db: {
      getAppState: key => state.has(key) ? clone(state.get(key)) : null,
      setAppState(key, value) { state.set(key, clone(value)); events.push('persist:' + value.phase); },
      compareAndSetAppState(key, before, next) {
        if (next.phase === failPhase
          || (failAppliedProof && next.captureAppliedProof && !before.captureAppliedProof)
          || JSON.stringify(state.get(key)) !== JSON.stringify(before)) return false;
        state.set(key, clone(next)); events.push('persist:' + next.phase);
        if (next.captureAppliedProof && !before.captureAppliedProof) events.push('persist:applied-proof');
        return true;
      },
      inspectPendingCodexWriterHandoff(key) {
        return state.has(key) ? { status: 'present', journal: clone(state.get(key)) } : { status: 'absent' };
      },
    } },
    resolveAgentInputProcess: async () => ({ success: true, cliPid: 123457, lockPids: [123457] }),
    readProcessEditor: async () => '/fixture/' + captureApi.CAPTURE_HELPER_BASENAME,
    dismissCodexSlashCompletionBeforeExternalEditor: async () => ({ success: true, dismissed: false }),
    agentInputCaptureProtocol: protocol,
    readCaptureOutcome: operation => diskProtocol
      ? captureApi.readOutcome(operation) : outcomes.get(operation.operationId) || null,
    recordComposerForensicPtyInput() {},
    logAgentDraftProofContradictionAfterReturn() {},
    aiBoundaryTestGate: { enabled: false },
    codexImageBindings: { resetComposer() {} },
    waitForAgentEditorReturnReady: async () => {
      if (helperReturn.ready === true) emitFrame();
      return helperReturn;
    },
    inspectCodexNativeRewindCommitReceipt: () => receipt,
    finalizeCodexNativeRewindCommitReceipt() { finalized += 1; return { success: true }; },
    settleCodexWriterHandoffObservation: async () => {
      if (settleAction) await settleAction();
      return { bindingCommitted: false, handoffStatus: 'unresolved' };
    },
    inspectManualCodexStableSourceRollbackOutcome: async () => ({ proven: false }),
    codexDataModule: { _api: { loadSessionRecords: async () => {
      if (beforeTargetReturn) await beforeTargetReturn();
      return { success: true, records: [{ __line: 44, type: 'event_msg', payload: { type: 'user_message', message: expectedText } }] };
    } } },
    inspectAiDescendantProcessesByTab: async () => {
      if (beforeProcessReturn) await beforeProcessReturn();
      return { status: 'found' };
    },
    mainWindow: { webContents: {} },
    startCodexSessionWatcher(_sender, args) {
      watcherRestarts.push(args);
      assert.equal(args.launchId, actionGeneration, 'restore cannot invent another native action');
      assert.equal(args.sourceTerminalToken, term);
      context.codexWatchers.set(tabId, { ...args });
    },
    armCodexWriterHandoffObservation() { assert.fail('recovery cannot re-arm Native Rewind'); },
    transitionMainCodexActionAuthority(value, phase, reason) {
      events.push('authority:' + phase);
      return authorityApi.transitionCodexActionAuthority(value, phase, { reason });
    },
  });
  const functionNames = [
    'codexRewindPostEnterKey', 'readCodexRewindPostEnterResult', 'persistCodexRewindPostEnter',
    'createCodexRewindPostEnterOperation', 'isCodexRewindPostEnterCurrent',
    'readCodexRewindContinuationLaunchId',
    'waitForCodexRewindPostEnterComposer', 'captureCodexRewindPostEnterInput',
    'completeCodexRewindPostEnterRecord', 'recoverCodexRewindPostEnterOperation',
    'captureAgentInputAtWriteBoundary', 'getTerminalStopRevision', 'captureAgentInputIdentity', 'validateAgentInputIdentity',
    'releaseAgentInputCapturePending',
    'closeCodexWatcher',
    'publicAgentInputIdentity', 'validateAgentExactCaptureInputTransition', 'agentDraftProofMatchesCaptureIdentity',
    'currentCodexActionAuthorityIdentity', 'codexActionAuthorityKey', 'codexNativeRewindHandoffJournalKey',
    'readPendingCodexNativeRewindHandoff', 'markCodexWriterHandoffBranchDraftRestored',
    'markCodexWriterHandoffRollbackApplied', 'withPtyWriteLock',
    'compareCodexRestoredPromptForTab', 'buildCodexHistoryDraftFromPayload',
    'normalizeCandidate', 'compareCodexRestoredPrompt', 'grabRestoredCodexRewindInput',
  ];
  vm.runInContext(functionNames.map(name => actual.function(name)).join('\n'), context, { filename: 'actual-rewind-main-functions.js' });
  if (releaseFromFrozen) {
    vm.runInContext(frozen.function('releaseAgentInputCapturePending'), context);
  }
  vm.runInContext('function applyActualAuthorityFinally() {\n' + actual.authorityFinally() + '\n}', context);
  helperBody = vm.runInContext('(' + actual.hookBody() + ')', context);

  async function runHelper() {
    const pending = context.grabInputPending.get(tabId);
    assert.ok(pending, 'actual capture pending was registered before Ctrl+G');
    pending.helperId = 'exact-helper';
    if (diskProtocol) fs.writeFileSync(path.join(pending.captureOperation.operationDir, 'helper.json'),
      JSON.stringify({ helperId: pending.helperId, helperPid: 123458 }));
    Object.assign(context, {
      pending, tabId, agent: 'codex', mode: 'grab', text: composer, images: 0,
      exactEmpty: false, contradiction: null,
      msg: { ...pending.captureOperation, helperId: pending.helperId,
        stage: 'prepare', ppid: 123457, pid: 123458 },
      identityStableAtHook: context.validateAgentInputIdentity(tabId, pending.captureIdentity),
      editorReturnPromise: null,
      startEditorReturnWait: () => Promise.resolve(),
      acknowledgeCapture: decision => events.push('ack:' + decision),
    });
    try { await helperBody(); }
    catch (error) {
      // The outer hook catches preparation errors, preserves the composer and
      // resolves the request. Do not turn this physical-boundary model into a
      // second implementation of the successful callback under test.
      protocol.cancel(pending.captureOperation, 'fixture-prepare-failed');
      pendingTimers.delete(pending.timer);
      pending.resolve({ success: false, error: error.message, draftPreserved: true });
    }
  }
  const expectation = { ...journal, terminalToken: term };
  const create = ({ postEnterFrame = true } = {}) => {
    const record = context.createCodexRewindPostEnterOperation(tabId, {
      authority, expectation, expectedText, targetPayload: { message: expectedText }, entered: true,
    });
    // The real provider emits a NEW committed frame after confirm Enter.
    // Do not let the pre-Enter ready frame stand in for this causal edge.
    if (postEnterFrame) emitFrame({ mcp: startup });
    return record;
  };
  const request = { tabId, operationId: identity.operationId, actionGeneration };
  const exactCompare = text => ({ matched: hashCodexRewindTargetText(text) === journal.targetTextHash, mode: 'exact' });
  t.after(() => { pendingTimers.clear(); ipcMain.removeAllListeners(); mirror.synchronizedFrameWaiters.clear(); });
  return {
    context, tabId, term, mirror, authority, journal, events, writes, state, watcherRestarts,
    expectedText, request, create, exactCompare,
    get composer() { return composer; },
    get captures() { return captureCounter; },
    get inputRevision() { return inputRevision; },
    get finalized() { return finalized; },
    emitFrame,
    becomeReady() { effectiveReady = true; emitFrame(); ipcMain.emit('agent:readiness-changed-internal', null, { tabId }); },
    setHelperReturn(value) { helperReturn = value; },
    setFailPhase(value) { failPhase = value; },
    setFailAppliedProof(value) { failAppliedProof = value; },
    mutate(kind) {
      if (kind === 'terminal') context.terminals.set(tabId, { ...term });
      if (kind === 'lifecycle') lifecycle = 'physical-epoch:3';
      if (kind === 'run') context.terminalCommandState.get(tabId).runSeq += 1;
      if (kind === 'input') inputRevision += 1;
      if (kind === 'launch') context.codexLastRunCommandPayload.get(tabId).launchId = 'replacement-launch';
      if (kind === 'stopping') context.aiStoppingTabs.set(tabId, { toolType: 'codex' });
      emitFrame({ mcp: startup });
    },
    setBeforeTargetReturn(value) { beforeTargetReturn = value; },
    setBeforeProcessReturn(value) { beforeProcessReturn = value; },
    setSettleAction(value) { settleAction = value; },
    commitChild() {
      binding = 'exact-child'; state.delete(journalKey);
      receipt = { committed: true, sourceSessionId, childSessionId: binding, receiptId: 'receipt-exact' };
    },
    runHelper,
    helperDone: () => helperPromise,
    capture(record, extra = {}) {
      return context.withPtyWriteLock(term,
        () => context.captureCodexRewindPostEnterInput(record, { compare: exactCompare, ...extra }),
        { kind: 'fixture-original-rewind', tabId });
    },
    nestedGrab(record, cancelPromise) {
      context.rewindPostEnterRecord = record;
      context.codexRewindCancelPromise = cancelPromise;
      return context.withPtyWriteLock(term,
        () => context.grabRestoredCodexRewindInput(expectedText, { message: expectedText }),
        { kind: 'fixture-original-rewind', tabId });
    },
  };
}

test('permanent before fixture preserves every verbatim fragment and full-source provenance', () => {
  const metadata = require('./fixtures/codex-rewind-post-enter-before.cjs');
  const saved = sourceReader(fs.readFileSync(beforeFixturePath, 'utf8'), beforeFixturePath);
  assert.match(metadata.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(metadata.sourcePath, '/private/tmp/noted-settings-final-vZa4ZH/source/src/main/main.js');
  for (const [name, expected] of Object.entries(metadata.fragmentSha256)) {
    const source = name === 'authorityFinally' ? saved.authorityFinally() : saved.function(name);
    assert.equal(crypto.createHash('sha256').update(source).digest('hex'), expected, name);
  }
});

test('frozen actual nested Grab breaks on startup codex_input_not_ready before any Ctrl+G', async () => {
  let lookups = 0;
  const writes = [];
  const term = { write: value => writes.push(value) };
  const context = vm.createContext({
    term, tabId: 'old-tab', terminals: new Map([['old-tab', term]]),
    console: { log() {}, warn() {} }, isCodexTuiEffectivelyReady: () => false,
    resolveAgentInputProcess: async () => { lookups += 1; throw new Error('startup must not perform lookup'); },
    normalizeCandidate: text => String(text).replace(/\s+/g, ' ').trim(),
    compareCodexRestoredPrompt: (expected, actualText) => ({ matched: expected === actualText }),
  });
  vm.runInContext(frozen.function('captureAgentInputAtWriteBoundary') + '\n'
    + frozen.function('grabRestoredCodexRewindInput'), context);
  const result = await context.grabRestoredCodexRewindInput('full expected context-file prompt', {});
  assert.equal(result.success, false);
  assert.equal(result.error, 'codex_input_not_ready');
  assert.equal(result.matchedTarget, false);
  assert.equal(lookups, 0);
  assert.deepEqual(writes, []);
});

test('actual nested Grab waits through startup, persists full capture before clear, and writes one Ctrl+G', async t => {
  const f = fixture(t, { startup: true });
  const record = f.create();
  const resultPromise = f.nestedGrab(record);
  await flush();
  assert.deepEqual(f.writes, []);
  f.becomeReady();
  const result = await resultPromise;
  assert.equal(result.success, true);
  assert.equal(result.text, f.expectedText);
  assert.equal(result.matchedTarget, true);
  assert.deepEqual(f.writes, ['\x07']);
  assert.equal(f.inputRevision, 1);
  assert.equal(f.context.isCodexRewindPostEnterCurrent(record), true, 'own capture bump stays owned');
  assert.ok(f.events.indexOf('persist:capture-prepared') < f.events.indexOf('helper:clear'));
  assert.equal(f.composer, '');
  assert.equal(record.durable.preparedDraft.capturedText, f.expectedText);
  assert.equal(record.durable.captureResult.draftTransfer.text, f.expectedText);
  assert.equal(f.mirror.synchronizedFrameWaiters.size, 0);
});

test('tab34: retired startup payload does not invalidate the same consumed Rewind after Enter', async t => {
  const f = fixture(t);
  // task_started retires this temporary startup/watchdog payload before the
  // later Rewind; the admitted action still owns the same physical run.
  f.context.codexLastRunCommandPayload.delete(f.tabId);
  const record = f.create();
  const result = await f.nestedGrab(record);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.text, f.expectedText);
  assert.equal(result.matchedTarget, true);
  assert.deepEqual(f.writes, ['\x07']);
  assert.equal(f.context.isCodexRewindPostEnterCurrent(record), true);
  f.commitChild();
  const completed = await f.context.completeCodexRewindPostEnterRecord(record, record.durable.captureResult);
  assert.equal(completed.success, true, JSON.stringify(completed));
  assert.equal(completed.handoffStatus, 'adopted-child');
  assert.deepEqual(f.writes, ['\x07'], 'settlement never replays Enter or Send');
});

test('retired launch payload cannot mask a replacement launch or changed physical Rewind owner', async t => {
  for (const kind of ['terminal', 'lifecycle', 'run', 'input', 'stopping', 'launch', 'invalid-launch']) {
    const f = fixture(t);
    f.context.codexLastRunCommandPayload.delete(f.tabId);
    const record = f.create();
    if (kind === 'launch' || kind === 'invalid-launch') {
      f.context.codexLastRunCommandPayload.set(f.tabId,
        kind === 'launch' ? { launchId: 'replacement-launch' } : {});
    } else f.mutate(kind);
    const result = await f.capture(record);
    assert.equal(result.success, false, kind);
    assert.deepEqual(f.writes, [], kind);
    assert.equal(f.composer, f.expectedText, kind);
  }
});

test('legacy exact post-Enter recovery survives startup payload retirement across its process await', async t => {
  const f = fixture(t, { legacy: true, expiredWatcher: true });
  f.context.codexLastRunCommandPayload.delete(f.tabId);
  const result = await f.context.recoverCodexRewindPostEnterOperation(f.request);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.historyDraftText, f.expectedText);
  assert.deepEqual(f.writes, ['\x07']);
});

test('actual wait/capture cancels and refuses changed terminal, lifecycle, run, launch and input before Ctrl+G', async t => {
  for (const kind of ['cancel', 'terminal', 'lifecycle', 'run', 'launch', 'input', 'stopping']) {
    const f = fixture(t, { startup: true });
    const record = f.create();
    let cancel;
    const cancelPromise = new Promise(resolve => { cancel = resolve; });
    const flight = f.capture(record, { cancelPromise });
    await flush();
    if (kind === 'cancel') cancel();
    else f.mutate(kind);
    const result = await flight;
    assert.equal(result.success, false, kind);
    assert.equal(result.pending, true, kind);
    assert.equal(result.rollbackMayHaveApplied, true, kind);
    assert.deepEqual(f.writes, [], kind);
    assert.equal(f.composer, f.expectedText, kind);
  }
});

test('actual failed durability prepare prevents helper authorization and preserves the entire native draft', async t => {
  const f = fixture(t);
  const record = f.create();
  f.setFailPhase('capture-prepared');
  const result = await f.capture(record);
  assert.equal(result.success, false);
  assert.equal(result.error, 'codex_rewind_post_enter_journal_changed');
  assert.equal(f.events.includes('helper:authorize'), false);
  assert.equal(f.events.includes('helper:clear'), false);
  assert.equal(f.composer, f.expectedText);
  assert.deepEqual(f.writes, ['\x07']);
});

test('actual late helper outcome recovers the original operation without another Ctrl+G', async t => {
  const f = fixture(t);
  const record = f.create();
  f.setHelperReturn({ ready: false, reason: 'return-edge-not-yet-observed' });
  const first = await f.capture(record);
  assert.equal(first.success, false);
  assert.equal(first.error, 'external_editor_return_unconfirmed');
  assert.equal(first.draftTransfer.text, f.expectedText, 'already-cleared draft stays accounted for');
  let completed = false;
  const secondFlight = f.capture(record).then(result => { completed = true; return result; });
  await flush();
  assert.equal(completed, false, 'the old ready frame before Ctrl+G is not a helper return');
  f.emitFrame();
  const second = await secondFlight;
  assert.equal(second.success, true);
  assert.equal(second.lateRecovery, true);
  assert.equal(second.captureOperationId, first.captureOperationId);
  assert.deepEqual(f.writes, ['\x07']);
  assert.equal(f.captures, 1);
});

test('actual armed capture with no exact outcome remains pending and is never reissued', async t => {
  const f = fixture(t, { autoHelper: false });
  const record = f.create();
  const firstFlight = f.capture(record);
  await flush();
  const pending = f.context.grabInputPending.get(f.tabId);
  pending.resolve({ success: false, error: 'external_editor_timeout' });
  assert.equal((await firstFlight).success, false);
  f.emitFrame(); // A new frame alone still does not invent a matching helper outcome.
  const next = await f.capture(record);
  assert.equal(next.error, 'codex_rewind_capture_outcome_pending');
  assert.equal(next.pending, true);
  assert.equal(next.rollbackMayHaveApplied, true);
  assert.deepEqual(f.writes, ['\x07']);
  assert.equal(f.captures, 1);
});

test('actual completion persists one branch-draft result and read/recover replays the same operation without sending', async t => {
  const f = fixture(t);
  const record = f.create();
  const captured = await f.capture(record);
  const result = await f.context.completeCodexRewindPostEnterRecord(record, captured);
  assert.equal(result.success, true);
  assert.equal(result.handoffStatus, 'branch-draft-restored');
  assert.equal(result.historyDraftText, f.expectedText);
  assert.equal(f.context.readCodexRewindPostEnterResult(f.request).operationId, f.request.operationId);
  const replay = await f.context.recoverCodexRewindPostEnterOperation(f.request);
  assert.equal(replay.captureOperationId, result.captureOperationId);
  assert.equal(replay.historyDraftText, f.expectedText);
  assert.deepEqual(f.writes, ['\x07']);
  assert.equal(f.context.readCodexRewindPostEnterResult({ ...f.request, operationId: 'other' }).success, false);
});

test('actual completion accepts the exact child receipt after transient journal/observer cleanup', async t => {
  const f = fixture(t);
  const record = f.create();
  const captured = await f.capture(record);
  f.setSettleAction(() => { f.commitChild(); f.context.codexWatchers.delete(f.tabId); });
  const result = await f.context.completeCodexRewindPostEnterRecord(record, captured);
  assert.equal(result.success, true);
  assert.equal(result.handoffStatus, 'adopted-child');
  assert.equal(result.activeSessionId, 'exact-child');
  assert.equal(f.finalized, 1);
  assert.deepEqual(f.writes, ['\x07']);
});

test('actual final authority policy keeps a written pending operation consumed, unlike the frozen finally', async t => {
  const f = fixture(t, { startup: true });
  const record = f.create();
  Object.assign(f.context, {
    rewindActionAuthority: f.authority, rewindPostEnterRecord: record,
    codexRewindOperationResult: { success: false, pending: true, error: 'codex_input_not_ready' },
    tabId: f.tabId,
  });
  f.context.applyActualAuthorityFinally();
  assert.equal(f.authority.phase, 'consumed');
  assert.equal(f.events.includes('authority:revoked'), false);
  assert.equal(record.durable.enterWrittenAt > 0, true);
  vm.runInContext(frozen.authorityFinally(), f.context);
  assert.equal(f.authority.phase, 'revoked', 'old actual finally destroys the continuation after the same failure');
});

test('actual post-Enter capture rejects a saved ready frame from before confirm Enter', async t => {
  const f = fixture(t);
  const record = f.create({ postEnterFrame: false });
  let completed = false;
  const flight = f.capture(record).then(result => { completed = true; return result; });
  await flush();
  assert.equal(completed, false);
  assert.deepEqual(f.writes, []);
  f.emitFrame();
  assert.equal((await flight).success, true);
  assert.deepEqual(f.writes, ['\x07']);
});

test('before: actual frozen release deletes real helper proof before a failed result save, leaving only prepared text', async t => {
  const f = fixture(t, { realCaptureProtocol: true, releaseFromFrozen: true });
  const record = f.create();
  f.setFailPhase('captured');
  const result = await f.capture(record);
  assert.equal(result.success, false);
  assert.equal(result.error, 'capture_result_persist_failed');
  assert.equal(f.composer, '', 'helper already cleared the real-owned draft');
  assert.equal(record.durable.preparedDraft.capturedText, f.expectedText);
  assert.equal(record.durable.captureResult, undefined);
  assert.equal(record.durable.captureAppliedProof, undefined);
  assert.equal(captureApi.readOutcome(record.durable.captureOperation), null, 'actual protocol.release deleted outcome.json');
  assert.equal(fs.existsSync(record.durable.captureOperation.operationDir), false);
  f.setFailPhase(null);
  const late = await f.capture(record);
  assert.equal(late.success, false);
  assert.equal(late.error, 'codex_rewind_capture_outcome_pending', 'prepared text is not an applied-clear receipt');
  assert.deepEqual(f.writes, ['\x07'], 'even the old gap must never trigger a second Ctrl+G');
});

test('after: actual release persists applied proof before deleting real helper files even if final result save fails', async t => {
  const f = fixture(t, { realCaptureProtocol: true });
  const record = f.create();
  f.setFailPhase('captured');
  const result = await f.capture(record);
  assert.equal(result.success, false);
  assert.equal(result.error, 'capture_result_persist_failed');
  assert.equal(record.durable.preparedDraft.capturedText, f.expectedText);
  assert.equal(record.durable.captureResult, undefined);
  assert.equal(record.durable.captureAppliedProof.applied, true);
  assert.equal(captureApi.operationMatches(record.durable.captureAppliedProof, record.durable.captureOperation), true);
  assert.equal(record.durable.captureAppliedProof.helperId, record.durable.helperId);
  assert.equal(captureApi.readOutcome(record.durable.captureOperation), null, 'normal cleanup still completes');
  assert.ok(f.events.indexOf('persist:applied-proof') < f.events.indexOf('outcome:deleted'));
  f.setFailPhase(null);
  const late = await f.capture(record);
  assert.equal(late.success, true);
  assert.equal(late.lateRecovery, true);
  assert.equal(late.draftTransfer.text, f.expectedText);
  assert.equal(late.captureOperationId, record.durable.captureOperation.operationId);
  const completed = await f.context.completeCodexRewindPostEnterRecord(record, late);
  assert.equal(completed.success, true);
  assert.equal(completed.historyDraftText, f.expectedText);
  assert.deepEqual(f.writes, ['\x07']);
});

test('actual release retains real outcome when applied-proof persistence fails, then cleans only after exact recovery saves it', async t => {
  const f = fixture(t, { realCaptureProtocol: true });
  const record = f.create();
  f.setFailPhase('captured');
  f.setFailAppliedProof(true);
  const result = await f.capture(record);
  assert.equal(result.success, false);
  assert.equal(record.durable.captureAppliedProof, undefined);
  assert.equal(captureApi.readOutcome(record.durable.captureOperation).applied, true);
  assert.equal(f.events.includes('outcome:deleted'), false);
  assert.equal(f.context.grabInputPending.has(f.tabId), true);
  f.setFailPhase(null);
  f.setFailAppliedProof(false);
  const late = await f.capture(record);
  assert.equal(late.success, true);
  assert.equal(record.durable.captureAppliedProof.applied, true);
  assert.equal(captureApi.readOutcome(record.durable.captureOperation), null);
  assert.equal(f.context.grabInputPending.has(f.tabId), false);
  assert.deepEqual(f.writes, ['\x07']);
});

test('actual legacy recovery restores an expired watcher from retained intent without rearm, Enter or restart', async t => {
  const f = fixture(t, { legacy: true, expiredWatcher: true });
  const result = await f.context.recoverCodexRewindPostEnterOperation(f.request);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.handoffGeneration, f.request.actionGeneration);
  assert.equal(result.historyDraftText, f.expectedText);
  assert.equal(f.authority.phase, 'revoked', 'the original input authority is never revived');
  assert.equal(f.watcherRestarts.length, 1, 'only the observation subscription is restored');
  assert.equal(f.watcherRestarts[0].launchId, f.request.actionGeneration);
  assert.equal(f.inputRevision, 1);
  assert.equal(f.captures, 1);
  assert.deepEqual(f.writes, ['\x07']);
});

test('actual legacy recovery rechecks scope after target and live-process awaits before capture', async t => {
  for (const boundary of ['target', 'process']) {
    const f = fixture(t, { legacy: true, expiredWatcher: true });
    if (boundary === 'target') f.setBeforeTargetReturn(() => f.mutate('input'));
    else f.setBeforeProcessReturn(() => f.mutate('lifecycle'));
    const result = await f.context.recoverCodexRewindPostEnterOperation(f.request);
    assert.equal(result.success, false, boundary);
    assert.equal(result.pending, true, boundary);
    assert.equal(f.watcherRestarts.length, 0, boundary);
    assert.deepEqual(f.writes, [], boundary);
  }
});

test('before: frozen actual TTL closes an already-written Native Rewind observer while its journal remains pending', t => {
  const f = fixture(t, { legacy: true });
  const observer = f.context.codexWatchers.get(f.tabId);
  const waiterResults = [];
  let closed = 0;
  observer.handoffWaiters = new Set([result => waiterResults.push(result)]);
  observer.watcher = { close() { closed += 1; } };
  vm.runInContext(frozen.function('closeCodexWatcher'), f.context);
  f.context.closeCodexWatcher(f.tabId, 'ttl');
  assert.equal(closed, 1);
  assert.equal(f.context.codexWatchers.has(f.tabId), false);
  assert.equal(waiterResults[0].status, 'observer-closed');
  assert.equal(f.context.readPendingCodexNativeRewindHandoff(f.tabId).actionGeneration, f.request.actionGeneration);
  assert.deepEqual(f.writes, []);
});

test('actual TTL retains the exact written Native Rewind observation, and an old timer cannot close a replacement', t => {
  for (const reason of ['ttl', 'ttl-no-watch']) {
    const f = fixture(t, { legacy: true });
    const observer = f.context.codexWatchers.get(f.tabId);
    let closed = 0;
    let notified = 0;
    observer.watcher = { close() { closed += 1; } };
    observer.handoffWaiters = new Set([() => { notified += 1; }]);
    f.context.closeCodexWatcher(f.tabId, reason);
    assert.equal(f.context.codexWatchers.get(f.tabId), observer);
    assert.equal(closed, 0);
    assert.equal(notified, 0);
    assert.equal(observer.timeout.ms, f.context.CODEX_WATCHER_TTL_MS);
    const oldTimer = observer.timeout;
    const newerObserver = { ...observer, launchId: 'new-action' };
    f.context.codexWatchers.set(f.tabId, newerObserver);
    oldTimer.callback();
    assert.equal(f.context.codexWatchers.get(f.tabId), newerObserver);
    assert.deepEqual(f.writes, []);
  }
});

test('actual TTL does not retain changed physical scopes, foreign journals, unwritten actions or explicit Stop/restart', t => {
  for (const kind of ['terminal', 'lifecycle', 'run', 'foreign-generation', 'foreign-source', 'missing-journal', 'unwritten', 'stop', 'restart']) {
    const f = fixture(t, { legacy: true });
    const observer = f.context.codexWatchers.get(f.tabId);
    let closed = 0;
    observer.watcher = { close() { closed += 1; } };
    const key = 'codex.pending-writer-handoff.v1:' + f.tabId;
    if (['terminal', 'lifecycle', 'run'].includes(kind)) f.mutate(kind);
    if (kind === 'foreign-generation') f.state.set(key, { ...f.journal, actionGeneration: 'other-action' });
    if (kind === 'foreign-source') f.state.set(key, { ...f.journal, sourceSessionId: 'other-source' });
    if (kind === 'missing-journal') f.state.delete(key);
    if (kind === 'unwritten') observer.handoffActionStartedAtMs = null;
    f.context.closeCodexWatcher(f.tabId, ['stop', 'restart'].includes(kind) ? kind : 'ttl');
    assert.equal(closed, 1, kind);
    assert.equal(f.context.codexWatchers.has(f.tabId), false, kind);
    assert.deepEqual(f.writes, [], kind);
  }
});
