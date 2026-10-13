'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const registry = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { bindStructuredAuthoringPresentation } = require('./structured-authoring');
const { scenarioDestination } = require('./agent-message-identity');
const { agentSendTargetPreconditionFailure } = require('./agent-send-target-precondition');

const mainAst = ts.createSourceFile('main.js', fs.readFileSync(require.resolve('./main'), 'utf8'), ts.ScriptTarget.Latest, true);
const webAst = ts.createSourceFile('web-server.js', fs.readFileSync(require.resolve('./web-server'), 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = (ast, name) => {
  const found = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(found, name);
  return found.getText(ast);
};
const plain = value => JSON.parse(JSON.stringify(value));

// Real Main public snapshot/readiness/write-boundary functions. Process/TUI
// primitives are private fixtures, not a snapshot object invented by the web
// test. A saved/history SID deliberately differs from the proven writer SID.
function mainFixture({ toolType = 'codex', ready = true, status = 'active' } = {}) {
  const tabId = 'capacity-private-tab', terminal = {};
  const terminals = new Map([[tabId, terminal]]);
  const commands = new Map([[tabId, { runSeq: 1 }]]);
  const turns = new Map([[tabId, { currentTurnId: null, lastOutcomeTurnId: 'capacity-turn' }]]);
  let generation = 'process-G';
  let writer = { sessionId: 'writer-S', terminalToken: terminal, runSeq: 1,
    lifecycleGeneration: generation, launchId: 'launch-L' };
  const context = vm.createContext({
    sdkSessions: new Map(), terminals, terminalCommandState: commands, codexTurnWatchers: turns,
    terminalLifecycleEpochs: new Map([[terminal, 'terminal-A']]),
    captureAiProcessLookupScope: () => ({ generation, terminal: terminals.get(tabId), cwd: '/private/fixture' }),
    aiProcessLookupScopeCurrent: (_tab, scope) => scope.generation === generation && scope.terminal === terminals.get(tabId),
    getTerminalLifecycleGeneration: () => generation,
    getTerminalInputRevision: () => 1,
    resolveAiToolTypeForTab: () => toolType,
    conversationOwners: { current: () => ({ ownerToken: 'owner', ownerOrder: 1 }) },
    bridgeKnownSessions: new Map(toolType === 'claude' ? [[tabId, 'claude-live-S']] : []),
    codexKnownSessions: new Map([[tabId, 'saved-stale-S']]),
    claudeStartupGateRevisions: new Map(), claudeTurnBusy: new Map(),
    claudeLaunchGenerationByTab: new Map([[tabId, { generation: 'claude-launch-L' }]]),
    claudePromptReady: new Set(),
    getActiveAgentExecutionContext: () => ({ turnId: turns.get(tabId).currentTurnId || turns.get(tabId).lastOutcomeTurnId }),
    codexRuntimePolicies: { read: () => null }, codexLiveSettingsObserver: { read: () => null },
    currentClaudeStartupDefaultsGate: () => null,
    readAiLifecycleIdentityForTab: async () => ({ processStatus: 'found', terminalRunSeq: 1, inputRevision: 1 }),
    getClaudePtyRuntimePresence: () => ({ hasTerm: true, status, inputReady: ready }),
    getPersistedAiSessionBindingForShutdown: () => ({ claude_session_id: 'claude-history-S' }),
    getSessionMaterialization: () => ({ materialized: true }),
    projectCodexRuntimeSnapshotFromEvents: () => ({ sessionId: 'history-only-S', sessionStatus: status, inputReady: ready }),
    getCodexPublicWriterFields: () => ({ writerConfirmed: !!writer }),
    getCodexRuntimeSessionId: () => 'saved-stale-S',
    getCodexTuiReadyState: async () => ({ inputReady: ready }),
    getCodexWriterProofSnapshot: () => writer?.terminalToken === terminals.get(tabId)
      && writer.lifecycleGeneration === generation && writer.runSeq === commands.get(tabId).runSeq ? writer : null,
    currentCodexAcceptedResumeSourceProof: () => null,
    codexLastRunCommandPayload: new Map(),
    getCodexResumeReadIdentityLeaseForTab: () => null,
  });
  vm.runInContext(['readAgentSendDestinationAtWriteBoundary', 'readMainAgentStartReadiness', 'readMainPublicRuntimeSnapshot']
    .map(name => declaration(mainAst, name)).join('\n'), context);
  return { context, tabId,
    snapshot: () => context.readMainPublicRuntimeSnapshot(tabId),
    destination: () => context.readAgentSendDestinationAtWriteBoundary(tabId, toolType),
    loseWriter: () => { writer = null; },
    newTurn: () => { turns.get(tabId).currentTurnId = 'new-user-turn'; },
  };
}

test('actual coherent Main snapshot retains proven Codex destination even before composer is ready, not history/saved SID', async () => {
  const h = mainFixture({ ready: false });
  const snapshot = await h.snapshot();
  assert.equal(snapshot.coherent, true);
  assert.equal(snapshot.inputReady, false, 'destination proof is not fake input readiness');
  assert.equal(snapshot.sessionId, 'history-only-S');
  assert.deepEqual(plain(scenarioDestination(snapshot)), {
    toolType: 'codex', terminalInstanceId: 'terminal-A', launchId: 'launch-L',
    sessionId: 'writer-S', acceptedResumeSourceSessionId: null,
    lifecycleGeneration: 'process-G', turnId: 'capacity-turn',
  });
});

test('the same coherent projection carries Claude live destination separately from its saved read SID', async () => {
  const h = mainFixture({ toolType: 'claude' });
  const snapshot = await h.snapshot();
  assert.equal(snapshot.sessionId, 'claude-history-S');
  assert.equal(scenarioDestination(snapshot).sessionId, 'claude-live-S');
  assert.equal(snapshot.sendTarget.terminalInstanceId, 'terminal-A');
});

function sendFixture(t, options = {}) {
  const h = mainFixture(options);
  const db = new Database(':memory:');
  t.after(() => db.close());
  let attempts = 0;
  const store = createAgentSendReceiptStore(db, { randomUUID: () => 'attempt-' + ++attempts });
  const writes = [];
  const context = vm.createContext({
    require, path, srcMainDir: __dirname,
    ...registry, AGENT_SEND_RECEIPT_STATES: registry.RECEIPT_STATES,
    agentSendReceiptRegistry: registry.createAgentSendReceiptRegistry(), agentSendReceiptStore: store,
    agentSendReceiptStartupReady: Promise.resolve(), agentSendBridgeTimeoutMs: 1000,
    scenarioDestination, agentSendTargetPreconditionFailure, promptAuditFingerprint,
    bindStructuredAuthoringPresentation, withPromptOriginPresentation: value => value,
    tabWorkContext: null, console: { log() {}, warn() {} }, shortId: value => value,
    getOrchestrationRunStore: () => ({ listForTab: async () => [] }),
    findOrchestrationTabDescriptor: () => ({ toolType: 'codex', sessionId: 'saved-stale-S' }),
    readAgentRuntimeSnapshot: () => h.snapshot(),
    bridgeRequest: async (action, payload) => {
      assert.equal(action, 'sendAgentPromptScenario');
      assert.equal(payload.requireLive, true);
      assert.equal(payload.prompt, 'continue');
      assert.equal(payload.model, undefined); assert.equal(payload.effort, undefined);
      assert.equal(store.get(payload.sendOperationKey).receipt.expectedTarget.sessionId, 'writer-S');
      if (options.beforeWrite) options.beforeWrite(h);
      const refusal = agentSendTargetPreconditionFailure(payload.expectedTarget, h.destination());
      if (refusal) return refusal;
      store.markAttemptState(payload.sendOperationKey, payload.sendAttemptId, 'enter-armed');
      writes.push({ prompt: payload.prompt, enter: '\r' }); // test primitive, never a production PTY
      return { success: null, accepted: true, submitted: true, auditPending: true, status: 'audit-pending' };
    },
  });
  vm.runInContext(['readScenarioDestination', 'durableRecordHasProviderQueueAcceptance', 'durableAgentSendReplay',
    'durableAgentSendFailure', 'runPreparedAgentSendScenario', 'runAgentSendScenario', 'sendCodexCapacityContinuation']
    .map(name => declaration(webAst, name)).join('\n'), context);
  const args = { tabId: h.tabId, sessionId: 'writer-S', turnId: 'capacity-turn', generation: 'process-G',
    handoffId: 'exact-capacity-handoff', isCurrent: async () => true };
  return { ...h, writes, store, args,
    send: () => context.sendCodexCapacityContinuation(args),
    attempts: () => attempts,
  };
}

test('actual capacity→coherent Main→common web→SQLite path submits one continue; same-ID pending replay writes nothing else', async t => {
  const h = sendFixture(t);
  const first = await h.send();
  assert.equal(first.submitted, true, first.error);
  assert.equal(first.auditPending, true, 'this test does not fabricate provider/History confirmation');
  const replay = await h.send();
  assert.equal(replay.submitted, true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.attempts(), 1);
  assert.equal(h.store.list()[0].state, STORE_STATES.AUDIT_PENDING);
});

test('missing writer proof, including unknown presentation, never borrows a history/saved SID or writes', async t => {
  for (const mode of ['unknown', 'no-writer']) {
    const h = sendFixture(t, mode === 'unknown' ? { status: 'unknown' } : {});
    h.loseWriter();
    const result = await h.send();
    assert.equal(result.submitted, false);
    assert.equal(h.writes.length, 0);
    assert.equal(h.attempts(), 0, 'preflight refusal remains before a physical attempt');
  }
});

test('new user turn between main preflight and write still refuses the pinned capacity retry', async t => {
  const h = sendFixture(t, { beforeWrite: current => current.newTurn() });
  const result = await h.send();
  assert.equal(result.code, 'agent_send_target_changed');
  assert.equal(result.submitted, false);
  assert.equal(h.writes.length, 0);
});
