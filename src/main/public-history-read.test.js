'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const url = require('node:url');
const crypto = require('node:crypto');
const ts = require('typescript');
const { MAX_EVENT_TABS, eventTabIds, stampedEventSink, PublicHistoryRevisions, TabTranscriptSubscriptions,
  historyPayloadCapability, historyPayloadQuery } = require('./public-history-read');
const { SessionTranscriptService } = require('./session-transcript-service');
const { applyHistoryEntryWindow } = require('./history-entry-window');
const { historyReadSession, historyReadOwnerFromProjection } = require('./history-read-session');
const { completionNotificationCapability } = require('./tab-completion-notification-api');
const { normalizeHistoryResponseToolType, decorateHistoryResponseTimings, observeHistoryResponseTimingBindings } = require('./history-response-timings');
const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const functions = (text, names) => {
  const ast = ts.createSourceFile('actual.js', text, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, name); return node.getText(ast);
  }).join('\n');
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const quiet = { log() {}, warn() {}, error() {} };
const sendJson = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

test('multiplex validation is bounded, explicit, backwards compatible and percent-safe', () => {
  assert.equal(eventTabIds({ tabId: 'A' }), null);
  assert.equal(eventTabIds({ scope: 'projects' }), null);
  assert.deepEqual(eventTabIds({ tabIds: '["A","B","A","percent%2Fid"]' }), ['A', 'B', 'percent%2Fid']);
  for (const value of ['{}', '[]', '[null]', '[1]', '[""]', JSON.stringify(Array(33).fill('A'))]) {
    assert.throws(() => eventTabIds({ tabIds: value }));
  }
  for (const mixed of [{ tabId: 'A' }, { scope: 'projects' }, { projectActivity: '1' }]) {
    assert.throws(() => eventTabIds({ ...mixed, tabIds: '["A"]' }));
  }
});

test('SSE stamps identity and serializes slow initial A before buffered A events, without blocking B', () => {
  const rows = []; let alive = true;
  const sink = stampedEventSink({ isAlive: () => alive, close: () => { alive = false; }, send: str => rows.push(JSON.parse(str)) }, 'instance');
  const initial = sink.beginInitial('A');
  sink.send(JSON.stringify({ type: 'transcript-changed', tabId: 'A', sessionId: 'child', version: 3 }));
  sink.send(JSON.stringify({ type: 'snapshot', tabId: 'B' }));
  initial.send(JSON.stringify({ type: 'snapshot', tabId: 'A', sessionId: 'source' })); initial.finish();
  assert.deepEqual(rows.map(x => [x.tabId, x.type, x.initial]), [['B','snapshot',false],['A','snapshot',true],['A','transcript-changed',false]]);
  assert.deepEqual(rows.map(x => x.sequence), [1, 2, 3]);
  assert.equal(new Set(rows.map(x => x.connectionId)).size, 1);
  assert.equal(rows[2].sessionId, 'child'); assert.equal(rows[2].streamInstanceId, 'instance');
  alive = false; sink.send('{"tabId":"A"}'); assert.equal(rows.length, 3);
});

test('slow initial queue is bounded and closes instead of dropping arbitrary live rows', () => {
  let closed = false;
  const sink = stampedEventSink({ isAlive: () => !closed, close: () => { closed = true; }, send() {} }, 'instance', 20);
  sink.beginInitial('A'); sink.send('{"tabId":"A","type":"message","content":"large"}');
  assert.equal(closed, true);
});

test('opaque revision cannot be reused across tab, source, projection bounds or restart', () => {
  const cache = new PublicHistoryRevisions(1), scope = { tabId: 'A', sessionId: 'S', bounds: { last: 2 } };
  const revision = { token: 'canonical', sources: [{ filePath: '/never-from-input' }] };
  const token = cache.remember(revision, scope);
  assert.equal(cache.lookup(token, scope), revision);
  assert.equal(cache.lookup(token, { ...scope, tabId: 'B' }), null);
  assert.equal(cache.lookup(token, { ...scope, sessionId: 'child' }), null);
  assert.equal(cache.lookup(token, { ...scope, bounds: { last: 4 } }), null);
  cache.remember({ token: 'new' }, scope); assert.equal(cache.lookup(token, scope), null);
  assert.equal(new PublicHistoryRevisions().lookup(token, scope), null);
});

test('one consumer joins concurrent connects and close during async subscribe is cleaned up', async () => {
  let live = true; const read = deferred(), subscribed = deferred(), calls = [];
  const owner = new TabTranscriptSubscriptions({ hasConsumers: () => live, readSession: async () => read.promise,
    subscribe: async request => { calls.push(['subscribe', request]); await subscribed.promise; return { success: true }; },
    unsubscribe: async request => { calls.push(['unsubscribe', request]); } });
  const a = owner.reconcile('A'), b = owner.reconcile('A');
  read.resolve({ toolType: 'codex', sessionId: 'source' });
  // Resolve-only tick, not a wall-clock race.
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  live = false; owner.releaseOrphans(); subscribed.resolve(); await Promise.all([a, b]);
  assert.deepEqual(calls.map(c => c[0]), ['subscribe', 'unsubscribe']);
  assert.equal(owner.tabs.size, 0);
});

test('source changes during read use one trailing reconciliation; close/reconnect cannot unsubscribe the new child', async () => {
  let live = true, sid = 'source'; const first = deferred(), calls = []; let count = 0;
  const owner = new TabTranscriptSubscriptions({ hasConsumers: () => live,
    readSession: async () => { if (++count === 1) await first.promise; return { toolType: 'codex', sessionId: sid }; },
    subscribe: async request => { calls.push(['subscribe', request.sessionId]); return { success: true }; },
    unsubscribe: async () => { calls.push(['unsubscribe']); } });
  const a = owner.reconcile('A'); live = false; owner.releaseOrphans(); live = true; sid = 'child'; owner.reconcile('A');
  first.resolve(); await a;
  assert.deepEqual(calls, [['subscribe', 'child']]);
  await owner.reconcile('A'); assert.equal(calls.length, 1);
  sid = 'grandchild'; await owner.reconcile('A'); assert.deepEqual(calls[1], ['subscribe','grandchild']);
  await owner.stop(); assert.equal(owner.tabs.size, 0);
});

