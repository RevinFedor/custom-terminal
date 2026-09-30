'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

const source = process.env.CODEX_OBSERVATION_INSTALLED_ASAR
  ? require('@electron/asar').extractFile(process.env.CODEX_OBSERVATION_INSTALLED_ASAR, 'dist/main/main.js').toString()
  : fs.readFileSync(process.env.CODEX_OBSERVATION_MAIN_SOURCE || path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const quiet = { log() {}, warn() {}, error() {} };

// Execute the real main observation, reconciliation and slash boundary. Only
// external I/O (process inspection, SQLite, watchers and PTY) is replaced.
// In particular, do not stub ensureCodexSubmissionWatcher as always available:
// that hid the settings -> old Resume rearm -> /compact production failure.
function harness({ hasTurn = true, provisional = false, failFirstAttach = false } = {}) {
  const tabId = 'fixture-tab';
  const sessionId = 'fixture-session';
  const term = { write() { assert.fail('no real PTY writes in this fixture'); } };
  const runtime = { lifecycle: 'fixture-terminal:1', input: 3, observation: 0 };
  const commandState = { runSeq: 1, isRunning: true };
  const launch = { command: 'codex-c', sessionId, launchId: 'fixture-launch',
    terminalToken: term, lifecycleGeneration: runtime.lifecycle, runSeq: 1,
    startedAt: 1000, cwd: '/fixture' };
  const candidate = { status: 'owned', sessionId, filePath: '/fixture/rollout.jsonl',
    pids: [42], sourceMatch: 'source-in-place', sourceSessionId: sessionId,
    forkedFromId: 'historical-parent', cwd: '/fixture' };
  const events = [];
  const state = { sessionId, filePath: candidate.filePath,
    sourceObservationLaunchId: provisional ? launch.launchId : null,
    processGeneration: runtime.lifecycle, processGenerationBoundaryOffset: 100,
    offset: 120, busy: false };
  const proof = { ...candidate, valid: true, kind: 'process-open-rollout',
    launchId: launch.launchId, terminalToken: term,
    lifecycleGeneration: runtime.lifecycle, runSeq: 1 };
  const context = vm.createContext({
    ...require('./ai-process-liveness'),
    ...require('./codex-writer-ownership'),
    ...require('./codex-writer-binding'),
    ...require('./codex-runtime-contract'),
    ...require('./codex-resume-user-activity'),
    ...require('./agent-send-target-precondition'),
    console: quiet, setImmediate,
    terminals: new Map([[tabId, term]]),
    terminalCommandState: new Map([[tabId, commandState]]),
    terminalProjects: new Map([[tabId, '/fixture']]),
    terminalProjectIds: new Map([[tabId, 'fixture-project']]),
    claudeLaunchGenerationByTab: new Map(),
    nodePerformance: { now: Date.now, timeOrigin: 0 }, beginPerfOp() {}, endPerfOp() {},
    terminalLifecycleEpochs: new WeakMap([[term, 'fixture-terminal']]),
    codexLastRunCommandPayload: new Map([[tabId, launch]]),
    codexKnownSessions: new Map(provisional ? [] : [[tabId, sessionId]]),
    codexWriterProofs: new Map(provisional ? [] : [[tabId, proof]]),
    codexTurnWatchers: new Map(hasTurn ? [[tabId, state]] : []),
    codexWatchers: new Map(), codexSessionDiscoveryIntents: new Map(),
    codexPendingSettingsProofHandoffs: new Map(),
    codexWriterSessionInflight: new Map(), codexPickerQueue: new Map(),
    codexModelEffortIntentReconcileInflight: new Map(),
    codexSettingsMutationQueue: require('./codex-settings-mutation-queue').createCodexSettingsMutationQueue(),
    aiStoppingTabs: new Map(),
    mainWindow: { isDestroyed: () => false, webContents: { send() {} } },
    getTerminalLifecycleGeneration: () => runtime.lifecycle,
    getTerminalInputRevision: () => runtime.input,
    getTerminalStopRevision: () => 0,
    getCodexExitObserverGeneration: () => runtime.lifecycle,
    isCodexExitObserverCurrent: (_tab, generation) => runtime.lifecycle === generation,
    getCodexWriterObservationGeneration: () => runtime.observation,
    getCodexSessionOwner: () => null,
    getCodexResumeSourceLeaseForTab: () => ({ tabId, sourceSessionId: sessionId,
      launchId: launch.launchId }),
    getCodexResumeReadIdentityLeaseForTab: () => null,
    isCodexTuiEffectivelyReady: () => true,
    codexHasLivePtySubmitEvidence: () => true,
    hasCodexPromptOrTurnInFlight: () => false,
    inspectCodexOwnedWriter: async () => ({ ...candidate }),
    codexDataModule: { _api: { findCodexLinkedLiveBoundary: async () => {
      events.push('read-launch-boundary');
      return { found: false };
    } } },
    runKeyedExclusive: (_map, _key, run) => run(),
    syncCodexDelayedWriterCandidateWatchers() {},
    invalidateCodexWriterProof: (_tab, reason) => {
      events.push('invalidate:' + reason);
      const current = context.codexWriterProofs.get(tabId);
      if (current) context.codexWriterProofs.set(tabId, { ...current, valid: false });
    },
    codexSessionIdFromDb: () => sessionId,
    readPendingCodexNativeRewindHandoff: () => null,
    persistCodexKnownSessionBinding: () => ({ success: true }),
    setCodexKnownSession: (_tab, sid, _reason, nextProof) => {
      context.codexKnownSessions.set(tabId, sid);
      context.codexWriterProofs.set(tabId, { ...nextProof, sessionId: sid, valid: true });
      return { success: true };
    },
    getPendingCodexPasteAudits: () => [],
    releaseCodexSourceObservationAfterWriterProof() {},
    releaseCodexResumeSourceLeaseForTab() {},
    startCodexSessionWatcher: (_sender, request) => {
      events.push('start-discovery');
      runtime.observation++;
      context.codexSessionDiscoveryIntents.set(tabId, { ...request });
      context.codexWatchers.set(tabId, { ...request });
    },
    ensureCodexTurnWatcher: async (_tab, sid) => {
      assert.equal(sid, sessionId);
      events.push('attach-turn');
      context.codexTurnWatchers.set(tabId, { ...state });
      return true;
    },
    startCodexTurnWatcher: request => {
      if (failFirstAttach) { failFirstAttach = false; return false; }
      context.codexTurnWatchers.set(tabId, { ...state, ...request });
      return true;
    },
    withPtyWriteLock: (_term, run) => run(),
    isOwnedDesktopHistorySendSource: () => true,
    requestTerminalCodexDraftState: async () => ({ success: true, hasDraft: false }),
    createCodexPickerDraftCapture: () => ({}),
    getCurrentCodexServiceTierProofIdentity: () => null,
    captureCodexManualCompactBoundary: () => ({ tabId, sessionId,
      lifecycleGeneration: runtime.lifecycle, promptSeq: 1, sourceOffset: 120 }),
    readCodexManualInputOwner: () => ({}),
    compactOperations: { armPending: request => ({ ...request, operationId: 'fixture-compact' }) },
    cancelCodexManualCompactPending() {},
    sendCodexLiveSlashCommand: async (_term, request) => {
      const admission = request.writeGuard('before-paste');
      if (!admission.allowed) return { success: false, submitted: false, error: admission.reason };
      events.push('write:' + request.command);
      return { success: true, submitted: true };
    },
  });
  for (const name of [
    'getCodexWriterProofSnapshot', 'getCodexSubmissionObservationContext',
    'armCodexSubmissionObservationWithoutProof', 'ensureCodexSubmissionWatcher',
    'reconcileCodexWriterFromProcessInner', 'currentCodexAcceptedResumeSourceProof',
    'readAgentSendDestinationAtWriteBoundary', 'agentSendRequestExpectedTargets',
    'agentSendRequestTargetFailure', 'executeCodexLiveSlashCommandRequest',
    'captureAiProcessLookupScope', 'aiProcessLookupScopeCurrent',
    'findAiDescendantProcessesByTab', 'inspectAiDescendantProcessesByTab',
    'inspectCodexWriterProcessProofInner',
  ]) {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item)
      && item.name?.text === name);
    assert.ok(node, name);
    vm.runInContext(node.getText(ast), context);
  }
  context.reconcileCodexWriterFromProcess = async (...args) => {
    try { return await context.reconcileCodexWriterFromProcessInner(...args); }
    catch (error) { events.push('reconcile-error:' + error.message); throw error; }
  };
  const observe = reason => context.ensureCodexSubmissionWatcher(tabId, '/fixture', reason);
  const drainDiscovery = async () => {
    const observer = context.codexWatchers.get(tabId);
    if (observer) await context.reconcileCodexWriterFromProcessInner(tabId, {
      reason: 'writer-proof-linked', expectedObserver: observer,
    });
  };
  const compact = () => context.executeCodexLiveSlashCommandRequest({
    tabId, command: '/compact', handoffId: 'fixture-handoff', source: 'history-panel',
    expectedTarget: { toolType: 'codex', sessionId },
  });
  return { context, events, runtime, commandState, candidate, launch, state,
    tabId, sessionId, term, observe, drainDiscovery, compact };
}

