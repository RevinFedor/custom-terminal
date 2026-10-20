'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const shutdown = require('./shutdown-ai-session-snapshot');
const { resolveCodexReadIdentity } = require('./codex-runtime-contract');
const { captureShutdownProcessProof } = require('./shutdown-process-proof');

const source = fs.readFileSync(process.env.NOTED_SHUTDOWN_MAIN_SOURCE || path.join(__dirname, 'main.js'), 'utf8');

function block(start, end) {
  const at = source.indexOf(start);
  assert.ok(at >= 0, 'missing start: ' + start);
  const to = source.indexOf(end, at + start.length);
  assert.ok(to > at, 'missing end: ' + end);
  return source.slice(at, to);
}

test('process proof confirms liveness but never invents identity from a saved row', () => {
  const helper = block(
    'async function augmentShutdownStateFromProcessProof',
    '\n\nfunction markInterruptedAiSessionEntries',
  );
  assert.match(helper, /Array\.from\(terminals\.keys\(\)/);
  assert.match(helper, /captureShutdownProcessProof\(\{/);
  assert.match(helper, /readSnapshot: \(\) => getProcessTreeSnapshot\(\{ forceFresh: true \}\)/);
  assert.match(helper, /inspectAiDescendantProcessesByTab\(tabId, null\)/);
  assert.match(helper, /providers\.size > 1/);
  assert.match(helper, /resolveAcceptedClaudeResumeShutdownTarget\(\{/);
  assert.match(helper, /intentSessionId: intentBefore\?\.sessionId/);
  assert.match(helper, /persistedSessionId: persistedAfter\?\.claude_session_id/);
  assert.doesNotMatch(helper, /terminalCommandState[\s\S]{0,80}isRunning/,
    'stale isRunning must not become shutdown proof');
});

test('exact collector requires Claude bridge / Codex writer / active turn / stopping identity', () => {
  const collector = block(
    'function exactShutdownCandidatesForTab',
    '\n\nfunction getInterruptedAiSessionEntries',
  );
  assert.match(collector, /bridgeKnownSessions\.get\(tabId\)/);
  assert.match(collector, /getCodexWriterProofSnapshot\(tabId\)/);
  assert.match(collector, /getActiveAgentExecutionContext\(tabId\)/);
  assert.match(collector, /aiStoppingTabs\.get\(tabId\)/);
  assert.doesNotMatch(collector, /codexKnownSessions\.get\(tabId\)/);
});

test('before-quit freezes augmented owners and will-quit never recomputes them away', () => {
  const before = block("app.on('before-quit'", "app.on('will-quit'");
  const will = block("app.on('will-quit'", "app.on('window-all-closed'");
  assert.match(before, /augmentShutdownStateFromProcessProof\(activeAiSessions, liveAiTabIds\)/);
  assert.match(before, /_gracefulShutdownAiSessions = new Map\(activeAiSessions\)/);
  assert.match(before, /reconcileInterruptedAiSessionEntries\([\s\S]{0,180}'before-quit-process-proof'/);
  assert.match(will, /_gracefulShutdownAiSessions \|\| getInterruptedAiSessionEntries\(\)/);
  assert.match(will, /markInterruptedAiSessionEntries\(activeAiSessions, 'will-quit'\)/);
});

test('shutdown uses bounded canonical writer reconcile and a recovery-only complete idle lease', () => {
  const helper = block('function captureCodexShutdownScope', '\n\nfunction markInterruptedAiSessionEntries');
  assert.match(helper, /reconcileCodexShutdownTarget\(\{/);
  assert.match(helper, /reconcileCodexWriterFromProcess\(tabId, \{ reason: 'shutdown-recovery-proof' \}\)/);
  assert.match(helper, /Math\.max\(0, codexProofDeadline - Date\.now\(\)\)/);
  assert.match(helper, /currentProviders\.size === 1 && currentProviders\.has\('codex'\)/);
  assert.match(helper, /resolveCodexReadIdentity\(\{/);
  assert.match(helper, /allowIdleResume: readLaunch\?\.materializedFresh === false/);
  assert.match(helper, /submitResolutionPending: codexReadIdentitySubmitPending\.get\(tabId\)/);
  assert.doesNotMatch(helper, /getCodexRuntimeSessionSnapshot|setCodexKnownSession|mark.*Audit|term\.write/);
  const lease = block('function bindCodexResumeReadIdentityLease', '\n\nfunction markCodexLaunchAcceptancePending');
  assert.match(lease, /materializedFresh: codexLastRunCommandPayload\.get\(tabId\)\?\.materializedFresh === true/);
});

function shutdownHarness() {
  const tabId = 'root-tab-3314';
  const term = { pid: 60628 };
  const state = { proof: null, runSeq: 7, reconcileCalls: 0, lookups: 0, providers: ['codex'], adopted: false };
  const readLease = {
    command: 'codex-c', tabId, sessionId: 'source-a', launchId: 'launch-a',
    terminalToken: term, runSeq: 7, lifecycleGeneration: 'terminal:7', materializedFresh: false,
  };
  const context = {
    ...shutdown, resolveCodexReadIdentity, captureShutdownProcessProof, Date, Set, Map,
    PROCESS_TREE_SNAPSHOT_TTL_MS: 750, nodePerformance: { now: () => Date.now() },
    captureAiProcessLookupScope: () => ({ terminal: term }),
    aiProcessLookupScopeCurrent: (_id, scope) => scope.terminal === term,
    getAiProcessNameFromCommand: cmd => cmd,
    getProcessTreeSnapshot: async () => {
      state.lookups += 1;
      return { createdAt: Date.now(), processesByPid: new Map(), children: new Map([[term.pid,
        state.providers.map((cmd, i) => ({ pid: 60629 + i, ppid: term.pid, cmd })),
      ]]) };
    },
    console: { log() {}, warn() {} },
    terminals: new Map([[tabId, term]]),
    terminalCommandState: { get: () => ({ runSeq: state.runSeq, isRunning: true }) },
    claudeStartupIntents: new Map(), claudeLaunchGenerationByTab: new Map(),
    codexLastRunCommandPayload: new Map(),
    codexSessionDiscoveryIntents: new Map([[tabId, {
      sourceMode: 'resume', sourceSessionId: 'source-a', launchId: 'launch-a',
      sourceRunSeq: 7, sourceLifecycleGeneration: 'terminal:7',
    }]]),
    codexTurnWatchers: new Map([[tabId, {
      sessionId: 'source-a', sourceObservationLaunchId: 'launch-a', processGeneration: 'terminal:7',
    }]]),
    codexWatchers: new Map(), codexReadIdentitySubmitPending: new Map(),
    resolveAuthoritativeTabProjectId: () => 'project-a',
    getTerminalLifecycleGeneration: () => 'terminal:7',
    getTerminalInputRevision: () => 0,
    getCodexWriterObservationGeneration: () => 0,
    getCodexExitObserverGeneration: () => 0,
    getCodexResumeReadIdentityLeaseForTab: () => readLease,
    getCodexResumeSourceLeaseForTab: () => ({ tabId, sourceSessionId: 'source-a', launchId: 'launch-a' }),
    getCodexWriterProofSnapshot: () => state.proof,
    codexSessionIdFromDb: () => state.proof?.sessionId || 'source-a',
    hasCodexPromptOrTurnInFlight: () => false,
    exactShutdownCandidatesForTab: () => state.proof ? [{ engine: 'codex', sessionId: state.proof.sessionId }] : [],
    AI_PROCESS_LOOKUP_STATUS: { FOUND: 'found', ABSENT: 'absent', UNKNOWN: 'unknown' },
    inspectAiDescendantProcessesByTab: async () => {
      state.lookups += 1;
      return { status: 'found', matches: state.providers.map((processName) => ({ processName, pid: 60629 })) };
    },
    reconcileCodexWriterFromProcess: async () => {
      state.reconcileCalls += 1;
      if (state.adopted) state.proof = { sessionId: 'source-a', launchId: 'launch-a' };
      return { status: state.adopted ? 'adopted' : 'provisional-source', sessionId: 'source-a', pids: [60629] };
    },
  };
  vm.createContext(context);
  vm.runInContext(block('function captureCodexShutdownScope', '\n\nfunction markInterruptedAiSessionEntries'), context);
  return { tabId, state, context, readLease };
}

test('actual augmentation recovers the root found/provisional shape in both proof branches', async () => {
  for (const adopted of [false, true]) {
    const { context, state, tabId } = shutdownHarness();
    state.adopted = adopted;
    const result = await context.augmentShutdownStateFromProcessProof(new Map(), new Set());
    assert.equal(result.recoverableEntries.get(tabId)?.sessionId, 'source-a');
    assert.equal(result.liveTabIds.has(tabId), true);
    assert.equal(state.reconcileCalls, 1);
    assert.equal(state.lookups, 2, 'provider set must be checked again after descriptor IO');
    assert.equal(!!state.proof, adopted, 'idle lease must not publish a writer');
  }
});

test('actual augmentation rejects fresh, unresolved first submit, dual owners and a replaced generation', async () => {
  for (const failure of ['fresh', 'submit', 'dual', 'generation', 'late-dual']) {
    const { context, state, tabId, readLease } = shutdownHarness();
    if (failure === 'fresh') readLease.materializedFresh = true;
    if (failure === 'submit') context.codexReadIdentitySubmitPending.set(tabId, { enterWritten: true });
    if (failure === 'dual') state.providers.push('claude');
    const reconcile = context.reconcileCodexWriterFromProcess;
    if (failure === 'generation' || failure === 'late-dual') {
      context.reconcileCodexWriterFromProcess = async () => {
        const result = await reconcile();
        if (failure === 'generation') state.runSeq += 1;
        else state.providers.push('claude');
        return result;
      };
    }
    const result = await context.augmentShutdownStateFromProcessProof(new Map(), new Set());
    assert.equal(result.recoverableEntries.has(tabId), false, failure);
    assert.equal(result.liveTabIds.has(tabId), true, failure);
    assert.equal(state.proof, null, failure);
  }
});

test('a writer adopted after the seed snapshot is re-read without another reconcile', async () => {
  const { context, state, tabId } = shutdownHarness();
  const inspect = context.getProcessTreeSnapshot;
  context.getProcessTreeSnapshot = async () => {
    state.proof = { sessionId: 'child-b', launchId: 'launch-a' };
    return inspect();
  };
  const result = await context.augmentShutdownStateFromProcessProof(new Map(), new Set());
  assert.equal(result.recoverableEntries.get(tabId)?.sessionId, 'child-b');
  assert.equal(state.reconcileCalls, 0);
});
