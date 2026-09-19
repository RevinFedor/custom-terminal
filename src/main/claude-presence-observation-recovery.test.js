'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const liveness = require('./ai-process-liveness');
const { projectClaudePtyPresence } = require('./claude-pty-presence');
const { createProcessTreeSnapshotSingleFlight } = require('./process-tree-snapshot-single-flight');

const TAB = 'tab-presence-recovery';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const source = fs.readFileSync(require.resolve('./main'), 'utf8');
const tree = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);

function actualSource() {
  const names = [
    'currentClaudeStartupDefaultsGate',
    'getClaudePtyRuntimePresence',
    'captureAiProcessLookupScope',
    'aiProcessLookupScopeCurrent',
    'aiProcessLookupCacheKey',
    'invalidateAiProcessLookupCache',
    'findAiDescendantProcessesByTab',
    'inspectAiDescendantProcessesByTabCached',
    'resolveTerminalCommandState',
    'readClaudePresenceProcessProof',
    'wakeClaudePresenceAfterProcessSnapshot',
    'invalidateProcessTreeSnapshot',
    'captureProcessTreeSnapshot',
    'getProcessTreeSnapshot',
  ];
  const declarations = names.map((name) => {
    const node = tree.statements.find((candidate) => (
      ts.isFunctionDeclaration(candidate) && candidate.name?.text === name
    ));
    assert.ok(node, 'actual main function exists: ' + name);
    return node.getText(tree);
  });
  const presenceHandler = tree.statements.find((candidate) => (
    ts.isExpressionStatement(candidate)
      && ts.isCallExpression(candidate.expression)
      && candidate.expression.expression.getText(tree) === 'ipcMain.handle'
      && candidate.expression.arguments[0]?.text === 'claude:get-presence'
  ));
  assert.ok(presenceHandler, 'actual claude:get-presence IPC handler exists');
  declarations.push(presenceHandler.getText(tree));
  return declarations.join('\n');
}

function psSnapshot({ providerPid = null, shellPid = 100 } = {}) {
  const rows = [`${shellPid} 1 ${shellPid} ${shellPid} /bin/zsh`];
  if (providerPid !== null) {
    rows.push(`${providerPid} ${shellPid} ${providerPid} ${providerPid} claude`);
  }
  return rows.join('\n');
}