function timingOwner() {
  let now = 100000, pending = null;
  const open = new Map(), preflight = new Map();
  const context = vm.createContext({ normalizeHistoryResponseToolType, activityOpenIntervals: open,
    responseActivityPreflights: preflight, Date: { now: () => now },
    projectManager: { db: { getLatestPendingHistoryResponseTimingForTab: (_tab, tool) => !tool || tool === pending?.toolType ? pending : null } } });
  vm.runInContext(functions(main, ['readAgentTabTiming']), context);
  return { open, preflight, read: x => context.readAgentTabTiming(x), setPending: x => { pending = x; }, setNow: x => { now = x; } };
}

test('actual shared IPC owner reads preflight -> running -> exact pending -> null without creating intervals', () => {
  const h = timingOwner();
  h.preflight.set('A', { engine: 'codex', startTs: 90000 });
  assert.equal(h.read({ tabId: 'A', toolType: 'codex' }).timing.startTs, 90000);
  assert.equal(h.read({ tabId: 'A', toolType: 'codex' }).timing.phase, 'preflight');
  assert.equal(h.read({ tabId: 'A', toolType: 'claude' }).timing, null);
  h.open.set('A', { engine: 'codex', startTs: 90000, sessionId: 'source' }); h.preflight.clear();
  assert.equal(h.read({ tabId: 'A' }).timing.startTs, 90000);
  h.open.clear(); h.setPending({ intervalId: 7, toolType: 'codex', sessionId: 'child', startTs: 90000, endTs: 99000, durationMs: 9000 });
  const value = h.read({ tabId: 'A' }).timing;
  assert.equal(value.state, 'pending'); assert.equal(value.validUntil, 109000);
  h.setNow(109001); assert.equal(h.read({ tabId: 'A' }).timing, null);
  assert.equal(h.open.size, 0); assert.equal(h.preflight.size, 0);
  assert.match(main, /ipcMain.handle\('agent-activity:get-tab-timing', \(_event, payload = \{\}\) => readAgentTabTiming\(payload\)\)/);
});

test('bound sidecar observer only sees successful exact bindings and can unsubscribe', () => {
  const notifications = [], release = observeHistoryResponseTimingBindings(x => notifications.push(x));
  let accepted = false;
  const db = { getPendingHistoryResponseTimings: () => [{ intervalId: 1, tabId: 'A', sessionId: 'S', startTs: 1000, endTs: 2000 }],
    bindHistoryResponseTimingEntry: () => accepted };
  const input = { tabId:'A', toolType:'codex', sessionId:'S', entries:[{ uuid:'exact', sessionId:'S', role:'assistant', content:'answer', timestamp:new Date(1500).toISOString() }] };
  decorateHistoryResponseTimings(db, input); assert.equal(notifications.length, 0);
  accepted = true; decorateHistoryResponseTimings(db, input); assert.equal(notifications[0].intervalId, 1);
  release(); decorateHistoryResponseTimings(db, input); assert.equal(notifications.length, 1);
});

async function historyHarness(t, realRecords = null, ownerProof = false, worker = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-history-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout-source.jsonl'); fs.writeFileSync(file, realRecords ? realRecords.map(r=>JSON.stringify(r)).join('\n')+'\n' : '{"type":"session_meta"}\n');
  const realParser = realRecords ? require('./ipc/codex-data')._api : null;
  let sid = 'source', loads = 0, nextSid = null, rows = [{ uuid:'u', role:'user', content:'prompt' }, { uuid:'a', role:'assistant', content:'answer' }];
  let timingRevision = 'none', timings = [];
  let inputDuringRead = false;
  const ownerRows = new Map();
  const owner = ownerProof ? new (require('./conversation-owner').ConversationOwners)({
    db: { getAppState: key => ownerRows.get(key), setAppState: (key, value) => ownerRows.set(key, value) },
    capture: () => ({ known: true, provider: 'codex', projectId: 'P', cwd: dir, sessionId: sid, launchId: null }),
  }) : null;
  owner?.checkpoint('A', { operationId: 'O', toolType: 'codex', bindingCommitted: true, activeSessionId: sid }, owner.observation('A'));
  const service = new SessionTranscriptService({ getMainWindow: () => null,
    promptPresentationStore: { getHistoryResponseTimingRevision: () => timingRevision,
      getHistoryResponseTimingsForEntries: () => timings },
    codexData: { _api: {
      findCodexSessionFile: async () => ({ filePath: file }),
      loadSessionRecords: async () => { loads++; const records=realParser ? await realParser.parseJsonlFile(file) : []; const stat = fs.statSync(file); return { success:true, records, filePath:file,
        sourceSnapshot:{ filePath:file, size:stat.size, mtimeMs:stat.mtimeMs, sessionId:sid, linkKind:'end' } }; },
      buildCodexFullHistory: (records, ...args) => { if(realParser)return realParser.buildCodexFullHistory(records,...args);
        if (inputDuringRead) { owner?.noteInput('A'); inputDuringRead = false; }
        const projection=rows.map(row => ({ ...row, sessionId:sid })); if(nextSid){sid=nextSid;nextSid=null;} return projection; },
    } } });
  const scope = vm.createContext({ console:quiet, crypto, sendJson, decId:decodeURIComponent, applyHistoryEntryWindow,
    historyPayloadCapability, historyPayloadQuery,
    conversationOwners: owner,
    publicHistoryRevisions:new PublicHistoryRevisions(), transcriptService:service,
    resolveHistorySessionInfo: async () => ({ toolType:'codex', sessionId:sid, writerSessionId:null, writerConfirmed:false, cwd:dir }),
    publishTabTiming() {}, bridgeRequest: () => { throw Error('unexpected renderer fallback'); } });
  const start = source.indexOf('  // Load JSONL session history.');
  const end = source.indexOf("  return sendJson(res, 404, { error: 'not found' });", start);
  const webAst = ts.createSourceFile('web.js', source, ts.ScriptTarget.Latest, true);
  const ownerRead = webAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'finishConversationOwnerRead');
  vm.runInContext(ownerRead.getText(webAst), scope);
  const handler = vm.runInContext('(async (req,res,parsed) => { let m; ' + source.slice(start, end) + '})', scope);
  const server = http.createServer((req,res) => handler(req,res,url.parse(req.url,true)).catch(e => sendJson(res,500,{error:e.message})));
  let client;
  const config = { sessionsDir: dir, cacheDirectory: path.join(dir, 'prepared'), memoryBudgetMb: 64 };
  if (worker) {
    client = new (require('./history-read-client').HistoryReadClient)(config);
    service.historyReader = client;
    t.after(() => client.close());
  }
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  return { read: async (query, route = 'history') => { const response = await fetch(`http://127.0.0.1:${server.address().port}/api/terminal-tabs/A/${route}?${new URLSearchParams(query)}`);
    return { status:response.status, data:await response.json() }; }, loads: () => loads,
    file, service, scope, get client() { return client; },
    async restartWorker() { await client.close(); client = new (require('./history-read-client').HistoryReadClient)(config); service.historyReader = client; },
    owner, duringReadInput: () => { inputDuringRead = true; },
    setSid: x => { sid=x; }, duringRead: x => { nextSid=x; }, change: next => { rows=next; fs.appendFileSync(file,'{}\n'); },
    append: records => fs.appendFileSync(file,records.map(r=>JSON.stringify(r)).join('\n')+'\n'),
    setTiming: () => { timingRevision='bound'; timings=[{ entryUuid:'a', intervalId:7, startTs:1, endTs:1001, durationMs:1000 }]; } };
}