test('confirmed Resume -> settings preparation -> /compact does not reopen consumed discovery', async () => {
  const h = harness();
  assert.equal((await h.observe('model-effort-picker-writer')).available, true, JSON.stringify(h.events));
  await h.drainDiscovery();
  const result = await h.compact();
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.submitted, true);
  assert.equal(h.context.getCodexWriterProofSnapshot(h.tabId)?.sessionId, h.sessionId);
  assert.deepEqual(h.events, ['write:/compact']);
  assert.equal(h.context.codexWatchers.size, 0);
  assert.equal(h.context.codexSessionDiscoveryIntents.size, 0);
});

test('normal Send observation retains the completed Resume and existing turn watcher', async () => {
  const h = harness();
  const result = h.context.armCodexSubmissionObservationWithoutProof(h.tabId, '/fixture',
    'safe-paste-final:history-panel', { reserveProvisional: true });
  assert.equal(result.available, true);
  assert.equal(result.kind, 'turn');
  assert.equal(result.reservation, null);
  assert.equal(result.rearmed, false);
  await h.drainDiscovery();
  assert.equal(h.context.getCodexWriterProofSnapshot(h.tabId)?.valid, true);
  assert.deepEqual(h.events, []);
});

test('a missing turn observer is restored without restarting completed Resume discovery', async () => {
  const h = harness({ hasTurn: false, failFirstAttach: true });
  assert.equal((await h.observe('local-command-target')).available, true, JSON.stringify(h.events));
  await h.drainDiscovery();
  assert.ok(h.context.codexTurnWatchers.has(h.tabId));
  assert.equal(h.context.codexWatchers.size, 0);
  assert.equal(h.context.getCodexWriterProofSnapshot(h.tabId)?.valid, true);
  assert.equal(h.events.includes('start-discovery'), false);
  await new Promise(setImmediate);
});

