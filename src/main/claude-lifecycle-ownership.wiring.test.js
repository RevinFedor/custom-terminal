'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { proveEmptyClaudeRestore, isEmptyClaudeRestoreCurrent } = require('./claude-empty-restore');
const { evaluateClaudeFreshStartAdmission } = require('./claude-fresh-start-admission');
const { shouldClearClaudeShellLaunchOnCommandFinished } = require('./ai-shell-launch');
const { EventEmitter } = require('node:events');
const { createClaudeTurnInterrupt } = require('./claude-turn-interrupt');
const { projectClaudePtyPresence } = require('./claude-pty-presence');
const { TaskCompletionIntentRegistry } = require('./task-completion-intent');
const { waitForAgentReadyTransition, READINESS_CHANGED_EVENT } = require('./agent-ready-wait');

const main = fs.readFileSync(require.resolve('./main.js'), 'utf8');
function take(first, next) {
  const start = main.indexOf(first);
  const end = main.indexOf(next, start + first.length);
  assert.ok(start >= 0 && end > start, `actual main markers: ${first} -> ${next}`);
  return main.slice(start, end);
}
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const noop = () => {};
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, handler) => {
    assert.equal(handlers.has(channel), false, `duplicate handler ${channel}`);
    handlers.set(channel, handler);
  };
  const writes = [];
  const secondary = [];
  const terminal = { write: data => writes.push({ terminal: 'A', data }) };
  let interruptClockAt = 10_000;
  const context = {
    assertKnownEmptySend: () => null,
    crypto, ipcMain, projectClaudePtyPresence, waitForAgentReadyTransition,
    proveEmptyClaudeRestore, isEmptyClaudeRestoreCurrent, evaluateClaudeFreshStartAdmission,
    createClaudeTurnInterrupt: options => createClaudeTurnInterrupt({ ...options, now: () => interruptClockAt }),
    console: { log() {}, warn() {}, error() {} },
    mainWindow: null,
    terminals: new Map([['T', terminal]]),
    terminalCommandState: new Map([['T', { runSeq: 1, isRunning: false }]]),
    terminalProjects: new Map([['T', '/fixture']]),
    terminalProjectIds: new Map([['T', 'fixture-project']]),
    codexLastRunCommandPayload: new Map(),
    terminalLifecycleEpochs: new WeakMap(),
    bridgePidCache: new Map(),
    taskCompletionIntents: new TaskCompletionIntentRegistry(),
    claudeLaunchGenerationSeq: 0,
    claudeStartupProofSession: { cancel: noop },
    aiBoundaryTestGate: { cancelMatching: noop },
    claudePromptStability: { open: noop, clear: noop },
    claudeStartupMainRuntime: { clear: noop },
    clearClaudePtyCompactProofAttempt: noop,
    clearTerminalCommandOrigin: noop,
    resolveAiToolTypeForTab: (_tabId, toolType) => toolType || 'claude',
    getAiRuntimeSessionId: () => 'source',
    broadcastAiRuntimeStatus: noop,
    _webBroadcast: noop,
    bumpTerminalInputRevision: () => secondary.push('input-revision'),
    recordComposerForensicPtyInput: () => secondary.push('input-forensics'),
    notifyTerminalEscapeWritten: noop,
    cancelClaudeLocalCommandFromInput: (_tabId, data) => secondary.push('cancel-local:' + data),
    armInterruptIdleProbe: () => secondary.push('arm-idle-probe'),
    // The OS proof must retire with this fixture's process. Always returning
    // found after clearLaunch would now truthfully keep readiness unresolved.
    resolveTerminalCommandState: async () => ({ expectedProcess: 'claude',
      providerProcessAlive: context.claudeLaunchGenerationByTab.has('T')
        || context.claudeCliActive.get('T') === true || context.bridgeKnownSessions.has('T') }),
    projectManager: { db: { db: { prepare: () => ({ get: () => ({ claude_session_id: 'source', cwd: '/fixture' }) }) } } },
    getSessionMaterialization: () => ({ materialized: true, timelineCount: 1 }),
    historyPresenceTestGate: { waitIfArmed: async () => {} },
    proveIdleShellForAgentLaunch: async () => ({ allowed: true }),
    writeAgentLaunchCommandToIdleShell: (target, options) => target.write(options.command + '\r'),
    getClaudeJsonlLiveOwner: () => null,
    getClaudeJsonlExternalOwner: async () => null,
    markClaudePendingJsonlOwner: () => true,
    reportTerminalIncident: async () => assert.fail('deterministic wake must not time out'),
    runKeyedExclusive: async (_map, _key, task) => task(),
    aiLifecycleActionInflight: new Map(),
    claudeResumePreparationInflight: new Map(),
    admitAiLifecycleLaunch: async () => ({ allowed: true }),
    prepareClaudeJsonlBeforeResume: async () => ({ success: true, trimmed: 0 }),
    agentLaunchPreparations: { begin: () => ({ token: 1 }), update: noop, finish: noop },
    findSessionFile: () => null,
    getPersistedAiSessionBindingForShutdown: () => ({ claude_session_id: 'source' }),
  };
  for (const name of [
    'claudeTurnBusy', 'codexTurnWatchers', 'claudeLaunchGenerationByTab', 'claudePreclaimedCommandGenerations', 'aiStoppingTabs',
    'claudeStartupDefaultsGateByTab', 'bridgeKnownSessions', 'claudeLocalCommandWatchers',
    'claudeCliActive', 'claudeAwaitingInput', 'claudeStartupIntents', 'claudeStartupIntentUseByTab',
    'claudePendingPromptDispatchers', 'claudeTrustFolderPromptHintTabs', 'claudeTrustFolderPromptHintBuffers',
    'claudeTrustFolderPromptFired', 'claudeTrustFolderPromptInflight', 'claudeAutoModeDefaultPromptHintTabs',
    'claudeAutoModeDefaultPromptHintBuffers', 'claudeState', 'claudePendingPrompt',
  ]) context[name] = new Map();
  context.claudePromptReady = new Set();
  vm.createContext(context);
  vm.runInContext([
    take('const pasteInflight = new WeakMap();', 'function markActivePtySubmit('),
    take('function getTerminalLifecycleGeneration(', 'function normalizeRememberedShellCommand('),
    take('function captureAiProcessLookupScope(', 'function invalidateAiProcessLookupCache('),
    take('function findClaudePidByTab(', 'async function prebindClaudeHookRouteForSubmit('),
    take('function readAgentSendDestinationAtWriteBoundary(', 'function agentSendRequestExpectedTargets('),
    take('function getActiveAgentExecutionContext(', 'function emitClaudeAbnormalTurnEnd('),
    take('function emitAgentReadinessChanged(', 'function publishClaudeStartupDefaultsGate('),
    take('function markAiStopping(', 'function exactShutdownCandidatesForTab('),
    take('function beginClaudeLaunchGeneration(', 'function readClaudeStartupIntent('),
    take('function markClaudeShellLaunchStarted(', 'function rollbackClaudeShellLaunchClaims('),
    take('function validateClaudeSavedHistoryLaunch(', 'async function writeClaudeSavedHistoryResume('),
    take('function currentClaudeStartupDefaultsGate(', '// Operational phases are runtime facts'),
    take('async function readMainAgentStartReadiness(', 'async function readMainAgentStartReadinessForTab('),
    take('const interruptClaudeTurnAtBoundary = createClaudeTurnInterrupt(', 'const interruptCodexTurnAtBoundary = createCodexTurnInterrupt('),
    take('async function runClaudeCommandFromPayload(', 'async function runClaudeCommandSerialized('),
    take('async function runClaudeCommandSerialized(', "ipcMain.on('claude:run-command'"),
  ].join('\n'), context);
  const invoke = (channel, ...args) => {
    assert.ok(handlers.has(channel), `main handler exists: ${channel}`);
    return handlers.get(channel)({}, ...args);
  };
  const startTurn = (sessionId = 'source', processId = '100') => {
    context.claudeTurnBusy.set('T', true);
    return context.taskCompletionIntents.beginTurn({ tabId: 'T', provider: 'claude', sessionId, processId });
  };
  const ready = (launchId, sessionId = 'source') => {
    context.bridgeKnownSessions.set('T', sessionId);
    context.claudeCliActive.set('T', true);
    context.claudePromptReady.add('T');
    context.claudeStartupDefaultsGateByTab.set('T', { generation: launchId, status: 'ready' });
    context.emitAgentReadinessChanged('T', { status: 'ready', reason: 'test-same-launch-ready' });
  };
  return { context, invoke, writes, secondary, terminal, startTurn, ready,
    advanceInterruptTime: ms => { interruptClockAt += ms; } };
}

