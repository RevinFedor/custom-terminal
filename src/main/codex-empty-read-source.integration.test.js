'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');
const http = require('node:http');
const url = require('node:url');
const contract = require('./codex-runtime-contract');
const { projectCodexPolicyRuntime } = require('./codex-runtime-policies');
const { createCodexRuntimeProjectionStore } = require('./codex-runtime-projection-store');
const { SessionTranscriptService } = require('./session-transcript-service');
const { PublicHistoryRevisions } = require('./public-history-read');
const { historyReadSession, historyReadOwnerFromProjection } = require('./history-read-session');
const api = require('./ipc/codex-data')._api;
const quiet = { log() {}, warn() {}, error() {} };
function functions(file, names) {
  const tree = ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, file), 'utf8'), ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const n = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(n, name); return n.getText(tree);
  }).join('\n');
}
const mainCode = functions('main.js', ['getCodexResumeSourceLeaseForTab', 'getCodexResumeReadIdentityLeaseForTab',
  'bindCodexResumeReadIdentityLease', 'getCurrentCodexEmptyReadSource', 'refreshCodexEmptyReadSource', 'projectCodexRuntimeSnapshotFromEvents',
  'publishCodexRuntimeProjection', 'getCodexRuntimeProjectionBatch', 'getCodexPublicWriterFields',
  'getCodexPublicRuntimeProjection', 'broadcastCodexReadySnapshot', '_webBroadcast', 'armCodexReadIdentitySubmitBarrier',
  'currentCodexAcceptedResumeSourceProof', 'readAgentSendDestinationAtWriteBoundary']);