const hiddenRecords = () => [
  { type: 'session_meta', timestamp: '2026-10-03T00:00:00Z', payload: { id: 'source', cwd: '/fixture' } },
  { type: 'event_msg', timestamp: '2026-10-03T00:00:01Z', payload: { type: 'user_message', message: 'ordinary prompt '.repeat(2500) } },
  { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call-hidden',
    arguments: JSON.stringify({ cmd: 'echo ' + 'code '.repeat(20000) }) } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-hidden', output: 'OUTPUT '.repeat(10000) } },
  { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'THINK '.repeat(10000) }] } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ordinary answer '.repeat(2500) }] } },
  { type: 'compacted', message: 'COMPACT '.repeat(20000) },
].map((row, index) => ({ ...row, timestamp: new Date(Date.UTC(2026, 9, 3) + index * 1000).toISOString() }));
const lightQuery = { view: 'history', last: '80', delta: '1', payloads: 'on-demand-v1' };
const payloadQuery = (history, ref) => ({ toolType: history.toolType, sessionId: history.sessionId,
  entryUuid: ref.rowUuid, payloadId: ref.payloadId, payloadGeneration: history.payloadGeneration, contentHash: ref.contentHash });

test('actual /api/me advertises the opt-in only with an available payload owner and requires auth', async t => {
  const ast = ts.createSourceFile('web.js', source, ts.ScriptTarget.Latest, true);
  const method = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleApi');
  const block = method.body.statements.find(node => ts.isIfStatement(node) && node.expression.getText(ast).includes("'/api/me'"));
  const scope = vm.createContext({ sendJson, checkAuth: req => req.headers.authorization === 'Bearer fixture',
    publicTabActivity: null, projectCardSignals: null, codexGoalActions: null,
    publicHistoryFreshness: null, agentSendQueue: null, systemPromptService: null, agentParamsService: null, completionNotificationCapability,
    getLanIp: () => '127.0.0.1', webServerServiceHealth: () => ({ instanceId: 'fixture' }), MAX_EVENT_TABS,
    transcriptService: { getToolPayload() {} }, historyPayloadCapability,
    readAgentTabTiming: null, readAgentUsage: null, readAgentParams: null, readAgentRuntimeSnapshot: null,
    readCodexAuthProfile: null, savedHistoryOperations: null, conversationOwners: null, inboxSavedHistoryOperations: null,
    agentSendReceiptStore: null, STRUCTURED_AUTHORING_LIMITS: { bytes: 1 }, MAX_CONTEXT_FILES: 1,
    MAX_CONTEXT_FILE_BYTES: 1, MAX_CONTEXT_TOTAL_BYTES: 1 });
  const handler = vm.runInContext('(async (req,res,parsed) => {' + block.getText(ast) + '})', scope);
  const freshnessDeclaration = ast.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => item.name.getText(ast) === 'historyFreshnessCapability'));
  vm.runInContext(freshnessDeclaration.getText(ast), scope);
  const server = http.createServer((req, res) => handler(req, res, url.parse(req.url, true)).catch(error => sendJson(res, 500, { error: error.message })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const address = `http://127.0.0.1:${server.address().port}/api/me`;
  assert.equal((await fetch(address)).status, 401);
  const allowed = await (await fetch(address, { headers: { authorization: 'Bearer fixture' } })).json();
  assert.deepEqual(allowed.capabilities.historyPayloads, historyPayloadCapability);
  assert.equal(allowed.capabilities.historyPayloads.headerVersion, 2);
  assert.deepEqual(allowed.capabilities.completionNotifications, completionNotificationCapability);
  assert.equal(allowed.capabilities.historyFreshness, undefined);
  assert.equal(allowed.capabilities.tabActivity, undefined);
  scope.publicTabActivity = require('./public-tab-activity').createPublicTabActivity({ epoch: 'metadata-epoch',
    readState: () => { throw Error('capability must not read tab metadata'); },
    readInherited: () => { throw Error('capability must not read registry'); } });
  const activity = await (await fetch(address, { headers: { authorization: 'Bearer fixture' } })).json();
  assert.deepEqual(activity.capabilities.tabActivity, scope.publicTabActivity.capability);
  scope.publicTabActivity = null;
  scope.publicHistoryFreshness = {};
  const freshness = await (await fetch(address, { headers: { authorization: 'Bearer fixture' } })).json();
  assert.deepEqual(freshness.capabilities.historyFreshness, { version: 1, providers: ['claude','codex'],
    endpoint: '/api/history-freshness', maxTabs: 32, historyQuery: { freshness: 'v1' },
    event: 'history-freshness', ordering: 'epoch-sequence', outcomeCoverage: false });
  scope.transcriptService = null;
  const absent = await (await fetch(address, { headers: { authorization: 'Bearer fixture' } })).json();
  assert.equal(absent.capabilities.historyPayloads, undefined);
});