test('actual AutoResume reopens proven empty history without --resume and waits for its fresh UUID', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-empty-auto-restore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'source.jsonl');
  const metadata = [{ type: 'mode', mode: 'normal', sessionId: 'source' },
    { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'source' }];
  const startup = ['model', 'effort'].flatMap((command, i) => [
    { type: 'user', uuid: 'caveat-' + i, message: { content: '<local-command-caveat>local only</local-command-caveat>' } },
    { type: 'user', uuid: 'wrapper-' + i, message: { content: '<command-name>/' + command + '</command-name>' } },
    { type: 'user', uuid: 'stdout-' + i, message: { content: command === 'model'
      ? '<local-command-stdout>Set model to Opus</local-command-stdout>'
      : '<local-command-stdout>Set effort level to max</local-command-stdout>' } },
    { type: 'assistant', uuid: 'ack-' + i, message: { content: 'No response requested.' } },
  ]);
  fs.writeFileSync(filePath, [...metadata, ...startup].map(JSON.stringify).join('\n') + '\n');
  const h = harness();
  const dataSource = fs.readFileSync(require.resolve('./ipc/claude-data'), 'utf8');
  const trimStart = dataSource.indexOf('function _trimTrailingStartupSlashEntriesFromFile(');
  const trimEnd = dataSource.indexOf('function _trimTrailingEffortEntries(', trimStart);
  const trimContext = { fs, Buffer, STARTUP_SLASH_TRIM_TAIL_BYTES: 512 * 1024,
    invalidateClaudeJsonlCache: noop, console: h.context.console };
  vm.createContext(trimContext);
  vm.runInContext(dataSource.slice(trimStart, trimEnd), trimContext);
  h.context.prepareClaudeJsonlBeforeResume = async () => {
    const result = trimContext._trimTrailingStartupSlashEntriesFromFile(filePath, 'source');
    assert.equal(result.trimmed, 8, 'the actual repair removes the same eight startup lines');
    return result;
  };
  h.context.findSessionFile = () => ({ filePath });
  h.context.getSessionMaterialization = () => ({ success: true, materialized: false, reason: 'timeline-empty' });
  const result = await h.context.runClaudeCommandSerialized({}, {
    tabId: 'T', command: 'claude-c', sessionId: 'source', launchSource: 'auto-resume',
  });
  assert.equal(result.accepted, true);
  assert.equal(result.command, 'claude');
  assert.equal(result.restoredEmptySessionId, 'source');
  assert.equal(result.sessionId, null);
  assert.deepEqual(fs.readFileSync(filePath, 'utf8').trim().split('\n').map(JSON.parse), metadata);
  assert.deepEqual(h.writes, [{ terminal: 'A', data: 'claude --dangerously-skip-permissions\r' }]);
  const waiting = h.invoke('agent:wait-start-ready', {
    tabId: 'T', toolType: 'claude', expectedOwner: { launchId: result.launchId },
  });
  await tick();
  h.ready(result.launchId, 'new-empty-runtime-id');
  assert.equal((await waiting).ready, true);
});