test('a confirmed writer that appears during reconciliation consumes the old Resume once', async () => {
  const h = harness({ provisional: true });
  h.context.reconcileCodexWriterFromProcess = async (...args) => {
    const result = await h.context.reconcileCodexWriterFromProcessInner(args[0], {
      ...args[1], reason: 'source-rollout-appended',
    });
    if (result.status === 'adopted') {
      h.context.codexWatchers.delete(h.tabId);
      h.context.codexSessionDiscoveryIntents.delete(h.tabId);
      h.state.sourceObservationLaunchId = null;
    }
    return result;
  };
  const result = await h.observe('model-effort-picker-writer');
  assert.equal(result.available, true);
  assert.equal(result.kind, 'turn');
  assert.equal(h.events.filter(event => event === 'start-discovery').length, 1);
  assert.equal(h.context.codexWatchers.size, 0, 'do not reopen discovery consumed inside await');
  assert.equal(h.context.codexSessionDiscoveryIntents.size, 0);
});

test('unsettled Resume still rearms both source/child observation and reserves only one first Send', async () => {
  const h = harness({ provisional: true });
  const result = await h.observe('model-effort-picker-writer');
  assert.equal(result.available, true, JSON.stringify(result));
  assert.equal(result.kind, 'provisional-source');
  assert.equal(h.events.filter(event => event === 'start-discovery').length, 1);
  assert.equal(h.context.getCodexWriterProofSnapshot(h.tabId), null);
  const first = h.context.armCodexSubmissionObservationWithoutProof(h.tabId, '/fixture',
    'safe-paste-final:history-panel', { reserveProvisional: true });
  assert.equal(first.available, true);
  assert.equal(first.kind, 'provisional-source');
  first.reservation.submitted = true;
  const repeated = h.context.armCodexSubmissionObservationWithoutProof(h.tabId, '/fixture',
    'safe-paste-final:history-panel', { reserveProvisional: true });
  assert.equal(repeated.available, false);
  assert.equal(h.events.some(event => event.startsWith('write:')), false);
});