test('actual HTTP -> worker -> canonical parser: no hidden bodies, full prose, exact on-tap action/result/compact', async t => {
  const h = await historyHarness(t, hiddenRecords(), false, true);
  const legacy = await h.read({ view: 'history', last: '80', delta: '1' });
  const first = await h.read({ ...lightQuery, ifRevision: legacy.data.historyRevision });
  assert.equal(first.status, 200, JSON.stringify(first)); assert.equal(first.data.unchanged, false);
  assert.notEqual(first.data.historyRevision, legacy.data.historyRevision);
  assert.deepEqual(first.data.entries.map(row => row.uuid), legacy.data.entries.map(row => row.uuid));
  for (const row of legacy.data.entries.filter(row => row.role === 'user' || row.content?.startsWith('ordinary answer'))) {
    assert.equal(first.data.entries.find(value => value.uuid === row.uuid).content, row.content);
  }
  assert.ok(JSON.stringify(first).length < JSON.stringify(legacy).length / 2);
  const row = first.data.entries.find(row => row.actions?.[0]?.actionRef);
  const action = row.actions[0];
  assert.equal(first.data.payloadHeaderVersion, 2);
  assert.equal(action.hasResult, true); assert.equal(action.status, 'done');
  assert.equal(action.rawTool.args, undefined); assert.equal(action.rawTool.result, undefined);
  for (const ref of [action.actionRef, action.rawTool.resultRef,
    first.data.entries.find(row => row.thinkingRef)?.thinkingRef,
    first.data.entries.find(row => row.compactSummaryRef)?.compactSummaryRef]) {
    assert.ok(ref, 'every hidden field has a ref');
    const body = await h.read(payloadQuery(first.data, ref), 'history-payload');
    assert.equal(body.status, 200, JSON.stringify(body));
    assert.equal(body.data.totalChars, ref.totalChars); assert.equal(body.data.nextOffset, null);
    if (ref.encoding === 'json') assert.ok(JSON.stringify(JSON.parse(body.data.payload).rawTool.args).length > 100000);
  }
  assert.equal((await h.read({ ...lightQuery, ifRevision: first.data.historyRevision })).data.unchanged, true);
  const normal = await h.read({ view: 'history', last: '80', delta: '1', ifRevision: first.data.historyRevision });
  assert.equal(normal.data.unchanged, false); assert.deepEqual(normal.data.entries, legacy.data.entries);
});

test('canonical settings baseline precedes a bounded tail, survives SSD restart, and preserves A→B→A and rollback', async t => {
  const settings = (model, effort, index) => ({ type: 'event_msg', timestamp: new Date(1000000 + index * 1000).toISOString(),
    payload: { type: 'thread_settings_applied', thread_settings: { model, reasoning_effort: effort } } });
  const user = text => ({ type: 'event_msg', payload: { type: 'user_message', message: text } });
  const records = [{ type: 'session_meta', payload: { id: 'source' } }, settings('A', 'max', 1), user('one'),
    settings('B', 'max', 2), user('two'), settings('A', 'max', 3), user('tail')];
  const h = await historyHarness(t, records, false, true);
  const query = { view: 'history', last: '1', delta: '1', payloads: 'on-demand-v1' };
  const first = (await h.read(query)).data;
  assert.equal(first.entries.length, 1); assert.equal(first.entries[0].content, 'tail');
  const baseline = first.settingsBaseline;
  assert.equal(baseline.before.model.settingsFact.value, 'A');
  assert.equal(baseline.before.model.timestamp, records[5].timestamp);
  assert.equal(baseline.before.effort.settingsFact.value, 'max');
  assert.equal(baseline.scope.revisionToken, first.revision.token);
  assert.equal(baseline.scope.payloadGeneration, first.payloadGeneration);
  assert.equal(baseline.window.hasMoreBelow, false);
  assert.equal(baseline.before.model.sourceIdentityAliases, undefined, 'baseline never carries long alias arrays');
  const fullBefore = (await h.read({ view: 'history', last: '100' })).data;
  const secondUser = fullBefore.entries.find(row => row.content === 'two');
  const around = (await h.read({ view: 'history', around: secondUser.uuid, radius: '1' })).data;
  assert.equal(around.entries.length, 3);
  assert.equal(around.entries[1].uuid, secondUser.uuid);
  assert.equal(around.settingsBaseline.before.model.settingsFact.value, 'A');
  assert.equal(around.settingsBaseline.before.model.timestamp, records[1].timestamp, 'baseline belongs before this historical window');
  assert.equal(around.settingsBaseline.window.hasMoreBelow, true, 'historical around baseline is not the live tail');
  await h.restartWorker();
  const again = (await h.read(query)).data;
  assert.deepEqual(again.settingsBaseline.before, baseline.before);
  assert.deepEqual(again.settingsBaseline.window, baseline.window);
  assert.equal(again.settingsBaseline.scope.payloadGeneration, baseline.scope.payloadGeneration);
  assert.equal(again.settingsBaseline.scope.revisionToken, again.revision.token);
  h.append([settings('A', 'max', 4)]);
  const repeated = (await h.read({ ...query, ifRevision: again.historyRevision })).data;
  assert.equal(repeated.settingsBaseline.before.model.uuid, baseline.before.model.uuid);
  h.append([{ type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } }]);
  const rolled = (await h.read(query)).data;
  assert.equal(rolled.settingsBaseline.before.model.settingsFact.value, 'B');
  const full = (await h.read({ view: 'history', last: '100' })).data;
  assert.deepEqual(full.settingsBaseline.before, { model: null, effort: null });
  const unchanged = (await h.read({ ...query, ifRevision: rolled.historyRevision })).data;
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.settingsBaseline, undefined, 'unchanged retains the previously received bound baseline');
});

test('on-demand refs survive worker restart/SSD and reject rewrite, wrong row/hash/session and malformed ranges', async t => {
  const h = await historyHarness(t, hiddenRecords(), false, true);
  const first = (await h.read(lightQuery)).data;
  const ref = first.entries.find(row => row.actions?.[0]?.actionRef).actions[0].actionRef;
  const query = payloadQuery(first, ref);
  await h.restartWorker();
  const body = await h.read(query, 'history-payload');
  assert.equal(body.status, 200, JSON.stringify(body));
  assert.equal((await h.client.call('stats')).sourceBytes, 0, 'SSD read without raw replay');
  for (const [change, status] of [[{ sessionId: 'foreign' }, 409], [{ entryUuid: 'missing' }, 404],
    [{ contentHash: '0'.repeat(64) }, 409], [{ payloadId: 'missing' }, 404], [{ offset: '-1' }, 400],
    [{ limit: '1' }, 400], [{ offset: String(ref.totalChars + 1) }, 400], [{ payloadGeneration: '' }, 400]]) {
    assert.equal((await h.read({ ...query, ...change }, 'history-payload')).status, status, JSON.stringify(change));
  }
  const previous = fs.statSync(h.file);
  const rewritten = fs.readFileSync(h.file, 'utf8').replace('echo ', 'READ ');
  fs.writeFileSync(h.file + '.replacement', rewritten); fs.utimesSync(h.file + '.replacement', previous.atime, previous.mtime);
  fs.renameSync(h.file + '.replacement', h.file);
  const stale = await h.read(query, 'history-payload');
  assert.equal(stale.status, 409, JSON.stringify(stale)); assert.equal(stale.data.error, 'history_payload_generation_changed');
});