for (const variant of ['real-history', 'missing-file', 'manual-resume', 'failed-proof']) {
  test('actual restore keeps Resume for ' + variant, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-empty-auto-control-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const filePath = path.join(root, 'source.jsonl');
    if (variant !== 'missing-file') fs.writeFileSync(filePath, variant === 'real-history'
      ? JSON.stringify({ type: 'user', uuid: 'u', message: { content: 'keep conversation' } })
      : variant === 'failed-proof' ? '{broken' : '');
    const h = harness();
    h.context.findSessionFile = () => ({ filePath });
    const result = await h.context.runClaudeCommandSerialized({}, {
      tabId: 'T', command: 'claude-c', sessionId: 'source',
      launchSource: variant === 'manual-resume' ? 'manual' : 'auto-resume',
    });
    assert.equal(result.accepted, true);
    assert.equal(result.command, 'claude-c');
    assert.equal(result.restoredEmptySessionId, undefined);
    assert.match(h.writes[0].data, /--resume source/);
  });
}

test('actual empty restore refuses a file change while awaiting its shell boundary', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-empty-auto-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'source.jsonl');
  fs.writeFileSync(filePath, '');
  const h = harness();
  h.context.findSessionFile = () => ({ filePath });
  h.context.getSessionMaterialization = () => ({ success: true, materialized: false });
  h.context.proveIdleShellForAgentLaunch = async () => {
    fs.appendFileSync(filePath, JSON.stringify({ type: 'user', uuid: 'u', message: { content: 'new user' } }) + '\n');
    return { allowed: true };
  };
  const result = await h.context.runClaudeCommandSerialized({}, {
    tabId: 'T', command: 'claude-c', sessionId: 'source', launchSource: 'auto-resume',
  });
  assert.equal(result.accepted, false);
  assert.equal(result.error, 'claude_empty_restore_changed');
  assert.deepEqual(h.writes, []);
});

