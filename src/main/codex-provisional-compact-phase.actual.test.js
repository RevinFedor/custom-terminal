'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const moduleRoot = process.env.COMPACT_PHASE_BASELINE || __dirname;
const source = fs.readFileSync(path.join(moduleRoot, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const declarations = new Map(ast.statements.filter(ts.isFunctionDeclaration)
  .map(node => [node.name?.text, node.getText(ast)]));
const registryDeclaration = ast.statements.filter(ts.isVariableStatement)
  .flatMap(node => [...node.declarationList.declarations])
  .find(node => node.name.getText(ast) === 'compactOperations');
const publishOperation = registryDeclaration.initializer.arguments[0].properties
  .find(node => node.name?.getText(ast) === 'publish').initializer.getText(ast);
const { createProviderSemanticShadow } = require(path.join(moduleRoot, 'provider-semantic-shadow.js'));
const compactContract = require(path.join(moduleRoot, 'compact-operation-state.js'));
const providerGuards = require(path.join(moduleRoot, 'codex-provider-preview.js'));
const turnOutcomes = require(path.join(moduleRoot, 'codex-turn-outcome.js'));
const promptAudit = require(path.join(moduleRoot, 'codex-prompt-audit.js'));
const { createTerminalShellReadinessTracker } = require('./terminal-shell-readiness.cjs');
const { EventEmitter } = require('node:events');
const noop = () => {};

function fixture({ writerSessionId = null, withWatcher = true, sourceId = 'SOURCE' } = {}) {
  let now = 1000;
  const writes = [];
  const terminal = { pid: 10, write: bytes => writes.push(bytes) };
  const publications = [], activity = [], previews = [], logs = [], ipc = [], web = [];
  const ipcEmitter = new EventEmitter();
  const registry = compactContract.createCompactOperationRegistry({
    now: () => now, publish: operation => { publications.push(operation); context.publishCompactOperation(operation); },
  });
  const owner = { sourceId, launchId: 'L', terminalToken: terminal,
    runSeq: 1, lifecycleGeneration: 'G', turnActive: true, turnId: 'TURN', threadId: 'S' };
  const watcher = { tabId: 'T', sessionId: 'S', processGeneration: 'G',
    filePath: '/fixture/rollout.jsonl', offset: 100, eventSequence: 2,
    sourceObservationTerminal: terminal, sourceObservationRunSeq: 1, sourceObservationLaunchId: 'L',
    busy: true, currentTurnId: 'TURN', lastEventType: 'task_started' };
  const stat = { size: 100, dev: 11, ino: 12, isFile: () => true };
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } }, WeakRef, Buffer, path, srcMainDir: __dirname,
    clearTimeout, clearInterval,
    console: { log: value => logs.push(value), warn: value => logs.push(value), error: value => logs.push(value) },
    fs: { statSync: () => { if (context.statError) throw Error('fixture-stat-unavailable'); return { ...stat }; } },
    require: modulePath => {
      assert.equal(modulePath, path.join(__dirname, 'web-server'));
      return { needsMessageReturnProof: () => false };
    },
    codexCanonicalPresentation: null,
    terminals: new Map([['T', terminal]]), terminalCommandState: new Map([['T', { runSeq: 1 }]]),
    codexLastRunCommandPayload: new Map([['T', { launchId: 'L' }]]),
    codexProviderSemanticSources: new Map([['T', owner]]),
    codexTurnWatchers: withWatcher ? new Map([['T', watcher]]) : new Map(),
    codexPromptGeneration: new Map([['T', 1]]), codexPromptInFlight: new Map(),
    CODEX_PROMPT_IN_FLIGHT_TTL_MS: 60000,
    clearCodexPromptInFlight: tabId => context.codexPromptInFlight.delete(tabId),
    aiStoppingTabs: new Map(), terminalStopRevisions: new WeakMap(),
    compactOperations: registry, ...providerGuards, ...compactContract, ...turnOutcomes, ...promptAudit,
    getTerminalLifecycleGeneration: () => context.generation,
    getTerminalStopRevision: () => context.stopRevision,
    getCodexWriterProofSnapshot: () => context.writerSessionId ? {
      sessionId: context.writerSessionId, filePath: watcher.filePath,
      terminalToken: terminal, runSeq: 1, lifecycleGeneration: 'G', launchId: 'L', actionGeneration: 'L',
      ...context.writerPatch,
    } : null,
    // No startup/ready authority is invented: the fixture has a real active
    // causal turn in the provider owner, and the actual admission helper reads it.
    isCodexStartupLifecycleFresh: () => false,
    terminalHistoryPreviewController: { observeSemanticEvent: detail => { previews.push(detail); return true; },
      clearSemanticSource: noop, expectSemanticSource: noop, activateSemanticSource: noop },
    publishCodexProviderTurnActivity: detail => {
      activity.push(detail); owner.turnActive = detail.active; owner.turnId = detail.turnId; owner.phase = detail.phase;
    },
    // These are unrelated decoration/publication leaves of the actual line
    // consumer. None can bind a compact, supply a writer, or settle a phase.
    mainWindow: { isDestroyed: () => false, webContents: { send: (channel, detail) => {
      ipc.push({ channel, detail }); ipcEmitter.emit(channel, null, detail);
    } } },
    compactOperationSubscribers: new Set(),
    _webBroadcast: (_tabId, detail) => web.push(detail), scheduleProjectActivityBroadcast: noop, recordActivity: noop,
    codexNativeQuestionMirror: { observeRecord: noop },
    recordCodexLiveSubagentOwnership: noop, trackCodexTabSubagentActivity: noop,
    observeCodexPromptAuditCarrier: noop, observeCodexCapacityRetryRecord: noop,
    buildCodexLiveRawMessage: () => null, buildCodexHistoryLiveCompactEntry: () => null,
    reconcileCodexManualCompactPendingOwner: () => null,
  });
  Object.defineProperty(context, 'stopRevision', { get: () => context.terminalStopRevisions.get(terminal) || 0,
    set: value => context.terminalStopRevisions.set(terminal, value) });
  context.generation = 'G'; context.stopRevision = 0; context.writerSessionId = writerSessionId;
  const names = ['currentCodexProviderSemanticOwnerContext', 'codexProviderRequestCausalTurnSnapshot',
    'authorizeCodexProviderMainRequest', 'captureCodexManualCompactBoundary',
    'captureCodexProviderCompactionBoundary',
    'observeCodexProviderCompactionPhase', 'readCodexProviderCompactionEvidence', 'bindCodexProviderCompactionEvidence',
    'observeCodexProviderCompactionLifecycle', 'processCodexSourceAuditOnlyText',
    'finishCodexProviderCompactionObservation', 'handleCodexProviderSemanticEvent',
    'getTerminalStopRevision', 'armCodexProviderSemanticSource', 'disarmCodexProviderSemanticSource', 'persistCompactSendReceipt',
    'codexEventType', 'codexLiveSourceIdentity', 'processCodexTurnLine'];
  vm.runInContext(names.filter(name => declarations.has(name)).map(name => declarations.get(name)).join('\n'), context);
  vm.runInContext('globalThis.publishCompactOperation = ' + publishOperation + ';', context);
  const shadow = createProviderSemanticShadow({ now: () => now,
    log: { log: value => logs.push(value), warn: value => logs.push(value) },
    authorizeCodexMainRequest: context.authorizeCodexProviderMainRequest,
    onCodexSemanticEvent: context.handleCodexProviderSemanticEvent,
  });
  const connection = shadow.createCodexConnection({ tabId: 'T', sourceId });
  const request = (requestKind = 'compaction', options = {}) => {
    const target = options.connection || connection;
    return target.beginRequest({ type: 'response.create', client_metadata: {
      'x-codex-turn-metadata': JSON.stringify({ session_id: options.sessionId || 'S',
        thread_id: options.threadId || 'S', turn_id: options.turnId || 'TURN', request_kind: requestKind }),
    } });
  };
  const event = (value, incomingSourceId = sourceId) => context.handleCodexProviderSemanticEvent({
    tabId: 'T', sourceId: incomingSourceId, event: { sessionId: 'S', threadId: 'S', turnId: 'TURN',
      requestKind: 'compaction', requestId: 'direct-request', observedAt: now, ...value },
  });
  const processRecord = (record, offset = 100, state = watcher) => context.processCodexTurnLine(state,
    JSON.stringify(record), offset);
  const compacted = (offset = 100, state = watcher) => processRecord({ type: 'compacted',
    timestamp: '2026-10-29T07:00:00.000Z', payload: { message: 'finite synthetic capsule' } }, offset, state);
  const auditBytes = (bytes, offset = 100, state = watcher) => {
    state.offset = offset + Buffer.byteLength(bytes); stat.size = Math.max(stat.size, state.offset);
    context.processCodexSourceAuditOnlyText(state, bytes, offset);
  };
  const auditRecord = (record, offset = 100, state = watcher) => auditBytes(Buffer.from(JSON.stringify(record) + '\n'), offset, state);
  return { context, registry, owner, watcher, terminal, shadow, connection, request, event,
    stat, writes, processRecord, compacted, auditBytes, auditRecord, publications, activity, previews, logs, ipc, web, ipcEmitter,
    now: value => { now = value; } };
}

