'use strict';
// Whole CommonJS HTTP route, real private PM/SQLite/assets/FIFO/journal/sidecars.
// Electron is Node-only. Renderer capture and provider execution are controlled
// ports; no provider files, user storage, Send, raw JSONL, or production GC.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), vm = require('node:vm'), Module = require('node:module');
const { EventEmitter } = require('node:events');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { AgentSendQueue, readQueuedSendAssetIds } = require('./agent-send-queue');
const { PromptQueueAssetStore, collectReferencedAssetIds } = require('./prompt-queue-assets');
const { RunAfterOperationJournal } = require('./run-after-operation-journal');
const { adoptCompletedQueueTransfers, protectQueueAssets } = require('./replay-asset-ownership');
const { importMobileUploads } = require('./owned-mobile-attachments');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { saveAuditedPromptPresentation } = require('./history-prompt-presentations');
let privateRoot;
const electronPath = require.resolve('electron'), oldElectron = require.cache[electronPath];
require.cache[electronPath] = { id: electronPath, loaded: true, exports: { app: { getPath: () => privateRoot, isPackaged: false } } };
const DatabaseManager = require('./database');
if (oldElectron) require.cache[electronPath] = oldElectron; else delete require.cache[electronPath];
const barrier = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

async function fixture(t, { bootstrap = false } = {}) {
  privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-replay-bytes-private-'));
  const root = privateRoot, seed = new DatabaseManager(), project = seed.createEmptyProject('PRIVATE');
  seed.saveTabs(project.id, [{ tabId: 'T', name: 'PRIVATE', cwd: root, tabType: 'terminal', commandType: 'codex' }], true);
  seed.close(); // Avoid the optional legacy user-JSON migration in actual PM.init.
  const pmModule = new Module(path.join(__dirname, 'project-manager.js'), module);
  pmModule.filename = path.join(__dirname, 'project-manager.js'); pmModule.paths = module.paths;
  pmModule._compile(fs.readFileSync(pmModule.filename, 'utf8'), pmModule.filename);
  const pm = pmModule.exports, db = pm.db.db, store = createAgentSendReceiptStore(db);
  const assetStore = new PromptQueueAssetStore({ rootDir: path.join(root, 'assets'), logger: { warn() {} } });
  let executions = 0;
  const queue = new AgentSendQueue({ store, ready: () => false, execute: () => { executions++; throw Error('no provider execution allowed'); } });
  const callbacks = new Map(), sender = new EventEmitter();
  sender.id = 7; sender.mainFrame = { processId: 8, routingId: 9 }; sender.isDestroyed = () => false;
  sender.send = () => {}; // registration/wake only; no renderer executor
  const electron = { app: { getPath: () => root, isPackaged: false },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: sender }] },
    ipcMain: { on: (name, fn) => callbacks.set(name, fn), removeListener: name => callbacks.delete(name) } };
  const load = Module.createRequire(path.join(__dirname, 'web-server.js'));
  const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const cjs = { exports: {} }, quiet = { log() {}, warn() {}, error() {} };
  // Complete CJS initialization (no injected projectManager/global aliases).
  // Only external live-service dependencies are explicit controlled ports.
  let port;
  if (bootstrap) {
    const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  }
  const privateProcess = Object.assign(Object.create(process), { env: { ...process.env,
    NOTED_DISCOVERY_DIR: path.join(root, 'discovery'), ...(port ? { NOTED_WEB_PORT: String(port) } : {}) } });
  const create = vm.runInNewContext('(function(require,module,exports,__dirname,__filename){' + source + `
    return { route:handleApi, api:()=>getRunAfterApi(), stop, reset:()=>{runAfterApi=null;}, server:()=>httpServer, initialize(p) {
      token='private-token'; mobileAttachmentAssetStore=p.assets;
      agentSendReceiptStore=p.store; agentSendQueue=p.queue; agentSendReceiptStartupReady=Promise.resolve();
    } };
  })`, { console: quiet, process: privateProcess, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate });
  const whole = create(id => id === './project-manager' || id === path.join(__dirname, 'project-manager') ? pm : id === 'electron' ? electron : load(id),
    cjs, cjs.exports, __dirname, path.join(__dirname, 'web-server.js'));
  let privateToken = 'private-token', server, nextLoss = null;
  if (bootstrap) {
    cjs.exports.start({ sdkSessions: new Map(), agentSendReceiptStore: store, mobileAttachmentAssetStore: assetStore,
      agentSendReceiptStartupReady: Promise.resolve({ ready: true }),
      resolveAgentToolType: () => ({ observed: true, toolType: 'codex' }) });
    server = whole.server(); await new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));
    privateToken = fs.readFileSync(path.join(root, 'discovery', 'web-token.txt'), 'utf8').trim();
  } else {
    whole.initialize({ assets: assetStore, store, queue });
    server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://private');
    if (nextLoss) { const loss = nextLoss; nextLoss = null; res.end = () => { loss.resolve(); return res; }; }
    void whole.route(req, res, { pathname: parsed.pathname, query: Object.fromEntries(parsed.searchParams) }, new Map())
      .catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (route, body, signal) => {
    const res = await fetch(base + route, { signal, headers: { authorization: 'Bearer ' + privateToken, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() };
  };
  const api = () => whole.api();
  const createOperation = (id, op, assetIds, result = {}, args = {}, writes = null) => {
    const saved = { op, args, runAfter: { version: 1, operationId: id,
      expected: { mainScopeKey: api().scopeKey('T'), epoch: api().journal.epoch + ':renderer', revision: 1, scopeKey: 'private' } } };
    const scope = { scopeKey: api().scopeKey('T'), frame: api().frameSnapshot() };
    const ticket = api().journal.reserve(id, 'T', saved, scope).ticket;
    api().journal.holdAssets(ticket, assetIds);
    api().journal.finish(ticket, { result, writes, retainAssets: op === 'replay' });
    return api().journal.read(id);
  };
  const assets = async () => {
    const managed = await assetStore.materializeBuffer(Buffer.from('private-managed-image-bytes'), { id: 1, mediaType: 'image/png' });
    const uploads = path.join(root, 'mobile-uploads'); fs.mkdirSync(uploads);
    fs.mkdirSync(path.join(uploads, 'upload-id'));
    const mobilePath = path.join(uploads, 'upload-id', 'private.png'); fs.writeFileSync(mobilePath, Buffer.from('private-mobile-image-bytes'));
    const imported = await importMobileUploads({ rootDir: uploads, assetStore,
      attachments: [{ path: mobilePath, kind: 'image', name: 'private.png', mimeType: 'image/png' }] });
    const mobile = { id: 2, ...imported.refs[0], path: assetStore.assetPath(imported.refs[0].assetId) }; imported.release();
    return [managed, mobile];
  };
  const admit = (refs, handoffId = 'H', { provider = 'codex', surface = 'project-api', itemId = null, manual = false } = {}) => {
    const operationKey = (surface === 'project-api' ? 'project:' : 'history:') + 'T:' + handoffId;
    const prompt = manual ? refs.map(ref => '[imagePath: ' + ref.path + ']').join('\n') : 'private prompt';
    const identity = { operationKey, tabId: 'T', handoffId, surface, provider,
      requestFingerprint: fingerprintAgentSendRequest({ handoffId, refs }), promptHash: promptAuditFingerprint(prompt), promptLength: prompt.length };
    const request = { tabId: 'T', handoffId, prompt, source: itemId ? 'prompt-queue' : manual ? 'history-panel' : 'terminal-mcp',
      presentationSnapshot: { imagePaths: refs }, authoringSnapshot: { imagePaths: refs,
        ...(manual ? { editorText: refs.map((_ref, index) => `[Image #${index + 1}]`).join('\n') } : {}) },
      ...(itemId ? { promptQueueIntent: { version: 1, kind: 'queue', itemId, armedAt: null,
        triggerTabId: 'T', conditionKey: '', triggerKey: 'null' } } : {}) };
    assert.equal(queue.enqueue({ identity, request }).ok, true);
    return { kind: 'project-send', tabId: 'T', handoffId, operationKey, provider, attemptId: null };
  };
  const transfer = (sourceOperationId, replacement, assetIds, changes = {}) => {
    const lease = api().receipt(sourceOperationId).assetLease;
    return { version: 1, requestId: 'dispose-' + sourceOperationId, tabId: 'T',
      source: { mainEpoch: lease.mainEpoch, mainScopeKey: lease.mainScopeKey }, expectedAssetIds: lease.assetIds,
      discardAssetIds: [], transferAssetIds: assetIds, replacement, ...changes };
  };
  const post = (sourceId, body, signal) => request('/api/run-after/operations/' + sourceId + '/assets', body, signal);
  const refs = () => new Set([...api().journal.referencedAssetIds(), ...readQueuedSendAssetIds(db),
    ...pm.db.getHistoryPromptPresentationAssetIds(), ...collectReferencedAssetIds(pm.db.getAppState('promptQueueByTab'))]);
  const collect = async () => { adoptCompletedQueueTransfers(db); assetStore.now = () => Date.now() + 40 * 86400000;
    return assetStore.garbageCollect(refs(), { minAgeMs: 0 }); };
  const confirm = (replacement, { entryUuid = 'PRIVATE-U' } = {}) => {
    const old = store.get(replacement.operationKey);
    const begun = store.beginAttempt(old);
    store.settleAttempt(replacement.operationKey, begun.attemptId, { success: null, accepted: true,
      submitted: true, status: 'delivery-unknown' });
    // Only the transcript observer is substituted. Actual common claim,
    // promotion, subscribers and queue completion run on this synthetic audit.
    const promoted = store.promoteFromAudit({ success: true, operationKey: replacement.operationKey,
      attemptId: begun.attemptId, provider: replacement.provider, sessionId: 'PRIVATE-SID',
      promptHash: old.promptHash, actualHash: old.promptHash, expectedHash: old.promptHash,
      entryUuid, sourceIdentity: 'PRIVATE-SOURCE', auditTimestamp: '2026-10-08T00:00:00.000Z' });
    assert.equal(promoted.promoted, true, JSON.stringify(promoted));
    return { ...replacement, attemptId: begun.attemptId };
  };
  const sidecar = (replacement, refs, overrides = {}) => {
    const audit = store.get(replacement.operationKey).auditIdentity;
    if (Object.keys(overrides).length) return pm.db.saveHistoryPromptPresentation({ toolType: replacement.provider,
      sessionId: audit.sessionId, entryUuid: audit.entryUuid, auditTimestamp: audit.auditTimestamp,
      transportHash: audit.promptHash, schemaVersion: 3, chips: refs.map(ref => ({ ...ref, kind: 'image-ref' })), ...overrides });
    return saveAuditedPromptPresentation(pm.db, { toolType: replacement.provider, sessionId: audit.sessionId,
      entryUuid: audit.entryUuid, auditTimestamp: audit.auditTimestamp, actualHash: audit.promptHash,
      snapshot: { imagePaths: refs } });
  };
  t.after(async () => {
    assert.equal(executions, 0, 'never invoke provider runner'); queue.dispose();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await whole.stop();
    pm.db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, db, pm, store, queue, api, whole, sender, assetStore, createOperation, assets, admit, transfer, post, request, refs, collect, confirm, sidecar,
    loseNextResponse: () => { nextLoss = barrier(); return nextLoss; } };
}

test('whole CJS/private HTTP advertises separate journal epoch and conditional asset contract', async t => {
  const f = await fixture(t), me = await f.request('/api/me');
  assert.equal(me.status, 200); const cap = me.body.capabilities.runAfter;
  assert.equal(cap.mainEpoch, f.api().journal.epoch); assert.notEqual(cap.mainEpoch, me.body.service.instanceId);
  assert.equal(cap.assetDisposition.version, 1); assert.equal(cap.assetDisposition.legacyRelease, 'explicit-discard-only');
  assert.deepEqual(cap.assetDisposition.owners, ['project-send', 'run-after-item']);
});

test('managed+mobile refs, repeated/reordered occurrences: same IDs atomically leave original and enter FIFO', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids, { draft: { imagePaths: refs } });
  const replacement = f.admit([{ ...refs[1], id: 1 }, { ...refs[0], id: 2 }, { ...refs[0], id: 3 }]);
  const body = f.transfer('R', replacement, ids), res = await f.post('R', body);
  assert.equal(res.status, 200, JSON.stringify(res.body)); assert.equal(res.body.operation.result.sourceReleased, true);
  assert.deepEqual(JSON.parse(f.queue.item(replacement.operationKey).asset_transfer_ids_json), ids);
  assert.equal(f.api().receipt('R').assetLease.released, true); assert.equal((await f.collect()).removed.length, 0);
  const before = f.db.prepare('SELECT COUNT(*) AS n FROM agent_send_queue').get().n;
  assert.deepEqual((await f.post('R', body)).body.operation, res.body.operation);
  const read = await f.request('/api/run-after/operations/' + body.requestId); assert.deepEqual(read.body.operation, res.body.operation);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_send_queue').get().n, before);
});

for (const kind of ['waiting', 'awaiting-receipt', 'failed', 'cancelled', 'released-unknown']) {
  test('current FIFO pins survive ' + kind + ', restart and GC without any provider invocation', async t => {
    const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
    f.createOperation('R', 'replay', ids); const replacement = f.admit(refs);
    f.db.prepare('UPDATE agent_send_queue SET state=? WHERE operation_key=?').run(kind, replacement.operationKey);
    if (kind === 'awaiting-receipt' || kind === 'released-unknown') {
      const attempt = f.store.beginAttempt(f.store.get(replacement.operationKey)); replacement.attemptId = attempt.attemptId;
      f.store.settleAttempt(replacement.operationKey, attempt.attemptId, { success: null, submitted: null, status: 'delivery-unknown' });
    }
    const result = await f.post('R', f.transfer('R', replacement, ids)); assert.equal(result.status, 200);
    const epoch = f.api().journal.epoch; f.whole.reset(); assert.notEqual(f.api().journal.epoch, epoch);
    assert.equal((await f.collect()).removed.length, 0); assert.equal(f.queue.item(replacement.operationKey).state, kind);
  });
}

for (const change of ['wrong-source-epoch', 'wrong-source-scope', 'wrong-provider', 'wrong-attempt', 'wrong-handoff',
  'wrong-target', 'unknown-operation', 'missing-pin', 'missing-covered-asset', 'missing-bytes', 'wrong-expected-set']) {
  test('refusal ' + change + ' retains every original asset and durable negative receipt', async t => {
    const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
    f.createOperation('R', 'replay', ids); const replacement = f.admit(change === 'missing-covered-asset' ? refs.slice(0, 1) : refs);
    const body = f.transfer('R', replacement, ids);
    if (change === 'wrong-source-epoch') body.source.mainEpoch = 'foreign-epoch';
    if (change === 'wrong-source-scope') body.source.mainScopeKey = 'foreign-scope';
    if (change === 'wrong-provider') replacement.provider = 'claude';
    if (change === 'wrong-attempt') replacement.attemptId = 'foreign-attempt';
    if (change === 'wrong-handoff') { replacement.handoffId = 'foreign'; replacement.operationKey = 'project:T:foreign'; }
    if (change === 'wrong-target') { replacement.tabId = 'B'; replacement.operationKey = 'project:B:H'; }
    if (change === 'unknown-operation') { replacement.handoffId = 'missing'; replacement.operationKey = 'project:T:missing'; }
    if (change === 'missing-pin') f.db.prepare("UPDATE agent_send_queue SET asset_ids_json='[]' WHERE operation_key=?").run(replacement.operationKey);
    if (change === 'missing-bytes') fs.unlinkSync(f.assetStore.assetPath(ids[1]));
    if (change === 'wrong-expected-set') { body.expectedAssetIds = [ids[0]]; body.transferAssetIds = [ids[0]]; }
    const res = await f.post('R', body); assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(f.api().receipt('R').released, false); assert.deepEqual(f.api().receipt('R').assetLease.assetIds, ids);
    if (change !== 'wrong-target') {
      assert.equal(res.body.operation.phase, 'rejected'); assert.equal(res.body.operation.result.disposition, 'retained');
      assert.deepEqual((await f.post('R', body)).body.operation, res.body.operation);
    }
    assert.deepEqual(JSON.parse(f.queue.item('project:T:H').asset_transfer_ids_json), []);
  });
}

test('partial discard + partial transfer require no false claim about removed or still-edited refs', async t => {
  const f = await fixture(t), refs = await f.assets(), third = await f.assetStore.materializeBuffer(Buffer.from('private-third'), { id: 3 });
  const all = [...refs, third], ids = all.map(r => r.assetId); f.createOperation('R', 'replay', ids);
  const replacement = f.admit([refs[0]]);
  const partial = await f.post('R', f.transfer('R', replacement, [ids[0]], { discardAssetIds: [ids[1]] }));
  assert.equal(partial.status, 200); assert.equal(partial.body.operation.result.disposition, 'partial');
  assert.deepEqual(f.api().receipt('R').assetLease.assetIds, [ids[2]]);
  const discard = f.transfer('R', null, [], { requestId: 'remove-final', discardAssetIds: [ids[2]] });
  assert.equal((await f.post('R', discard)).status, 200); const gc = await f.collect();
  assert.deepEqual(new Set(gc.removed), new Set([ids[1], ids[2]])); assert.ok(fs.existsSync(f.assetStore.assetPath(ids[0])));
});

test('same-ID changed body/replacement and stale partial snapshot are explicit conflicts, not rewritten proof', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); const replacement = f.admit(refs), body = f.transfer('R', replacement, [ids[0]]);
  const first = await f.post('R', body); assert.equal(first.status, 200);
  const changed = await f.post('R', { ...body, transferAssetIds: [ids[1]] });
  assert.equal(changed.status, 409); assert.equal(changed.body.error, 'run_after_asset_request_conflict');
  const other = f.admit(refs, 'OTHER'); assert.equal((await f.post('R', { ...body, replacement: other })).status, 409);
  const stale = await f.post('R', { ...body, requestId: 'stale-fresh-key' }); assert.equal(stale.status, 409);
  assert.deepEqual(f.api().receipt('R').assetLease.assetIds, [ids[1]]); assert.deepEqual(first.body.operation, (await f.post('R', body)).body.operation);
});