test('actual managed startup exit wakes readiness before timeout even while WAITING_PROMPT', async () => {
  const h = harness();
  const launchId = h.context.markClaudeShellLaunchStarted('T', 'source');
  const waiting = h.invoke('agent:wait-start-ready', { tabId: 'T', toolType: 'claude', expectedOwner: { launchId } });
  await tick();
  assert.equal(shouldClearClaudeShellLaunchOnCommandFinished({
    hasClaudeState: true, hasPendingPrompt: false, startupIntentReason: 'claude-run-command-resume',
    sawOscCommandStart: true, sameTerminal: true,
  }).clear, true);
  h.context.claudeStartupIntents.delete('T');
  h.context.claudeCliActive.delete('T');
  h.context.clearClaudeLaunchGeneration('T', 'command-finished-no-bridge');
  const result = await waiting;
  assert.equal(result.error, 'agent_ready_owner_changed');
  assert.equal(result.ready, false);
});

test('actual Claude presence separates live send destination from the saved materialization session', async () => {
  const h = harness();
  h.context.terminalCommandState.get('T').isRunning = true;
  h.context.bridgeKnownSessions.set('T', 'live-writer-B');
  h.context.claudeCliActive.set('T', true);
  h.context.claudePromptReady.add('T');
  const presence = await h.invoke('claude:get-presence', 'T');
  assert.equal(presence.sessionId, 'source', 'existing history/materialization projection is unchanged');
  assert.equal(presence.sendTarget.sessionId, 'live-writer-B', 'send preparation must see the actual current destination');
  assert.equal(presence.sendTarget.toolType, 'claude');
});

