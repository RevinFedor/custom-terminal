'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { createClaudeSettingsSendRuntime } = require('./claude-settings-send');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const {
  createAgentSendReceiptRegistry,
  fingerprintAgentSendRequest,
  isAgentSendProviderQueueAccepted,
  RECEIPT_STATES,
} = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { withPromptOriginPresentation } = require('./history-prompt-presentations');

const read = relative => fs.readFileSync(path.join(__dirname, relative), 'utf8');
const mainSource = read('main.js');
const webSource = read('web-server.js');
const rendererSource = read('../renderer/utils/claudePtyActions.ts');
const quiet = { log() {}, warn() {}, error() {} };
const sources = new Map();
function ast(source) {
  if (!sources.has(source)) sources.set(source,
    ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true));
  return sources.get(source);
}
function declaration(source, name) {
  const parsed = ast(source);
  const node = parsed.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, 'actual declaration: ' + name);
  return node.getText(parsed).replace(/^export /, '');
}
function compile(source) {
  return ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
}
function actualSettingsSendIpc(runtime) {
  const parsed = ast(mainSource);
  const node = parsed.statements.find(n => ts.isExpressionStatement(n)
    && ts.isCallExpression(n.expression)
    && n.expression.expression.getText(parsed) === 'ipcMain.handle'
    && n.expression.arguments[0]?.text === 'claude:send-prompt-with-settings');
  assert.ok(node, 'actual settings/send IPC registration');
  let handler;
  vm.runInNewContext(node.getText(parsed), {
    console: quiet,
    claudeSettingsSendRuntime: runtime,
    ipcMain: { handle: (_channel, fn) => { handler = fn; } },
  });
  return handler;
}
function actualPtyWriteQueue() {
  const start = mainSource.indexOf('const pasteInflight = new WeakMap();');
  const end = mainSource.indexOf('\nfunction markActivePtySubmit(', start);
  assert.ok(start > 0 && end > start);
  return vm.runInNewContext(mainSource.slice(start, end) + '\n({ withPtyWriteLock })');
}

// Execute the actual IPC registration, renderer send function, Project API
// scenario and SQLite store. Only the physical PTY/provider boundary is a
// fault-injected fixture: no Electron app, CLI, model, auth or live DB is used.
function harness(t, initialFault) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-settings-receipt-'));
  const databasePath = path.join(directory, 'receipts.sqlite');
  let db;
  t.after(() => {
    if (db?.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  try {
    db = new Database(databasePath);
  } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI; run with ELECTRON_RUN_AS_NODE=1');
      return null;
    }
    throw error;
  }
  let store = createAgentSendReceiptStore(db);
  const term = {};
  const queue = actualPtyWriteQueue();
  const writes = [];
  const ipcReplies = [];
  const bridgeReplies = [];
  const statesAtFailure = [];
  const draftTransfer = { id: 'exact-capture', text: 'unchanged draft', imagePaths: ['/fixture/image.png'] };
  let fault = initialFault;
  const runtime = createClaudeSettingsSendRuntime({
    getTerminal: () => term,
    withWriteLock: queue.withPtyWriteLock,
    captureRuntime: () => ({ term }),
    isRuntimeCurrent: () => true,
    readConfirmedSettings: async () => {
      if (fault === 'before-paste') throw Object.assign(new Error('setting proof unavailable'), { draftTransfer });
      return { success: true, sessionId: 'session', latestSessionId: 'session', model: 'model-A', modelProofAt: 1 };
    },
    sendCommand: async () => assert.fail('matching settings need no slash command'),
    readProof: async () => assert.fail('matching settings need no extra proof'),
    confirmDialog: async () => assert.fail('matching settings need no picker'),
    retryExactInput: async () => assert.fail('matching settings need no retry'),
    settleClaim: async () => assert.fail('matching settings have no claim'),
    toggleThinking: async () => assert.fail('no thinking intent'),
    paste: async (_term, content, request) => {
      assert.equal(request.deferPostWriteResolution, true);
      assert.equal(store.markAttemptState(request.sendOperationKey, request.sendAttemptId,
        STORE_STATES.ENTER_ARMED).ok, true);
      statesAtFailure.push(store.get(request.sendOperationKey).state);
      if (fault === 'armed-before-write-refusal') return {
        success: false, accepted: false, submitted: false,
        pasteWritten: false, enterWritten: false, status: 'not-submitted',
        code: 'agent_send_cancelled_before_write', draftTransfer,
      };
      writes.push('paste:' + content, 'Enter');
      if (fault === 'paste-rejection') throw new Error('synthetic failure after physical Enter');
      return {
        submitted: true, enterWritten: true,
        finishAfterPtyWrite: async () => {
          if (fault === 'audit-rejection') throw new Error('synthetic post-Enter resolution failure');
          return { success: true, submitted: true, enterWritten: true, status: 'sent' };
        },
      };
    },
  });
  const handler = actualSettingsSendIpc(runtime);
  const renderer = vm.createContext({
    console: quiet,
    sendInflight: new Map(),
    shortTab: id => id,
    errorText: error => String(error?.message || error),
    useWorkspaceStore: { getState: () => ({ clearInterruptedState() {} }) },
    isStandaloneAgentLocalCommand: () => false,
    ipcRenderer: { invoke: async (channel, request) => {
      assert.equal(channel, 'claude:send-prompt-with-settings');
      // Match the successful IPC data channel, not custom Error properties
      // which Electron is free to discard from rejected invoke() calls.
      const receipt = structuredClone(await handler({}, structuredClone(request)));
      ipcReplies.push(receipt);
      return receipt;
    } },
  });
  vm.runInContext(compile(declaration(rendererSource, 'sendClaudePtyPrompt')), renderer);
  const projectApi = vm.createContext({
    console: quiet,
    tabWorkContext: null, // This receipt fixture has no attached context updates.
    crypto: require('node:crypto'),
    agentSendReceiptStartupReady: Promise.resolve(),
    agentSendBridgeTimeoutMs: 1000,
    agentSendReceiptStore: store,
    agentSendReceiptRegistry: createAgentSendReceiptRegistry(),
    AGENT_SEND_RECEIPT_STATES: RECEIPT_STATES,
    fingerprintAgentSendRequest,
    promptAuditFingerprint,
    withPromptOriginPresentation,
    isAgentSendProviderQueueAccepted,
    shortId: id => id,
    findOrchestrationTabDescriptor: () => ({
      projectId: 'project', toolType: 'claude', tabType: 'terminal', sessionId: 'session',
    }),
    bridgeRequest: async (action, request) => {
      assert.equal(action, 'sendAgentPromptScenario');
      const receipt = await renderer.sendClaudePtyPrompt(request.tabId, request.prompt, request);
      bridgeReplies.push(receipt);
      return receipt;
    },
  });
  vm.runInContext([
    'durableRecordHasProviderQueueAcceptance', 'durableAgentSendReplay',
    'durableAgentSendFailure', 'runPreparedAgentSendScenario', 'runAgentSendScenario',
  ].map(name => declaration(webSource, name)).join('\n'), projectApi);
  const request = {
    tabId: 'tab', prompt: 'one exact user prompt', model: 'model-A',
    handoffId: 'same-handoff', sendOperationKey: 'project:tab:same-handoff',
    provider: 'claude', sessionId: 'session', source: 'project-api',
  };
  return {
    writes, ipcReplies, bridgeReplies, statesAtFailure, draftTransfer, request,
    setFault: value => { fault = value; },
    record: () => store.get(request.sendOperationKey),
    send: () => projectApi.runAgentSendScenario(request),
    reopen: () => {
      db.close();
      db = new Database(databasePath);
      store = createAgentSendReceiptStore(db);
      projectApi.agentSendReceiptStore = store;
      projectApi.agentSendReceiptRegistry = createAgentSendReceiptRegistry();
    },
  };
}

