'use strict';
// Actual HTTP router, RunStore, FIFO/receipt store, coherent response DTO and
// Main result reader. Private Node SQLite adapter; OS/Electron/runtime are leaves.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const Module = require('node:module'), { EventEmitter, once } = require('node:events');
const { NodeSqlite, mainResultReader, codexApi } = require('./fixtures/build-install-posthook.cjs');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { AgentSendQueue } = require('./agent-send-queue');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { OrchestrationRunStore } = require('./orchestration-runs');
const { createAgentResponseObservationReader } = require('./agent-response-observation-reader');
test('real await endpoint binds the current Loop receipt and natural result, persists restart and never sends', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-http-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const oldEnv = { NOTED_WEB_PORT: process.env.NOTED_WEB_PORT, NOTED_DISCOVERY_DIR: process.env.NOTED_DISCOVERY_DIR };
  process.env.NOTED_WEB_PORT = String(port); process.env.NOTED_DISCOVERY_DIR = path.join(root, 'discovery');
  const db = new NodeSqlite(path.join(root, 'private.sqlite'));
  db.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT)');
  const appState = { getAppState: key => { const row = db.prepare('SELECT value FROM app_state WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; },
    setAppState: (key, value) => { db.prepare('INSERT INTO app_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); return { success: true }; } };
  appState.setAppState('promptQueueByTab', JSON.stringify({ P: { loopPromptEnabled: true, loopPromptMode: 'own-turn', loopPromptEpoch: 'E', loopPromptArmedAt: 1 } }));
  const receipts = createAgentSendReceiptStore(db), input = [];
  const queue = new AgentSendQueue({ store: receipts, ready: () => false, execute: async value => input.push(value) });
  const context = { provider: 'codex', sessionId: 'S', turnId: 'T', generation: 4, processId: null, startedAt: 1000 };
  const prompt = 'Check all work.\n<terminal_task_completion_protocol>Loop</terminal_task_completion_protocol>\n<loop_review_token>current-review</loop_review_token>';
  const request = { tabId: 'P', provider: 'codex', source: 'prompt-loop', handoffId: 'loop-H', prompt,
    expectedTarget: { toolType: 'codex', sessionId: 'S' } };
  const identity = { operationKey: 'history:P:loop-H', surface: 'desktop-history', tabId: 'P', provider: 'codex',
    sessionId: 'S', handoffId: 'loop-H', requestFingerprint: fingerprintAgentSendRequest(request),
    promptHash: promptAuditFingerprint(prompt), promptLength: prompt.length };
  assert.equal(queue.enqueue({ identity, request }).ok, true);
  const attempt = receipts.beginAttempt(identity);
  receipts.settleAttempt(identity.operationKey, attempt.attemptId, { submitted: true, deliveryUnknown: true, status: 'delivery-unknown' });
  const rows = [{ type: 'event_msg', timestamp: '2026-10-21T00:00:00Z', payload: { type: 'task_started', turn_id: 'T' } },
    { type: 'event_msg', timestamp: '2026-10-21T00:00:01Z', payload: { type: 'user_message', message: prompt } }];
  const file = path.join(root, 'provider.jsonl'), encode = values => values.map(value => JSON.stringify(value) + '\n').join('');
  fs.writeFileSync(file, encode(rows));
  const user = codexApi().getCodexUserRecordIdentity({ ...rows[1], __line: 1, __byteOffset: Buffer.byteLength(encode(rows.slice(0, 1))) }, 'S');
  assert.ok(user.uuid && user.sourceIdentity, 'actual native identity uses uuid/sourceIdentity');
  const readResult = mainResultReader(file);
  assert.equal(receipts.promoteFromAudit({ success: true, operationKey: identity.operationKey, attemptId: attempt.attemptId,
    provider: 'codex', sessionId: 'S', promptHash: identity.promptHash, actualHash: identity.promptHash,
    entryUuid: user.uuid, sourceIdentity: user.sourceIdentity, executionContext: context,
    transcriptBoundary: { byteOffset: 1 }, auditTimestamp: rows[1].timestamp }).promoted, true);
  const store = new OrchestrationRunStore(path.join(root, 'orchestration-runs.json'));
  await store.reserveOrGet({ runId: 'R', sourceTabId: 'P', sourceProjectId: 'project', sourceSessionId: 'S',
    sourceExecutionContext: context, targetTabId: 'C', targetProjectId: 'project', targetToolType: 'codex', notifySource: true });
  await store.persistStrict();
  const projects = [{ id: 'project', name: 'private', path: root, tabs: [
    { tabId: 'P', commandType: 'codex', codexSessionId: 'S', cwd: root },
    { tabId: 'C', commandType: 'codex', codexSessionId: 'child-S', cwd: root }] }];
  const manager = { db: { db, ...appState, getAllProjects: () => projects,
    getProjectById: id => projects.find(p => p.id === id), getTabHistoryEntriesByTabId: () => [] } };
  const ipcMain = new EventEmitter(), handlers = new Map();
  ipcMain.handle = (name, handler) => handlers.set(name, handler); ipcMain.removeHandler = name => handlers.delete(name);
  const originalLoad = Module._load;
  Module._load = function(name, parent, main) {
    if (name === 'electron') return { app: { getPath: () => root, isPackaged: false }, BrowserWindow: { getAllWindows: () => [] }, ipcMain };
    if (name === './project-manager' || name === path.join(__dirname, 'project-manager')) return manager;
    if (/\/ipc\/(claude-data|codex-data|settings)$/.test(name)) return {};
    return originalLoad.call(this, name, parent, main);
  };
  const web = require('./web-server');
  const raw = { known: true, exists: true, revision: 'one', tabId: 'P', toolType: 'codex', sessionId: 'S', cwd: root,
    busy: true, transitioning: false, backgroundWorkCount: 0,
    turn: { ...context, active: true, completionEligible: true, intentId: null }, executionContext: context };
  const reader = createAgentResponseObservationReader({ captureState: () => raw,
    readLifecycle: async () => ({ processStatus: 'found', processName: 'codex' }) });
  const start = () => web.start({ sdkSessions: new Map(), agentSendReceiptStore: receipts,
    registerTaskCompletionIntent: () => assert.fail('pending wait must not register task completion'),
    getAgentResponseState: tabId => reader.getAgentResponseState(tabId), getAgentTurnResult: readResult,
    captureTabInspection: () => raw,
    readAgentRuntimeSnapshot: async () => ({ coherent: true, toolType: 'codex', commandType: 'codex', sessionId: 'S',
      status: raw.busy ? 'busy' : 'active', processStatus: 'found', inputReady: true, liveLifecycle: true,
      writerConfirmed: true, writerUsableForMutation: true, sendTarget: { toolType: 'codex', sessionId: 'S' },
      lifecycleGeneration: 'L', terminalRunSeq: 1, inputRevision: 1 }) });
  t.after(async () => { await web.stop(); queue.dispose(); Module._load = originalLoad; db.close();
    for (const [key, value] of Object.entries(oldEnv)) if (value == null) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true }); });
  async function ready() { const deadline = Date.now() + 3000;
    while (!web.getInfo().running) { assert.ok(Date.now() < deadline); await new Promise(resolve => setImmediate(resolve)); } }
  start(); await ready();
  async function api(route, body) {
    const res = await fetch('http://127.0.0.1:' + web.getInfo().port + route, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + web.getInfo().token, 'Content-Type': 'application/json', Connection: 'close' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
    return { status: res.status, body: await res.json() };
  }
  assert.equal((await api('/api/me')).body.capabilities.loopDependencies.version, 1);
  const body = { sourceMeta: { tabId: 'P' }, dependencies: [{ kind: 'run', id: 'R' }], reason: 'Need R', reviewToken: 'current-review' };
  const retained = receipts.get(identity.operationKey), queued = queue.item(identity.operationKey);
  assert.equal(retained.state, 'confirmed');
  assert.equal(typeof retained.auditIdentity.entryUuid, 'string');
  assert.equal(retained.auditIdentity.promptHash, retained.promptHash);
  assert.equal(retained.auditIdentity.sessionId, retained.sessionId);
  assert.equal(retained.auditIdentity.attemptId, retained.attemptId);
  assert.deepEqual(retained.receipt.auditExecutionContext, context);
  assert.ok(queued, 'immutable request retained');
  assert.equal(queued.request_hash, fingerprintAgentSendRequest(JSON.parse(queued.request_json)));
  const accepted = await api('/api/terminal-tabs/P/await-dependencies', body);
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.body.entry.receipt.attemptId, attempt.attemptId);
  assert.equal((await api('/api/terminal-tabs/P/await-dependencies', body)).body.entry.id, accepted.body.entry.id);
  assert.equal((await api('/api/terminal-tabs/P/await-dependencies', { ...body, sourceMeta: { tabId: 'other' } })).status, 403);
  assert.equal((await api('/api/terminal-tabs/P/complete-task', { sourceMeta: { tabId: 'P' } })).status, 409);
  fs.appendFileSync(file, encode([{ type: 'response_item', payload: { type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: 'Waiting for R.' }] } },
    { type: 'event_msg', timestamp: '2026-10-21T00:00:02Z', payload: { type: 'task_complete', turn_id: 'T', last_agent_message: 'Waiting for R.' } }]));
  raw.busy = false; raw.turn = null; raw.executionContext = null; raw.revision = 'two';
  let snapshot = await handlers.get('loop-dependencies:list')();
  assert.equal(snapshot.entries[0].state, 'waiting'); assert.equal(snapshot.entries[0].naturalProof.userUuid, user.uuid);
  await web.stop(); start(); await ready();
  snapshot = await handlers.get('loop-dependencies:list')();
  assert.equal(snapshot.entries[0].state, 'waiting'); assert.equal(snapshot.entries[0].id, accepted.body.entry.id);
  assert.equal(JSON.parse(appState.getAppState('promptQueueByTab')).P.loopPromptEnabled, true);
  assert.equal(input.length, 0, 'no provider input, no new Research or duplicated run');
  assert.equal((await api('/api/orchestrations?tabId=P')).body.runs.filter(run => run.runId === 'R').length, 1);
  // The ordinary mode must keep its original completion authority even when
  // the optional external-wait journal cannot restore.
  await web.stop();
  appState.setAppState('promptQueueByTab', JSON.stringify({ P: { loopPromptEnabled: true,
    loopPromptMode: 'all-work', loopPromptEpoch: 'ordinary', loopPromptArmedAt: 1 } }));
  appState.setAppState('loopDependencies.v1', { version: 1, entries: 'corrupt-private-fixture' });
  start(); await ready();
  const ordinary = await api('/api/terminal-tabs/P/complete-task', { sourceMeta: { tabId: 'P' } });
  assert.equal(ordinary.status, 409, 'optional wait persistence must not replace the ordinary child guard');
  assert.equal(ordinary.body.code, 'active_child_delegations');
});