test('restart before/after transfer keeps original scope and exact immutable receipt; real SQLite reopen', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); const replacement = f.admit(refs), body = f.transfer('R', replacement, ids);
  const originalEpoch = body.source.mainEpoch; f.whole.reset(); assert.notEqual(f.api().journal.epoch, originalEpoch);
  const first = await f.post('R', body); assert.equal(first.status, 200);
  const Database = require('better-sqlite3'), reopened = new Database(f.db.name);
  try {
    const journal = new RunAfterOperationJournal({ db: reopened }); assert.notEqual(journal.epoch, originalEpoch);
    assert.deepEqual(journal.read(body.requestId), first.body.operation);
    assert.deepEqual([...readQueuedSendAssetIds(reopened)].sort(), ids.slice().sort());
    assert.equal(journal.read('R').assetLease.released, true);
  } finally { reopened.close(); }
  f.whole.reset(); assert.deepEqual((await f.post('R', body)).body.operation, first.body.operation);
  assert.equal((await f.collect()).removed.length, 0);
});

test('queued→completed gap pins bytes; exact canonical sidecar adopts before later explicit History deletion', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); const replacement = f.admit(refs);
  assert.equal((await f.post('R', f.transfer('R', replacement, ids))).status, 200);
  const confirmed = f.confirm(replacement); assert.equal(f.queue.item(replacement.operationKey).state, 'completed');
  f.queue.releasePresentation(replacement.operationKey); assert.equal((await f.collect()).removed.length, 0);
  f.sidecar(confirmed, refs, { entryUuid: 'FOREIGN' }); adoptCompletedQueueTransfers(f.db);
  assert.deepEqual(JSON.parse(f.queue.item(replacement.operationKey).asset_transfer_ids_json), ids);
  f.sidecar(confirmed, refs); adoptCompletedQueueTransfers(f.db);
  assert.deepEqual(JSON.parse(f.queue.item(replacement.operationKey).asset_transfer_ids_json), []);
  assert.equal((await f.collect()).removed.length, 0);
  f.db.prepare('DELETE FROM history_prompt_presentations').run();
  assert.deepEqual(new Set((await f.collect()).removed), new Set(ids));
});

