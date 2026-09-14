'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const mainAst = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
const rendererSource = fs.readFileSync(path.join(__dirname, '../renderer/utils/claudePtyActions.ts'), 'utf8');
const rendererAst = ts.createSourceFile('actions.ts', rendererSource, ts.ScriptTarget.Latest, true);
const declaration = (ast, name) => {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, name);
  return node.getText(ast).replace(/^export /, '');
};
const compile = source => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;

function harness(t, { writer = 'B', changeDuringAudit = false, changeDuringSettingsRead = false } = {}) {
  let db;
  try { db = new Database(':memory:'); }
  catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI; run with ELECTRON_RUN_AS_NODE=1');
      return null;
    }
    throw error;
  }
  t.after(() => db.close());
  const store = createAgentSendReceiptStore(db);
  const writes = [], settingCalls = [], ipcRequests = [];
  const bindings = new Map(writer ? [['tab', writer]] : []);
  const term = { write: value => writes.push(value) };
  const handlers = new Map();
  const context = vm.createContext({
    reconcileClaudeStartupAfterSettings: () => {},
    _webBroadcast() {},
    conversationOwners: { noteInput() {} },
    ...require('./agent-send-target-precondition'),
    ...require('./agent-history-send-receipt'),
    ...require('./agent-send-receipt-store'),
    ...require('./claude-prompt-audit'),
    ...require('./claude-prompt-transport'),
    ...require('./claude-composer-proof'),
    ...require('./history-prompt-presentations'),
    ...require('./prompt-queue-source'),
    ...require('./terminal-paste-profile'),
    ...require('./prompt-audit-fingerprint'),
    AGENT_SEND_DURABLE_STATES: require('./agent-send-receipt-store').STORE_STATES,
    Buffer, Date, console: { log() {}, warn() {}, error() {} },
    require, path, srcMainDir: __dirname,
    terminals: new Map([['tab', term]]),
    terminalLifecycleEpochs: new WeakMap([[term, 'terminal-instance']]),
    terminalCommandState: new Map([['tab', { runSeq: 7, isRunning: true }]]),
    terminalInputRevisions: new Map([['tab', 1]]),
    getTerminalLifecycleGeneration: () => 'G', getHeadlessTerminalMirror: () => null,
    bridgeKnownSessions: bindings, claudeLaunchGenerationByTab: new Map(), findClaudePidByTab: () => 100,
    mainWindow: null, aiStoppingTabs: new Map(), hasLiveClaudeInTab: () => true,
    agentSendReceiptStore: store,
    agentSendCancellations: { isCancelled: () => false },
    CLAUDE_PASTE_AUDIT_TIMEOUT_MS: 15, CODEX_PASTE_AUDIT_TIMEOUT_MS: 15,
    activityOpenIntervals: new Map(), responseActivityPreflights: new Map(),
    resolveClaudeSessionFileForTab: (_tab, sid) => '/fixture/' + sid,
    captureClaudePromptAuditBoundary: async (_file, { sessionId }) => {
      if (changeDuringAudit) bindings.set('tab', 'B');
      return { available: true, sessionId, byteOffset: 10, fileSize: 10 };
    },
    drainPtyData: async () => {},
    validatePromptQueueImageMarkers: async () => ({ success: true }),
    claudeDataApi: { getConfirmedSettings: async () => {
      settingCalls.push('read');
      if (changeDuringSettingsRead) bindings.set('tab', 'B');
      return { sessionId: bindings.get('tab'), model: 'model-A', effort: 'high' };
    } },
    sendClaudeCommandInternal: async () => { settingCalls.push('write'); return { success: true }; },
    readClaudeStartupSlashProof: async () => ({ success: true }),
    inspectClaudeExactSettingInput: async () => ({ success: true }),
    toggleClaudeThinkingInternal: async () => { settingCalls.push('think'); return { success: true }; },
    beginAgentSettingsActivity: () => null, agentSettingsActivity: { end() {} },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  });
  const lockStart = mainSource.indexOf('const pasteInflight = new WeakMap();');
  const lockEnd = mainSource.indexOf('\nfunction markActivePtySubmit(', lockStart);
  vm.runInContext(mainSource.slice(lockStart, lockEnd), context);
  for (const name of ['getTerminalInputRevision', 'bumpTerminalInputRevision', 'findTabIdForTerm',
    'pasteAuditHash', 'pasteAuditPreview', 'readAgentSendDestinationAtWriteBoundary',
    'agentSendRequestExpectedTargets', 'agentSendRequestTargetFailure', 'expectedKnownEmptySend', 'assertKnownEmptySend',
    'safePasteAndSubmit', '_safePasteAndSubmitInner', 'finishSafePasteAfterWrite']) {
    vm.runInContext(declaration(mainAst, name), context);
  }
  const settingsRuntime = mainAst.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => item.name.getText(mainAst) === 'claudeSettingsSendRuntime'));
  assert.ok(settingsRuntime);
  vm.runInContext(settingsRuntime.getText(mainAst), context);
  for (const channel of ['terminal:paste', 'claude:send-prompt-with-settings']) {
    const handler = mainAst.statements.find(node => ts.isExpressionStatement(node)
      && ts.isCallExpression(node.expression) && node.expression.expression.getText(mainAst) === 'ipcMain.handle'
      && node.expression.arguments[0]?.text === channel);
    assert.ok(handler, channel);
    vm.runInContext(handler.getText(mainAst), context);
  }
  const renderer = vm.createContext({
    console: { log() {}, warn() {} }, sendInflight: new Map(), shortTab: value => value,
    errorText: value => String(value?.message || value), isStandaloneAgentLocalCommand: () => false,
    useWorkspaceStore: { getState: () => ({ clearInterruptedState() {} }) },
    ipcRenderer: { invoke: async (channel, request) => {
      ipcRequests.push(request);
      return handlers.get(channel)({}, request);
    } },
  });
  vm.runInContext(compile(declaration(rendererAst, 'sendClaudePtyPrompt')), renderer);
  return {
    writes, settingCalls, ipcRequests, store,
    send: options => renderer.sendClaudePtyPrompt('tab', 'original authoring text', {
      source: 'history-panel', handoffId: 'handoff-A', expectedTarget: { sessionId: 'A', toolType: 'claude' },
      ...options,
    }),
  };
}