const webCode = functions('web-server.js', ['checkAuth', 'handleApi', 'resolveHistorySessionInfo']);

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-empty-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'sessions'), cwd = path.join(root, 'project'), sessionId = crypto.randomUUID();
  fs.mkdirSync(cwd);
  const created = await api.materializeEmptySession({ sessionId, cwd, sessionsDir });
  const inspected = await api.inspectConversationMaterializationFromFile(sessionId, cwd, { sessionsDir });
  assert.ok(inspected.emptyReadSource, 'actual complete standalone source reader must issue proof');
  const term = {}, events = [];
  const launch = { command: 'codex-c', tabId: 'T', sessionId, launchId: 'L', runSeq: 2,
    lifecycleGeneration: 'G:2', terminalToken: term, materializedFresh: true, emptyReadSource: inspected.emptyReadSource };
  let savedSessionId = sessionId, ready = false, inFlight = false;
  const ctx = vm.createContext({ path, srcMainDir: __dirname, fs, console: quiet, ...contract, projectCodexPolicyRuntime,
    CODEX_STARTUP_NO_STATE_TIMEOUT_MS: 60000,
    codexRuntimeProjectionStore: createCodexRuntimeProjectionStore(),
    codexDataModule: { _api: { inspectConversationMaterializationFromFile: (sid, dir) =>
      api.inspectConversationMaterializationFromFile(sid, dir, { sessionsDir }) } },
    terminalProjects: new Map([['T', cwd]]),
    terminals: new Map([['T', term]]), terminalCommandState: new Map([['T', { runSeq: 2, isRunning: true }]]),
    terminalLifecycleEpochs: new Map([[term, 'fixture-terminal']]),
    codexLastRunCommandPayload: new Map([['T', launch]]),
    codexResumeSourceLeases: new Map([[sessionId, { tabId: 'T', launchId: 'L' }]]),
    codexSessionDiscoveryIntents: new Map([['T', { sourceMode: 'resume', sourceSessionId: sessionId,
      launchId: 'L', sourceRunSeq: 2, sourceLifecycleGeneration: 'G:2' }]]),
    codexConversationMaterializationCache: new Map([[sessionId, inspected]]),
    codexRuntimePolicies: null, codexLiveSettingsObserver: null,
    getTerminalLifecycleGeneration: () => 'G:2', codexSessionIdFromDb: () => savedSessionId,
    getCodexSavedSessionId: () => savedSessionId, getCodexRuntimeSessionId: () => null,
    resolveAuthoritativeTabProjectId: () => 'P',
    getCurrentCodexProvisionalSourceObservation: () => null, getCodexWriterProofSnapshot: () => null,
    isCodexWriterUsableForMutation: () => false, hasCodexEstablishedWriterUiLifecycle: () => false,
    hasEstablishedCodexLifecycleIndicators: () => true, getCodexLiveInputControl: () => null,
    isCodexTuiEffectivelyReady: () => ready, hasCodexEstablishedComposerLifecycle: () => ready,
    hasCodexPromptOrTurnInFlight: () => inFlight,
    codexTurnStateSnapshot: () => ({ busy: false, hasWatcher: false }),
    getCodexProvisionalSettingsSnapshot: () => null, getCodexMcpStartupStatus: () => null,
    currentAiLifecycleIdentity: () => ({ terminalLifecycleGeneration: 'G:2', inputRevision: 0 }),
    scheduleProjectActivityBroadcast() {}, noteProjectCardSignalsChanged() {},
    require: id => { assert.equal(id, path.join(__dirname, 'web-server')); return { webBroadcast: (_tab, data) => events.push(data) }; },
  });
  for (const name of ['codexWriterProofs', 'codexKnownSessions', 'codexWatchers', 'codexTurnWatchers',
    'codexProviderSemanticSources', 'aiStoppingTabs', 'codexManualActionRequired', 'codexTuiReadyLastNotReady',
    'codexLifecycleWarnings', 'codexReadIdentitySubmitPending']) ctx[name] = new Map();
  for (const name of ['codexTuiReadyTabs', 'codexLateMcpProofPending', 'codexStartupNoStateTimeoutTabs']) ctx[name] = new Set();
  vm.runInContext(mainCode, ctx);
  assert.equal(ctx.bindCodexResumeReadIdentityLease({ tabId: 'T', sourceSessionId: sessionId, launchId: 'L',
    terminalToken: term, terminalRunSeq: 2, terminalLifecycleGeneration: 'G:2' }), true);
  const service = new SessionTranscriptService({ getMainWindow: () => null, codexData: { _api: {
    ...api, findCodexSessionFile: (sid, dir) => api.findCodexSessionFile(sid, dir, { sessionsDir }),
    loadSessionRecords: async (sid, dir) => {
      const found = await api.findCodexSessionFile(sid, dir, { sessionsDir });
      const stat = fs.statSync(found.filePath);
      const parsed = await api.readJsonlRange(found.filePath, 0, stat.size - 1);
      return { success: true, records: parsed.records, filePath: found.filePath,
        sourceSnapshot: { filePath: found.filePath, size: stat.size, mtimeMs: stat.mtimeMs, sessionId: sid, linkKind: 'end' } };
    },
  } } });
  const sendJson = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  const web = vm.createContext({ url, crypto, console: quiet, require: () => ({}), token: 'fixture', path,
    handleSystemPromptApi: async () => false, systemPromptService: null, readBody: async () => ({}),
    decId: decodeURIComponent, sendJson, historyReadSession, historyReadOwnerFromProjection, transcriptService: service,
    conversationOwners: null, finishConversationOwnerRead: () => ({}), publishTabTiming() {},
    publicHistoryRevisions: new PublicHistoryRevisions(),
    findOrchestrationTabDescriptor: () => ({ tabId: 'T', projectId: 'P', toolType: 'codex', sessionId: savedSessionId, cwd }),
    resolveCodexRuntimeProjectionBatch: (tabs, projectId) => ctx.getCodexRuntimeProjectionBatch(tabs, projectId),
    resolveAgentSessionInfo: () => { throw Error('no renderer read fallback'); },
    bridgeRequest: () => { throw Error('no renderer empty-history fallback'); },
  });
  vm.runInContext(webCode, web);
  return { root, cwd, sessionsDir, created, sessionId, term, launch, inspected, ctx, web, service, events,
    ready: () => { ready = true; ctx.broadcastCodexReadySnapshot('T'); },
    replaceSaved: value => savedSessionId = value, inFlight: () => inFlight = true };
}