test('actual main Claude interrupt handler uses the shared queue and preserves request-side cleanup', async () => {
  const h = harness();
  h.context.beginClaudeLaunchGeneration('T', '100');
  assert.equal((await h.invoke('claude:interrupt-turn', 'T')).skipped, 'idle-composer');
  h.startTurn();
  const gate = deferred();
  const firstWriter = h.context.withPtyWriteLock(h.terminal, () => gate.promise, { kind: 'safe-paste' });
  let settled = false;
  const waiting = h.invoke('claude:interrupt-turn', 'T').then(result => { settled = true; return result; });
  await tick();
  assert.equal(settled, false);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.secondary, []);
  gate.resolve();
  await firstWriter;
  const result = await waiting;
  assert.equal(result.interruptRequested, true);
  assert.equal(result.interrupted, true);
  assert.equal(result.interruptConfirmed, false);
  assert.deepEqual(h.writes, [{ terminal: 'A', data: '\x1b' }]);
  assert.deepEqual(h.secondary, ['input-revision', 'input-forensics', 'cancel-local:\x1b', 'arm-idle-probe']);
  assert.equal((await h.invoke('claude:interrupt-turn', 'T')).skipped, 'interrupt-already-requested');
  assert.equal(h.writes.length, 1);
});

test('actual main permits a new explicit same-turn Claude retry after 700ms but not after the turn ended', async () => {
  const h = harness();
  h.context.beginClaudeLaunchGeneration('T', '100');
  h.startTurn();
  assert.equal((await h.invoke('claude:interrupt-turn', 'T')).interruptRequested, true);
  h.advanceInterruptTime(699);
  assert.equal((await h.invoke('claude:interrupt-turn', 'T')).skipped, 'interrupt-already-requested');
  h.advanceInterruptTime(1);
  assert.equal((await h.invoke('claude:interrupt-turn', 'T')).interruptRequested, true);
  assert.equal(h.writes.length, 2);
  h.advanceInterruptTime(700);
  h.context.claudeTurnBusy.set('T', false);
  assert.equal((await h.invoke('claude:interrupt-turn', 'T')).skipped, 'idle-composer');
  assert.equal(h.writes.length, 2);
});

test('actual main still interrupts its exact /compact operation without requiring a provider turn', async () => {
  const h = harness();
  const launchId = h.context.beginClaudeLaunchGeneration('T', '100');
  h.context.bridgeKnownSessions.set('T', 'source');
  h.context.claudeLocalCommandWatchers.set('T', {
    command: '/compact', operationId: 'compact-1',
    owner: { terminal: h.terminal, generation: launchId, sessionId: 'source', inputRevision: 10 },
  });
  h.context.getTerminalInputRevision = () => 99; // Typing does not revoke cancellation of that same command.
  assert.equal(h.context.getClaudePtyRuntimePresence('T').isBusy, true);
  const result = await h.invoke('claude:interrupt-turn', 'T');
  assert.equal(result.interruptRequested, true);
  assert.equal(result.turnId, 'local-command:compact-1');
  assert.equal(result.interrupted, true);
  assert.equal(result.interruptConfirmed, false);
  assert.deepEqual(h.writes, [{ terminal: 'A', data: '\x1b' }]);
  assert.ok(h.secondary.includes('cancel-local:\x1b'));
});

for (const replacement of ['operation', 'terminal', 'launch', 'session', 'provider-turn']) {
  test(`actual main queued /compact interrupt cannot cross its ${replacement} identity`, async () => {
    const h = harness();
    const launchId = h.context.beginClaudeLaunchGeneration('T', '100');
    h.context.bridgeKnownSessions.set('T', 'source');
    const command = { command: '/compact', operationId: 'compact-1',
      owner: { terminal: h.terminal, generation: launchId, sessionId: 'source' } };
    h.context.claudeLocalCommandWatchers.set('T', command);
    const gate = deferred();
    const first = h.context.withPtyWriteLock(h.terminal, () => gate.promise, { kind: 'safe-paste' });
    const waiting = h.invoke('claude:interrupt-turn', 'T');
    await tick();
    if (replacement === 'operation') h.context.claudeLocalCommandWatchers.set('T', { ...command, operationId: 'compact-2' });
    if (replacement === 'terminal') command.owner.terminal = {};
    if (replacement === 'launch') command.owner.generation = 'other-launch';
    if (replacement === 'session') command.owner.sessionId = 'other-session';
    if (replacement === 'provider-turn') h.startTurn();
    gate.resolve(); await first;
    const result = await waiting;
    assert.equal(result.interruptRequested, false);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.secondary, []);
  });
}