function historyConsumer(h) {
  const filePath = path.resolve(moduleRoot, '../renderer/components/Workspace/HistoryPanel.tsx');
  const historySource = fs.readFileSync(filePath, 'utf8');
  const historyAst = ts.createSourceFile(filePath, historySource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(historyAst) === 'useEffect'
      && node.arguments[0]?.getText(historyAst).includes("ipcRenderer.on('agent:operational-phase'")) effect = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(historyAst); assert.ok(effect, 'actual History compact phase effect');
  let current = null;
  const removals = [], errors = [];
  const context = vm.createContext({ tabId: 'T', toolType: 'codex', console: h.context.console,
    setCompactOperationalPhase: value => { current = typeof value === 'function' ? value(current) : value; },
    appendCompactErrorEntry: operation => errors.push(operation),
    removeLocalPromptEntry: (...args) => removals.push(args), consumeHistoryPromptHandoff: noop,
    ipcRenderer: { on: (...args) => h.ipcEmitter.on(...args), removeListener: (...args) => h.ipcEmitter.removeListener(...args),
      invoke: async () => h.registry.snapshot('T', 'codex') },
  });
  const code = ts.transpileModule('(' + effect.getText(historyAst) + ')', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const cleanup = vm.runInContext(code, context)();
  return { current: () => current, removals, errors, cleanup };
}

function stopFixture({ withWatcher = true, lookup = 'found', exited = true, rootAlive = true } = {}) {
  const h = fixture({ withWatcher });
  const effects = [];
  Object.assign(h.context, {
    // OS/process-tree leaves are finite controlled verdicts. Main's actual
    // Stop, Stop revision, admission and finalization bodies remain intact.
    AI_PROCESS_LOOKUP_STATUS: { FOUND: 'found', ABSENT: 'absent', UNKNOWN: 'unknown' },
    inspectAiDescendantProcessesByTab: async (_tab, _tool, options) => {
      options.onSnapshot({ children: new Map() });
      return { status: lookup, matches: lookup === 'found'
        ? [{ pid: 11, ppid: 10, processName: 'codex', depth: 1, cmd: 'codex' }] : [],
      error: lookup === 'unknown' ? Error('fixture-process-inspection-unavailable') : null };
    },
    getProcessTreeSnapshot: async () => ({ children: new Map() }),
    selectAiProcessForStop: matches => matches[0],
    buildAiStopScope: () => ({ rootPid: 11, processGroups: [11], signalPids: [], trackedPids: [11, 12] }),
    waitForAiStopScopeExit: async () => ({ exited, elapsedMs: 0,
      residual: { aliveGroups: exited ? [] : [11], alivePids: exited ? [] : [12] } }),
    signalAiStopScope: (_scope, signal) => {
      effects.push(signal); return { errors: [], signaledGroups: [11], signaledPids: [] };
    },
    isAiStopSignalTargetAlive: () => rootAlive,
    terminalShellReadiness: createTerminalShellReadinessTracker(),
    resolveAiToolTypeForTab: (_tab, tool) => tool || 'codex',
    getAiRuntimeSessionId: () => h.context.writerSessionId,
    codexCapacityRetryRuntime: null, ipcMain: new EventEmitter(),
    captureAgentLaunchFence: () => ({}), broadcastAgentLaunchFenceRevoked: noop,
    revokeCodexActionAuthoritiesForTab: noop,
    resolveActivityIdentity: () => ({ sessionId: h.context.writerSessionId }),
    getAiProcessNameFromCommand: () => 'codex',
    projectManager: null,
    broadcastAiRuntimeStatus: (...args) => effects.push(['runtime-status', ...args]),
    emitAgentReadinessChanged: noop,
    restoreAiRuntimeStatusAfterFailedStop: () => effects.push('failed-stop-status-restored'),
    // Unrelated cleanup effects are recordings; the actual turn-watcher close
    // and compact finalization are executed, rather than fabricated here.
    cancelCodexManualCompactPending: noop,
    retireAgentInputCaptureForProcess: noop, invalidateProcessTreeSnapshot: noop,
    finalizeStoppedAiCommandState: noop, invalidateAiProcessLookupCache: noop,
    invalidateCodexExitObservers: noop, clearCodexLaunchPayload: noop,
    closeCodexWatcher: noop, clearCodexKnownSession: noop, clearCodexTuiReady: noop,
    emitCodexBusy: noop, clearCodexPromptInFlight: noop, getPendingCodexPasteAudits: () => [],
    clearCodexDescendantExitRecheck: noop, clearCodexFinishDebounce: noop, clearTerminalCommandOrigin: noop,
    activityOpenIntervals: new Map(),
  });
  for (const name of ['bridgeKnownSessions', 'codexKnownSessions', 'codexInputLineBuffers',
    'codexCompactTuiFeedbackBuffers', 'claudeTurnBusy', 'claudeSpinnerBusy']) h.context[name] = new Map();
  for (const name of ['claudeCliActive', 'claudePromptReady', 'codexTuiReadyTabs']) h.context[name] = new Set();
  vm.runInContext(['markAiStopping', 'clearAiStopping', 'closeCodexTurnWatcher', 'stopAiProcessInTab', 'finalizeCodexCommandFinished']
    .map(name => declarations.get(name)).join('\n'), h.context);
  return { ...h, effects, stop: () => h.context.stopAiProcessInTab('T', { toolType: 'codex', reason: 'manual-stop' }),
    finishCommand: () => h.context.finalizeCodexCommandFinished('T', 0, 'command-finished') };
}

test('provisional native compact publishes its observed phase before a writer is confirmed', () => {
  const h = fixture(); h.request();
  const active = h.registry.getActive('T', 'codex');
  assert.ok(active, 'exact current provider compact must be visible while writer proof is still absent');
  assert.equal(active.source, 'provider-compaction');
  assert.equal(active.phase, 'compacting');
  assert.equal(active.observationOnly, true);
  assert.equal(active.sessionId, null);
  assert.equal(active.sourceByteOffset, null);
  assert.equal(active.command, null);
  assert.equal(active.handoffId, null);
  assert.equal(active.sendOperationKey, null);
  assert.equal(active.sendAttemptId, null);
  assert.equal(h.activity[0].phase, 'compacting');
  assert.equal(h.activity[0].active, true);
  assert.equal(h.ipc[0].channel, 'agent:operational-phase');
  assert.equal(h.ipc[0].detail.operationId, active.operationId);
  assert.equal(h.web[0].type, 'operational-phase');
});

test('actual Main operational-phase publisher reaches the actual History effect while writer is provisional', async t => {
  const h = fixture(); const history = historyConsumer(h); t.after(history.cleanup);
  await Promise.resolve(); h.request();
  const active = history.current(); assert.ok(active, 'History must receive the compact operation, not only generic busy');
  assert.equal(active.phase, 'compacting'); assert.equal(active.observationOnly, true);
  assert.equal(active.sessionId, null); assert.equal(active.sourceByteOffset, null);
  h.request('turn');
  assert.equal(history.current(), null, 'exact continuation removes only the phase, without a fabricated successful compact');
  assert.deepEqual(history.removals, [], 'phase-only observation has no /compact handoff to consume');
});

test('no watcher is required for early read-only phase, but later attachment cannot invent a pre-request EOF', () => {
  const h = fixture({ withWatcher: false }); h.request();
  assert.equal(h.registry.getActive('T')?.observationOnly, true);
  h.context.codexTurnWatchers.set('T', h.watcher);
  h.context.writerSessionId = 'S'; h.compacted();
  assert.equal(h.registry.getActive('T')?.observationOnly, true);
  assert.equal(h.registry.snapshot('T').settled.length, 0);
});

test('unavailable initial stat preserves the phase but never upgrades a late stat into its boundary', () => {
  const h = fixture(); h.context.statError = true; h.request();
  assert.equal(h.registry.getActive('T')?.observationOnly, true);
  h.context.statError = false; h.context.writerSessionId = 'S'; h.compacted();
  assert.equal(h.registry.getActive('T')?.observationOnly, true);
  assert.equal(h.registry.snapshot('T').settled.length, 0);
});

test('phase-only observation cannot accept canonical or generic successful completion before binding', () => {
  const h = fixture(); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
  const identity = { tabId: 'T', provider: 'codex', operationId: active.operationId, generation: 'G' };
  assert.equal(h.registry.observeCodexEvidence({ ...identity, kind: 'compacted', rolloutOffset: 100 }), null);
  assert.equal(h.registry.finish({ ...identity, outcome: 'completed', reason: 'compacted' }), null);
  h.compacted();
  assert.equal(h.registry.getActive('T')?.operationId, active.operationId);
  assert.equal(h.registry.getActive('T')?.sessionId, null);
  assert.equal(h.registry.snapshot('T').settled.length, 0);
  assert.equal(h.context.writerSessionId, null);
  assert.deepEqual(h.writes, [], 'observing a phase must not write PTY input');
});

test('WebSocket retries and HTTP-SSE fallback keep the original compact operation and causal start', () => {
  const h = fixture(); const first = h.request(); const active = h.registry.getActive('T'); assert.ok(active);
  h.now(2000); const retry = h.request();
  assert.notEqual(first.requestId, retry.requestId);
  const http = h.shadow.createCodexConnection({ tabId: 'T', sourceId: 'SOURCE', transport: 'http-sse' });
  h.now(3000); h.request('compaction', { connection: http });
  assert.equal(h.registry.getActive('T').operationId, active.operationId);
  assert.equal(h.registry.getActive('T').startedAt, 1000);
  assert.equal(h.registry.getActive('T').providerRequestId, first.requestId);
  assert.equal(h.registry.snapshot('T').settled.length, 0);
});

test('response completion, transport close and semantic turn_completed do not settle compact or whole-turn busy', () => {
  const h = fixture(); const request = h.request(); const active = h.registry.getActive('T'); assert.ok(active);
  h.connection.observeServerFrame(JSON.stringify({ type: 'response.completed', response: { id: 'R', output: [] } }));
  h.connection.finishAll('transport-closed');
  h.event({ type: 'turn_completed', requestId: request.requestId });
  assert.equal(h.registry.getActive('T').operationId, active.operationId);
  assert.equal(h.registry.snapshot('T').settled.length, 0);
  assert.equal(h.owner.turnActive, true);
  assert.equal(h.activity.filter(detail => detail.active === false).length, 0);
});

for (const mutation of [
  ['terminal', h => h.context.terminals.set('T', {})],
  ['launch', h => h.context.codexLastRunCommandPayload.set('T', { launchId: 'L2' })],
  ['run', h => h.context.terminalCommandState.set('T', { runSeq: 2 })],
  ['lifecycle', h => { h.context.generation = 'G2'; }],
  ['source', h => { h.owner.sourceId = 'SOURCE2'; }],
  ['stopping', h => h.context.aiStoppingTabs.set('T', { toolType: 'codex' })],
]) {
  test('an invalid physical provider owner cannot start a phase: ' + mutation[0], () => {
    const h = fixture(); mutation[1](h); h.request();
    assert.equal(h.registry.getActive('T'), null);
    assert.equal(h.publications.length, 0);
  });
}

test('a known foreign writer is rejected by actual request admission and by the Main phase guard', () => {
  const h = fixture({ writerSessionId: 'FOREIGN' }); const request = h.request();
  assert.equal(request.classification, 'side');
  assert.equal(h.registry.getActive('T'), null);
  h.event({ type: 'turn_started' });
  assert.equal(h.registry.getActive('T'), null);
});

for (const kind of ['turn', 'prewarm', 'recap']) {
  test('non-compaction ' + kind + ' traffic cannot create a compact phase', () => {
    const h = fixture(); h.request(kind);
    assert.equal(h.registry.getActive('T'), null);
    assert.equal(h.publications.length, 0);
  });
}

for (const pending of [false, true]) {
  test('native transport does not replace or promote an explicit /compact ' + (pending ? 'pending intent' : 'active operation'), () => {
    const h = fixture();
    h.registry[pending ? 'armPending' : 'begin']({ tabId: 'T', provider: 'codex', command: '/compact',
      operationId: 'EXPLICIT', sessionId: 'S', generation: 'G', handoffId: 'H', acceptedAt: 500,
      sourceByteOffset: 90 });
    const before = h.registry.snapshot('T');
    const pendingBefore = h.registry.getPending('T'); h.request(); h.request('turn');
    assert.deepEqual(h.registry.snapshot('T'), before);
    assert.deepEqual(h.registry.getPending('T'), pendingBefore);
  });
}

test('only a new exact same-group ordinary request retires an unbound phase, as UNKNOWN rather than success', () => {
  const h = fixture(); const compactRequest = h.request(); const active = h.registry.getActive('T'); assert.ok(active);
  h.event({ type: 'turn_started', requestKind: 'turn', requestId: compactRequest.requestId });
  assert.equal(h.registry.getActive('T').operationId, active.operationId, 'same request is not continuation proof');
  h.now(4000); const continuation = h.request('turn');
  assert.notEqual(continuation.requestId, compactRequest.requestId);
  assert.equal(h.registry.getActive('T'), null);
  const settled = h.registry.snapshot('T').settled[0];
  assert.equal(settled.operationId, active.operationId);
  assert.equal(settled.outcome, 'unknown'); assert.equal(settled.endedAt, 4000);
  assert.equal(h.owner.turnActive, true);
});

for (const wrong of [
  { requestKind: 'prewarm' }, { requestKind: 'recap' },
  { requestKind: 'turn', turnId: 'OTHER-TURN' },
  { requestKind: 'turn', threadId: 'OTHER-THREAD' },
  { requestKind: 'turn', sessionId: 'OTHER-SESSION' },
]) {
  test('non-exact continuation cannot retire phase: ' + JSON.stringify(wrong), () => {
    const h = fixture(); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
    h.event({ type: 'turn_started', requestId: 'new-request', ...wrong });
    assert.equal(h.registry.getActive('T')?.operationId, active.operationId);
    assert.equal(h.registry.snapshot('T').settled.length, 0);
  });
}

test('same-file writer adoption replays compacted from the original EOF and completes without whole-turn end', () => {
  const h = fixture(); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
  h.compacted(100);
  assert.equal(h.registry.getActive('T').observationOnly, true, 'unconfirmed canonical record is not binding proof');
  h.context.writerSessionId = 'S'; h.stat.size = 1000; h.now(5000); h.compacted(100);
  assert.equal(h.registry.getActive('T'), null);
  const settled = h.registry.snapshot('T').settled[0];
  assert.equal(settled.operationId, active.operationId);
  assert.equal(settled.outcome, 'completed'); assert.equal(settled.endedAt, 5000);
  assert.equal(settled.sourceByteOffset, 100, 'late current EOF is not a substitute for the pre-request boundary');
  assert.equal(settled.startedAt, 1000);
  assert.equal(settled.sessionId, 'S'); assert.equal(settled.observationOnly, false);
  assert.equal(h.owner.turnActive, true);
});

for (const [name, mutate, recordOffset] of [
  ['old offset', noop, 99],
  ['file inode replacement', h => { h.stat.ino = 13; }],
  ['file device replacement', h => { h.stat.dev = 13; }],
  ['file path replacement', h => { h.watcher.filePath = '/fixture/replacement.jsonl'; }],
  ['watcher replacement', h => h.context.codexTurnWatchers.set('T', { ...h.watcher })],
  ['source replaced', h => { h.owner.sourceId = 'OTHER-SOURCE'; }],
  ['launch replaced', h => h.context.codexLastRunCommandPayload.set('T', { launchId: 'L2' })],
  ['run replaced', h => h.context.terminalCommandState.set('T', { runSeq: 2 })],
  ['lifecycle replaced', h => { h.context.generation = 'G2'; }],
  ['Stop revision advanced', h => { h.context.stopRevision++; }],
  ['turn changed', h => { h.watcher.currentTurnId = 'OTHER-TURN'; }],
  ['thread changed', h => { h.owner.threadId = 'OTHER-THREAD'; }],
  ['writer physical terminal replaced', h => { h.context.writerPatch = { terminalToken: {} }; }],
  ['writer run replaced', h => { h.context.writerPatch = { runSeq: 2 }; }],
  ['writer generation replaced', h => { h.context.writerPatch = { lifecycleGeneration: 'G2' }; }],
  ['writer launch replaced', h => { h.context.writerPatch = { launchId: 'L2' }; }],
]) {
  test('canonical record cannot bind provisional phase after ' + name, () => {
    const h = fixture(); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
    h.context.writerSessionId = 'S'; mutate(h); h.compacted(recordOffset ?? 100);
    assert.equal(h.registry.getActive('T')?.operationId, active.operationId);
    assert.equal(h.registry.getActive('T')?.observationOnly, true);
    assert.equal(h.registry.snapshot('T').settled.length, 0);
  });
}

test('source to child writer handoff cannot rebase a provisional compact to child bytes', () => {
  const h = fixture(); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
  const child = { ...h.watcher, sessionId: 'CHILD', filePath: '/fixture/child.jsonl', sourceObservationLaunchId: null };
  h.context.codexTurnWatchers.set('T', child);
  h.context.writerSessionId = 'CHILD'; h.context.writerPatch = { filePath: child.filePath };
  h.compacted(100, child);
  assert.equal(h.registry.getActive('T')?.operationId, active.operationId);
  assert.equal(h.registry.getActive('T')?.observationOnly, true);
  assert.equal(h.registry.snapshot('T').settled.length, 0);
});

for (const patch of [
  { providerSourceId: 'OTHER-SOURCE' }, { providerLaunchId: 'OTHER-LAUNCH' }, { providerRunSeq: 2 },
  { providerThreadId: 'OTHER-THREAD' }, { providerObservedSessionId: 'OTHER-SESSION' }, { turnId: 'OTHER-TURN' },
]) {
  test('registry retry cannot inherit another compact group: ' + JSON.stringify(patch), () => {
    const h = fixture(); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
    const observed = h.registry.observeProviderCompaction({ ...active, providerRequestId: 'NEW',
      requestKind: 'compaction', acceptedAt: 5000, ...patch });
    assert.equal(observed, null);
    assert.deepEqual(h.registry.getActive('T'), active);
    assert.equal(h.registry.snapshot('T').settled.length, 0);
  });
}

for (const patch of [
  { providerSourceId: 'OTHER-SOURCE' }, { providerLaunchId: 'OTHER-LAUNCH' }, { providerRunSeq: 2 },
  { providerStopRevision: 2 }, { providerThreadId: 'OTHER-THREAD' }, { turnId: 'OTHER-TURN' },
  { sessionId: 'OTHER-SESSION' }, { operationId: 'OTHER-OPERATION' }, { sourceByteOffset: -1 },
]) {
  test('registry binding rejects a changed pinned owner: ' + JSON.stringify(patch), () => {
    const h = fixture(); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
    assert.equal(h.registry.bindProviderCompaction({ ...active, sessionId: 'S', sourceByteOffset: 100, ...patch }), null);
    assert.deepEqual(h.registry.getActive('T'), active);
  });
}

test('existing source disarm retires phase-only compact without a writer or watcher', () => {
  const h = fixture({ withWatcher: false }); h.request(); assert.ok(h.registry.getActive('T'));
  assert.equal(h.context.disarmCodexProviderSemanticSource('T', 'fixture-release', 'L'), true);
  assert.equal(h.registry.getActive('T'), null);
  assert.equal(h.registry.snapshot('T').settled[0].outcome, 'unknown');
});

for (const withWatcher of [true, false]) {
  for (const lookup of ['found', 'absent']) {
    test('actual successful Stop clears observed compact with ' + lookup + ' process and ' + (withWatcher ? 'watcher' : 'no watcher'), async () => {
      const h = stopFixture({ withWatcher, lookup }); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
      const result = await h.stop(); assert.equal(result.success, true);
      assert.equal(h.registry.getActive('T'), null);
      const settled = h.registry.snapshot('T').settled[0];
      assert.equal(settled.operationId, active.operationId); assert.equal(settled.outcome, 'aborted');
      assert.equal(h.owner.compactObservation, null);
    });
  }
}

test('actual failed Stop preserves observation and old Stop fence blocks canonical binding; exact continuation recovers UNKNOWN', async () => {
  const h = stopFixture({ lookup: 'unknown' }); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
  const result = await h.stop(); assert.equal(result.success, false); assert.equal(result.lookupUnknown, true);
  assert.equal(h.registry.getActive('T')?.operationId, active.operationId);
  assert.equal(h.registry.snapshot('T').settled.length, 0);
  assert.equal(h.context.aiStoppingTabs.has('T'), false);
  assert.ok(h.effects.includes('failed-stop-status-restored'));
  assert.equal(h.context.getTerminalStopRevision('T'), 1);
  h.context.writerSessionId = 'S'; h.compacted();
  assert.equal(h.registry.getActive('T')?.observationOnly, true);
  h.request('turn');
  assert.equal(h.registry.getActive('T'), null);
  assert.equal(h.registry.snapshot('T').settled[0].outcome, 'unknown');
});

for (const rootAlive of [true, false]) {
  test('actual failed Stop with residual owned process scope does not clear compact, rootAlive=' + rootAlive, async () => {
    const h = stopFixture({ exited: false, rootAlive }); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
    const result = await h.stop(); assert.equal(result.success, false); assert.equal(result.error, 'ai_process_tree_residual');
    assert.equal(h.registry.getActive('T')?.operationId, active.operationId);
    assert.equal(h.registry.snapshot('T').settled.length, 0);
  });
}

for (const type of ['task_complete', 'turn_aborted']) {
  test('actual source-audit boundary retires provisional compact as UNKNOWN without writer: ' + type, () => {
    const h = fixture(); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
    h.auditRecord({ type: 'event_msg', payload: { type, turn_id: 'TURN' } });
    assert.equal(h.registry.getActive('T'), null);
    const settled = h.registry.snapshot('T').settled[0];
    assert.equal(settled.operationId, active.operationId); assert.equal(settled.outcome, 'unknown');
    assert.equal(h.context.writerSessionId, null);
    assert.equal(h.owner.compactObservation, null);
    assert.equal(h.owner.turnActive, true, 'phase retirement is not authority to lower whole-turn busy');
    assert.equal(h.activity.length, 1); assert.deepEqual(h.writes, []);
  });
}

test('raw Escape user carrier plus split typed abort uses the existing source-audit reader, without provider traffic or writer', () => {
  const h = fixture(); h.request(); assert.ok(h.registry.getActive('T'));
  const user = Buffer.from(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message',
    message: '<turn_aborted>\nThe user interrupted the previous turn.', turn_id: 'TURN' } }) + '\n');
  const abort = Buffer.from(JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'TURN' } }) + '\n');
  h.context.processCodexUserMessagePasteAudit = () => { throw Error('provider abort marker is not a new user Send'); };
  const split = 19;
  h.auditBytes(Buffer.concat([user, abort.subarray(0, split)]));
  assert.ok(h.registry.getActive('T'), 'a partial typed record cannot retire the phase');
  h.auditBytes(abort.subarray(split), 100 + user.length + split);
  assert.equal(h.registry.getActive('T'), null);
  assert.equal(h.registry.snapshot('T').settled[0].outcome, 'unknown');
  assert.equal(h.context.writerSessionId, null); assert.equal(h.owner.turnActive, true);
  assert.equal(h.previews.length, 1, 'the raw source append does not fabricate another provider segment');
});