test('on-demand delta preserves the exact body revision for late results; old ref never returns new content', async t => {
  const records = hiddenRecords().slice(0, 3);
  const h = await historyHarness(t, records, false, true);
  const first = (await h.read(lightQuery)).data;
  const ref = first.entries.find(row => row.actions?.[0]?.actionRef).actions[0].actionRef;
  const pending = first.entries.find(row => row.uuid === ref.rowUuid).actions[0];
  assert.deepEqual([pending.hasResult, pending.status], [false, 'running']);
  h.append([{ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-hidden', output: 'late result' } }]);
  const next = (await h.read({ ...lightQuery, ifRevision: first.historyRevision })).data;
  assert.equal(next.delta, true); assert.ok(next.changedEntries.some(row => row.uuid === ref.rowUuid));
  const stale = await h.read(payloadQuery(first, ref), 'history-payload');
  assert.equal(stale.status, 409); assert.equal(stale.data.error, 'history_payload_changed');
  const changed = next.changedEntries.find(row => row.uuid === ref.rowUuid).actions[0].actionRef;
  const finished = next.changedEntries.find(row => row.uuid === ref.rowUuid).actions[0];
  assert.deepEqual([finished.hasResult, finished.status], [true, 'done']);
  const valid = await h.read(payloadQuery({ ...first, ...next }, changed), 'history-payload');
  assert.equal(valid.status, 200, JSON.stringify(valid));
  assert.equal(JSON.parse(valid.data.payload).rawTool.result, 'late result');
});

test('actual HTTP and canonical reader do not reuse header-v1 revisions as header-v2 unchanged', async t => {
  const { buildHistoryRevision } = require('./history-revision');
  const h = await historyHarness(t, hiddenRecords(), false, true);
  const first = (await h.read(lightQuery)).data;
  const context = JSON.parse(first.revision.context);
  assert.equal(context.payloadHeaderVersion, 2);
  delete context.payloadHeaderVersion;
  const oldRevision = buildHistoryRevision(first.revision, first.revision.sources, { context: JSON.stringify(context) });
  const held = h.scope.publicHistoryRevisions.entries.get(first.historyRevision);
  const oldScope = JSON.parse(held.scope); delete oldScope.payloadHeaderVersion;
  const oldToken = h.scope.publicHistoryRevisions.remember(oldRevision, oldScope);
  const reply = await h.read({ ...lightQuery, ifRevision: oldToken });
  assert.equal(reply.status, 200); assert.equal(reply.data.unchanged, false);
  assert.equal(reply.data.payloadHeaderVersion, 2);
  assert.equal(reply.data.entries.find(row => row.actions?.[0]).actions[0].hasResult, true);
  const direct = await h.service.getHistory({ ...oldScope, ifRevision: oldRevision });
  assert.equal(direct.unchanged, false); assert.equal(JSON.parse(direct.revision.context).payloadHeaderVersion, 2);
});

test('payload read rejects a session change while awaiting the reader, and has no renderer/full fallback', async t => {
  const h = await historyHarness(t, hiddenRecords(), false, true);
  const first = (await h.read(lightQuery)).data;
  const ref = first.entries.find(row => row.actions?.[0]?.actionRef).actions[0].actionRef;
  const original = h.service.getToolPayload.bind(h.service);
  h.service.getToolPayload = async request => { const result = await original(request); h.setSid('child'); return result; };
  assert.equal((await h.read(payloadQuery(first, ref), 'history-payload')).status, 409);
  for (const query of [{ payloads: 'on-demand-v1' }, { view: 'history', payloads: 'unknown' }]) {
    assert.equal((await h.read(query)).status, 400);
  }
});

test('actual payload HTTP pages retain the complete >4 MiB action, not a truncated JSON success', async t => {
  const full = '🧪'.repeat(2200000);
  const h = await historyHarness(t, [{ type: 'response_item', payload: { type: 'function_call', name: 'write_file',
    call_id: 'large-input', arguments: JSON.stringify({ path: '/tmp/body.txt', content: full }) } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'large-input', output: full } }], false, true);
  const first = (await h.read(lightQuery)).data;
  const action = first.entries[0].actions[0];
  for (const ref of [action.actionRef, action.rawTool.resultRef]) {
  let text = '', offset = 0;
  do {
    const body = await h.read({ ...payloadQuery(first, ref), offset: String(offset) }, 'history-payload');
    assert.equal(body.status, 200, body.data.error);
    text += body.data.payload; offset = body.data.nextOffset;
  } while (offset !== null);
  assert.equal(text.length, ref.totalChars);
  assert.equal(ref.encoding === 'json' ? JSON.parse(text).rawTool.args.content : text, full);
  }
});

test('Claude actual branch reader supports on-demand Edit/thinking/compact and rejects same-size source rewrite', async t => {
  const Module = require('node:module');
  const h = await historyHarness(t);
  const root = path.dirname(h.file), projectDir = path.join(root, '.claude/projects/-fixture');
  fs.mkdirSync(projectDir, { recursive: true });
  const full = 'BODY '.repeat(10000);
  const records = [
    { uuid: 'user', type: 'user', message: { role: 'user', content: 'ordinary '.repeat(5000) } },
    { uuid: 'edit', parentUuid: 'user', type: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: full }, { type: 'text', text: 'complete prose '.repeat(2000) },
      { type: 'tool_use', id: 'edit-call', name: 'Edit', input: { file_path: '/tmp/file.md', old_string: full, new_string: 'NEW ' + full } },
    ] } },
    { uuid: 'result', parentUuid: 'edit', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-call', content: full }] } },
    { uuid: 'task', parentUuid: 'result', type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'task-call', name: 'Agent', input: { description: 'sync failure', prompt: 'test' } },
    ] } },
    { uuid: 'task-result', parentUuid: 'task', type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'task-call', content: '', is_error: true },
    ] } },
    { uuid: 'async-task', parentUuid: 'task-result', type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'async-call', name: 'Agent', input: { description: 'background child', prompt: 'test' } },
    ] } },
    { uuid: 'async-result', parentUuid: 'async-task', type: 'user', toolUseResult: { isAsync: true, agentId: 'a1' }, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'async-call', content: 'async launched' },
    ] } },
    { uuid: 'compact', parentUuid: 'async-result', type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 1000 } },
    { uuid: 'summary', parentUuid: 'compact', type: 'user', isCompactSummary: true, message: { role: 'user', content: full } },
    { uuid: 'tail', parentUuid: 'summary', type: 'assistant', message: { role: 'assistant', content: 'after compact' } },
  ].map((row, index) => ({ ...row, sessionId: 'S', timestamp: new Date(1000000 + index * 1000).toISOString() }));
  const file = path.join(projectDir, 'S.jsonl'); fs.writeFileSync(file, records.map(row => JSON.stringify(row)).join('\n') + '\n');
  const originalLoad = Module._load, modulePath = require.resolve('./ipc/claude-data');
  delete require.cache[modulePath];
  Module._load = function(name, parent, isMain) {
    if (name === 'electron') return { ipcMain: { handle() {} } };
    if (name === 'os' || name === 'node:os') return { ...os, homedir: () => root };
    return originalLoad.call(this, name, parent, isMain);
  };
  let data;
  try { data = require(modulePath); } finally { Module._load = originalLoad; }
  data.register({ projectManager: {}, formatToolAction: () => null });
  h.service.claudeData = data;
  h.scope.resolveHistorySessionInfo = async () => ({ toolType: 'claude', sessionId: 'S', cwd: '/fixture' });
  const legacy = (await h.read({ view: 'history', last: '80' })).data;
  const first = (await h.read({ ...lightQuery, ifRevision: legacy.historyRevision })).data;
  assert.equal(first.success, true, first.error);
  assert.equal(first.payloadHeaderVersion, 2);
  const edited = first.entries.find(row => row.uuid === 'edit').actions[0];
  assert.equal(edited.hasResult, true); assert.equal(edited.status, 'done');
  assert.deepEqual(edited.fileChange, { filePath: '/tmp/file.md', displayPath: 'file.md', added: 1, removed: 1, countsSource: 'arguments' });
  const failedTask = first.entries.find(row => row.uuid === 'task').actions[0];
  assert.equal(failedTask.tool, 'Task'); assert.equal(failedTask.hasResult, true); assert.equal(failedTask.status, 'error');
  const asyncTask = first.entries.find(row => row.uuid === 'async-task').actions[0];
  assert.equal(asyncTask.hasResult, false); assert.equal(asyncTask.status, 'running');
  assert.ok(legacy.entries?.find(row => row.uuid === 'edit'), JSON.stringify({ legacy: legacy.entries?.map(row => [row.uuid, row.role]), keys: Object.keys(legacy) }));
  assert.equal(first.entries.find(row => row.uuid === 'edit').content, legacy.entries.find(row => row.uuid === 'edit').content);
  assert.equal((await h.read({ ...lightQuery, ifRevision: first.historyRevision })).data.unchanged, true);
  const oldHeaderContext = JSON.parse(first.revision.context); delete oldHeaderContext.payloadHeaderVersion;
  const oldHeaderRevision = require('./history-revision').buildHistoryRevision(first.revision, first.revision.sources,
    { context: JSON.stringify(oldHeaderContext) });
  const upgraded = await h.service.getHistory({ toolType: 'claude', sessionId: 'S', cwd: '/fixture', tabId: 'A',
    dehydrate: true, payloadPolicy: 'on-demand-v1', bounds: { last: 80 }, ifRevision: oldHeaderRevision });
  assert.equal(upgraded.unchanged, false); assert.equal(JSON.parse(upgraded.revision.context).payloadHeaderVersion, 2);
  const refs = [first.entries.find(row => row.uuid === 'edit').actions[0].actionRef,
    first.entries.find(row => row.uuid === 'edit').thinkingRef,
    first.entries.find(row => row.uuid === 'compact').compactSummaryRef];
  for (const ref of refs) {
    assert.ok(ref);
    const body = await h.read(payloadQuery(first, ref), 'history-payload');
    assert.equal(body.status, 200, JSON.stringify(body));
    if (ref.encoding === 'json') assert.equal(JSON.parse(body.data.payload).rawTool.args.old_string, full);
    else assert.equal(body.data.payload, ref === refs[2] ? legacy.entries.find(row => row.uuid === 'compact').compactSummary : full);
  }
  const stat = fs.statSync(file);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('BODY ', 'EDIT '));
  fs.utimesSync(file, stat.atime, stat.mtime);
  assert.equal((await h.read(payloadQuery(first, refs[0]), 'history-payload')).status, 409);
});

