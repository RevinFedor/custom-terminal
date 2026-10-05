'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const vm = require('node:vm');
const http = require('node:http');
const url = require('node:url');
const ts = require('typescript');
const SQLite = require('better-sqlite3');
const DatabaseManager = require('./database');
const { SessionTranscriptService } = require('./session-transcript-service');
const codexData = require('./ipc/codex-data');
const { HistoryReadClient } = require('./history-read-client');
const { HistoryFreshness, historyFreshnessScopeKey } = require('./history-freshness');
const { historyReadOwnerFromProjection } = require('./history-read-session');
const { PublicHistoryRevisions, historyPayloadCapability, historyPayloadQuery, eventTabIds } = require('./public-history-read');
const { hashFileSegment } = require('./codex-virtual-transcript');
const { buildCodexForkLineageManifest } = require('./session-history-events');
const { applyHistoryEntryWindow } = require('./history-entry-window');
const { resolveAiToolOwner } = require('./ai-tool-owner');
const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const ast = ts.createSourceFile('web.js', source, ts.ScriptTarget.Latest, true);
const declaration = name => {
  const found = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(found, name); return found.getText(ast);
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const SID = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const query = { view: 'history', last: '80', delta: '1', payloads: 'on-demand-v1', freshness: 'v1' };
const answer = text => ({ type: 'response_item', timestamp: '2026-10-04T00:00:02.000Z',
  payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] } });
const encode = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