test('a genuinely newer task_started retires only the old observation, not turn state or input ownership', () => {
  const h = fixture(); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
  h.auditRecord({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'NEXT-TURN' } });
  assert.equal(h.registry.getActive('T'), null);
  assert.equal(h.registry.snapshot('T').settled[0].outcome, 'unknown');
  assert.equal(h.watcher.currentTurnId, 'TURN'); assert.equal(h.owner.turnId, 'TURN');
  assert.equal(h.owner.turnActive, true); assert.deepEqual(h.writes, []);
});

for (const [name, mutate, type, turnId, offset] of [
  ['same task_started is not newer', noop, 'task_started', 'TURN'],
  ['foreign task_complete', noop, 'task_complete', 'OTHER-TURN'],
  ['foreign turn_aborted', noop, 'turn_aborted', 'OTHER-TURN'],
  ['missing turn ID', noop, 'turn_aborted', null],
  ['old record offset', noop, 'turn_aborted', 'TURN', 99],
  ['file inode replaced', h => { h.stat.ino = 99; }, 'turn_aborted', 'TURN'],
  ['file path replaced', h => { h.watcher.filePath = '/fixture/replaced.jsonl'; }, 'turn_aborted', 'TURN'],
  ['watcher replaced', h => h.context.codexTurnWatchers.set('T', { ...h.watcher }), 'turn_aborted', 'TURN'],
  ['physical source replaced', h => { h.owner.sourceId = 'OTHER-SOURCE'; }, 'turn_aborted', 'TURN'],
  ['launch replaced', h => h.context.codexLastRunCommandPayload.set('T', { launchId: 'L2' }), 'turn_aborted', 'TURN'],
  ['run replaced', h => h.context.terminalCommandState.set('T', { runSeq: 2 }), 'turn_aborted', 'TURN'],
]) {
  test('source-audit lifecycle cannot retire another provisional compact: ' + name, () => {
    const h = fixture(); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
    mutate(h); h.auditRecord({ type: 'event_msg', payload: { type, turn_id: turnId } }, offset ?? 100);
    assert.equal(h.registry.getActive('T')?.operationId, active.operationId);
    assert.equal(h.registry.getActive('T')?.observationOnly, true);
    assert.equal(h.registry.snapshot('T').settled.length, 0);
  });
}