test('completed historical receipt without current sidecar or FIFO pin cannot certify bytes; actual sidecar can', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); const replacement = f.confirm(f.admit(refs));
  const body = f.transfer('R', replacement, ids); const stale = await f.post('R', body);
  assert.equal(stale.status, 409); assert.equal(stale.body.operation.result.error, 'run_after_asset_replacement_not_retained');
  f.sidecar(replacement, refs); assert.equal((await f.post('R', { ...body, requestId: 'with-current-history' })).status, 200);
  assert.equal(f.api().receipt('with-current-history').result.replacement.owner, 'canonical-history');
});

test('explicit failed/cancelled dismissal releases transferred pins, while mere failure does not', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); const replacement = f.admit(refs);
  assert.equal((await f.post('R', f.transfer('R', replacement, ids))).status, 200);
  f.queue.cancelWaiting('T', 'H'); assert.equal((await f.collect()).removed.length, 0);
  f.queue.dismissUnwritten('T', 'H'); assert.deepEqual(new Set((await f.collect()).removed), new Set(ids));
});

test('RunAfter item owner uses exact applied mutation/current item, then SAME FIFO enqueue atomically adopts', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); f.pm.db.setAppState('promptQueueByTab', JSON.stringify({ T: { items: [{ id: 'I', text: 'private', imagePaths: refs }] } }));
  const added = f.createOperation('ADD', 'add', [], { itemId: 'I' });
  const row = f.api().journal.record('ADD');
  const replacement = { kind: 'run-after-item', tabId: 'T', operationId: 'ADD', mainEpoch: row.main_epoch,
    mainScopeKey: JSON.parse(row.request_json).scope.scopeKey, itemId: 'I' };
  assert.equal(added.phase, 'applied'); const result = await f.post('R', f.transfer('R', replacement, ids)); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(f.api().receipt('ADD').assetLease.assetIds, ids);
  // No proof is derived from latest renderer/session/catalog. The exact item
  // command is the existing persisted automatic queue intent.
  const send = f.admit(refs, 'AUTOMATIC', { surface: 'desktop-history', itemId: 'I' });
  assert.equal(f.api().receipt('ADD').assetLease.released, true);
  assert.deepEqual(JSON.parse(f.queue.item(send.operationKey).asset_transfer_ids_json), ids);
  assert.equal((await f.collect()).removed.length, 0);
});

