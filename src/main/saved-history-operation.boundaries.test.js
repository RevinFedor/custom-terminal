'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const { SavedHistoryOperations } = require('./saved-history-operation');
const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const tree = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
function find(predicate) {
  let found;
  function visit(node) { if (predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); }
  visit(tree); assert.ok(found); return found;
}

test('actual Stop IPC forwards a receipt authority tied to the real target, not a caller-supplied other tab', async () => {
  const call = find(n => ts.isCallExpression(n) && n.expression.getText(tree) === 'ipcMain.handle'
    && n.arguments[0]?.text === 'terminal:stop-ai-process');
  const context = { options: null, path, srcMainDir: __dirname,
    stopAiProcessInTabSerialized: async (tabId, options) => {
      context.options = options;
      return options.preSignalGuard();
    }, require: () => ({ validateSavedHistoryStop: request => {
      assert.equal(request.tabId, 'real-tab');
      assert.equal(request.operationId, 'same-operation');
      return { allowed: false, reason: 'owner-changed' };
    } }) };
  const shared = find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'stopAgentProcessScenarioInMain');
  vm.runInNewContext(shared.getText(tree), context);
  const handler = vm.runInNewContext('(' + call.arguments[1].getText(tree) + ')', context);
  const result = await handler(null, { tabId: 'real-tab', authority: { kind: 'saved-history', tabId: 'other-tab', operationId: 'same-operation' } });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'owner-changed');
});

test('actual Codex write callback revalidates the operation after awaited shell proof and before any bytes', async () => {
  const parent = find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'runCodexCommandFromPayloadInner');
  let callback;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'withPtyWriteLock'
      && node.arguments[1]?.getText(tree).includes('writeAgentLaunchCommandToIdleShell')) callback = node.arguments[1];
    ts.forEachChild(node, visit);
  }
  visit(parent); assert.ok(callback);
  for (const stale of [false, true]) {
    const events = [];
    const context = { term: {}, tabId: 'real-tab', payload: { historyOperation: { tabId: 'forged-tab', operationId: 'op' } },
      sessionId: 'child', launchId: 'launch', launchRunSeq: 4, ownsMcpStartupRecoveryHandoff: false,
      providerProxyBaseUrl: null, cmdLine: 'codex resume child', startedAt: 0,
      proveIdleShellForAgentLaunch: async () => { events.push('proof'); return { allowed: true }; },
      path, srcMainDir: __dirname, require: () => ({ validateSavedHistoryResume: (request, phase, detail) => {
        assert.equal(request.tabId, 'real-tab'); assert.equal(phase, 'write'); assert.equal(detail.sessionId, 'child');
        events.push('operation-proof'); if (stale) throw Error('stale');
      } }), rebaseCodexLaunchObservationAtWrite: () => {}, disarmCodexProviderSemanticSource: () => {},
      writeAgentLaunchCommandToIdleShell: () => events.push('write') };
    const run = vm.runInNewContext('(' + callback.getText(tree) + ')', context);
    if (stale) await assert.rejects(run, /stale/); else assert.equal((await run()).written, true);
    assert.deepEqual(events, stale ? ['proof', 'operation-proof'] : ['proof', 'operation-proof', 'write']);
  }
});

test('actual web startup adapter registers one IPC owner and resolves source modules from its own directory', () => {
  const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const parsed = ts.createSourceFile('web.js', source, ts.ScriptTarget.Latest, true);
  let selected;
  function visit(node) {
    if (ts.isIfStatement(node) && node.expression.getText(parsed) === 'savedHistoryRuntime && transcriptService') selected = node;
    ts.forEachChild(node, visit);
  }
  visit(parsed); assert.ok(selected);
  const handlers = new Map();
  const context = { path, __dirname, savedHistoryRuntime: {}, transcriptService: {}, savedHistoryIpcRegistered: false,
    codexDataApi: {}, claudeDataApi: null, app: { getPath: () => '/private/test-user-data' },
    buildCodexTimeline: () => [], resolveHistorySessionInfo: () => ({}),
    findOrchestrationTabDescriptor: () => null, bridgeRequest: () => {}, webBroadcast: () => {},
    reservedInboxTabId: () => 'inbox-tab', ensureExplicitAgentTabOpen: () => {}, claimInboxHistoryCleanup: () => {},
    ipcMain: { handle: (name, handler) => { assert.equal(handlers.has(name), false); handlers.set(name, handler); } },
    require: file => file.endsWith('project-manager') ? { db: {} } : require(file) };
  const sandbox = vm.createContext(context);
  const declaration = parsed.statements.find(n => ts.isVariableStatement(n) && n.getText(parsed).startsWith('const srcMainDir ='));
  assert.ok(declaration);
  vm.runInContext(declaration.getText(parsed), sandbox);
  vm.runInContext(selected.getText(parsed), sandbox);
  vm.runInContext(selected.getText(parsed), sandbox);
  assert.deepEqual([...handlers.keys()], ['saved-history:step', 'saved-history:get']);
});

test('real SQLite receipt survives reopen; unknown work cannot become a blind retry', async t => {
  const Sqlite = require('better-sqlite3');
  const DatabaseManager = require('./database');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-history-receipt-'));
  let sqlite;
  try { sqlite = new Sqlite(path.join(dir, 'receipt.sqlite')); }
  catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (error.code === 'ERR_DLOPEN_FAILED') { t.skip('Electron ABI: run with ELECTRON_RUN_AS_NODE=1'); return; }
    throw error;
  }
  t.after(() => { if (sqlite.open) sqlite.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  sqlite.exec('CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)');
  const store = () => {
    const db = Object.create(DatabaseManager.prototype); db.db = sqlite; return db;
  };
  const request = { operationId: 'durable-op', kind: 'rewind', expectedSessionId: 'source', targetUuid: 'exact-user' };
  const registry = new SavedHistoryOperations({ db: store(), dispatch: async () => {} });
  registry.accept('tab', request);
  await Promise.resolve();
  sqlite.close(); sqlite = new Sqlite(path.join(dir, 'receipt.sqlite'));
  const reopened = new SavedHistoryOperations({ db: store(), dispatch: () => { throw Error('must not repeat'); } });
  assert.equal(reopened.read('tab', 'durable-op').state, 'outcome-unknown');
  assert.equal(reopened.accept('tab', request).idempotent, true);
  assert.throws(() => reopened.accept('tab', { ...request, operationId: 'another' }), /history_operation_pending/);
  const key = reopened.key('tab', 'durable-op');
  const record = reopened.db.getAppState(key);
  reopened.db.setAppState(key, { ...record, state: 'completed', phase: 'completed', pending: false,
    success: true, bindingCommitted: true, activeSessionId: 'child', draft: { text: 'saved', chips: [], imagePaths: [] } });
  sqlite.close(); sqlite = new Sqlite(path.join(dir, 'receipt.sqlite'));
  const final = new SavedHistoryOperations({ db: store() }).read('tab', 'durable-op');
  assert.equal(final.success, true); assert.equal(final.draft.text, 'saved'); assert.equal(final.activeSessionId, 'child');
});