test('child source-audit lifecycle cannot retire the source compact observation', () => {
  const h = fixture(); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
  const child = { ...h.watcher, sessionId: 'CHILD', filePath: '/fixture/child.jsonl' };
  h.context.codexTurnWatchers.set('T', child);
  h.auditRecord({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'TURN' } }, 100, child);
  assert.equal(h.registry.getActive('T')?.operationId, active.operationId);
  assert.equal(h.registry.snapshot('T').settled.length, 0);
});

test('audit-only compacted is not success, and explicit/bound compacts keep their original completion consumer', () => {
  const unbound = fixture(); unbound.request(); const observed = unbound.registry.getActive('T'); assert.ok(observed);
  unbound.auditRecord({ type: 'compacted', payload: { message: 'synthetic compact summary' } });
  assert.equal(unbound.registry.getActive('T')?.operationId, observed.operationId);
  for (const explicit of [true, false]) {
    const h = fixture({ writerSessionId: explicit ? null : 'S' });
    if (explicit) h.registry.begin({ tabId: 'T', provider: 'codex', command: '/compact', operationId: 'EXPLICIT',
      sessionId: 'S', generation: 'G', sourceByteOffset: 90 });
    h.request(); const active = h.registry.getActive('T'); assert.ok(active); assert.notEqual(active.observationOnly, true);
    h.auditRecord({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'TURN' } });
    assert.equal(h.registry.getActive('T')?.operationId, active.operationId);
  }
});