test('wrong/stale RunAfter item operation/asset set refuses without creating replacement pins', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); f.pm.db.setAppState('promptQueueByTab', JSON.stringify({ T: { items: [{ id: 'I', imagePaths: refs.slice(0, 1) }] } }));
  f.createOperation('ADD', 'add', [], { itemId: 'I' }); const row = f.api().journal.record('ADD');
  const replacement = { kind: 'run-after-item', tabId: 'T', operationId: 'ADD', mainEpoch: row.main_epoch,
    mainScopeKey: JSON.parse(row.request_json).scope.scopeKey, itemId: 'I' };
  assert.equal((await f.post('R', f.transfer('R', replacement, ids))).status, 409);
  assert.deepEqual(f.api().receipt('R').assetLease.assetIds, ids); assert.deepEqual(JSON.parse(row.assets_json), []);
});

test('old GC snapshot crossing validation/release cannot delete a now transferred asset', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); const replacement = f.admit(refs), verified = barrier(), resume = barrier();
  const verify = f.assetStore.verifyOwnedRef.bind(f.assetStore); let calls = 0;
  f.assetStore.verifyOwnedRef = async ref => { const result = await verify(ref); if (++calls === 1) { verified.resolve(); await resume.promise; } return result; };
  const pending = f.post('R', f.transfer('R', replacement, ids)); await verified.promise;
  const collecting = f.assetStore.garbageCollect(new Set(), { minAgeMs: 0 }); // stale synthetic inventory, NOT production GC
  resume.resolve(); assert.equal((await pending).status, 200); await collecting;
  for (const id of ids) assert.ok(fs.existsSync(f.assetStore.assetPath(id)));
  assert.equal((await f.collect()).removed.length, 0);
});