test('actual HTTP History -> shared reader: full, unchanged, exact delta, changed bounds and read owner', async t => {
  const h = await historyHarness(t), query = { view:'history', last:'200', delta:'1' };
  const first = await h.read(query);
  assert.equal(first.status,200); assert.equal(first.data.entries.length,2);
  assert.match(first.data.historyRevision,/^[a-f0-9]{64}$/);
  const second = await h.read({ ...query, ifRevision:first.data.historyRevision });
  assert.equal(second.data.unchanged,true); assert.equal('entries' in second.data,false); assert.equal(h.loads(),1);
  h.change([{uuid:'u',role:'user',content:'prompt'},{uuid:'a',role:'assistant',content:'edited answer'},{uuid:'b',role:'user',content:'new'}]);
  const third = await h.read({ ...query, ifRevision:first.data.historyRevision });
  assert.equal(third.data.delta,true,JSON.stringify(third));
  assert.deepEqual(third.data.changedEntries.map(x=>x.uuid),['a','b']); assert.deepEqual(third.data.order,['u','a','b']);
  assert.equal('entries' in third.data,false);
  const otherWindow = await h.read({ ...query, last:'1', ifRevision:third.data.historyRevision });
  assert.equal(otherWindow.data.unchanged,false); assert.equal(otherWindow.data.entries.length,1);
  h.setSid('child');
  const child = await h.read({ ...query, ifRevision:third.data.historyRevision });
  assert.equal(child.data.readSessionId,'child'); assert.equal(child.data.writerConfirmed,false);
  assert.equal(child.data.delta,undefined); assert.equal(child.data.entries.length,3);
});