for (const fault of ['paste-rejection', 'audit-rejection']) {
  test('actual settings IPC → renderer → Project API preserves unknown after ' + fault, async t => {
    const h = harness(t, fault);
    if (!h) return;
    const first = await h.send();
    assert.deepEqual(h.statesAtFailure, ['enter-armed']);
    assert.deepEqual(h.writes, ['paste:one exact user prompt', 'Enter']);
    for (const receipt of [h.ipcReplies[0], h.bridgeReplies[0], first, h.record().receipt]) {
      assert.equal(receipt.submitted, null, 'an exception is not proof of no physical Enter');
      assert.equal(receipt.deliveryUnknown, true, 'renderer and API retain the explicit uncertainty');
      assert.equal(receipt.status, 'delivery-unknown');
      assert.notEqual(receipt.enterWritten, false);
      assert.notEqual(receipt.pasteWritten, false);
    }
    assert.equal(h.record().state, STORE_STATES.DELIVERY_UNKNOWN);
    const attemptId = h.record().attemptId;
    h.setFault(null);
    const replay = await h.send();
    assert.equal(replay.replayed, true);
    assert.equal(replay.submitted, null);
    assert.equal(h.record().attemptId, attemptId);
    h.reopen();
    assert.equal(h.record().state, STORE_STATES.DELIVERY_UNKNOWN);
    const afterReopen = await h.send();
    assert.equal(afterReopen.replayed, true);
    assert.equal(afterReopen.submitted, null);
    assert.equal(afterReopen.attemptId, attemptId);
    assert.equal(h.ipcReplies.length, 1, 'no second IPC send, including after durable reopen');
    assert.equal(h.writes.filter(value => value === 'Enter').length, 1);
  });
}

for (const fault of ['before-paste', 'armed-before-write-refusal']) {
  test('actual settings IPC preserves a retryable proven no-write result: ' + fault, async t => {
    const h = harness(t, fault);
    if (!h) return;
    const first = await h.send();
    for (const receipt of [h.ipcReplies[0], h.bridgeReplies[0], first, h.record().receipt]) {
      assert.equal(receipt.submitted, false);
      assert.equal(receipt.enterWritten, false);
      assert.equal(receipt.pasteWritten, false);
      assert.equal(receipt.deliveryUnknown, undefined);
      assert.deepEqual(receipt.draftTransfer, h.draftTransfer);
    }
    assert.deepEqual(h.writes, []);
    assert.equal(h.record().state, STORE_STATES.NOT_SUBMITTED);
    assert.deepEqual(h.statesAtFailure, fault === 'before-paste' ? [] : ['enter-armed']);
    const attemptId = h.record().attemptId;
    h.setFault(null);
    const retried = await h.send();
    assert.equal(retried.submitted, true);
    assert.notEqual(h.record().attemptId, attemptId);
    assert.equal(h.record().attempt, 2);
    assert.equal(h.writes.filter(value => value === 'Enter').length, 1);
    assert.equal(h.ipcReplies.length, 2);
  });
}
