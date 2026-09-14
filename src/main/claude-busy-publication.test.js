'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { projectClaudePtyPresence } = require('./claude-pty-presence');
const { claudeCompactOutcomeFromReason } = require('./compact-operation-state');
const { shouldCreateHistoryResponseTiming } = require('./history-response-timings');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
function actualFunction(name, nextBoundary) {
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf('\n' + nextBoundary, start);
  assert.ok(start >= 0 && end > start, 'actual main function must remain addressable: ' + name);
  return source.slice(start, end);
}

// Run the real publication/cleanup functions against isolated process maps.
// No Electron, PTY, user files, DB or live renderer is created by this harness.
function fixture() {
  const tabId = 'claude-tab';
  const publications = [];
  const timing = [];
  const operations = [];
  const context = vm.createContext({
    projectClaudePtyPresence,
    claudeCompactOutcomeFromReason,
    shouldCreateHistoryResponseTiming,
    clearTimeout,
    console: { log() {} },
    claudeTurnBusy: new Map([[tabId, false]]),
    claudeSpinnerBusy: new Map(),
    claudeSpinnerIdleTimer: new Map(),
    claudeLocalCommandWatchers: new Map(),
    terminals: new Map([[tabId, {}]]),
    bridgeKnownSessions: new Map([[tabId, 'session']]),
    claudePromptReady: new Set([tabId]),
    claudeCliActive: new Map([[tabId, true]]),
    aiStoppingTabs: new Map(),
    claudeStartupIntents: new Map(),
    claudeAwaitingInput: new Map(),
    claudeLaunchGenerationByTab: new Map([[tabId, { generation: 'launch-1' }]]),
    claudeStartupDefaultsGateByTab: new Map(),
    compactOperations: { finish: (value) => operations.push(value) },
    clearClaudePtyCompactProofAttempt() {},
    recordActivity: (...args) => timing.push(args),
    mainWindow: {
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => publications.push({ channel, payload }) },
    },
  });
  new vm.Script([
    actualFunction('currentClaudeStartupDefaultsGate', 'function getClaudePtyRuntimePresence('),
    actualFunction('getClaudePtyRuntimePresence', "ipcMain.handle('claude:get-presence'"),
    actualFunction('emitClaudeBusyState', 'function detectClaudeCompactOutputPhase('),
    actualFunction('stopClaudeLocalCommandWatcher', 'function completeClaudeLocalCommand('),
    actualFunction('completeClaudeLocalCommand', 'function cancelClaudeLocalCommandFromInput('),
  ].join('\n')).runInContext(context);
  const beginCompact = () => {
    context.claudeLocalCommandWatchers.set(tabId, {
      command: '/compact', startedAt: Date.now(), sessionId: 'session',
      generation: 'launch-1', operationId: 'compact-1',
    });
    context.emitClaudeBusyState(tabId, true, 'local-command', { localCommand: '/compact' });
  };
  return { tabId, context, publications, timing, operations, beginCompact };
}

test('old compact cleanup cannot hide the next answer or close its activity interval', async () => {
  const { resolveAgentBusyPresentation } = await import('../renderer/utils/agentBusyPresentation.mjs');
  const f = fixture();
  f.beginCompact();
  // Same ordering as production: next UserPromptSubmit, then old watcher cleanup.
  f.context.claudeTurnBusy.set(f.tabId, true);
  f.context.completeClaudeLocalCommand(f.tabId, 'owner-changed:input-generation-changed');
  const { channel, payload } = f.publications.at(-1);
  assert.equal(channel, 'claude:busy-state');
  assert.equal(payload.busy, false, 'the old operation really ended');
  assert.equal(payload.localCommandReason, 'owner-changed:input-generation-changed');
  assert.equal(resolveAgentBusyPresentation(payload), true, 'navigation must retain the answer loader');
  assert.equal(f.context.claudeTurnBusy.get(f.tabId), true);
  assert.equal(f.context.claudeLocalCommandWatchers.has(f.tabId), false);
  assert.equal(f.context.claudeSpinnerBusy.get(f.tabId), true);
  assert.equal(f.timing.at(-1)[1], true, 'local cleanup cannot close the running interval');
  assert.equal(f.operations.at(-1).outcome, 'unknown', 'owner loss is not successful compaction');
});

test('a standalone compact still shows and clears its own loader', async () => {
  const { resolveAgentBusyPresentation } = await import('../renderer/utils/agentBusyPresentation.mjs');
  const f = fixture();
  f.beginCompact();
  assert.equal(resolveAgentBusyPresentation(f.publications.at(-1).payload), true);
  f.context.completeClaudeLocalCommand(f.tabId, 'compact_boundary');
  const payload = f.publications.at(-1).payload;
  assert.equal(resolveAgentBusyPresentation(payload), false);
  assert.equal(payload.busy, false);
  assert.equal(payload.reason, 'local-command');
  assert.equal(payload.localCommand, '/compact');
  assert.equal(payload.localCommandReason, 'compact_boundary', 'Run after retains the exact success proof');
  assert.equal(f.timing.at(-1)[1], false);
});

test('successful compact outcome remains an end edge even when another answer is busy', async () => {
  const { resolveAgentBusyPresentation } = await import('../renderer/utils/agentBusyPresentation.mjs');
  const f = fixture();
  f.beginCompact();
  f.context.claudeTurnBusy.set(f.tabId, true);
  f.context.completeClaudeLocalCommand(f.tabId, 'compact_summary');
  const payload = f.publications.at(-1).payload;
  assert.equal(payload.busy, false, 'aggregation must not erase the automation outcome');
  assert.equal(payload.localCommandReason, 'compact_summary');
  assert.equal(resolveAgentBusyPresentation(payload), true);
});

test('current main maps, not a previous event, decide whether local cancellation is idle', () => {
  for (const reason of ['input-escape', 'input-ctrl-c', 'stop-failure', 'provider-error']) {
    const f = fixture();
    f.beginCompact();
    f.context.claudeTurnBusy.set(f.tabId, false);
    f.context.completeClaudeLocalCommand(f.tabId, reason);
    assert.equal(f.publications.at(-1).payload.activityBusy, false, reason);
    assert.equal(f.context.claudeLocalCommandWatchers.has(f.tabId), false);
    assert.equal(f.timing.at(-1)[1], false);
  }
});

test('a startup-local event uses the same gate as the presence snapshot', async () => {
  const { resolveAgentBusyPresentation } = await import('../renderer/utils/agentBusyPresentation.mjs');
  const f = fixture();
  f.context.claudeStartupDefaultsGateByTab.set(f.tabId, { generation: 'launch-1', status: 'pending' });
  f.beginCompact();
  const payload = f.publications.at(-1).payload;
  assert.equal(payload.busy, true, 'local operation still began');
  assert.equal(resolveAgentBusyPresentation(payload), false, 'startup remains outside public turn activity');
});
