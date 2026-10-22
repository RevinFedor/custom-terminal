'use strict';
// Real Project API router + JSON RunStore + native SQLite receipt/FIFO owners.
// Controlled leaves: Electron shell/window, project catalog and Main runtime.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const Module = require('node:module'), { EventEmitter, once } = require('node:events');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');

test('actual Project API separates eligibility, exact callback source and unresolved native FIFO', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-install-http-'));
  const oldEnv = { HOME: process.env.HOME, NOTED_WEB_PORT: process.env.NOTED_WEB_PORT };
  process.env.HOME = root;
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  process.env.NOTED_WEB_PORT = String(port);
  const db = new Database(path.join(root, 'receipts.sqlite')), receipts = createAgentSendReceiptStore(db);
  const rows = [{ id: 'P', name: 'private project', path: '/private/project',
    tabs: [{ tabId: '753', name: 'orchestrator', commandType: 'codex', codexSessionId: 'source-S', cwd: '/private/project' }] }];
  const appState = new Map();
  const manager = { getPrompts: () => [], db: { getAllProjects: () => rows,
    getProjectById: id => rows.find(p => p.id === id), getAppState: key => appState.get(key),
    setAppState: (key, value) => { appState.set(key, value); return { success: true }; },
    getTabHistoryEntriesByTabId: () => [] } };
  const original = Module._load, ipcMain = new EventEmitter();
  // Electron's newly registered Loop snapshot/reconcile IPC is outside this
  // HTTP eligibility scenario. Keep the real router and its assertions.
  ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  let runtime = [], physical = [], sourceSession = 'source-S', sourceCoherent = true;
  Module._load = function(request, parent, main) {
    if (request === 'electron') return { app: { getPath: () => root, isPackaged: false },
      BrowserWindow: { getAllWindows: () => [] }, ipcMain };
    if (request === './project-manager' && parent?.filename.endsWith('/web-server.js')) return manager;
    if (/\/ipc\/(claude-data|codex-data|settings)$/.test(request)) return {};
    return original.call(this, request, parent, main);
  };
  const web = require('./web-server');
  t.after(async () => { await web.stop(); Module._load = original; db.close();
    for (const [key, value] of Object.entries(oldEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true }); });
  web.start({ sdkSessions: new Map(), agentSendReceiptStore: receipts,
    computeActiveLoaders: () => ({ idle: runtime.length === 0, loaders: runtime }),
    computeInstallInputBlockers: () => physical,
    readAgentRuntimeSnapshot: async () => ({ coherent: sourceCoherent, toolType: 'codex', commandType: 'codex',
      status: 'active', processStatus: 'found', liveLifecycle: true, sessionId: sourceSession,
      writerConfirmed: true, writerUsableForMutation: true, inputReady: true,
      sendTarget: { toolType: 'codex', sessionId: sourceSession },
      lifecycleGeneration: 'L', terminalRunSeq: 1, inputRevision: 1 }),
  });
  web.markSendQueueRendererReady(true, 1);
  // Existing server readiness is observable, not a guessed fixed delay.
  const deadline = Date.now() + 3000;
  while (!web.getInfo().running) { assert.ok(Date.now() < deadline); await new Promise(resolve => setImmediate(resolve)); }
  const api = async (route, body) => {
    const response = await fetch('http://127.0.0.1:' + port + route, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + web.getInfo().token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  let result;
  do { result = await api('/api/install-eligibility'); if (result.status === 503) await new Promise(resolve => setImmediate(resolve)); }
  while (result.status === 503 && Date.now() < deadline);
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body.eligible, true);
  runtime = [{ tabId: '753', kind: 'codex', status: 'busy' }];
  assert.equal((await api('/api/install-eligibility')).body.eligible, false, 'real source turn is not exempted');
  assert.equal((await api('/api/active-loaders')).body.idle, false);
  runtime = []; physical = [{ tabId: '753', kind: 'input', status: 'physical-input' }];
  assert.equal((await api('/api/install-eligibility')).body.eligible, false); physical = [];
  const source = await api('/api/build-install/source', { tabId: '753', sessionId: 'source-S', projectId: 'P', installRequestId: 'I' });
  assert.equal(source.status, 200, JSON.stringify(source));
  assert.deepEqual(source.body.source.expectedTarget, { toolType: 'codex', sessionId: 'source-S' });
  assert.equal(web.buildInstallAutomationBlocked('753'), true, 'MCP holds Loop BEFORE the Voice POST/ACK');
  const bound = await api('/api/build-install/source', { tabId: '753', sessionId: 'source-S', projectId: 'P', installRequestId: 'I', installJobId: 'J' });
  assert.equal(bound.status, 200); assert.equal(bound.body.idempotent, true);
  const waiting = await api('/api/active-loaders');
  assert.equal(waiting.body.idle, false); assert.ok(waiting.body.loaders.some(row => row.kind === 'build-install'));
  assert.equal((await api('/api/install-eligibility')).body.eligible, true, 'logical install loader does not deadlock its own installer');
  sourceSession = 'replacement';
  assert.equal((await api('/api/build-install/source', { tabId: '753', sessionId: 'source-S', projectId: 'P' })).status, 409);
  assert.equal((await api('/api/build-install/source', { tabId: 'missing', sessionId: 'source-S', projectId: 'P' })).status, 409);
  sourceCoherent = false;
  const forceSource = await api('/api/build-install/source', { tabId: '753', sessionId: 'source-S', projectId: 'P',
    installRequestId: 'F', installJobId: 'force-J', force: true });
  assert.equal(forceSource.status, 200); assert.equal(forceSource.body.source.sessionId, 'source-S');
  assert.equal(forceSource.body.source.identityBasis, 'saved-conversation-for-forced-restart');
  sourceCoherent = true;

  const request = { tabId: '753', provider: 'codex', handoffId: 'original', prompt: 'held original' };
  const identity = { operationKey: 'private:original', surface: 'project-api', tabId: '753', provider: 'codex',
    handoffId: 'original', requestFingerprint: fingerprintAgentSendRequest(request), promptHash: fingerprintAgentSendRequest(request.prompt), promptLength: request.prompt.length };
  const attempt = receipts.beginAttempt(identity); assert.equal(attempt.action, 'attempt-started');
  receipts.markAttemptState(identity.operationKey, attempt.attemptId, 'enter-armed');
  assert.equal((await api('/api/install-eligibility')).body.eligible, false, 'Enter arm blocks without a loader');
  receipts.settleAttempt(identity.operationKey, attempt.attemptId, { success: null, submitted: true,
    deliveryUnknown: true, status: 'delivery-unknown' });
  const unknown = await api('/api/install-eligibility'); assert.equal(unknown.body.eligible, false);
  assert.ok(unknown.body.blockers.some(b => b.status === 'delivery-unknown'));
  assert.equal(receipts.get(identity.operationKey).state, 'delivery-unknown', 'GET cannot release or rewrite UNKNOWN');
});