test('legacy full release remains explicit discard, never a conditional transfer certificate', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids);
  const result = await f.request('/api/run-after/operations/R/release', { tabId: 'T' }); assert.equal(result.status, 200);
  assert.equal(result.body.operation.released, true); assert.equal(result.body.operation.result?.replacement, undefined);
  assert.deepEqual(new Set((await f.collect()).removed), new Set(ids));
});

test('actual web.start private bootstrap uses native SQLite/asset owner and exposes the real HTTP route', async t => {
  const f = await fixture(t, { bootstrap: true }), refs = await f.assets(), ids = refs.map(r => r.assetId);
  const me = await f.request('/api/me'); assert.equal(me.status, 200); assert.equal(me.body.capabilities.runAfter.assetDisposition.atomic, true);
  f.createOperation('R', 'replay', ids);
  const result = await f.post('R', f.transfer('R', null, [], { discardAssetIds: ids }));
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.operation.result.sourceReleased, true);
});

test('lost actual HTTP response after commit: GET/exact retry recover the same receipt with no second mutation', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); const replacement = f.admit(refs), body = f.transfer('R', replacement, ids);
  const loss = f.loseNextResponse(), abort = new AbortController();
  const pending = f.post('R', body, abort.signal).catch(error => error);
  await loss.promise; abort.abort(); assert.equal((await pending).name, 'AbortError');
  const recovered = await f.request('/api/run-after/operations/' + body.requestId); assert.equal(recovered.body.operation.phase, 'applied');
  f.whole.reset(); assert.deepEqual((await f.post('R', body)).body.operation, recovered.body.operation);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM run_after_operations WHERE operation_id=?").get(body.requestId).n, 1);
  assert.equal((await f.collect()).removed.length, 0);
});