test('matching post-failed-Stop source abort can retire the observation UNKNOWN, without reusing its revoked canonical proof', async () => {
  const h = stopFixture({ lookup: 'unknown' }); h.request(); assert.ok(h.registry.getActive('T'));
  assert.equal((await h.stop()).success, false);
  assert.equal(h.context.getTerminalStopRevision('T'), 1);
  h.auditRecord({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'TURN' } });
  assert.equal(h.registry.getActive('T'), null);
  assert.equal(h.registry.snapshot('T').settled[0].outcome, 'unknown');
  assert.equal(h.context.writerSessionId, null);
});

test('reviewed: a writer proof for another file cannot bind the captured compact boundary', () => {
  const h = fixture(); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
  h.context.writerSessionId = 'S'; h.context.writerPatch = { filePath: '/fixture/other-writer.jsonl' };
  h.compacted();
  assert.equal(h.registry.getActive('T')?.operationId, active.operationId);
  assert.equal(h.registry.getActive('T')?.observationOnly, true);
  assert.equal(h.registry.snapshot('T').settled.length, 0);
});

for (const consumer of ['canonical', 'audit-only']) {
  test('reviewed: an in-place manual binding conflict revokes captured compact evidence for ' + consumer, () => {
    const h = fixture(); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
    h.watcher.manualBindingConflict = { candidateSessionId: 'S', persistedSessionId: 'OTHER' };
    h.context.writerSessionId = 'S';
    if (consumer === 'canonical') h.compacted();
    else h.auditRecord({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'TURN' } });
    assert.equal(h.registry.getActive('T')?.operationId, active.operationId);
    assert.equal(h.registry.getActive('T')?.observationOnly, true);
    assert.equal(h.registry.snapshot('T').settled.length, 0);
  });
}