test('unknown process ownership still refuses before slash write', async () => {
  const h = harness();
  h.candidate.status = 'unknown';
  const result = await h.compact();
  assert.equal(result.success, false);
  assert.equal(result.submitted, false);
  assert.equal(result.error, 'agent_send_target_unresolved');
  assert.equal(h.context.getCodexWriterProofSnapshot(h.tabId), null);
  assert.equal(h.events.some(event => event.startsWith('write:')), false);
  assert.equal(h.events.some(event => event.startsWith('reconcile-error:')), false);
});

test('tab34: an unresolved earlier Rewind is not reported as a proven conversation change', async () => {
  const h = harness();
  h.context.codexLastRunCommandPayload.delete(h.tabId);
  h.context.codexSessionDiscoveryIntents.set(h.tabId, {
    sourceMode: 'writer-handoff', sourceSessionId: h.sessionId,
    launchId: 'codex-writer-handoff-unsettled',
  });
  h.candidate.status = 'ambiguous';
  const result = await h.compact();
  assert.equal(result.error, 'agent_send_target_unresolved', JSON.stringify(result));
  assert.equal(result.submitted, false);
  assert.equal(result.pasteWritten, false);
  assert.equal(result.enterWritten, false);
  assert.equal(h.context.getCodexWriterProofSnapshot(h.tabId), null);
  assert.equal(h.events.some(event => event.startsWith('write:')), false);
});

test('a replacement during process inspection cannot admit the old slash target', async () => {
  const h = harness();
  h.context.inspectCodexOwnedWriter = async () => {
    h.runtime.lifecycle = 'fixture-terminal:2';
    h.commandState.runSeq = 2;
    h.context.codexWriterProofs.delete(h.tabId);
    return { ...h.candidate };
  };
  const result = await h.compact();
  assert.equal(result.success, false);
  assert.equal(result.submitted, false);
  assert.equal(h.events.some(event => event.startsWith('write:')), false);
  assert.equal(h.events.some(event => event.startsWith('reconcile-error:')), false);
});

test('a different confirmed session during the draft read still refuses the captured target', async () => {
  const h = harness();
  h.context.requestTerminalCodexDraftState = async () => {
    h.context.codexKnownSessions.set(h.tabId, 'other-session');
    h.context.codexWriterProofs.set(h.tabId, {
      ...h.context.codexWriterProofs.get(h.tabId), sessionId: 'other-session',
      sourceSessionId: 'other-session', launchId: 'other-launch',
    });
    return { success: true, hasDraft: false };
  };
  const result = await h.compact();
  assert.equal(result.error, 'agent_send_target_changed');
  assert.equal(result.submitted, false);
  assert.equal(h.events.some(event => event.startsWith('write:')), false);
});

test('actual ps scope expiry on first-turn launch-payload cleanup cannot invalidate the confirmed writer', async () => {
  const h = harness();
  let resolveSnapshot;
  h.context.getProcessTreeSnapshot = () => new Promise(resolve => { resolveSnapshot = resolve; });
  h.context.inspectCodexOwnedWriter = h.context.inspectCodexWriterProcessProofInner;
  const prior = h.context.getCodexWriterProofSnapshot(h.tabId);
  const read = h.context.reconcileCodexWriterFromProcessInner(h.tabId, { reason: 'post-submit-observation' });
  h.context.codexLastRunCommandPayload.delete(h.tabId); // task_started consumes payload, same PTY/process
  resolveSnapshot({ children: new Map(), psMs: 0 });
  const result = await read;
  assert.equal(result.status, 'stale-process-scope');
  assert.equal(result.preserveWriterProof, true);
  assert.equal(h.context.getCodexWriterProofSnapshot(h.tabId)?.valid, true);
  assert.equal(h.context.getCodexWriterProofSnapshot(h.tabId)?.launchId, prior.launchId);
  assert.equal(h.events.some(event => event.startsWith('invalidate:')), false);
  h.context.inspectCodexOwnedWriter = async () => ({ ...h.candidate });
  assert.equal((await h.compact()).success, true);
});