function fixture({ windowSendThrows = false } = {}) {
  const pty = { pid: 100 };
  const state = {
    lifecycle: 'pty-generation-1',
    runSeq: 1,
    launchId: 'claude-launch-1',
    cwd: '/fixture/project',
    projectId: 'fixture-project',
  };
  const execReplies = [];
  const execCalls = [];
  const sent = [];
  const logs = [];
  let performanceTick = 0;
  let presenceHandler = null;
  const context = vm.createContext({
    ...liveness,
    console: {
      log: (...args) => logs.push(['log', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    },
    projectClaudePtyPresence,
    BrowserWindow: {
      getAllWindows: () => [{
        isDestroyed: () => false,
        webContents: {
          send: (_channel, detail) => {
            sent.push(detail);
            if (windowSendThrows) throw new Error('fixture webContents.send failure');
          },
        },
      }],
    },
    beginPerfOp: () => 'fixture-perf-op',
    endPerfOp() {},
    nodePerformance: {
      now: () => ++performanceTick,
      timeOrigin: 1_000_000,
    },
    ipcMain: {
      handle: (channel, handler) => {
        if (channel === 'claude:get-presence') presenceHandler = handler;
      },
    },
    terminals: new Map([[TAB, pty]]),
    terminalCommandState: new Map([[TAB, { runSeq: state.runSeq, isRunning: false, lastExitCode: 0 }]]),
    claudeLaunchGenerationByTab: new Map([[TAB, { generation: state.launchId }]]),
    codexLastRunCommandPayload: new Map(),
    terminalProjectIds: new Map([[TAB, state.projectId]]),
    terminalProjects: new Map([[TAB, state.cwd]]),
    getTerminalLifecycleGeneration: () => state.lifecycle,
    resolveAiToolTypeForTab: (_tabId, fallback = null) => fallback || 'claude',
    commandLooksLikeAiProcess: (command, expected) => expected === 'claude' && command === 'claude',
    AI_PROCESS_LOOKUP_CACHE_MS: 10_000,
    PROCESS_TREE_SNAPSHOT_TTL_MS: 10_000,
    aiProcessLookupCache: new Map(),
    claudePresenceObservationWaiters: new Map(),
    processTreeSnapshotCache: null,
    processTreeSnapshotSingleFlight: null,
    claudeStartupDefaultsGateByTab: new Map(),
    bridgeKnownSessions: new Map(),
    claudeTurnBusy: new Map(),
    claudeLocalCommandWatchers: new Map(),
    claudePromptReady: new Set(),
    aiStoppingTabs: new Map(),
    claudeStartupIntents: new Map(),
    claudeAwaitingInput: new Map(),
    claudeCliActive: new Map(),
    codexManualActionRequired: new Map(),
    codexKnownSessions: new Map(),
    codexTurnWatchers: new Map(),
    codexTuiReadyTabs: new Map(),
    activityOpenIntervals: new Map(),
    keepCodexRuntimeAliveFromProcessProof: async () => assert.fail('Claude proof must not use Codex recovery'),
    projectManager: null,
    getSessionMaterialization: null,
    readAgentSendDestinationAtWriteBoundary: () => ({ owner: 'fixture' }),
    historyPresenceTestGate: { waitIfArmed: async () => {} },
    execAsync: (command, timeoutMs) => {
      execCalls.push({ command, timeoutMs });
      const reply = execReplies.shift();
      if (reply === undefined) throw new Error('unexpected ps execution');
      return typeof reply === 'function' ? reply() : reply;
    },
  });
  vm.runInContext(actualSource(), context);
  context.processTreeSnapshotSingleFlight = createProcessTreeSnapshotSingleFlight({
    capture: (options) => context.captureProcessTreeSnapshot(options),
    now: () => context.nodePerformance.now(),
  });

  return {
    context,
    state,
    pty,
    sent,
    logs,
    execCalls,
    queueExec(reply) { execReplies.push(reply); },
    getPresence: () => {
      assert.equal(typeof presenceHandler, 'function', 'actual IPC handler was registered');
      return presenceHandler(null, TAB);
    },
    seedLookupCache(expectedProcess, matches) {
      context.aiProcessLookupCache.set(TAB + ':' + expectedProcess, {
        at: context.nodePerformance.now(),
        matches,
        scope: context.captureAiProcessLookupScope(TAB),
      });
    },
    collect: (options = { forceFresh: true }) => context.getProcessTreeSnapshot(options),
    invalidateSnapshot: () => context.invalidateProcessTreeSnapshot('fixture-epoch-boundary'),
  };
}

async function registerUnknownPresence(h) {
  h.queueExec(Promise.reject(new Error('fixture ps unavailable')));
  const presence = await h.getPresence();
  assert.equal(presence.processLookupUnknown, true);
  assert.equal(presence.providerProcessAlive, false);
  assert.equal(presence.status, 'unknown');
  assert.equal(presence.inputReady, false);
  assert.deepEqual([...h.context.claudePresenceObservationWaiters.keys()], [TAB]);
  return presence;
}

test('actual Claude presence recovers to absent on the same PTY without inventing input readiness', async () => {
  const h = fixture({ windowSendThrows: true });
  await registerUnknownPresence(h);
  h.seedLookupCache('claude', [{ pid: 999, processName: 'claude', depth: 1 }]);
  h.seedLookupCache('codex', [{ pid: 998, processName: 'codex', depth: 1 }]);

  h.queueExec(psSnapshot());
  const firstSnapshot = await h.collect();
  assert.equal(typeof firstSnapshot.children.get, 'function');
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].tabId, TAB);
  assert.equal(h.sent[0].toolType, 'claude');
  assert.equal(h.sent[0].lifecycleGeneration, 'pty-generation-1');
  assert.equal(h.sent[0].reason, 'process-observation-recovered');
  assert.equal(h.context.claudePresenceObservationWaiters.size, 0);
  assert.equal(h.context.aiProcessLookupCache.has(TAB + ':claude'), false);
  assert.equal(h.context.aiProcessLookupCache.has(TAB + ':codex'), true,
    'recovery invalidates only the Claude proof cache');
  assert.ok(h.logs.some(([level, ...args]) => level === 'warn'
    && args.join(' ').includes('fixture webContents.send failure')));

  // A second successful OS snapshot has no waiter to replay or wake.
  h.queueExec(psSnapshot());
  await h.collect();
  assert.equal(h.sent.length, 1);

  const recovered = await h.getPresence();
  assert.equal(recovered.providerProcessAlive, false);
  assert.equal(recovered.processLookupUnknown, false);
  assert.equal(recovered.status, 'inactive');
  assert.equal(recovered.inputReady, false);
});

