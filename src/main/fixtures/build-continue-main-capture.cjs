'use strict';

// Actual Main capture functions; native catalog/source/process leaves are
// controlled. No user's tab, PTY, History, JSONL or database is opened.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { TaskCompletionIntentRegistry } = require('../task-completion-intent');
const mainPath = path.resolve(__dirname, '../main.js');
const source = fs.readFileSync(mainPath, 'utf8');
const tree = ts.createSourceFile(mainPath, source, ts.ScriptTarget.Latest, true);
const functions = new Map(tree.statements.filter(ts.isFunctionDeclaration)
  .map(node => [node.name?.text, node.getText(tree)]));

function mainCaptureFixture({ writerSession = null, tabId = 'T', sessionId = 'S', projectId = 'P', cwd = '/fixture' } = {}) {
  const terminal = {}, registry = new TaskCompletionIntentRegistry({ now: () => 100 });
  registry.beginTurn({ tabId, provider: 'codex', sessionId, turnId: 'own-turn' });
  const state = {
    owner: { known: true, provider: 'codex', sessionId, projectId, cwd,
      terminalId: 'physical-T', launchId: 'launch-T', runSeq: 1 },
    writerSession, generation: 'physical:1', inputRevision: 4, stopRevision: 0,
    command: { isRunning: true, runSeq: 1, processLookupUnknown: false },
  };
  const watcher = { busy: true, sessionId, currentTurnId: 'own-turn', lastOutcomeTurnId: null,
    lastEventType: 'task_started', liveTurnEvents: 5, catchUpPending: false,
    publicTurnStateSuppressed: false, catchUpPublicationsSuppressed: false, outcomeKnown: false,
    processGeneration: 'physical:1', sourceObservationTerminal: terminal, sourceObservationRunSeq: 1,
    sourceObservationStartedAt: 10, processGenerationBoundaryOffset: 0,
    loopCanonicalInputOffset: 40, filePath: '/controlled/source.jsonl' };
  const watchers = new Map([[tabId, watcher]]), terminals = new Map([[tabId, terminal]]), stopping = new Map();
  const context = vm.createContext({ require, console, path, srcMainDir: path.resolve(__dirname, '..'),
    projectManager: { db: { db: { prepare: sql => ({ get: () => sql.includes('SELECT name') ? { name: 'private worker' } : { tab_id: 'T' } }) } } },
    captureConversationOwner: () => state.owner, sdkSessions: new Map(), taskCompletionIntents: registry,
    codexTurnWatchers: watchers, claudeTurnBusy: new Map(),
    getCodexPublicRuntimeProjection: () => ({ sessionStatus: 'busy' }),
    hasEstablishedCodexLifecycleIndicators: () => true,
    getCodexWriterProofSnapshot: () => state.writerSession ? { sessionId: state.writerSession } : null,
    getTerminalLifecycleGeneration: () => state.generation,
    aiStoppingTabs: stopping, terminals, ptyActiveWriteOperation: new Map(), codexPromptInFlight: new Map(),
    codexProviderSemanticSources: new Map(), conversationOwners: { stored: () => ({ epoch: 'owner-e', revision: 16 }) },
    getCombinedTabBackgroundWorkCount: () => 1, captureLoopInputBoundary: () => null,
    getTerminalInputRevision: () => state.inputRevision, getTerminalStopRevision: () => state.stopRevision,
    claudeHookLastEvent: new Map(), tabBackgroundWorkRevisionByTab: new Map([['T', 6]]),
    projectCodexRuntimeSnapshotFromEvents: () => ({ sessionStatus: 'busy', liveLifecycle: true,
      writerConfirmed: !!state.writerSession }), terminalCommandState: { get: () => state.command },
    getTabBackgroundWorkAgents: () => [{ provider: 'codex', toolUseId: 'child', agentSessionId: 'native-child', generation: 'physical:1' }],
    getTabBackgroundWorkTasks: () => [],
  });
  const names = ['getActiveAgentExecutionContext', 'getCodexRuntimeSessionId', 'captureAgentResponseReadState',
    'captureTabInspection', 'captureBuildContinueTabInspection'];
  vm.runInContext(names.filter(name => functions.has(name)).map(name => functions.get(name)).join('\n'), context);
  return { state, watcher, watchers, terminals, stopping, registry, terminal, context, tabId,
    publicView: () => context.captureTabInspection(tabId),
    capture: () => (context.captureBuildContinueTabInspection || context.captureTabInspection)(tabId),
    actualMainFunctions: names.filter(name => functions.has(name)),
  };
}

module.exports = { mainCaptureFixture };