test('concurrent pin dismissal during bytes await is rechecked inside final transaction; original remains', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); const replacement = f.admit(refs), entered = barrier(), release = barrier();
  const verify = f.assetStore.verifyOwnedRef.bind(f.assetStore);
  f.assetStore.verifyOwnedRef = async ref => { const out = await verify(ref); entered.resolve(); await release.promise; return out; };
  const pending = f.post('R', f.transfer('R', replacement, ids)); await entered.promise;
  f.queue.cancelWaiting('T', 'H', { dismiss: true }); release.resolve();
  const result = await pending; assert.equal(result.status, 409); assert.equal(result.body.operation.result.error, 'run_after_asset_replacement_not_retained');
  assert.deepEqual(f.api().receipt('R').assetLease.assetIds, ids); assert.equal((await f.collect()).removed.length, 0);
});

test('two partial dispositions racing under one expected set: one atomic commit, other durable CAS refusal', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); const replacement = f.admit(refs);
  const a = f.transfer('R', replacement, [ids[0]], { requestId: 'A' });
  const b = f.transfer('R', replacement, [ids[1]], { requestId: 'B' });
  const results = await Promise.all([f.post('R', a), f.post('R', b)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.api().receipt('R').assetLease.assetIds.length, 1); assert.equal((await f.collect()).removed.length, 0);
});

test('protected internal FIFO pins follow existing atomic manual waiting merge, not immutable old tombstones', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  const left = f.admit(refs, 'LEFT', { surface: 'desktop-history', manual: true });
  const right = f.admit(refs, 'RIGHT', { surface: 'desktop-history', manual: true });
  // A preserving regression for the existing internal owner primitive. The
  // public conditional transfer does NOT claim desktop-history as project-api.
  f.db.transaction(() => protectQueueAssets(f.db, right.operationKey, ids))();
  const guard = f.queue.mergeGuard(right.operationKey); assert.ok(guard);
  const merged = await f.queue.mergeWaiting({ ...guard, requestId: 'MERGE' });
  assert.equal(merged.success, true, JSON.stringify(merged));
  assert.deepEqual(JSON.parse(f.queue.item(right.operationKey).asset_transfer_ids_json), []);
  assert.deepEqual(JSON.parse(f.queue.item(merged.operationKey).asset_transfer_ids_json), ids);
  assert.equal((await f.collect()).removed.length, 0);
});

test('late partial canonical sidecar moves only covered IDs; remaining completed FIFO bytes stay pinned', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); const replacement = f.admit(refs);
  assert.equal((await f.post('R', f.transfer('R', replacement, ids))).status, 200);
  const confirmed = f.confirm(replacement); f.sidecar(confirmed, refs.slice(0, 1)); adoptCompletedQueueTransfers(f.db);
  assert.deepEqual(JSON.parse(f.queue.item(replacement.operationKey).asset_transfer_ids_json), [ids[1]]);
  assert.equal((await f.collect()).removed.length, 0);
  f.sidecar(confirmed, refs); adoptCompletedQueueTransfers(f.db);
  assert.deepEqual(JSON.parse(f.queue.item(replacement.operationKey).asset_transfer_ids_json), []);
});