for (const cause of ['submitted-prompt-in-flight', 'rollout-turn-active']) {
  test('reviewed: actual Main admission carries ' + cause + ' and retires the previous boundaryless compact UNKNOWN', () => {
    const h = fixture({ withWatcher: false }); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
    assert.equal(h.owner.compactObservation.boundary, null);
    if (cause === 'submitted-prompt-in-flight') h.context.codexPromptInFlight.set('T', { startedAt: 1000, submitted: true });
    else h.context.codexTurnWatchers.set('T', { ...h.watcher, currentTurnId: 'NEXT-TURN', lastEventType: 'task_started' });
    const request = h.request('turn', { turnId: 'NEXT-TURN' });
    assert.equal(request.classification, 'main');
    assert.equal(h.previews.at(-1).event.causalTurnReason, cause, 'actual shadow must preserve Main admission provenance');
    assert.equal(h.registry.getActive('T'), null);
    const settled = h.registry.snapshot('T').settled[0];
    assert.equal(settled.operationId, active.operationId); assert.equal(settled.outcome, 'unknown');
    assert.equal(h.owner.compactObservation, null); assert.equal(h.owner.turnActive, true);
  });
}

for (const kind of ['turn', 'recap', 'prewarm']) {
  test('reviewed: raw different-turn ' + kind + ' traffic cannot retire a boundaryless compact', () => {
    const h = fixture({ withWatcher: false }); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
    const request = h.request(kind, { turnId: 'FOREIGN-TURN', threadId: 'FOREIGN-THREAD', sessionId: 'FOREIGN-SESSION' });
    assert.notEqual(request.classification, 'main');
    assert.equal(h.registry.getActive('T')?.operationId, active.operationId);
    assert.equal(h.registry.snapshot('T').settled.length, 0);
  });
}