test('actual ready broadcast→main read lease→HTTP returns settled empty History without a writer/first Send', async t => {
  const h = await fixture(t);
  const server = http.createServer((req, res) => h.web.handleApi(req, res, url.parse(req.url, true), new Map())
    .catch(e => h.web.sendJson(res, 500, { error: e.message })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const read = async revision => {
    const res = await fetch('http://127.0.0.1:' + server.address().port
      + '/api/terminal-tabs/T/history?view=history&delta=1&last=80' + (revision ? '&ifRevision=' + revision : ''),
    { headers: { authorization: 'Bearer fixture' } });
    return { status: res.status, data: await res.json() };
  };
  const beforeReady = await read();
  assert.equal(beforeReady.status, 409, 'source existence alone does not admit startup read: ' + JSON.stringify(beforeReady));
  h.ready();
  assert.equal(h.events.at(-1).readSessionId, h.sessionId, 'causal readiness broadcasts the newly readable source');
  assert.equal(h.events.at(-1).writerConfirmed, false);
  const empty = await read(); assert.equal(empty.status, 200, JSON.stringify(empty));
  assert.equal(empty.data.success, true); assert.deepEqual(empty.data.entries, []); assert.equal(empty.data.total, 0);
  assert.equal(empty.data.sessionId, h.sessionId); assert.equal(empty.data.readSessionId, h.sessionId);
  assert.equal(empty.data.writerConfirmed, false); assert.equal(empty.data.writerSessionId, null);
  const runtime = h.ctx.getCodexRuntimeProjectionBatch([{ tabId: 'T', savedSessionId: h.sessionId }], 'P').T;
  assert.equal(runtime.conversationMaterialized, false); assert.equal(runtime.timelineCount, 0);
  assert.equal(runtime.canRewriteHistory, false); assert.equal(runtime.canDeleteHistory, false);
  assert.equal((await read(empty.data.historyRevision)).data.unchanged, true);
  const bytes = fs.readFileSync(h.created.filePath);
  h.ctx.armCodexReadIdentitySubmitBarrier('T', 'fixture-reservation');
  h.ctx.publishCodexRuntimeProjection('T', 'fixture-reservation');
  const reserved = await read(); assert.equal(reserved.status, 409); assert.equal(reserved.data.error, 'history_read_identity_unavailable');
  assert.deepEqual(fs.readFileSync(h.created.filePath), bytes, 'no Send/Enter/launch/JSONL mutation');
});

test('actual main event projection supplies the same launch deadline, then revokes it on readiness and Stop', async t => {
  const h = await fixture(t);
  h.launch.startedAt = 1000;
  const snapshot = () => h.ctx.projectCodexRuntimeSnapshotFromEvents('T', 'P');
  assert.equal(snapshot().startupWait.launchId, 'L');
  assert.equal(snapshot().startupWait.deadlineAt, 61000);
  h.ctx.aiStoppingTabs.set('T', { toolType: 'codex' });
  assert.equal(snapshot().startupWait, null);
  h.ctx.aiStoppingTabs.delete('T');
  h.ready();
  assert.equal(snapshot().startupWait, null);
});

test('file append/in-place ABA and wrong runtime owner revoke empty read at O(stat), never reuse cached empty admission', async t => {
  const h = await fixture(t); h.ready();
  const read = () => h.ctx.getCodexRuntimeProjectionBatch([{ tabId: 'T', savedSessionId: h.sessionId }], 'P').T;
  assert.equal(read().readSessionId, h.sessionId);
  await fs.promises.appendFile(h.created.filePath, '{"type":"event_msg","payload":{"type":"user_message","message":"FIXTURE_ONLY"}}\n');
  assert.equal(read().readSessionId, null); assert.equal(read().writerConfirmed, false);
  const witness = h.inspected.emptyReadSource;
  const stat = fs.statSync(h.created.filePath);
  assert.equal(contract.codexEmptyReadSourceMatchesStat(witness, { ...stat, size: witness.size,
    mtimeMs: witness.mtimeMs, ctimeMs: witness.ctimeMs + 1 }), false, 'mtime/size restoration cannot restore proof');
  h.ctx.terminals.set('T', {}); assert.equal(h.ctx.getCurrentCodexEmptyReadSource('T'), null);
  h.replaceSaved('another'); assert.equal(h.ctx.getCurrentCodexEmptyReadSource('T'), null);
});

test('a late empty response cannot clear newer same-SID History after empty-source becomes a live writer', async t => {
  const h = await fixture(t); h.ready();
  let entered, release;
  const started = new Promise(resolve => entered = resolve), held = new Promise(resolve => release = resolve);
  const getHistory = h.service.getHistory.bind(h.service);
  h.service.getHistory = async payload => { const result = await getHistory(payload); entered(); await held; return result; };
  const server = http.createServer((req, res) => h.web.handleApi(req, res, url.parse(req.url, true), new Map())
    .catch(e => h.web.sendJson(res, 500, { error: e.message })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const pending = fetch('http://127.0.0.1:' + server.address().port + '/api/terminal-tabs/T/history?view=history&last=80',
    { headers: { authorization: 'Bearer fixture' } });
  await started;
  // The SID/project do NOT change. Reproduce the exact stronger read-owner
  // observation after the initial snapshot, without a provider Send/Enter.
  h.web.resolveHistorySessionInfo = async () => ({ toolType: 'codex', sessionId: h.sessionId, cwd: h.cwd,
    readIdentitySource: 'live-writer', writerSessionId: h.sessionId, writerConfirmed: true });
  release(); const response = await pending, data = await response.json();
  assert.equal(response.status, 409); assert.equal(data.error, 'history_read_identity_changed');
  assert.equal(data.entries, undefined, 'never present stale zero rows as current empty');
});

test('the actual bounded reader rejects a stat identity change across parsing the complete header', async t => {
  const h = await fixture(t); let reads = 0;
  const code = functions('ipc/codex-data.js', ['inspectCodexConversationMaterializationFromFile']);
  const ctx = vm.createContext({ path, CODEX_MATERIALIZATION_HEAD_MAX_BYTES: 512 * 1024,
    findCodexSessionFile: async () => ({ filePath: h.created.filePath }), readJsonlRange: api.readJsonlRange,
    inspectCodexConversationMaterialization: api.inspectConversationMaterialization,
    fs: { promises: { stat: async file => { const stat = await fs.promises.stat(file); return ++reads === 2
      ? { ...stat, ctimeMs: stat.ctimeMs + 1 } : stat; } } } });
  vm.runInContext(code, ctx);
  const result = await ctx.inspectCodexConversationMaterializationFromFile(h.sessionId, h.cwd);
  assert.equal(result.emptyReadSource, undefined); assert.equal(reads, 2);
});

test('current ready preparation re-attests a benign header rewrite, but cannot carry it through a replacement/input', async t => {
  const h = await fixture(t), meta = h.created.records[0];
  meta.timestamp = '2026-09-16T09:00:00Z';
  await fs.promises.writeFile(h.created.filePath, JSON.stringify(meta) + '\n');
  assert.equal(h.ctx.getCurrentCodexEmptyReadSource('T'), null);
  assert.ok(await h.ctx.refreshCodexEmptyReadSource('T'));
  h.ready(); assert.equal(h.events.at(-1).readSessionId, h.sessionId);
  meta.timestamp = '2026-09-16T09:01:00Z';
  await fs.promises.writeFile(h.created.filePath, JSON.stringify(meta) + '\n');
  let entered, release;
  const pending = new Promise(resolve => entered = resolve), held = new Promise(resolve => release = resolve);
  const inspect = h.ctx.codexDataModule._api.inspectConversationMaterializationFromFile;
  h.ctx.codexDataModule._api.inspectConversationMaterializationFromFile = async (...args) => {
    const result = await inspect(...args); entered(); await held; return result;
  };
  const refresh = h.ctx.refreshCodexEmptyReadSource('T'); await pending;
  h.ctx.armCodexReadIdentitySubmitBarrier('T'); release();
  assert.equal(await refresh, null, 'a submit reservation made during the read revokes it');
});

test('empty read is scoped to lease/intent/terminal/run/ready and closes before any submit; legacy provisional writer remains strict', async t => {
  const h = await fixture(t), lease = h.ctx.getCodexResumeReadIdentityLeaseForTab('T');
  const base = { tabId: 'T', liveLifecycle: true, savedSessionId: h.sessionId, persistedSessionId: h.sessionId,
    writerStatus: 'pending', launch: lease, resumeLease: { tabId: 'T', sourceSessionId: h.sessionId, launchId: 'L' },
    intent: h.ctx.codexSessionDiscoveryIntents.get('T'), terminalToken: h.term, terminalRunSeq: 2,
    terminalLifecycleGeneration: 'G:2', processRunning: true, inputReady: true, emptyReadSource: h.inspected.emptyReadSource };
  assert.equal(contract.resolveCodexReadIdentity(base).sessionId, h.sessionId);
  assert.equal(contract.resolveCodexReadIdentity(base).mutationSafe, false);
  assert.equal(contract.resolveCodexReadIdentity({ ...base, writerStatus: 'provisional-source', processPids: [] }).mutationSafe, false);
  for (const patch of [{ savedSessionId: 'other' }, { persistedSessionId: 'other' }, { terminalToken: {} },
    { terminalRunSeq: 3 }, { terminalLifecycleGeneration: 'G:3' }, { launch: { ...lease, launchId: 'other' } },
    { resumeLease: null }, { intent: null }, { inputReady: false }, { busy: true }, { stopping: true },
    { processRunning: false }, { promptOrTurnInFlight: true }, { provisionalSubmitReserved: true },
    { submitResolutionPending: { enterWritten: true } }, { emptyReadSource: null }, { writerStatus: 'adopted' }]) {
    assert.equal(contract.resolveCodexReadIdentity({ ...base, ...patch }).available, false, JSON.stringify(patch));
  }
  assert.equal(contract.validateCodexProvisionalSourceObservation({ status: 'provisional-source', pids: [] }).valid, false);
});

for (const defect of ['thin-fork', 'paginated', 'mismatched-meta-id', 'wrong-cwd', 'truncated', 'invalid-json', 'extra-record'])
test('actual bounded source reader cannot attest empty ' + defect, async t => {
  const h = await fixture(t), record = h.created.records[0];
  if (defect === 'thin-fork') record.payload.history_base = { session_id: 'other', history_offset: 3 };
  if (defect === 'paginated') record.payload.history_mode = 'paginated';
  if (defect === 'mismatched-meta-id') record.payload.session_id = 'other';
  if (defect === 'wrong-cwd') record.payload.cwd = '/other';
  let text = JSON.stringify(record) + '\n';
  if (defect === 'truncated') text += '{"type":';
  if (defect === 'invalid-json') text += 'not-json\n';
  if (defect === 'extra-record') text += '{"type":"thread_settings_applied","payload":{}}\n';
  await fs.promises.writeFile(h.created.filePath, text);
  const result = await api.inspectConversationMaterializationFromFile(h.sessionId, h.cwd, { sessionsDir: h.sessionsDir });
  assert.equal(result.emptyReadSource, undefined);
});