test('actual HTTP History preserves its starting owner order if later input arrives on SAME SID during the read', async t => {
  const h = await historyHarness(t, null, true);
  const before = h.owner.current('A'); h.duringReadInput();
  const result = await h.read({ view: 'history' });
  assert.equal(result.status, 200); assert.equal(result.data.sessionId, 'source');
  assert.equal(result.data.ownerSnapshotCurrent, false);
  assert.deepEqual(result.data.conversationOwner.ownerOrder, before.ownerOrder);
  const after = h.owner.current('A');
  assert.notEqual(after.ownerToken, before.ownerToken);
  assert.ok(after.ownerOrder.revision > before.ownerOrder.revision);
});

test('actual HTTP -> SessionTranscriptService -> Codex incremental JSONL parser and History projector', async t => {
  const turn = n => [
    {type:'event_msg',timestamp:`2026-09-13T10:00:0${n}.000Z`,payload:{type:'task_started',turn_id:'turn-'+n}},
    {type:'event_msg',timestamp:`2026-09-13T10:00:0${n}.001Z`,payload:{type:'user_message',message:'prompt-'+n}},
    {type:'response_item',timestamp:`2026-09-13T10:00:0${n}.500Z`,payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'answer-'+n}]}},
    {type:'event_msg',payload:{type:'task_complete',turn_id:'turn-'+n}},
  ];
  const h=await historyHarness(t,[{type:'session_meta',payload:{id:'source',cwd:'/fixture'}},...turn(1)]);
  const query={view:'history',delta:'1',last:'100'};
  const first=await h.read(query); assert.equal(first.status,200);assert.equal(first.data.entries.length,2);
  assert.deepEqual(first.data.entries.map(x=>x.content),['prompt-1','answer-1']);
  assert.equal((await h.read({...query,ifRevision:first.data.historyRevision})).data.unchanged,true);assert.equal(h.loads(),1);
  h.append(turn(2));
  const second=await h.read({...query,ifRevision:first.data.historyRevision});
  assert.equal(second.data.delta,true);assert.deepEqual(second.data.changedEntries.map(x=>x.content),['prompt-2','answer-2']);
  assert.equal(second.data.order.length,4);
});

test('HTTP History sidecar-only change invalidates the exact row; legacy ETag cannot suppress it', async t => {
  const h = await historyHarness(t), query={view:'history',delta:'1'};
  const first=await h.read(query); h.setTiming();
  const second=await h.read({...query,ifRevision:first.data.historyRevision});
  assert.equal(second.data.delta,true); assert.deepEqual(second.data.changedEntries.map(x=>x.uuid),['a']);
  assert.equal(second.data.changedEntries[0].responseTiming.durationMs,1000);
  assert.notEqual(second.data.historyRevision,first.data.historyRevision);
  assert.equal((await h.read({view:'history',ifRevision:'{"sources":["/etc/passwd"]}'})).status,400);
  assert.equal((await h.read({ifRevision:first.data.historyRevision})).status,400);
});

test('source adoption during History read returns an identity conflict, not old rows stamped as the new child', async t => {
  const h=await historyHarness(t); h.duringRead('child');
  const result=await h.read({view:'history',delta:'1'});
  assert.equal(result.status,409); assert.equal(result.data.error,'history_read_identity_changed');
  assert.equal(result.data.previousReadSessionId,'source'); assert.equal(result.data.readSessionId,'child');
  assert.equal('entries' in result.data,false);
});

test('another client window cannot lend proof for a row this HTTP caller never held', async t => {
  const h=await historyHarness(t), row=uuid=>({uuid,role:'assistant',content:uuid});
  h.change(['a','b','c','d','e'].map(row));
  const narrow={view:'history',delta:'1',around:'b',radius:'1'};
  const first=await h.read(narrow);assert.deepEqual(first.data.entries.map(x=>x.uuid),['a','b','c']);
  await h.read({view:'history',delta:'1'}); // wider snapshot at the SAME internal revision
  h.change(['a','b','d','e'].map(row));
  const result=await h.read({...narrow,ifRevision:first.data.historyRevision});
  assert.equal(result.data.delta,true);assert.deepEqual(result.data.order,['a','b','d']);
  assert.deepEqual(result.data.changedEntries.map(x=>x.uuid),['d']);
});

test('an async subscribe failure releases its partial consumer without an automatic retry', async () => {
  let reads=0, cleanup=0, errors=0;
  const owner=new TabTranscriptSubscriptions({hasConsumers:()=>true,
    readSession:async()=>{reads++;return {sessionId:'S',toolType:'codex'};},
    subscribe:async()=>{throw Error('watcher failed');},unsubscribe:async()=>{cleanup++;},onError:()=>{errors++;}});
  await owner.reconcile('A'); assert.equal(reads,1);assert.equal(cleanup,1);assert.equal(errors,1);assert.equal(owner.tabs.size,0);
});

test('read-only Codex resolution uses main event projection, not bridge or process lookup, and keeps writer distinct', async () => {
  const scope = vm.createContext({ historyReadSession, historyReadOwnerFromProjection,
    findOrchestrationTabDescriptor: () => ({toolType:'codex',sessionId:'saved',projectId:'P',cwd:'/fixture'}),
    resolveCodexRuntimeProjectionBatch: () => ({A:{sessionId:null,readSessionId:'source',writerConfirmed:false,provenWriterSessionId:null}}),
    resolveAgentSessionInfo: () => { throw Error('no process/renderer query'); } });
  vm.runInContext(functions(source,['resolveHistorySessionInfo']),scope);
  const info=await scope.resolveHistorySessionInfo('A');
  assert.equal(info.sessionId,'source'); assert.equal(info.writerSessionId,null); assert.equal(info.writerConfirmed,false);
});