async function harness(t, { provider = 'codex', worker = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-api-'));
  const db = new DatabaseManager({ existingConnection: new SQLite(path.join(dir, 'app.db')) }); db.initTables();
  db.db.pragma('journal_mode = WAL');
  const oldClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  let claudeData, file;
  if (provider === 'claude') {
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
    const projectDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', dir.replace(/\//g, '-'));
    fs.mkdirSync(projectDir, { recursive: true }); file = path.join(projectDir, SID + '.jsonl');
    fs.writeFileSync(file, encode([
      { type: 'user', uuid: 'U', parentUuid: null, sessionId: SID, timestamp: '2026-10-04T00:00:01Z', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', uuid: 'A', parentUuid: 'U', sessionId: SID, timestamp: '2026-10-04T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
    ]));
    const original = Module._load;
    Module._load = function (name, parent, main) {
      if (name === 'electron') return { ipcMain: { handle() {} } };
      return original.call(this, name, parent, main);
    };
    try { delete require.cache[require.resolve('./ipc/claude-data')]; claudeData = require('./ipc/claude-data'); }
    finally { Module._load = original; }
    claudeData.register({ projectManager: { db }, formatToolAction: () => null });
  } else {
    file = path.join(dir, 'rollout-' + SID + '.jsonl');
    fs.writeFileSync(file, encode([{ type: 'session_meta', payload: { id: SID, cwd: dir } },
      { type: 'event_msg', timestamp: '2026-10-04T00:00:01Z', payload: { type: 'user_message', message: 'hello' } }, answer('answer')]));
  }
  db.db.prepare('INSERT INTO projects(id,name,path) VALUES(?,?,?)').run('P', 'private', dir);
  db.db.prepare(`INSERT INTO tabs(project_id,tab_id,name,cwd,tab_type,command_type,claude_session_id,codex_session_id)
    VALUES('P','T','private',?,'terminal',?,?,?)`).run(dir, provider, provider === 'claude' ? SID : null, provider === 'codex' ? SID : null);
  const client = worker ? new HistoryReadClient({ databasePath: db.db.name, cacheDirectory: path.join(dir, 'cache'), sessionsDir: dir, memoryBudgetMb: 64 }) : null;
  const api = codexData._api;
  const service = new SessionTranscriptService({ getMainWindow: () => null, webBroadcast: null,
    promptPresentationStore: db, sessionHistoryStore: db, claudeData,
    codexData: { _api: { ...api,
      findCodexSessionFile: (id, cwd) => api.findCodexSessionFile(id, cwd, { sessionsDir: dir, allowContentScan: false }),
      loadSessionRecords: (id, cwd, options) => api.loadSessionRecords(id, cwd, { ...options, sessionsDir: dir }),
      projectCodexFullHistoryFromFile: (id, cwd, options) => api.projectCodexFullHistoryFromFile(id, cwd, { ...options, sessionsDir: dir }),
    } }, historyReader: client });
  let reads = 0, afterRead = null, currentSid = SID, busy = false;
  const read = service.getHistory.bind(service);
  service.getHistory = async payload => { reads++; const result = await read(payload); if (afterRead) await afterRead(result); return result; };
  const createOwner = () => new HistoryFreshness({ readContext: (scope, ids) => service.getHistoryFreshnessContext(scope, ids) });
  const sendJson = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const context = vm.createContext({ crypto, Buffer, Date, console: { log() {}, warn() {}, error() {} },
    sendJson, decId: decodeURIComponent, applyHistoryEntryWindow, eventTabIds,
    transcriptService: service, historyPayloadCapability, historyPayloadQuery,
    publicHistoryRevisions: new PublicHistoryRevisions(), publicHistoryFreshness: createOwner(), historyFreshnessScopeKey,
    historyReadOwnerFromProjection, resolveAiToolOwner, resolveAgentToolType: null,
    require: name => { assert.equal(name, './project-manager'); return { db }; },
    resolveCodexRuntimeProjectionBatch: rows => Object.fromEntries(rows.map(row => [row.tabId,
      { toolType: 'codex', sessionId: null, readSessionId: currentSid, writerConfirmed: false, provenWriterSessionId: null,
        status: busy ? 'busy' : 'inactive', busy, readIdentitySource: 'saved-session' }])),
    resolveHistorySessionInfo: async () => ({ tabId: 'T', toolType: provider, sessionId: currentSid, cwd: dir,
      writerSessionId: null, writerConfirmed: false, readIdentitySource: provider === 'codex' ? 'saved-session' : undefined }),
    publishTabTiming() {}, conversationOwners: null,
    withMessageProjection: value => value, stampPublicRuntimeSnapshot: (_id, value) => value,
    agentSendQueue: null, tabMessageService: null, externalRunByTabId: new Map(), externalRuns: new Map(),
    subscribers: new Map(), BCAST_LOG_TYPES: new Set(), PROJECT_ACTIVITY_TOPIC: 'project-activity',
    hasTabSubscribers: () => false, processOrchestrationLifecycle() {},
    bridgeRequest: () => { throw Error('unexpected renderer fallback'); },
  });
  vm.runInContext(['resolvePersistedPtyAgentOwner','resolveCurrentPtyAgentOwner',
    'historyFreshnessReadOwners','readPublicHistoryFreshness','readHistoryFreshnessWindow',
    'finishConversationOwnerRead','webBroadcast','sendHistoryFreshnessSnapshot'].map(declaration).join('\n'), context);
  const handle = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleApi');
  const batch = handle.body.statements.find(n => ts.isIfStatement(n) && n.expression.getText(ast).includes("'/api/history-freshness'"));
  const start = source.indexOf('  // Load JSONL session history.');
  const end = source.indexOf("  return sendJson(res, 404, { error: 'not found' });", start);
  const handler = vm.runInContext('(async (req,res,parsed) => { let m;' + batch.getText(ast) + source.slice(start, end) + '})', context);
  const server = http.createServer((req, res) => handler(req, res, url.parse(req.url, true)).catch(error => sendJson(res, 500, { error: error.message })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = async (route, values) => {
    const started = performance.now(); const r = await fetch(`http://127.0.0.1:${server.address().port}${route}?${new URLSearchParams(
      Object.fromEntries(Object.entries(values).filter(([,value]) => value !== undefined)))}`);
    const text = await r.text(); return { status: r.status, data: JSON.parse(text), bytes: Buffer.byteLength(text), ms: performance.now() - started };
  };
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await client?.close(); db.close();
    if (oldClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaudeDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file, db, service, context, client, reads: () => reads,
    history: values => request('/api/terminal-tabs/T/history', { ...query, ...values }),
    batch: (ids = ['T']) => request('/api/history-freshness', { tabIds: JSON.stringify(ids) }),
    hook: value => { afterRead = value; }, setBusy: value => { busy = value; }, setSid: value => { currentSid = value; },
    restart: () => { context.publicHistoryFreshness = createOwner(); context.publicHistoryRevisions.clear(); },
    append: text => fs.appendFileSync(file, encode([answer(text)])),
  };
}

for (const options of [{ provider: 'codex' }, { provider: 'codex', worker: true }, { provider: 'claude' }]) {
  test(`${options.provider}/${options.worker ? 'worker' : 'direct'} actual HTTP metadata and unchanged bypass heavy History`, async t => {
    const h = await harness(t, options);
    const initial = await h.batch(); assert.equal(initial.status, 200, JSON.stringify(initial.data)); assert.equal(initial.data.snapshots[0].state, 'unknown');
    assert.equal(h.reads(), 0);
    const first = await h.history(); assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.historyFreshness.state, 'known', JSON.stringify(first.data.historyFreshness));
    assert.ok(first.data.entries.length); assert.equal(first.data.freshnessReadSources, undefined);
    assert.equal(first.data.freshnessReader, undefined);
    const heavy = h.reads();
    const checked = await h.batch(); assert.equal(checked.data.snapshots[0].token, first.data.historyFreshness.token);
    const unchanged = await h.history({ ifRevision: first.data.historyRevision });
    assert.equal(unchanged.data.unchanged, true); assert.equal(h.reads(), heavy);
    assert.equal(unchanged.data.entries, undefined);
    assert.ok(unchanged.data.historyFreshness.coverage.requestKey);
    assert.equal(unchanged.data.writerConfirmed, false, 'read proof never promotes a saved/idle owner to writer');
    console.log('[FreshnessFixture] provider=' + options.provider + ' worker=' + !!options.worker
      + ' batchBytes=' + checked.bytes + ' batchMs=' + checked.ms.toFixed(2)
      + ' unchangedBytes=' + unchanged.bytes + ' unchangedMs=' + unchanged.ms.toFixed(2) + ' heavyCalls=' + h.reads());
  });
}

test('desktop append while native absent and a second turn change only the source version, not scope/window identity', async t => {
  const h = await harness(t); const first = await h.history();
  h.append('desktop while phone absent'); const dirty = await h.batch();
  assert.notEqual(dirty.data.snapshots[0].token, first.data.historyFreshness.token);
  const next = await h.history({ ifRevision: first.data.historyRevision });
  assert.equal(next.data.historyFreshness.state, 'known');
  assert.equal(next.data.historyFreshness.scope, first.data.historyFreshness.scope);
  assert.equal(next.data.historyFreshness.coverage.requestKey, first.data.historyFreshness.coverage.requestKey);
  assert.ok((next.data.entries || next.data.changedEntries).some(e => e.content === 'desktop while phone absent'));
  h.append('second turn'); assert.notEqual((await h.batch()).data.snapshots[0].token, next.data.historyFreshness.token);
});

test('worker restart cannot validate old payload coverage; metadata never starts the reader', async t => {
  const h = await harness(t, { worker: true }); const first = await h.history();
  const generation = h.client.workerGeneration;
  const exited = new Promise(resolve => h.client.worker.once('exit', resolve));
  await h.client.worker.terminate(); await exited;
  const after = await h.batch();
  assert.equal(after.data.snapshots[0].state, 'unknown');
  assert.equal(after.data.snapshots[0].reason, 'reader-generation-changed');
  assert.equal(h.client.worker, null); assert.equal(h.client.workerGeneration, generation);
  const next = await h.history({ ifRevision: first.data.historyRevision });
  assert.equal(next.data.historyFreshness.state, 'known');
  assert.notEqual(next.data.historyFreshness.token, first.data.historyFreshness.token);
  assert.equal(h.client.workerGeneration, generation + 1);
});

test('around window coverage is not tail coverage; a changed owner during read returns 409', async t => {
  const h = await harness(t); const tail = await h.history();
  const around = await h.history({ around: tail.data.entries[0].uuid, radius: '1', ifRevision: tail.data.historyRevision });
  assert.notEqual(around.data.unchanged, true);
  assert.notEqual(around.data.historyFreshness.coverage.requestKey, tail.data.historyFreshness.coverage.requestKey);
  h.hook(() => h.setSid(CHILD));
  const changed = await h.history();
  assert.equal(changed.status, 409); assert.equal(changed.data.error, 'history_read_identity_changed');
});

test('existing broadcast transports dirty metadata, connect revalidates; no event claims completion', async t => {
  const h = await harness(t); const first = await h.history(); const sent = [];
  const sink = { isAlive: () => true, send: text => sent.push(JSON.parse(text)) };
  h.context.subscribers.set('T', new Set([sink]));
  h.append('new');
  h.context.webBroadcast('T', { type: 'transcript-changed' });
  const event = sent.find(e => e.type === 'history-freshness');
  assert.equal(event.tabId, 'T'); assert.equal(event.historyFreshness.state, 'unknown');
  assert.ok(event.historyFreshness.sequence > first.data.historyFreshness.sequence);
  assert.equal(event.historyFreshness.completed, undefined);
  const before = h.reads(); await h.context.sendHistoryFreshnessSnapshot('T', sink);
  const reconnect = sent.at(-1); assert.equal(reconnect.reason, 'connect');
  assert.equal(reconnect.historyFreshness.state, 'known'); assert.equal(h.reads(), before);
  assert.notEqual(reconnect.historyFreshness.token, first.data.historyFreshness.token);
  assert.ok(source.includes('.then(() => sendHistoryFreshnessSnapshot(id, initialSink))'), 'SSE initial wiring');
  assert.ok(source.includes('.then(() => sendHistoryFreshnessSnapshot(tabId, sink))'), 'WS query subscription');
  assert.ok(source.includes('.then(() => sendHistoryFreshnessSnapshot(msg.tabId, sink))'), 'WS message subscription');
});

test('composite frozen prefix uses physical witnesses without admitting later parent rows', async t => {
  const h = await harness(t);
  const parentStat = fs.statSync(h.file), parentHash = await hashFileSegment(h.file, 0, parentStat.size);
  const childFile = path.join(h.dir, 'rollout-' + CHILD + '.jsonl');
  const prelude = encode([{ type: 'session_meta', payload: { id: CHILD, cwd: h.dir, forked_from_id: SID } }]);
  fs.writeFileSync(childFile, prelude);
  const prefixHash = await hashFileSegment(childFile, 0, Buffer.byteLength(prelude));
  const manifest = buildCodexForkLineageManifest({ sourceSessionId: SID, childSessionId: CHILD,
    sourceSegments: [{ physicalSessionId: SID, fromByte: 0, toByte: parentStat.size, startLine: 0,
      endLine: 3, prefixDigest: parentHash.sha256 }],
    childTailStart: { byteOffset: Buffer.byteLength(prelude), line: 1, prefixDigest: prefixHash.sha256 } });
  h.service.sessionHistoryStore = { getSessionHistoryEvents: id => id === CHILD ? [{
    eventKey: 'fork:codex:' + SID + ':' + CHILD, eventType: 'fork', provider: 'codex', sessionId: CHILD,
    sourceSessionId: SID, childSessionId: CHILD, snapshotComplete: true, isDirect: true, origin: 'app', lineageManifest: manifest,
  }] : [] };
  h.setSid(CHILD);
  const discovered = await h.history(); assert.equal(discovered.status, 200, JSON.stringify(discovered.data));
  // The first read discovered an additional dependency not in its pre-read
  // metadata snapshot. A bounded selected read certifies that complete scope.
  const first = discovered.data.historyFreshness.state === 'known' ? discovered : await h.history();
  assert.equal(first.data.historyFreshness.state, 'known'); assert.equal(first.data.historyFreshness.sourceCount, 2);
  assert.equal(first.data.composite, true);
  h.append('outside frozen parent boundary');
  const dirty = await h.batch(); assert.notEqual(dirty.data.snapshots[0].token, first.data.historyFreshness.token);
  const next = await h.history({ ifRevision: first.data.historyRevision });
  assert.equal(next.data.historyFreshness.state, 'known');
  assert.equal((next.data.entries || next.data.changedEntries || []).some(e => e.content === 'outside frozen parent boundary'), false);
});

test('busy→idle can precede History; a newer dirty event while GET is outstanding cannot be certified by older rows', async t => {
  const h = await harness(t); const first = await h.history();
  const started = deferred(), release = deferred(); h.setBusy(true);
  h.hook(async () => { started.resolve(); await release.promise; });
  const pending = h.history(); await started.promise;
  h.setBusy(false); h.append('later'); const event = h.context.publicHistoryFreshness.invalidate('T');
  assert.equal(event.state, 'unknown');
  const before = h.reads();
  const whileHeld = await h.batch();
  assert.equal(whileHeld.data.snapshots[0].state, 'known'); assert.equal(h.reads(), before);
  assert.notEqual(whileHeld.data.snapshots[0].token, first.data.historyFreshness.token,
    'metadata reads do not wait for the outstanding History operation');
  release.resolve(); const old = await pending; h.hook(null);
  assert.equal(old.data.historyFreshness.state, 'unknown'); assert.equal(old.data.historyFreshness.token, null);
  const applied = await h.history({ ifRevision: old.data.historyRevision });
  assert.equal(applied.data.historyFreshness.state, 'known');
  assert.notEqual(applied.data.historyFreshness.token, first.data.historyFreshness.token);
});

test('sidecar-only duration changes invalidate and reach actual History without source append', async t => {
  const h = await harness(t); const first = await h.history();
  const row = first.data.entries.find(e => e.role === 'assistant');
  const sql = new SQLite(h.db.db.name); t.after(() => sql.close());
  sql.prepare(`INSERT INTO agent_activity_intervals(id,tab_id,engine,session_id,start_ts,end_ts,duration_ms)
    VALUES(1,'T','codex',?,1,3001,3000)`).run(SID);
  sql.prepare(`INSERT INTO history_response_timings(interval_id,tool_type,tab_id,session_id,entry_uuid,source_identity)
    VALUES(1,'codex','T',?,?,?)`).run(SID, row.uuid, row.sourceIdentity || null);
  const dirty = await h.batch(); assert.notEqual(dirty.data.snapshots[0].token, first.data.historyFreshness.token);
  const changed = await h.history({ ifRevision: first.data.historyRevision });
  assert.equal(changed.data.historyFreshness.state, 'known');
  const rows = changed.data.entries || changed.data.changedEntries;
  assert.equal(rows.find(e => e.uuid === row.uuid).responseTiming.durationMs, 3000);
  sql.exec('UPDATE agent_activity_intervals SET duration_ms=6000 WHERE id=1');
  const later = await h.history({ ifRevision: changed.data.historyRevision });
  assert.equal((later.data.entries || later.data.changedEntries).find(e => e.uuid === row.uuid).responseTiming.durationMs, 6000);
});

test('batch is bounded and never calls project fanout or history preparation; missing/inactive/foreign owners stay distinct', async t => {
  const h = await harness(t); await h.history(); const before = h.reads();
  h.db.getAllProjects = () => { throw Error('full catalogue fanout forbidden'); };
  const snapshot = await h.batch(['T','missing']); assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.snapshots[0].state, 'known'); assert.equal(snapshot.data.snapshots[1].state, 'unknown');
  assert.equal(h.reads(), before); assert.ok(snapshot.bytes < 1600);
  assert.equal((await h.batch(Array(33).fill('T'))).status, 400);
  const catalogue = await h.batch(['T', ...Array.from({ length: 31 }, (_, i) => 'unobserved-' + i)]);
  assert.equal(catalogue.data.snapshots.length, 32); assert.equal(h.reads(), before);
  assert.ok(catalogue.bytes < 13000);
  console.log('[FreshnessFixture] batch32Bytes=' + catalogue.bytes + ' batch32Ms=' + catalogue.ms.toFixed(2) + ' extraHistoryCalls=' + (h.reads() - before));
  h.setSid(CHILD); assert.equal((await h.batch()).data.snapshots[0].state, 'unknown');
  h.setSid(SID); const epoch = (await h.batch()).data.epoch; h.restart();
  const cold = await h.batch(); assert.notEqual(cold.data.epoch, epoch); assert.equal(cold.data.snapshots[0].state, 'unknown');
  assert.equal(h.reads(), before);
});

test('missing source after a known page stays unknown; legacy reads retain the default wire', async t => {
  const h = await harness(t); const known = await h.history();
  const legacy = await h.history({ freshness: undefined });
  assert.equal(legacy.status, 200); assert.equal(legacy.data.historyFreshness, undefined);
  assert.equal(legacy.data.freshnessReadSources, undefined); assert.equal(legacy.data.freshnessReader, undefined);
  assert.equal((await h.history({ freshness: 'v2' })).status, 400);
  fs.unlinkSync(h.file);
  const absent = await h.batch(); assert.equal(absent.data.snapshots[0].reason, 'source-missing');
  assert.notEqual(absent.data.snapshots[0].token, known.data.historyFreshness.token);
});