test('stale process read also preserves a newer writer committed while its lookup awaited', async () => {
  const h = harness();
  let finish;
  h.context.inspectAiDescendantProcessesByTab = () => new Promise(resolve => { finish = resolve; });
  h.context.inspectCodexOwnedWriter = h.context.inspectCodexWriterProcessProofInner;
  const read = h.context.reconcileCodexWriterFromProcessInner(h.tabId);
  const next = { ...h.context.getCodexWriterProofSnapshot(h.tabId), sessionId: 'new-writer' };
  h.context.codexKnownSessions.set(h.tabId, 'new-writer');
  h.context.codexWriterProofs.set(h.tabId, next);
  finish({ status: 'unknown', reason: 'process_scope_changed', error: new Error('process lookup owner changed') });
  assert.equal((await read).status, 'stale-process-scope');
  assert.equal(h.context.getCodexWriterProofSnapshot(h.tabId)?.sessionId, 'new-writer');
  assert.equal(h.events.some(event => event.startsWith('invalidate:')), false);
});

test('a real unknown/absent process verdict still invalidates ownership rather than granting stale permission', async () => {
  for (const status of ['unknown', 'absent']) {
    const h = harness();
    h.context.inspectAiDescendantProcessesByTab = async () => ({ status, error: new Error('ps timed out') });
    h.context.inspectCodexOwnedWriter = h.context.inspectCodexWriterProcessProofInner;
    assert.equal((await h.context.reconcileCodexWriterFromProcessInner(h.tabId)).status, status);
    assert.equal(h.context.getCodexWriterProofSnapshot(h.tabId), null);
  }
});

test('native Rewind checks a fresh physical writer after one process-table timeout', async () => {
  const h = harness();
  const calls = [];
  h.context.inspectCodexOwnedWriter = async (_tab, _intent, options = {}) => {
    calls.push(options);
    return calls.length === 2
      ? { status: 'unknown', error: 'ps snapshot timed out', processSnapshotTimedOut: true }
      : { ...h.candidate };
  };
  const result = await h.context.reconcileCodexWriterFromProcessInner(h.tabId, {
    reason: 'codex-rewind-locked-before-target-load',
  });
  assert.equal(result.status, 'adopted');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].forceFreshProcessSnapshot, true);
  assert.equal(h.context.getCodexWriterProofSnapshot(h.tabId)?.sessionId, h.sessionId);
  assert.equal(h.events.some(event => event.startsWith('invalidate:')), false);
  assert.equal(h.events.some(event => event.startsWith('write:')), false);
});

test('native Rewind accepts no writer or PTY action after a second unknown process snapshot', async () => {
  const h = harness();
  let calls = 0;
  h.context.inspectCodexOwnedWriter = async () => ++calls === 1
    ? { ...h.candidate }
    : { status: 'unknown', error: 'ps snapshot timed out', processSnapshotTimedOut: true };
  const result = await h.context.reconcileCodexWriterFromProcessInner(h.tabId, {
    reason: 'codex-rewind-locked-before-target-load',
  });
  assert.equal(result.status, 'revalidation-unknown');
  assert.equal(calls, 3);
  assert.equal(h.context.getCodexWriterProofSnapshot(h.tabId), null);
  assert.equal(h.events.some(event => event.startsWith('write:')), false);
});

test('native Rewind abandons process-timeout recovery when the input owner changes', async () => {
  const h = harness();
  let calls = 0;
  h.context.inspectCodexOwnedWriter = async () => {
    calls++;
    if (calls === 2) {
      h.runtime.input++;
      return { status: 'unknown', error: 'ps snapshot timed out', processSnapshotTimedOut: true };
    }
    return { ...h.candidate };
  };
  const result = await h.context.reconcileCodexWriterFromProcessInner(h.tabId, {
    reason: 'codex-rewind-locked-before-target-load',
  });
  assert.equal(result.status, 'revalidation-stale-rewind-process-scope');
  assert.equal(calls, 2);
  assert.equal(h.context.getCodexWriterProofSnapshot(h.tabId)?.sessionId, h.sessionId);
  assert.equal(h.events.some(event => event.startsWith('invalidate:') || event.startsWith('write:')), false);
});

