'use strict';
// Actual authenticated web router, SQLite message/receipt owners and RunStore.
// Electron Quit and Main runtime/provider facts are controlled; no app is opened.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const Module = require('node:module'), { EventEmitter, once } = require('node:events');
const { NodeSqlite } = require('./fixtures/build-install-posthook.cjs');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');

async function fixture(t, failWrite = false) {
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
  let quitCount = 0;
  const ipcMain = new EventEmitter(); ipcMain.handle = () => {}; ipcMain.removeHandler = () => {};
  const originalLoad = Module._load;
  Module._load = function(name, parent, main) {
    if (name === 'electron') return { app: { isPackaged: false, getPath: () => root, quit: () => {
      const cut = manager.db.getAppState('buildContinueOperations.v1');
      assert.equal(cut.operations[0].id, 'http-operation-one', 'durable capture precedes Quit'); quitCount++;
    } }, BrowserWindow: { getAllWindows: () => [] }, ipcMain };
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
  return { get quitCount() { return quitCount; }, manager,
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
