'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { projectClaudePtyPresence } = require('./claude-pty-presence');
const main = fs.readFileSync(require.resolve('./main'), 'utf8');
const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const declaration = name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast);
const plain = value => JSON.parse(JSON.stringify(value));

function harness() {
  const events = [], listeners = new Map();
  const ctx = vm.createContext({
    console: { log() {}, warn() {} }, Date, projectClaudePtyPresence,
    terminals: new Map([['T', {}]]), bridgeKnownSessions: new Map([['T', 'S']]),
    claudeTurnBusy: new Map(), claudeLocalCommandWatchers: new Map(),
    claudePromptReady: new Set(['T']), aiStoppingTabs: new Map(),
    claudeStartupIntents: new Map(), claudeAwaitingInput: new Map(),
    claudeLaunchGenerationByTab: new Map([['T', { generation: 'L' }]]),
    claudeStartupDefaultsGateByTab: new Map(), claudeStartupGateRevisions: new Map(), claudeCliActive: new Map([['T', true]]),
    terminalProjectIds: new Map([['T', 'P']]), activityOpenIntervals: new Map(), tabCompletionNotifications: new Map(),
    projectLayoutChangedIds: new Set(), projectOrderChanged: false,
    codexKnownSessions: new Map(), codexTurnWatchers: new Map(), codexLastRunCommandPayload: new Map(),
    codexTuiReadyTabs: new Set(), geminiActiveTabs: new Set(), geminiSpinnerBusy: new Map(), sdkSessions: new Map(),
    projectManager: { db: { db: { prepare: () => ({ get: () => ({ project_id: 'P', command_type: 'claude', claude_session_id: 'S' }) }) } } },
    currentAiLifecycleIdentity: () => ({ lifecycleGeneration: 'terminal:1', sessionId: 'S' }),
    isCodexTuiEffectivelyReady: () => false,
    mainWindow: { isDestroyed: () => false, webContents: { send: (name, data) => events.push({ name, data }) } },
    _webBroadcast: (tabId, data) => events.push({ name: 'web', tabId, data }),
    scheduleProjectLayoutBroadcast() {}, scheduleProjectActivityBroadcast() {}, emitAgentReadinessChanged() {},
    consumeClaudeStartupIntent() {}, flushClaudePendingPromptAfterStartup() {},
    ensureClaudeLaunchGeneration: () => 'L', agentLaunchPreparations: { clearRejected() {} },
    claudeTrustFolderPromptHintTabs: new Set(), claudeAutoModeDefaultPromptHintTabs: new Set(),
    ensureClaudeStartupSettingsInMain() {},
    ipcMain: { emit() {}, handle: (key, fn) => listeners.set(key, fn), on: (key, fn) => listeners.set(key, fn) },
    claudeStartupMainRuntime: { retry: (_tab, expected) => ({ started: false, reason: JSON.stringify(expected) }) },
    resolveTerminalCommandState: async () => ({ expectedProcess: 'claude', providerProcessAlive: true }),
  });
  const names = ['getClaudePtyRuntimePresence', 'publishClaudeStartupDefaultsGate', 'publishClaudePromptReady',
    'readMainAgentStartReadiness', 'computeProjectActivity'];
  if (main.includes('function currentClaudeStartupDefaultsGate(')) names.push('currentClaudeStartupDefaultsGate');
  if (main.includes('function readClaudeStartupGateSnapshot(')) names.push('readClaudeStartupGateSnapshot');
  vm.runInContext(names.map(declaration).join('\n'), ctx);
  for (const key of ['claude:get-startup-defaults-gate', 'claude:dismiss-startup-defaults-failure', 'claude:retry-startup-defaults']) {
    const node = ast.statements.find(n => n.getText(ast).startsWith("ipcMain.handle('" + key + "'"));
    if (node) vm.runInContext(node.getText(ast), ctx);
  }
  const legacy = ast.statements.find(n => n.getText(ast).startsWith("ipcMain.on('claude:startup-defaults-gate'"));
  vm.runInContext(legacy.getText(ast), ctx);
  return { ctx, events, listeners, gate: status => ctx.claudeStartupDefaultsGateByTab.set('T', { status, generation: 'L', attemptId: 'A', error: status === 'failed' ? 'API error: 429' : null }) };
}