test('only a timed out process-table read may recover; generic unknown keeps its old refusal', async () => {
  const h = harness();
  h.context.inspectAiDescendantProcessesByTab = async () => ({
    status: 'unknown', error: Object.assign(new Error('process lookup failed'), {
      cause: { killed: true, signal: 'SIGTERM', message: 'Command failed: ps -eo pid=,ppid=,pgid=,tpgid=,command=' },
    }),
  });
  h.context.inspectCodexOwnedWriter = h.context.inspectCodexWriterProcessProofInner;
  assert.equal((await h.context.inspectCodexWriterProcessProofInner(h.tabId)).processSnapshotTimedOut, true);
  h.context.inspectAiDescendantProcessesByTab = async () => ({
    status: 'unknown', error: new Error('permission denied'),
  });
  assert.equal((await h.context.inspectCodexWriterProcessProofInner(h.tabId)).processSnapshotTimedOut, false);
});

test('stale final revalidation cannot revoke the writer established before its read', async () => {
  const h = harness();
  let reads = 0;
  h.context.inspectAiDescendantProcessesByTab = async () => ({ status: 'unknown',
    error: new Error('process_scope_changed') });
  h.context.inspectCodexOwnedWriter = (...args) => ++reads === 1
    ? Promise.resolve({ ...h.candidate })
    : h.context.inspectCodexWriterProcessProofInner(...args);
  const result = await h.context.reconcileCodexWriterFromProcessInner(h.tabId);
  assert.equal(result.status, 'revalidation-stale-process-scope');
  assert.equal(h.context.getCodexWriterProofSnapshot(h.tabId)?.valid, true);
  assert.equal(h.events.some(event => event.startsWith('invalidate:')), false);
});

test('fresh proof of the same process/file restores the launch identity after a genuine temporary lookup failure', async () => {
  const h = harness();
  h.context.codexLastRunCommandPayload.delete(h.tabId);
  h.context.codexWriterProofs.get(h.tabId).valid = false;
  h.context.codexWriterProofs.get(h.tabId).invalidatedReason = 'process-proof-unknown';
  assert.equal((await h.observe('send-target-revalidation')).available, true);
  assert.equal(h.context.getCodexWriterProofSnapshot(h.tabId).launchId, h.launch.launchId);
  assert.equal(h.context.agentSendRequestTargetFailure(h.tabId, 'codex', {
    expectedTarget: { toolType: 'codex', sessionId: h.sessionId, launchId: h.launch.launchId },
  }), null);
});

test('old launch identity is not inherited by a different process/file/runtime or an explicit new launch', async () => {
  for (const change of [
    proof => { proof.pids = [43]; }, proof => { proof.filePath = '/old/file.jsonl'; },
    proof => { proof.terminalToken = {}; }, proof => { proof.runSeq = 2; },
    proof => { proof.lifecycleGeneration = 'old'; }, proof => { proof.sessionId = 'old-session'; },
    proof => { proof.kind = 'native-rewind'; },
  ]) {
    const h = harness(); h.context.codexLastRunCommandPayload.delete(h.tabId);
    const proof = h.context.codexWriterProofs.get(h.tabId);
    proof.valid = false; proof.invalidatedReason = 'process-proof-unknown'; change(proof);
    assert.equal((await h.observe('send-target-revalidation')).available, true);
    assert.notEqual(h.context.getCodexWriterProofSnapshot(h.tabId).launchId, h.launch.launchId);
  }
  const h = harness(); h.context.codexLastRunCommandPayload.delete(h.tabId);
  Object.assign(h.context.codexWriterProofs.get(h.tabId), { valid: false, invalidatedReason: 'process-proof-unknown' });
  h.context.codexSessionDiscoveryIntents.set(h.tabId, { launchId: 'explicit-new-launch' });
  assert.equal((await h.observe('send-target-revalidation')).available, true);
  assert.equal(h.context.getCodexWriterProofSnapshot(h.tabId).launchId, 'explicit-new-launch');
});