test('reviewed: even Main-admitted recap cannot retire a compact as a new ordinary turn', () => {
  const h = fixture({ withWatcher: false }); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
  h.context.codexPromptInFlight.set('T', { startedAt: 1000, submitted: true });
  const request = h.request('recap', { turnId: 'NEXT-TURN' }); assert.equal(request.classification, 'main');
  assert.equal(h.registry.getActive('T')?.operationId, active.operationId);
  assert.equal(h.registry.snapshot('T').settled.length, 0);
});

test('reviewed: actual source arm retires the exact old compact before replacing source A with B', () => {
  const h = fixture({ sourceId: 'codex-provider:L' }); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
  h.context.codexLastRunCommandPayload.set('T', { launchId: 'L2' });
  h.context.terminalCommandState.set('T', { runSeq: 2 }); h.context.generation = 'G2';
  assert.equal(h.context.armCodexProviderSemanticSource({ tabId: 'T', launchId: 'L2' }), 'codex-provider:L2');
  assert.equal(h.registry.getActive('T'), null);
  const settled = h.registry.snapshot('T').settled[0];
  assert.equal(settled.operationId, active.operationId); assert.equal(settled.outcome, 'unknown');
  assert.equal(h.context.codexProviderSemanticSources.get('T').sourceId, 'codex-provider:L2');
});

test('reviewed: duplicate source arm for the same physical owner preserves phase and its original private boundary', () => {
  const h = fixture({ sourceId: 'codex-provider:L' }); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
  const proof = h.owner.compactObservation;
  assert.equal(h.context.armCodexProviderSemanticSource({ tabId: 'T', launchId: 'L' }), 'codex-provider:L');
  assert.equal(h.registry.getActive('T')?.operationId, active.operationId);
  assert.equal(h.context.codexProviderSemanticSources.get('T').compactObservation, proof);
  assert.equal(h.registry.snapshot('T').settled.length, 0);
  h.context.writerSessionId = 'S'; h.stat.size = 200; h.compacted();
  assert.equal(h.registry.getActive('T'), null);
  assert.equal(h.registry.snapshot('T').settled[0].outcome, 'completed');
});

test('reviewed: replacing a semantic source does not retire an explicit manual compact', () => {
  const h = fixture({ sourceId: 'codex-provider:L' });
  h.registry.begin({ tabId: 'T', provider: 'codex', command: '/compact', operationId: 'EXPLICIT',
    sessionId: 'S', generation: 'G', sourceByteOffset: 90 });
  h.context.codexLastRunCommandPayload.set('T', { launchId: 'L2' });
  h.context.armCodexProviderSemanticSource({ tabId: 'T', launchId: 'L2' });
  assert.equal(h.registry.getActive('T')?.operationId, 'EXPLICIT');
  assert.equal(h.registry.snapshot('T').settled.length, 0);
});