test('historical exact receipt stays historical after later permitted pin removal; changed body never reuses it', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); const replacement = f.admit(refs), body = f.transfer('R', replacement, ids);
  const saved = await f.post('R', body); assert.equal(saved.status, 200);
  f.queue.cancelWaiting('T', 'H', { dismiss: true }); assert.deepEqual(new Set((await f.collect()).removed), new Set(ids));
  assert.deepEqual((await f.post('R', body)).body.operation, saved.body.operation);
  assert.equal(saved.body.operation.result.historical, true);
  assert.equal((await f.post('R', { ...body, discardAssetIds: ids, transferAssetIds: [], replacement: null })).status, 409);
});

test('known attempt/provider checks support Claude without substituting a session ID or mobile proof', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); const replacement = f.admit(refs, 'CLAUDE', { provider: 'claude' });
  const attempt = f.store.beginAttempt(f.store.get(replacement.operationKey));
  f.store.settleAttempt(replacement.operationKey, attempt.attemptId, { success: null, submitted: null, status: 'delivery-unknown' });
  assert.equal((await f.post('R', f.transfer('R', replacement, ids))).status, 409);
  replacement.attemptId = attempt.attemptId;
  const result = await f.post('R', f.transfer('R', replacement, ids, { requestId: 'bound-attempt' }));
  assert.equal(result.status, 200); assert.equal(f.store.get(replacement.operationKey).state, 'delivery-unknown');
  assert.equal((await f.collect()).removed.length, 0);
});

test('wrong API surface, immutable request corruption and path-as-assetId cannot authorize transfer', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); const replacement = f.admit(refs), body = f.transfer('R', replacement, ids);
  f.db.prepare("UPDATE agent_send_receipts SET surface='desktop-history' WHERE operation_key=?").run(replacement.operationKey);
  const foreign = await f.post('R', body); assert.equal(foreign.status, 409);
  f.db.prepare("UPDATE agent_send_receipts SET surface='project-api' WHERE operation_key=?").run(replacement.operationKey);
  f.db.prepare("UPDATE agent_send_queue SET request_json='{}' WHERE operation_key=?").run(replacement.operationKey);
  assert.equal((await f.post('R', { ...body, requestId: 'corrupt-current-request' })).status, 409);
  assert.equal((await f.post('R', { ...body, requestId: 'path-is-not-id', expectedAssetIds: refs.map(ref => ref.path), transferAssetIds: [] })).status, 400);
  assert.deepEqual(f.api().receipt('R').assetLease.assetIds, ids);
});

test('no renderer frame/input is required after original Replay; full empty discard is still scoped', async t => {
  const f = await fixture(t); f.createOperation('EMPTY', 'replay', []);
  f.sender.isDestroyed = () => true;
  const result = await f.post('EMPTY', f.transfer('EMPTY', null, []));
  assert.equal(result.status, 200); assert.equal(result.body.operation.result.sourceReleased, true);
});

for (const op of ['update', 'remove', 'clear', 'replay']) {
  test('typed current RunAfter ' + op + ' settles only its item lease in the SAME authoring transaction', async t => {
    const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
    const item = { id: 'I', text: 'private', imagePaths: refs }, other = { id: 'OTHER', imagePaths: refs };
    f.pm.db.setAppState('promptQueueByTab', JSON.stringify({ T: { items: [item, other] } }));
    f.createOperation('R', 'replay', ids); f.createOperation('ADD', 'add', [], { itemId: 'I' });
    const row = f.api().journal.record('ADD'), replacement = { kind: 'run-after-item', tabId: 'T', operationId: 'ADD',
      mainEpoch: row.main_epoch, mainScopeKey: JSON.parse(row.request_json).scope.scopeKey, itemId: 'I' };
    assert.equal((await f.post('R', f.transfer('R', replacement, ids))).status, 200);
    const next = { T: { items: op === 'clear' ? [] : op === 'update' ? [{ ...item, imagePaths: refs.slice(0, 1) }, other] : [other] } };
    f.createOperation('ACTION', op, op === 'replay' ? ids : [], op === 'replay' ? { draft: { imagePaths: refs } } : {},
      { id: 'I', ...(op === 'update' ? { imagePaths: refs.slice(0, 1) } : {}) }, { promptQueueByTab: JSON.stringify(next) });
    const remaining = f.api().receipt('ADD').assetLease.assetIds;
    assert.deepEqual(remaining, op === 'update' ? [ids[0]] : []);
    if (op === 'replay') assert.deepEqual(f.api().receipt('ACTION').assetLease.assetIds, ids);
    assert.equal((await f.collect()).removed.length, op === 'clear' ? 2 : 0);
  });
}