for (const changeDuringAudit of [false, true]) {
  test('actual Claude renderer -> terminal:paste -> full paste path refuses wrong writer before bytes, async=' + changeDuringAudit, async t => {
    const h = harness(t, { writer: changeDuringAudit ? 'A' : 'B', changeDuringAudit });
    if (!h) return;
    const result = await h.send();
    assert.equal(result.code, 'agent_send_target_changed', JSON.stringify(result));
    assert.equal(result.submitted, false);
    assert.equal(result.pasteWritten, false);
    assert.deepEqual(h.writes, []);
    assert.equal(h.ipcRequests[0].expectedTarget.sessionId, 'A');
    assert.equal(h.store.list()[0].receipt.expectedTarget.sessionId, 'A');
  });
}

for (const changeDuringSettingsRead of [false, true]) {
  test('actual Claude settings+prompt owner refuses wrong destination before settings, async=' + changeDuringSettingsRead, async t => {
    const h = harness(t, { writer: changeDuringSettingsRead ? 'A' : 'B', changeDuringSettingsRead });
    if (!h) return;
    const result = await h.send({ model: 'requested-model', effort: 'high' });
    assert.equal(result.code, 'agent_send_target_changed', JSON.stringify(result));
    assert.equal(result.submitted, false);
    assert.equal(h.settingCalls.includes('write'), false);
    assert.equal(h.settingCalls.includes('think'), false);
    assert.deepEqual(h.writes, []);
  });
}

test('a History session hint locates audit data but cannot replace a missing live writer', async t => {
  const h = harness(t, { writer: null });
  if (!h) return;
  const result = await h.send({
    presentationSnapshot: { historySessionId: 'A' },
  });
  assert.equal(result.code, 'agent_send_target_changed', JSON.stringify(result));
  assert.equal(result.submitted, false);
  assert.equal(result.pasteWritten, false);
  assert.deepEqual(h.writes, []);
});
