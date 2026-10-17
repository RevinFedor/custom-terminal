'use strict';

// Actual Main snapshot/readiness/process-scope readers. Only the OS process
// snapshot, event projection, proof registry and clock-independent UI ports are
// controlled. No app, provider, PTY, user file or live database is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const ts = require('typescript');
const liveness = require('../ai-process-liveness');
const { normalizeAiLifecycleIdentity } = require('../ai-lifecycle-authority');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const names = ['captureAiProcessLookupScope', 'aiProcessLookupScopeCurrent',
  'findAiDescendantProcessesByTab', 'inspectAiDescendantProcessesByTab',
  'currentAiLifecycleIdentity', 'readAiLifecycleIdentityForTab',
  'getCodexPublicWriterFields', 'readAgentSendDestinationAtWriteBoundary',
  'readMainAgentStartReadiness', 'readMainPublicRuntimeSnapshot'];
const code = names.map(name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
}).join('\n');

function runtimeSnapshotCompletionFixture({ tabId = 'T', sessionId = 'S' } = {}) {
  const terminal = { pid: 100 }, command = { isRunning: true, runSeq: 1 };
  const state = { generation: 'G', input: 4, stop: 0, owner: 1, sessionId,
    writer: null, proofAt: 0, turn: null, ready: true, busy: false,
    process: 'found', lookups: 0, onLookup: null, onTui: null };
  const logs = [];
  const context = vm.createContext({
    console: { log: x => logs.push(x), warn: x => logs.push(x), error: x => logs.push(x) },
    ...liveness, normalizeAiLifecycleIdentity, nodePerformance: performance,
    beginPerfOp: () => 'fixture', endPerfOp() {},
    commandLooksLikeAiProcess: cmd => cmd === 'codex', getAiProcessNameFromCommand: () => 'codex',
    selectAiProcessForStop: matches => matches[0] || null,
    terminals: new Map([[tabId, terminal]]), terminalCommandState: new Map([[tabId, command]]),
    terminalProjectIds: new Map([[tabId, 'P']]), terminalProjects: new Map([[tabId, '/fixture']]),
    terminalLifecycleEpochs: new Map([[terminal, 'terminal-A']]),
    codexLastRunCommandPayload: new Map([[tabId, { launchId: 'L', sessionId }]]),
    claudeLaunchGenerationByTab: new Map(), sdkSessions: new Map(),
    bridgeKnownSessions: new Map(), codexKnownSessions: new Map(),
    claudeStartupGateRevisions: new Map(), claudeTurnBusy: new Map(),
    codexTurnWatchers: new Map([[tabId, { get currentTurnId() { return state.turn; } }]]),
    getTerminalLifecycleGeneration: () => state.generation,
    getTerminalInputRevision: () => state.input, getTerminalStopRevision: () => state.stop,
    resolveAiToolTypeForTab: () => 'codex', currentClaudeStartupDefaultsGate: () => null,
    resolveActivityIdentity: () => ({ sessionId: state.writer?.sessionId || null }),
    getActiveAgentExecutionContext: () => ({ turnId: state.turn }),
    conversationOwners: { current: () => ({ ownerToken: 'O' + state.owner,
      ownerOrder: { epoch: 'E', revision: state.owner },
      currentBinding: { state: 'bound', provider: 'codex', sessionId: state.sessionId } }) },
    codexRuntimePolicies: null, codexLiveSettingsObserver: { read: () => ({ proofAt: state.proofAt }) },
    getCodexSavedSessionId: () => state.sessionId,
    getCodexRuntimeSessionId: () => state.writer?.sessionId || null,
    getCodexWriterProofSnapshot: () => state.writer?.terminalToken === context.terminals.get(tabId)
      && state.writer.runSeq === command.runSeq && state.writer.lifecycleGeneration === state.generation
      ? state.writer : null,
    isCodexWriterUsableForMutation: () => !!state.writer,
    currentCodexAcceptedResumeSourceProof: () => null,
    getCodexResumeReadIdentityLeaseForTab: () => null,
    projectCodexRuntimeSnapshotFromEvents: () => ({ success: true,
      sessionId: command.isRunning ? state.writer?.sessionId || null : state.sessionId,
      savedSessionId: state.sessionId, liveLifecycle: command.isRunning,
      sessionStatus: !command.isRunning ? 'inactive' : state.busy ? 'busy' : 'active',
      inputReady: command.isRunning && state.ready }),
    getCodexTuiReadyState: async () => { await state.onTui?.(); return { inputReady: state.ready }; },
    getCodexRuntimeSessionSnapshot: async () => ({ sessionStatus: 'inactive', liveLifecycle: false,
      sessionId: state.sessionId, savedSessionId: state.sessionId, inputReady: false }),
    getProcessTreeSnapshot: async () => {
      const ordinal = ++state.lookups;
      await state.onLookup?.(ordinal);
      if (state.process === 'unknown') throw Object.assign(new Error('controlled ps timeout'), { code: 'ETIMEDOUT' });
      return { children: new Map([[context.terminals.get(tabId).pid, state.process === 'found'
        ? [{ pid: 200, ppid: 100, cmd: 'codex' }] : []]]),
        source: 'controlled', createdAt: performance.now(), psMs: 0, parseMs: 0, linesCount: 1 };
    },
  });
  vm.runInContext(code, context);
  const adopt = () => {
    state.writer = { sessionId: state.sessionId, terminalToken: context.terminals.get(tabId),
      runSeq: command.runSeq, lifecycleGeneration: state.generation, launchId: 'L' };
    context.codexKnownSessions.set(tabId, state.sessionId);
    state.proofAt++;
  };
  return { state, context, terminal, command, logs, adopt,
    snapshot: () => context.readMainPublicRuntimeSnapshot(tabId),
    cleanupLaunch: () => context.codexLastRunCommandPayload.delete(tabId) };
}

module.exports = { runtimeSnapshotCompletionFixture };