test('actual main presence separates a failed setting from a still running launch without allowing idle Send', () => {
  const { ctx, gate } = harness();
  for (const [status, expected] of [['pending', 'starting'], ['failed', 'active'], ['ready', 'active'], ['cleared', 'active']]) {
    gate(status);
    const actual = ctx.getClaudePtyRuntimePresence('T');
    assert.equal(actual.status, expected, status);
    assert.equal(actual.inputReady, ['ready', 'cleared'].includes(status), status);
  }
  ctx.claudeStartupDefaultsGateByTab.set('T', { status: 'failed', generation: 'old' });
  assert.equal(ctx.getClaudePtyRuntimePresence('T').inputReady, true, 'old launch cannot gate the current composer');
});

test('actual gate and prompt publications keep a live successor busy on ready, pending and failed edges', () => {
  const { ctx, events, gate } = harness();
  ctx.claudeTurnBusy.set('T', true);
  for (const status of ['pending', 'failed', 'ready']) {
    ctx.publishClaudeStartupDefaultsGate({ tabId: 'T', generation: 'L', status, error: status === 'failed' ? '429' : null });
    const published = events.filter(e => e.name === 'web').at(-1).data;
    assert.equal(published.sessionStatus, 'busy', status);
    assert.equal(published.busy, true, status);
    assert.equal(published.inputReady, true, 'the real accepted turn keeps existing type-ahead capability');
  }
  gate('failed');
  ctx.claudePromptReady.delete('T');
  ctx.publishClaudePromptReady('T');
  const published = events.filter(e => e.name === 'web').at(-1).data;
  assert.equal(published.busy, true);
  assert.equal(published.startupDefaultsPending, false, 'failed is not an unfinished transaction');
});

test('actual workflow activity does not turn failed settings into startup or erase the real response loader', () => {
  const { ctx, gate } = harness();
  gate('failed');
  let activity = plain(ctx.computeProjectActivity()).projects;
  assert.equal(activity[0].tabs[0].status, 'active');
  assert.equal(activity[0].streaming, false);
  assert.equal(activity[0].tabs[0].inputReady, false);
  ctx.claudeTurnBusy.set('T', true);
  activity = plain(ctx.computeProjectActivity()).projects;
  assert.equal(activity[0].tabs[0].status, 'busy');
  assert.equal(activity[0].tabs[0].inputReady, true);
  assert.equal(activity[0].streaming, true);
});

test('the PTY settings projection does not override an SDK response that has no terminal process', () => {
  const { ctx } = harness();
  ctx.terminals.clear(); ctx.bridgeKnownSessions.clear(); ctx.claudeCliActive.clear(); ctx.claudePromptReady.clear();
  ctx.sdkSessions.set('T', {});
  const activity = plain(ctx.computeProjectActivity()).projects;
  assert.equal(activity[0].tabs[0].status, 'busy');
  assert.equal(activity[0].streaming, true);
});

test('readiness after main restart verifies the live process instead of reporting absence from empty maps', async () => {
  const { ctx } = harness();
  ctx.bridgeKnownSessions.clear(); ctx.claudeCliActive.clear(); ctx.claudePromptReady.clear();
  const result = await ctx.readMainAgentStartReadiness('T', 'claude');
  assert.equal(result.status, 'starting');
  assert.equal(result.inputReady, false);
});

test('actual exact dismissal hides only one explanation, keeps failed proof and survives reread', () => {
  const { ctx, listeners, events } = harness();
  ctx.publishClaudeStartupDefaultsGate({ tabId: 'T', generation: 'L', attemptId: 'A', status: 'failed', error: 'API error: 429' });
  const dismiss = listeners.get('claude:dismiss-startup-defaults-failure');
  assert.equal(dismiss({}, { tabId: 'T', generation: 'old', attemptId: 'A' }).dismissed, false);
  const accepted = dismiss({}, { tabId: 'T', generation: 'L', attemptId: 'A' });
  assert.equal(accepted.dismissed, true);
  assert.equal(accepted.gate.status, 'failed');
  assert.equal(ctx.getClaudePtyRuntimePresence('T').inputReady, false);
  assert.equal(ctx.getClaudePtyRuntimePresence('T').status, 'active');
  assert.equal(listeners.get('claude:get-startup-defaults-gate')({}, { tabId: 'T' }).gate.dismissed, true);
  assert.equal(events.at(-1).data.dismissed, true);
  ctx.publishClaudeStartupDefaultsGate({ tabId: 'T', generation: 'L', attemptId: 'B', status: 'failed', error: 'new' });
  assert.equal(dismiss({}, { tabId: 'T', generation: 'L', attemptId: 'A' }).dismissed, false);
  assert.equal(ctx.readClaudeStartupGateSnapshot('T').gate.dismissed, false);
});

