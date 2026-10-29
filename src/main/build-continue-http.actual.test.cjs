'use strict';
// Actual authenticated web router, SQLite message/receipt owners and RunStore.
// Electron Quit and Main runtime/provider facts are controlled; no app is opened.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const Module = require('node:module'), { EventEmitter, once } = require('node:events');
const { NodeSqlite } = require('./fixtures/build-install-posthook.cjs');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');

async function fixture(t, failWrite = false, terminalAttention = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-continue-http-'));
  const db = new NodeSqlite(path.join(root, 'private.sqlite'));
  db.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT)');
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const oldEnv = { NOTED_WEB_PORT: process.env.NOTED_WEB_PORT, NOTED_DISCOVERY_DIR: process.env.NOTED_DISCOVERY_DIR };
  process.env.NOTED_WEB_PORT = String(port); process.env.NOTED_DISCOVERY_DIR = path.join(root, 'discovery');
  const projects = [{ id: 'project', name: 'private', path: root, tabs: [
    { tabId: 'worker', commandType: 'codex', codexSessionId: 'A', cwd: root },
    { tabId: 'waiting-source', commandType: 'codex', codexSessionId: 'P', cwd: root }] }];
  const manager = { db: { db, getAllProjects: () => projects, getProjectById: id => projects.find(p => p.id === id),
    getTabHistoryEntriesByTabId: () => [],
    getAppState: key => { const row = db.prepare('SELECT value FROM app_state WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; },
    setAppState: (key, value) => {
      if (failWrite && key === 'buildContinueOperations.v1') throw Error('controlled cut write failed');
      db.prepare('INSERT INTO app_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
      return { success: true };
    },
  } };
  if (terminalAttention) manager.db.setAppState('buildContinueOperations.v1', { version: 4, operations: [{
    version: 1, id: 'http-operation-one', phase: 'settled', capturedAt: 1000, sourceMainPid: 11,
    participants: [], references: { runs: [], messages: [] }, unresolved: [],
    targets: [{ source: { tabId: 'worker', projectId: 'project', provider: 'codex', sessionId: 'A', name: 'пробемы с телеграм' },
      route: { kind: 'local' }, state: terminalAttention, reason: 'continue-not-delivered', handoffId: 'exact-terminal-H',
      operationKey: 'history:worker:exact-terminal-H' }],
  }] });
  let quitCount = 0;
  const handlers = new Map(), publications = [];
  const ipcMain = new EventEmitter(); ipcMain.handle = (name, fn) => handlers.set(name, fn);
  ipcMain.removeHandler = name => handlers.delete(name);
  const originalLoad = Module._load;
  Module._load = function(name, parent, main) {
    if (name === 'electron') return { app: { isPackaged: false, getPath: () => root, quit: () => {
      const cut = manager.db.getAppState('buildContinueOperations.v1');
      assert.equal(cut.operations[0].id, 'http-operation-one', 'durable capture precedes Quit'); quitCount++;
    } }, BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: {
      isDestroyed: () => false, send: (channel, value) => publications.push({ channel, value }),
    } }] }, ipcMain };
    if (name === './project-manager' || name === path.join(__dirname, 'project-manager')) return manager;
    if (/\/ipc\/(claude-data|codex-data|settings)$/.test(name)) return {};
    return originalLoad.call(this, name, parent, main);
  };
  delete require.cache[require.resolve('./web-server')];
  const web = require('./web-server'), receipts = createAgentSendReceiptStore(db);
  const context = { provider: 'codex', sessionId: 'A', turnId: 'own-T', generation: 1, processId: null };
  web.start({ sdkSessions: new Map(), agentSendReceiptStore: receipts,
    captureTabInspection: tabId => ({ tabId, known: true, exists: true, toolType: 'codex',
      sessionId: tabId === 'worker' ? 'A' : 'P', cwd: root, revision: 'cut', busy: tabId === 'worker', transitioning: false,
      turn: tabId === 'worker' ? { ...context, active: true } : null,
      executionContext: tabId === 'worker' ? context : null, backgroundWorkCount: 0 }),
  });
  t.after(async () => { await web.stop(); Module._load = originalLoad; db.close();
    for (const [key, value] of Object.entries(oldEnv)) if (value == null) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true }); });
  const deadline = Date.now() + 5000;
  while (!web.getInfo().running) { assert(Date.now() < deadline, 'private HTTP startup deadline'); await new Promise(resolve => setImmediate(resolve)); }
  return { get quitCount() { return quitCount; }, manager, publications,
    ipc: (channel, request) => { assert(handlers.has(channel), channel); return handlers.get(channel)({}, request); },
    async api(route, body, token = web.getInfo().token) {
      const response = await fetch('http://127.0.0.1:' + web.getInfo().port + route, {
        method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Connection: 'close' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('production capture-quit API freezes only own turns, short ACK/report and read-only same-ID receipt', async t => {
  const h = await fixture(t);
  assert.equal((await h.api('/api/me')).body.capabilities.buildContinue.version, 2);
  assert.equal((await h.api('/api/me')).body.capabilities.buildContinue.proofRevision, 2);
  const request = { version: 2, action: 'capture-quit', operationId: 'http-operation-one', expectedMainPid: process.pid };
  assert.equal((await h.api('/api/build-continue/operations', request, 'wrong-token')).status, 401);
  assert.equal(h.quitCount, 0);
  const result = await h.api('/api/build-continue/operations', request);
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(h.quitCount, 1);
  assert.equal(result.body.operation.targetCount, 1); assert.equal(result.body.operation.targets[0].tabId, 'worker');
  assert.equal(result.body.operation.references, undefined, 'full inventory is a separate exact reader');
  const full = await h.api(result.body.reportUrl + '?full=1');
  assert.equal(full.body.operation.participants.find(p => p.source.tabId === 'waiting-source').busy, false);
  assert.equal(full.body.operation.targets.length, 1); assert.equal(h.quitCount, 1, 'receipt GET never closes again');
  const list = await h.api('/api/build-continue/operations');
  assert.equal(list.status, 200); assert.equal(list.body.operations[0].id, request.operationId);
  assert.equal(list.body.operations[0].participants, undefined); assert.equal(list.body.operations[0].references, undefined);
  assert.equal(h.quitCount, 1, 'metadata inventory never captures or quits');
  const premature = await h.api(result.body.reportUrl + '/restore', { version: 2 });
  assert.equal(premature.body.code, 'build_continue_replacement_required');
  assert.equal(h.quitCount, 1);
});

test('production capture cannot Quit without its own durable ACK', async t => {
  const h = await fixture(t, true);
  const result = await h.api('/api/build-continue/operations', {
    version: 2, action: 'capture-quit', operationId: 'http-operation-one', expectedMainPid: process.pid });
  assert.notEqual(result.status, 200); assert.equal(h.quitCount, 0);
  assert.equal(h.manager.db.getAppState('buildContinueOperations.v1'), null);
});

test('authenticated exact cancel-target revokes legacy recovery without restore, Quit or a new Send', async t => {
  const h = await fixture(t);
  const cut = await h.api('/api/build-continue/operations', { version: 2, action: 'capture-quit',
    operationId: 'http-operation-one', expectedMainPid: process.pid });
  const target = cut.body.operation.targets[0], url = cut.body.reportUrl + '/cancel-target';
  const body = { version: 2, requestId: 'http-cancel-one', tabId: target.tabId,
    handoffId: target.handoffId, operationKey: target.operationKey };
  assert.equal((await h.api(url, body, 'foreign-token')).status, 401);
  assert.equal((await h.api(url, { ...body, handoffId: 'wrong-target' })).status, 409);
  const cancelled = await h.api(url, body);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled));
  assert.equal(cancelled.body.operation.targets[0].active, false);
  assert(cancelled.body.operation.targets[0].cancellation.acknowledgedAt);
  assert.equal((await h.api(url, body)).status, 200);
  const readback = await h.api(cut.body.reportUrl); assert.equal(readback.body.operation.targets[0].state, 'cancelled');
  assert.equal(readback.body.operation.phase, 'captured', 'target cancellation cannot release the old Main global capture→Quit fence');
  assert.equal(h.quitCount, 1, 'only the fixture capture closed its fake app; cancel has no Quit/restore effect');
});

test('actual metadata IPC publishes pending recovery and authoritative exact cancellation independently of History', async t => {
  const h = await fixture(t);
  const caps = (await h.api('/api/me')).body.capabilities.buildContinue;
  assert.equal(caps.statusProjection.version, 1); assert.equal(caps.restartPrompt.version, 1);
  await h.api('/api/build-continue/operations', { version: 2, action: 'capture-quit',
    operationId: 'http-operation-one', expectedMainPid: process.pid });
  const before = h.ipc('build-continue:status-for-tab', 'worker');
  assert.equal(before.version, 1); assert.equal(before.targets.length, 1);
  assert.equal(before.targets[0].active, true); assert.equal(before.targets[0].phase, 'captured');
  assert.equal(before.targets[0].source.name, 'worker'); assert.equal(before.targets[0].source.tabId, 'worker');
  assert.equal(before.targets[0].taskId, 'own-T'); assert.deepEqual(before.targets[0].relatedRequests, []);
  for (const privateField of ['continuationPrompt', 'capturedRevision', 'subject', 'references']) {
    assert.equal(before.targets[0][privateField], undefined, privateField + ' is not a status payload');
  }
  assert.equal(h.ipc('build-continue:status-for-tab', 'waiting-source').targets.length, 0);
  assert(h.publications.some(row => row.channel === 'build-continue:status' && row.value.tabId === 'worker'));
  const target = before.targets[0], result = await h.ipc('build-continue:cancel-target', {
    operationId: target.operationId, requestId: 'ipc-exact-cancel', tabId: 'worker',
    handoffId: target.handoffId, operationKey: target.operationKey });
  assert.equal(result.ok, true); assert.equal(result.snapshot.epoch, before.epoch);
  assert(result.snapshot.revision > before.revision); assert.equal(result.snapshot.targets[0].active, false);
  assert(result.snapshot.targets[0].cancellation.acknowledgedAt);
  const published = h.publications.filter(row => row.channel === 'build-continue:status' && row.value.tabId === 'worker').at(-1).value;
  assert.deepEqual(published, result.snapshot);
  assert.equal(h.quitCount, 1); assert.equal(result.snapshot.targets[0].phase, 'captured');
});
for (const state of ['unresolved', 'paused']) test('actual IPC closes terminal ' + state + ' attention while keeping its History state and refusal', async t => {
  const h = await fixture(t, false, state), before = h.ipc('build-continue:status-for-tab', 'worker');
  const target = before.targets[0]; assert.equal(target.state, state); assert.equal(target.active, false);
  const request = { operationId: target.operationId, requestId: 'terminal-close-request', tabId: 'worker',
    handoffId: target.handoffId, operationKey: target.operationKey };
  const response = await h.ipc('build-continue:cancel-target', request), after = response.snapshot.targets[0];
  assert.equal(response.ok, true); assert.ok(after.cancellation.acknowledgedAt);
  assert.equal(after.cancellation.requestId, request.requestId); assert.equal(after.state, state);
  assert.equal(after.reason, 'continue-not-delivered'); assert.equal(after.operationKey, target.operationKey);
  assert.equal(response.snapshot.targets.length, 1, 'History row is not deleted');
  const again = await h.ipc('build-continue:cancel-target', request);
  assert.equal(again.snapshot.targets[0].cancellation.acknowledgedAt, after.cancellation.acknowledgedAt);
  assert.equal(h.quitCount, 0, 'X cannot invoke capture, restore or Quit');
});