for (const replacement of ['terminal', 'turn', 'launch', 'process', 'stop']) {
  test(`actual main queued Claude interrupt rejects ${replacement} replacement before its write`, async () => {
    const h = harness();
    h.context.beginClaudeLaunchGeneration('T', '100');
    h.startTurn();
    const gate = deferred();
    const first = h.context.withPtyWriteLock(h.terminal, () => gate.promise, { kind: 'safe-paste' });
    const waiting = h.invoke('claude:interrupt-turn', 'T');
    await tick();
    if (replacement === 'terminal') h.context.terminals.set('T', { write: data => h.writes.push({ terminal: 'B', data }) });
    if (replacement === 'turn') h.startTurn();
    if (replacement === 'process') h.startTurn('source', '200');
    if (replacement === 'launch') h.context.beginClaudeLaunchGeneration('T', '200');
    if (replacement === 'stop') h.context.markAiStopping('T', 'claude');
    gate.resolve(); await first;
    const result = await waiting;
    assert.equal(result.interruptRequested, false);
    assert.equal(result.interrupted, false);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.secondary, []);
  });
}

for (const command of ['claude', 'claude-c']) {
  test(`actual main ${command} admission, presence and late readiness share one launch`, async () => {
    const h = harness();
    const launch = await h.context.runClaudeCommandFromPayload({}, {
      tabId: 'T', command, sessionId: command === 'claude-c' ? 'source' : null,
      allowNewOverExisting: true,
    }, { resumeJsonlPrepared: true });
    assert.equal(launch.success, true);
    assert.equal(launch.accepted, true);
    assert.ok(launch.launchId);
    assert.equal(launch.launchId, launch.launchGeneration);
    assert.equal(h.context.claudeLaunchGenerationByTab.get('T').generation, launch.launchId);
    const presence = await h.invoke('claude:get-presence', 'T');
    assert.equal(presence.launchId, launch.launchId);
    let settled = false;
    const waiting = h.invoke('agent:wait-start-ready', { tabId: 'T', toolType: 'claude',
      expectedOwner: { launchId: launch.launchId } }).then(result => { settled = true; return result; });
    await tick();
    assert.equal(settled, false);
    h.context.terminalCommandState.get('T').runSeq += 1; // Same launch's first OSC-B.
    h.ready(launch.launchId, 'writer-child');
    const result = await waiting;
    assert.equal(result.ready, true);
    assert.equal(result.status.sessionId, 'writer-child');
    assert.equal(result.status.launchId, launch.launchId);
    assert.equal(h.context.ipcMain.listenerCount(READINESS_CHANGED_EVENT), 0);
  });
}

for (const replacement of ['stop', 'clear', 'another-launch']) {
  test(`actual main ${replacement} transition cannot resolve an older Claude startup`, async () => {
    const h = harness();
    const launchId = h.context.markClaudeShellLaunchStarted('T', 'source');
    const waiting = h.invoke('agent:wait-start-ready', { tabId: 'T', toolType: 'claude',
      expectedOwner: { launchId } });
    await tick();
    if (replacement === 'stop') h.context.markAiStopping('T', 'claude');
    if (replacement === 'clear') {
      h.context.claudeStartupIntents.delete('T');
      h.context.claudeCliActive.delete('T');
      h.context.clearClaudeLaunchGeneration('T', 'test-process-exit');
    }
    if (replacement === 'another-launch') {
      const newLaunchId = h.context.markClaudeShellLaunchStarted('T', 'other');
      h.ready(newLaunchId, 'other');
    }
    const result = await waiting;
    assert.equal(result.success, false);
    assert.equal(result.ready, false);
    assert.equal(result.error, 'agent_ready_owner_changed');
    assert.equal(h.context.ipcMain.listenerCount(READINESS_CHANGED_EVENT), 0);
  });
}