for (const withWatcher of [true, false]) {
  test('reviewed: actual command-finished finalizer clears provider observation UNKNOWN, watcher=' + withWatcher, () => {
    const h = stopFixture({ withWatcher }); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
    h.finishCommand();
    assert.equal(h.registry.getActive('T'), null);
    const settled = h.registry.snapshot('T').settled[0];
    assert.equal(settled.operationId, active.operationId); assert.equal(settled.outcome, 'unknown');
    assert.equal(h.owner.compactObservation, null);
    assert.equal(h.ipc.at(-1).channel, 'terminal:command-finished');
    assert.equal(h.context.terminalCommandState.get('T').isRunning, false);
  });
}

test('reviewed: residual Stop preserves a provisional compact that already bound but awaits task_complete catch-up', async () => {
  const h = stopFixture({ exited: false, rootAlive: false }); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
  h.context.writerSessionId = 'S'; h.stat.size = 300;
  assert.equal(h.context.bindCodexProviderCompactionEvidence(h.watcher, { type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'TURN' }, __byteOffset: 110 }), true);
  h.registry.observeCodexEvidence({ tabId: 'T', provider: 'codex', operationId: active.operationId,
    sessionId: 'S', generation: 'G', kind: 'task_complete', rolloutOffset: 110, eventSequence: 3 });
  assert.equal(h.registry.getActive('T').observationOnly, false);
  assert.equal(h.registry.getActive('T').codexTaskCompleteOffset, 110);
  const result = await h.stop(); assert.equal(result.success, false); assert.equal(result.error, 'ai_process_tree_residual');
  assert.equal(h.registry.getActive('T')?.operationId, active.operationId);
  assert.equal(h.registry.getActive('T')?.codexTaskCompleteOffset, 110);
  assert.equal(h.registry.snapshot('T').settled.length, 0);
});

test('reviewed: residual Stop preserves existing explicit manual compact cleanup behavior', async () => {
  const h = stopFixture({ exited: false, rootAlive: false });
  h.registry.begin({ tabId: 'T', provider: 'codex', command: '/compact', operationId: 'EXPLICIT',
    sessionId: 'S', generation: 'G', sourceByteOffset: 90 });
  const result = await h.stop(); assert.equal(result.success, false); assert.equal(result.error, 'ai_process_tree_residual');
  assert.equal(h.registry.getActive('T'), null);
  assert.equal(h.registry.snapshot('T').settled[0].outcome, 'aborted');
});

for (const ending of ['successful Stop', 'natural command exit']) {
  for (const hadPhase of [true, false]) {
    for (const withWatcher of [true, false]) {
      test('late-source guard: ' + ending + ' rejects delayed old compaction; phase=' + hadPhase + ', watcher=' + withWatcher, async () => {
        const h = stopFixture({ withWatcher });
        if (hadPhase) h.request();
        if (ending === 'successful Stop') assert.equal((await h.stop()).success, true);
        else h.finishCommand();
        assert.equal(h.registry.getActive('T'), null);
        assert.equal(h.context.aiStoppingTabs.has('T'), false);
        assert.equal(h.context.codexProviderSemanticSources.get('T'), h.owner,
          'the test retains the old physical source to exercise a truly late event at the same run');
        const beforePublications = h.publications.length, beforePreviews = h.previews.length, beforeActivity = h.activity.length;
        const request = h.request();
        assert.equal(request.classification, 'main', 'the actual prior-turn admission is not being artificially disabled');
        assert.equal(h.registry.getActive('T'), null, 'a delayed old-source compaction cannot resurrect the finished phase');
        assert.equal(h.publications.length, beforePublications);
        assert.equal(h.previews.length, beforePreviews); assert.equal(h.activity.length, beforeActivity);
        assert.equal(h.owner.processScopeExited, true);
      });
    }
  }
}

for (const [name, options] of [
  ['unknown process lookup', { lookup: 'unknown' }],
  ['residual live root', { exited: false, rootAlive: true }],
  ['residual descendants after root exit', { exited: false, rootAlive: false }],
]) {
  test('late-source guard: failed Stop leaves source open after ' + name, async () => {
    const h = stopFixture(options); h.request(); const active = h.registry.getActive('T'); assert.ok(active);
    assert.equal((await h.stop()).success, false);
    assert.notEqual(h.owner.processScopeExited, true);
    const beforeActivity = h.activity.length;
    const retry = h.request(); assert.equal(retry.classification, 'main');
    assert.equal(h.registry.getActive('T')?.operationId, active.operationId);
    assert.equal(h.registry.snapshot('T').settled.length, 0);
    assert.equal(h.activity.length, beforeActivity + 1, 'failure must not turn the retained source into a closed process owner');
  });
}

test('late-source guard: a genuinely new arm receives a fresh owner and admits its own compact request', async () => {
  const h = stopFixture({ withWatcher: false }); h.request(); assert.equal((await h.stop()).success, true);
  assert.equal(h.owner.processScopeExited, true);
  h.context.codexLastRunCommandPayload.set('T', { launchId: 'L2' });
  h.context.terminalCommandState.set('T', { runSeq: 2 }); h.context.generation = 'G2';
  const sourceId = h.context.armCodexProviderSemanticSource({ tabId: 'T', launchId: 'L2' });
  const fresh = h.context.codexProviderSemanticSources.get('T');
  assert.notEqual(fresh, h.owner); assert.notEqual(fresh.processScopeExited, true);
  h.context.codexPromptInFlight.set('T', { startedAt: 1000, submitted: true });
  const connection = h.shadow.createCodexConnection({ tabId: 'T', sourceId });
  const request = h.request('compaction', { connection, sessionId: 'NEW-SESSION', threadId: 'NEW-THREAD', turnId: 'NEW-TURN' });
  assert.equal(request.classification, 'main');
  const active = h.registry.getActive('T'); assert.ok(active);
  assert.equal(active.providerSourceId, sourceId); assert.equal(active.providerLaunchId, 'L2');
  assert.equal(active.providerRunSeq, 2); assert.equal(active.generation, 'G2');
  assert.equal(active.observationOnly, true);
});