test('actual timing HTTP handler and project activity wakeups read the same owner; GET cannot consume another client wake', async () => {
  const owner=timingOwner(); owner.preflight.set('A',{engine:'codex',startTs:90000});
  const events=[], snapshots=new Map();
  const scope=vm.createContext({ console:quiet, crypto, readAgentTabTiming: payload => ({...owner.read(payload),scope:{tabId:payload.tabId,readSessionId:'source',writerConfirmed:false},observedAt:100000}),
    publicTimingSnapshots:snapshots, publicTabActivity:null, webServerInstanceId:'instance', subscribers:new Map([['A',new Set([{isAlive:()=>true}])]]),
    PROJECT_ACTIVITY_TOPIC:'projects', webBroadcast: (_tab,payload)=>events.push(payload), projectActivitySnapshot:()=>{throw Error('not subscribed');} });
  vm.runInContext(functions(source,['hasTabSubscribers','publicTabTimingSnapshot','publishTabTiming','broadcastProjectActivity']),scope);
  scope.publicTabTimingSnapshot('A'); scope.broadcastProjectActivity('activity-open');
  assert.equal(events[0].type,'timing-changed'); assert.equal(events[0].timing.startTs,90000);
  scope.broadcastProjectActivity('duplicate'); assert.equal(events.length,1);
  owner.preflight.clear(); scope.broadcastProjectActivity('activity-close');
  assert.equal(events[1].timing,null); assert.equal(events[1].scope.writerConfirmed,false);
  const start=source.indexOf('  // Read the SAME main-owned interval');
  const end=source.indexOf('  // Load JSONL session history.',start);
  Object.assign(scope,{sendJson:(res,status,data)=>Object.assign(res,{status,data}),findOrchestrationTabDescriptor:id=>id==='A',decId:decodeURIComponent});
  const handler=vm.runInContext('(async(req,res,parsed)=>{let m;'+source.slice(start,end)+'})',scope);
  const result={}; await handler({method:'GET'},result,{pathname:'/api/terminal-tabs/A/timing',query:{}});
  assert.equal(result.status,200); assert.equal(result.data.instanceId,'instance');
  const unknown={}; await handler({method:'GET'},unknown,{pathname:'/api/terminal-tabs/missing/timing',query:{}}); assert.equal(unknown.status,404);
});

test('actual authenticated /events multiplex route: one connection, per-tab initial/watchers, existing clients and cleanup', async t => {
  const subs=new Map(), calls=[], initialA=deferred(), cleanup=deferred();
  const scope=vm.createContext({ console:quiet, eventTabIds, stampedEventSink, sendJson, decId:decodeURIComponent,
    webServerInstanceId:'instance', PROJECT_ACTIVITY_TOPIC:'projects', sdkSessions:new Map(),
    checkAuth:req=>req.headers.authorization==='Bearer fixture-only',
    findOrchestrationTabDescriptor:id=>['A','B'].includes(id), shortId:value=>value || '-', setInterval,clearInterval,
    subscribe:(id,sink)=>{ if(!subs.has(id))subs.set(id,new Set()); subs.get(id).add(sink); calls.push(['subscribe',id]); },
    unsubscribeAll:sink=>{ for(const set of subs.values())set.delete(sink); calls.push(['unsubscribe']); cleanup.resolve(); },
    releaseClaudeWatchersIfOrphan:()=>calls.push(['releaseClaude']),
    releaseTranscriptSubscriptionsIfOrphan:()=>calls.push(['releaseTranscript']),
    sendProjectActivitySnapshot:sink=>sink.send('{"type":"project-activity","projects":[]}'),
    sendInitialSnapshot:async(id,sink)=>{ if(id==='A')await initialA.promise; sink.send(JSON.stringify({type:'snapshot',tabId:id,sessionId:'source-'+id})); },
    sendTabTimingSnapshot:(id,sink)=>sink.send(JSON.stringify({type:'timing-changed',tabId:id,timing:null})),
    startClaudeTabWatcher:async id=>calls.push(['claude',id]), startTranscriptSubscriptionForTab:async id=>calls.push(['transcript',id]),
  });
  const start=source.indexOf("  if (parsed.pathname === '/api/events' && req.method === 'GET')");
  const end=source.indexOf("\n  if (!checkAuth(req))",start);
  const run=vm.runInContext('(async(req,res,parsed)=>{'+source.slice(start,end)+'})',scope);
  const server=http.createServer((req,res)=>run(req,res,url.parse(req.url,true)).catch(e=>sendJson(res,500,{error:e.message})));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const base='http://127.0.0.1:'+server.address().port;
  const rejected=await fetch(base+'/api/events?tabIds=%5B%22A%22%5D'); assert.equal(rejected.status,401);
  const invalid=await fetch(base+'/api/events?tabIds=%5B%22missing%22%5D',{headers:{Authorization:'Bearer fixture-only'}}); assert.equal(invalid.status,404);
  assert.equal(calls.length,0);
  const events=[], waiting=[]; let wire='';
  const waitFor=count=>events.length>=count?Promise.resolve():new Promise(resolve=>waiting.push({count,resolve}));
  const req=http.get(base+'/api/events?tabIds='+encodeURIComponent('["A","B","A"]'),{headers:{Authorization:'Bearer fixture-only'}},res=>{
    assert.equal(res.statusCode,200); assert.match(res.headers['content-type'],/event-stream/);
    res.on('data',chunk=>{ wire+=chunk; let pos;
      while((pos=wire.indexOf('\n\n'))>=0){const line=wire.slice(0,pos);wire=wire.slice(pos+2); if(line.startsWith('data: '))events.push(JSON.parse(line.slice(6)));}
      for(const waiter of waiting)if(events.length>=waiter.count)waiter.resolve();
    });
  });
  t.after(()=>req.destroy());
  await waitFor(2); // B is not blocked by slow A
  assert.equal(events[0].tabId,'B');
  const sink=[...subs.get('A')][0]; assert.equal(sink,[...subs.get('B')][0]);
  sink.send('{"type":"transcript-changed","tabId":"A","sessionId":"child","version":2}');
  initialA.resolve(); await waitFor(5);
  assert.deepEqual(events.filter(x=>x.tabId==='A').map(x=>x.type),['snapshot','timing-changed','transcript-changed']);
  assert.equal(events.at(-1).sessionId,'child');
  assert.deepEqual(calls.filter(x=>x[0]==='transcript').map(x=>x[1]),['A','B']);
  req.destroy(); await cleanup.promise; await new Promise(setImmediate);
  assert.equal([...subs.values()].every(set=>set.size===0),true);
  assert.equal(calls.filter(x=>x[0]==='releaseTranscript').length,1);
  for(const query of ['tabId=B','scope=projects']) {
    const connected=deferred();
    const old=http.get(base+'/api/events?'+query,{headers:{Authorization:'Bearer fixture-only'}},res=>{
      assert.equal(res.statusCode,200);res.once('data',()=>connected.resolve());
    }); await connected.promise;old.destroy();
  }
});