test('plain source snapshot missing an item is not falsely treated as an explicit lease discard', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.pm.db.setAppState('promptQueueByTab', JSON.stringify({ T: { items: [{ id: 'I', imagePaths: refs }] } }));
  f.createOperation('R', 'replay', ids); f.createOperation('ADD', 'add', [], { itemId: 'I' });
  const row = f.api().journal.record('ADD'), replacement = { kind: 'run-after-item', tabId: 'T', operationId: 'ADD',
    mainEpoch: row.main_epoch, mainScopeKey: JSON.parse(row.request_json).scope.scopeKey, itemId: 'I' };
  assert.equal((await f.post('R', f.transfer('R', replacement, ids))).status, 200);
  f.pm.db.setAppState('promptQueueByTab', JSON.stringify({ T: { items: [] } }));
  assert.deepEqual(f.api().receipt('ADD').assetLease.assetIds, ids); assert.equal((await f.collect()).removed.length, 0);
});

test('source-only audit + arbitrary same-time/hash legacy sidecar is not canonical origin proof', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); const replacement = f.admit(refs);
  assert.equal((await f.post('R', f.transfer('R', replacement, ids))).status, 200);
  const confirmed = f.confirm(replacement, { entryUuid: null }); f.sidecar(confirmed, refs, { entryUuid: 'FOREIGN' });
  adoptCompletedQueueTransfers(f.db); assert.deepEqual(JSON.parse(f.queue.item(replacement.operationKey).asset_transfer_ids_json), ids);
  assert.equal((await f.collect()).removed.length, 0);
});

test('source-only Claude audit with existing exact origin/source sidecar adopts; no invented UUID', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); const replacement = f.admit(refs, 'SOURCE-ONLY', { provider: 'claude' });
  assert.equal((await f.post('R', f.transfer('R', replacement, ids))).status, 200);
  const confirmed = f.confirm(replacement, { entryUuid: null }), record = f.store.get(replacement.operationKey), audit = record.auditIdentity;
  const projection = { kind: 'claude-request-presentation', version: 1,
    origin: { tabId: 'T', handoffId: confirmed.handoffId, operationKey: confirmed.operationKey, attemptId: confirmed.attemptId },
    binding: { sessionId: audit.sessionId, sourceIdentity: audit.sourceIdentity, auditTimestamp: audit.auditTimestamp, transportHash: audit.promptHash },
    requestText: 'private prompt', requestHash: record.promptHash, preparedHash: record.promptHash };
  f.pm.db.saveHistoryPromptPresentation({ toolType: 'claude', sessionId: audit.sessionId, auditTimestamp: audit.auditTimestamp,
    transportHash: audit.promptHash, schemaVersion: 5, chips: [...refs.map(ref => ({ ...ref, kind: 'image-ref' })), projection] });
  adoptCompletedQueueTransfers(f.db); assert.deepEqual(JSON.parse(f.queue.item(replacement.operationKey).asset_transfer_ids_json), []);
  assert.equal((await f.collect()).removed.length, 0);
});

test('FIRST body is durable before bytes await; pending GET/exact duplicate do not authorize a changed replacement', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); const replacement = f.admit(refs), body = f.transfer('R', replacement, ids);
  const entered = barrier(), release = barrier(), verify = f.assetStore.verifyOwnedRef.bind(f.assetStore);
  f.assetStore.verifyOwnedRef = async ref => { const out = await verify(ref); entered.resolve(); await release.promise; return out; };
  const first = f.post('R', body); await entered.promise;
  const pending = await f.request('/api/run-after/operations/' + body.requestId); assert.equal(pending.body.operation.phase, 'pending');
  assert.equal((await f.post('R', body)).status, 202);
  const changed = await f.post('R', { ...body, transferAssetIds: [ids[0]] }); assert.equal(changed.status, 409);
  assert.equal(changed.body.error, 'run_after_asset_request_conflict');
  release.resolve(); assert.equal((await first).status, 200); assert.equal((await f.collect()).removed.length, 0);
});

test('restart AFTER byte-only reservation resumes only its frozen request, never an ordinary unknown mutation', async t => {
  const f = await fixture(t), refs = await f.assets(), ids = refs.map(r => r.assetId);
  f.createOperation('R', 'replay', ids); const replacement = f.admit(refs), body = f.transfer('R', replacement, ids);
  f.api().journal.reserve(body.requestId, 'T', { op: 'assetDisposition', sourceOperationId: 'R', input: body }, { assetDisposition: true });
  f.whole.reset(); assert.equal(f.api().receipt(body.requestId).phase, 'unknown');
  assert.equal((await f.post('R', { ...body, transferAssetIds: [ids[0]] })).status, 409);
  const resumed = await f.post('R', body); assert.equal(resumed.status, 200);
  assert.equal(f.api().receipt('R').assetLease.released, true); assert.equal((await f.collect()).removed.length, 0);
  const other = f.api().journal.reserve('ordinary-unknown', 'T', { op: 'sendNow', args: { id: 'I' } }, { scopeKey: 'old' });
  f.api().journal.unknown('ordinary-unknown'); f.whole.reset(); assert.equal(f.api().receipt('ordinary-unknown').phase, 'unknown');
  assert.equal((await f.post('R', { ...body, requestId: 'ordinary-unknown' })).status, 409);
  assert.equal(other.replay, false);
});