test('actual gate publisher rejects an old launch and retry IPC preserves exact attempt', () => {
  const { ctx, listeners } = harness();
  ctx.publishClaudeStartupDefaultsGate({ tabId: 'T', generation: 'L', attemptId: 'A', status: 'ready' });
  const version = ctx.readClaudeStartupGateSnapshot('T').revision;
  ctx.publishClaudeStartupDefaultsGate({ tabId: 'T', generation: 'old', attemptId: 'old', status: 'failed' });
  assert.equal(ctx.readClaudeStartupGateSnapshot('T').revision, version);
  listeners.get('claude:startup-defaults-gate')({}, { tabId: 'T', status: 'cleared' });
  assert.equal(ctx.readClaudeStartupGateSnapshot('T').gate.status, 'ready', 'legacy renderer cannot erase main proof');
  const retry = listeners.get('claude:retry-startup-defaults')({}, { tabId: 'T', generation: 'L', attemptId: 'A' });
  assert.deepEqual(JSON.parse(retry.reason), { generation: 'L', attemptId: 'A' });
  ctx.claudeLaunchGenerationByTab.set('T', { generation: 'L2' });
  assert.equal(ctx.readClaudeStartupGateSnapshot('T').gate, null, 'no old launch failure returned from the read API');
});

test('process proof finishing after terminal replacement cannot lend its liveness to the new terminal', async () => {
  const { ctx } = harness();
  ctx.bridgeKnownSessions.clear(); ctx.claudeCliActive.clear(); ctx.claudePromptReady.clear();
  ctx.resolveTerminalCommandState = async () => {
    ctx.terminals.set('T', {});
    ctx.claudeLaunchGenerationByTab.set('T', { generation: 'L2' });
    return { expectedProcess: 'claude', providerProcessAlive: true };
  };
  const result = await ctx.readMainAgentStartReadiness('T', 'claude');
  assert.equal(result.status, 'unknown');
  assert.equal(result.launchId, 'L2');
  assert.equal(result.inputReady, false);
});

test('actual slash scanner → startup transaction retains the full provider error beyond log preview', async () => {
  const { scanClaudeStartupSlashRecords } = require('./claude-startup-slash-proof');
  const { createClaudeStartupMainRuntime } = require('./claude-startup-main-runtime');
  const raw = 'API error: 429 ' + JSON.stringify({ error: { type: 'rate_limit_error', message: 'long reason '.repeat(60) }, request_id: 'request-after-300' });
  const records = [
    { uuid: 'W', sessionId: 'S', message: { content: '<command-name>/model</command-name><command-args>fable</command-args>' } },
    { uuid: 'E', parentUuid: 'W', sessionId: 'S', message: { content: '<local-command-stdout>' + raw + '</local-command-stdout>' } },
  ];
  const events = [];
  const runtime = createClaudeStartupMainRuntime({
    currentLaunchGeneration: () => 'L', resolveSettings: async () => ({ model: 'fable' }),
    sendCommand: async () => ({ success: true, submitted: true }),
    proveCommand: async () => scanClaudeStartupSlashRecords(records, '/model fable', { sessionId: 'S' }),
    publishGate: value => events.push(value),
  });
  const attempt = runtime.ensure({ tabId: 'T', generation: 'L', trigger: 'test' });
  await attempt.promise;
  assert.equal(events.at(-1).status, 'failed');
  assert.match(events.at(-1).error, /request-after-300/);
  assert.equal(events.at(-1).errorCode, 'claude_rate_limit');
});