test('actual Claude presence recovers to found, but process proof alone does not claim a ready composer', async () => {
  const h = fixture();
  await registerUnknownPresence(h);
  h.seedLookupCache('claude', []);

  h.queueExec(psSnapshot({ providerPid: 220 }));
  await h.collect();
  assert.equal(h.sent.length, 1);
  assert.equal(h.context.claudePresenceObservationWaiters.size, 0);

  const recovered = await h.getPresence();
  assert.equal(recovered.providerProcessAlive, true);
  assert.equal(recovered.processLookupUnknown, false);
  assert.equal(recovered.status, 'starting');
  assert.equal(recovered.inputReady, false);
});

test('failed and superseded process-tree collectors do not wake; a later current collector wakes once', async () => {
  const h = fixture();
  await registerUnknownPresence(h);

  h.queueExec(Promise.reject(new Error('second fixture ps failure')));
  await assert.rejects(h.collect(), /second fixture ps failure/);
  assert.equal(h.sent.length, 0);
  assert.equal(h.context.claudePresenceObservationWaiters.size, 1);

  const oldCapture = deferred();
  const captureStarted = deferred();
  h.queueExec(() => {
    captureStarted.resolve();
    return oldCapture.promise;
  });
  const staleCollection = h.collect();
  await captureStarted.promise;
  h.invalidateSnapshot();
  oldCapture.resolve(psSnapshot({ providerPid: 221 }));
  await staleCollection;
  assert.equal(h.sent.length, 0, 'an invalidated process-snapshot generation cannot wake');
  assert.equal(h.context.claudePresenceObservationWaiters.size, 1);

  h.queueExec(psSnapshot({ providerPid: 222 }));
  await h.collect();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].lifecycleGeneration, 'pty-generation-1');
  assert.equal(h.context.claudePresenceObservationWaiters.size, 0);
});

for (const staleOwner of ['pty replacement', 'lifecycle/run epoch change']) {
  test('a successful collector does not wake an observation owned by a stale ' + staleOwner, async () => {
    const h = fixture();
    await registerUnknownPresence(h);

    if (staleOwner === 'pty replacement') {
      h.context.terminals.set(TAB, { pid: 200 });
    } else {
      h.state.lifecycle = 'pty-generation-2';
      h.state.runSeq += 1;
      h.context.terminalCommandState.set(TAB, {
        runSeq: h.state.runSeq,
        isRunning: false,
        lastExitCode: 0,
      });
    }

    h.queueExec(psSnapshot({ shellPid: 200, providerPid: 230 }));
    await h.collect();
    assert.equal(h.sent.length, 0);
    assert.equal(h.context.claudePresenceObservationWaiters.size, 0,
      'stale waiters are retired without publishing a wake for the replacement owner');
  });
}
