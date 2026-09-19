'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { classifyClaudeResumeShellInput } = require('./terminal-shell-command');
const { runKeyedExclusive } = require('./codex-writer-ownership');

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const TAB_ID = 'manual-resume-boundary';
const quiet = { log() {}, warn() {}, error() {} };

function actualFunctions(names) {
  const tree = ts.createSourceFile('main.js', fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'), ts.ScriptTarget.Latest, true);
  return names.map((name) => {
    const node = tree.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert.ok(node, 'actual main.js function exists: ' + name);
    return node.getText(tree);
  }).join('\n');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture({ liveClaude = false, delayedOwner = true } = {}) {
  const writes = [];
  const events = [];
  const externalOwner = deferred();
  const term = { pid: 42, generationToken: 'pty-A', write: (bytes) => {
    const value = String(bytes);
    writes.push(value);
    events.push('pty-write:' + value);
  } };
  const terminals = new Map([[TAB_ID, term]]);
  const terminalCommandState = new Map([[TAB_ID, { isRunning: false, runSeq: 7 }]]);
  const terminalProjects = new Map([[TAB_ID, '/tmp/project-A']]);
  const terminalProjectIds = new Map([[TAB_ID, 'project-A']]);
  const aiStoppingTabs = new Map();
  const bridgeKnownSessions = new Map(liveClaude ? [[TAB_ID, SESSION_ID]] : []);
  const claudePromptReady = new Set();
  const claudeTurnBusy = new Map();
  const claudeSpinnerBusy = new Map();
  const claudeLocalCommandWatchers = new Map();
  const claudeCliActive = new Set(liveClaude ? [TAB_ID] : []);
  const terminalInputLineBuffers = new Map();
  const terminalInputEscapeStates = new Map();
  const codexLateMcpProofPending = new Map();
  const codexTuiReadyTabs = new Set();
  const codexWatchers = new Map();
  const codexTurnWatchers = new Map();
  const codexKnownSessions = new Map();
  const codexLastRunCommandPayload = new Map();
  const codexManualQueueInterrupts = new Map();
  const codexPromptGeneration = new Map();
  const codexStartupPromptAdoptionProbeTabs = new Set();
  const codexStartupAutoEnter = new Map();
  const codexStartupPromptManualOwnershipTabs = new Set();
  const codexImageBindings = { handleTerminalInput() {} };
  const geminiActiveTabs = new Set();
  const geminiSpinnerBusy = new Map();
  const claudeSpinnerIdleTimer = new Map();
  const claudeTurnWatchdog = new Map();
  const claudeSpinnerLastSeenAt = new Map();
  const claudeHookLastEvent = new Map();
  const aiLifecycleActionInflight = new Map();
  const terminalCommandMeta = new Map();
  const ptyLastQueuedWriteOperation = new Map();
  const ptyActiveWriteOperation = new Map();
  const ipcMain = new EventEmitter();
  const claudeLaunchGenerationByTab = new Map();
  let inputRevision = 0;
  let externalOwnerCalls = 0;
  let trimCalls = 0;

  const ctx = vm.createContext({
    console: quiet, Buffer, path, srcMainDir: __dirname, setTimeout, clearTimeout,
    nodePerformance: { now: () => Date.now() }, terminals, terminalCommandState,
    terminalProjects, terminalProjectIds, aiStoppingTabs, bridgeKnownSessions,
    claudePromptReady, claudeTurnBusy, claudeSpinnerBusy, claudeLocalCommandWatchers,
    claudeCliActive, terminalInputLineBuffers, terminalInputEscapeStates,
    codexLateMcpProofPending, codexTuiReadyTabs, codexWatchers, codexTurnWatchers,
    codexKnownSessions, codexLastRunCommandPayload, codexManualQueueInterrupts,
    codexPromptGeneration, codexStartupPromptAdoptionProbeTabs, codexStartupAutoEnter,
    codexStartupPromptManualOwnershipTabs, codexImageBindings, geminiActiveTabs,
    geminiSpinnerBusy, claudeSpinnerIdleTimer, claudeTurnWatchdog,
    claudeSpinnerLastSeenAt, claudeHookLastEvent, aiLifecycleActionInflight,
    terminalCommandMeta, ptyLastQueuedWriteOperation, ptyActiveWriteOperation,
    claudeLaunchGenerationByTab, ipcMain, runKeyedExclusive,
    AI_PROCESS_LOOKUP_STATUS: { FOUND: 'found', ABSENT: 'absent', UNKNOWN: 'unknown' },
    classifyClaudeResumeShellInput,
    classifyLateMcpProofInput: () => ({ cancelProof: false }),
    shouldSerializeManualPtyInput: () => false,
    isPureCodexEscapeBurst: () => false,
    getCodexRuntimeSessionId: () => null,
    resolveCodexNativeRewindSourceContext: () => null,
    captureManualCodexQueueInterrupt: () => null,
    clearCodexStartupAutoEnter() {},
    findClaudePidByTab: () => null,
    getPendingClaudePasteAudits: () => [],
    cancelClaudeLocalCommandFromInput() {},
    getTerminalInputRevision: () => inputRevision,
    bumpTerminalInputRevision: () => ++inputRevision,
    getTerminalLifecycleGeneration: (tabId) => {
      const current = terminals.get(tabId);
      const runSeq = Number(terminalCommandState.get(tabId)?.runSeq || 0);
      return current ? String(current.generationToken) + ':' + runSeq : null;
    },
    conversationOwners: { noteInput() {} },
    revokeCodexActionAuthoritiesForManualInput() {},
    getHeadlessTerminalMirror: () => null,
    recordComposerForensicPtyInput() {},
    trackManualCodexRewindNavigationInput() {},
    trackClaudeInputLineForLocalCommands: () => null,
    trackCodexInputLineForCompact() {},
    queueTerminalCommandMeta(tabId, meta) { terminalCommandMeta.set(tabId, meta); },
    captureTerminalInputForLastCommand() {},
    getClaudeJsonlLiveOwner: () => null,
    getClaudeJsonlExternalOwner: async () => {
      externalOwnerCalls++;
      return delayedOwner ? externalOwner.promise : null;
    },
    trimTrailingEffortEntries: () => { trimCalls++; events.push('resume-trim'); return { trimmed: 0 }; },
    markClaudePendingJsonlOwner: () => { events.push('pending-jsonl-owner'); return true; },
    prepareCodexNativeSettingsIntentInput: () => null,
    markCodexNativeSettingsIntentInputWritten() {},
    activateClaudeLocalCommandWatcher() {},
    updateGeminiCharCount() {},
    terminalHistoryPreviewController: { finish() {} },
    taskCompletionIntents: { abortTurn() {} },
    stopClaudeLocalCommandWatcher() {},
    clearClaudeProviderFatalTurnWatch() {},
    emitClaudeAbnormalTurnEnd() {},
    wakeClaudePostEnterResolutionWaitersForTurnIdle() {},
    recordActivity() {},
    stopInterruptWatcher() {},
    clearBridgeTab(tabId) { bridgeKnownSessions.delete(tabId); events.push('bridge-cleared'); },
    getAiRuntimeSessionId: () => bridgeKnownSessions.get(TAB_ID) || null,
    resolveAiToolTypeForTab: (_tabId, fallback) => fallback || (liveClaude ? 'claude' : null),
    getLiveAiRuntimeOwners: () => liveClaude ? ['claude'] : [],
    cancelCodexManualCompactPending() {},
    inspectAiDescendantProcessesByTab: async () => ({ status: 'absent', matches: [], error: null }),
    getProcessTreeSnapshot: async () => ({ children: new Map() }),
    selectAiProcessForStop: () => null,
    getAiProcessNameFromCommand: () => null,
    projectManager: { db: { db: { prepare: () => ({ get: () => ({ command_type: 'claude' }) }) } } },
    codexCapacityRetryRuntime: null,
    revokeCodexActionAuthoritiesForTab() {},
    invalidateCodexExitObservers() {},
    restoreAiRuntimeStatusAfterFailedStop() {},
    finalizeStoppedAiCommandState(tabId, reason, { processName } = {}) {
      terminalCommandState.set(tabId, { ...terminalCommandState.get(tabId), isRunning: false });
      events.push('finalized:' + processName + ':' + reason);
    },
    mainWindow: null,
    emitAgentReadinessChanged() {},
    broadcastAiRuntimeStatus() {},
    invalidateAiProcessLookupCache() {},
    clearCodexLaunchPayload() {},
    closeCodexWatcher() {},
    clearCodexKnownSession() {},
    clearCodexTuiReady() {},
    closeCodexTurnWatcher() {},
    emitCodexBusy() {},
    process: { kill() { throw Object.assign(new Error('no process'), { code: 'ESRCH' }); } },
  });

  vm.runInContext(actualFunctions([
    'handleTerminalInput', 'stopAgentProcessScenarioInMain',
    'stopAiProcessInTabSerialized', 'stopAiProcessInTab',
    'markAiStopping', 'clearAiStopping', 'emitAgentReadinessChanged',
    'captureAiProcessLookupScope', 'aiProcessLookupScopeCurrent',
  ]), ctx);
  return {
    ctx, term, terminals, writes, events, externalOwner, aiStoppingTabs, bridgeKnownSessions,
    terminalCommandState, terminalProjects, terminalProjectIds,
    getInputRevision: () => inputRevision,
    getExternalOwnerCalls: () => externalOwnerCalls,
    getTrimCalls: () => trimCalls,
  };
}

async function beginManualResume(h) {
  const resume = h.ctx.handleTerminalInput({}, TAB_ID, 'claude --resume ' + SESSION_ID + '\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.getExternalOwnerCalls(), 1, 'ordinary keyboard Enter reached the external-owner await');
  assert.deepEqual(h.writes, []);
  return { resume };
}

async function assertResumeCancelled(h, resume) {
  h.externalOwner.resolve(null);
  await resume;
  assert.equal(h.getTrimCalls(), 0, 'stale Resume never trims the saved JSONL tail');
  assert.equal(h.events.includes('pending-jsonl-owner'), false, 'stale Resume never claims the session');
  assert.equal(h.writes.some((bytes) => bytes.startsWith('claude --resume ')), false,
    'stale Resume never reaches either PTY generation');
}

test('actual main Stop during raw Resume owner lookup cancels the delayed continuation', async () => {
  const h = fixture();
  const { resume } = await beginManualResume(h);
  let readinessStopSeen = false;
  const listener = (_event, payload) => {
    if (payload?.tabId === TAB_ID && payload?.status === 'stopping') readinessStopSeen = true;
  };
  // Subscribe before the Stop entrypoint. The handler's own listener was armed
  // before its external-owner await; this observer independently proves that
  // the actual main Stop emitted the shared lifecycle edge.
  h.ctx.ipcMain.on('agent:readiness-changed-internal', listener);
  const stop = await h.ctx.stopAgentProcessScenarioInMain({ tabId: TAB_ID, toolType: 'claude' });
  assert.equal(stop.success, true, 'main Stop settled from the authoritative ABSENT lookup');
  assert.equal(readinessStopSeen, true, 'actual markAiStopping emitted the internal readiness event');
  assert.equal(h.aiStoppingTabs.has(TAB_ID), false, 'actual Stop cleared its transient state before the owner lookup returned');
  h.ctx.ipcMain.removeListener('agent:readiness-changed-internal', listener);
  await assertResumeCancelled(h, resume);
});

test('newer raw text and Ctrl+C each supersede, but remain delivered during the Resume lookup', async () => {
  for (const newerInput of ['new text', '\x03']) {
    const h = fixture();
    const { resume } = await beginManualResume(h);
    const revisionBefore = h.getInputRevision();
    await h.ctx.handleTerminalInput({}, TAB_ID, newerInput);
    assert.ok(h.getInputRevision() > revisionBefore);
    assert.deepEqual(h.writes, [newerInput], 'the newest physical bytes retain ownership');
    await assertResumeCancelled(h, resume);
    assert.deepEqual(h.writes, [newerInput], 'old Resume does not follow newer text or interrupt');
  }
});

test('replacement PTY, command generation, or cwd supersedes the pending manual Resume', async () => {
  for (const replace of [
    (h) => h.terminals.set(TAB_ID, { pid: 99, generationToken: 'pty-B', write: (bytes) => h.writes.push(String(bytes)) }),
    (h) => h.terminalCommandState.set(TAB_ID, { isRunning: false, runSeq: 8 }),
    (h) => h.terminalProjects.set(TAB_ID, '/tmp/project-B'),
  ]) {
    const h = fixture();
    const { resume } = await beginManualResume(h);
    replace(h);
    await assertResumeCancelled(h, resume);
  }
});

test('an external-owner lookup rejection after Stop cannot fall through into trim or PTY write', async () => {
  const h = fixture();
  const { resume } = await beginManualResume(h);
  const stop = await h.ctx.stopAgentProcessScenarioInMain({ tabId: TAB_ID, toolType: 'claude' });
  assert.equal(stop.success, true);
  h.externalOwner.reject(new Error('controlled ps lookup failure'));
  await resume;
  assert.equal(h.getTrimCalls(), 0);
  assert.equal(h.events.includes('pending-jsonl-owner'), false);
  assert.deepEqual(h.writes, []);
});

test('non-racing manual Resume stays functional and active-TUI keyboard bytes bypass resume preflight', async () => {
  const resumeFixture = fixture({ delayedOwner: false });
  await resumeFixture.ctx.handleTerminalInput({}, TAB_ID, 'claude --resume ' + SESSION_ID + '\r');
  assert.equal(resumeFixture.getExternalOwnerCalls(), 1);
  assert.equal(resumeFixture.getTrimCalls(), 1);
  assert.ok(resumeFixture.events.includes('pending-jsonl-owner'));
  assert.deepEqual(resumeFixture.writes, ['claude --resume ' + SESSION_ID + '\r']);

  const activeFixture = fixture({ liveClaude: true });
  await activeFixture.ctx.handleTerminalInput({}, TAB_ID, 'hello\r');
  assert.equal(activeFixture.getExternalOwnerCalls(), 0, 'provider-owned input does not enter shell-resume preflight');
  assert.equal(activeFixture.getTrimCalls(), 0);
  assert.deepEqual(activeFixture.writes, ['hello\r'], 'active TUI bytes remain raw pass-through');
});
