'use strict';
// Whole CommonJS web service + actual private ProjectManager/SQLite/service.
// Electron is Node-only; renderer/runtime response delivery is controlled.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), vm = require('node:vm'), Module = require('node:module');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const esbuild = require('esbuild'), ts = require('typescript');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { createWorkflowOrganizationApi } = require('./workflow-organization-api');
const { createSystemPromptService } = require('./system-prompt-service');
const { SessionTranscriptService } = require('./session-transcript-service');
const { HistoryFreshness } = require('./history-freshness');
const { HistoryPreparedCache } = require('./history-prepared-cache');
const codexData = require('./ipc/codex-data');
const barrier = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const SID = '11111111-1111-4111-8111-111111111111';
let bridgeBundle, dispatcher;
test.before(async () => {
  const stubs = {
    useWorkspaceStore: 'export const useWorkspaceStore={getState:()=>globalThis.ports.workspace};',
    useUIStore: 'export const useUIStore={getState:()=>globalThis.ports.ui};',
    useProjectsStore: 'export const useProjectsStore={getState:()=>({projects:globalThis.ports.projects})};',
    usePromptQueueRunner: `export const getPromptQueueRuntimeSnapshot=()=>({pending:false,phase:'paused'});
      export const requestAutoCompactNow=(...a)=>globalThis.ports.coordinator.request(...a);
      export const cancelPendingAutoCompact=(tab,id)=>globalThis.ports.coordinator.cancel(tab,true,id);`,
    historyAgentRuntimes: 'export const getHistoryAgentRuntime=()=>globalThis.ports.runtime;',
    agentSendPreparation: `export const createAgentReadyWait=()=>({wait:async()=>{}});
      export const prepareAgentRuntimeForSend=async()=>({status:'active',submitCapability:'direct',presence:{inputReady:true}});
      export const prepareAgentRecordContext=async()=>({restartPerformed:false,historyContextResult:null});
      export const proveAgentComposerForSend=async()=>({complete:false});`,
    tabWorkContext: `export const prepareTabWorkContext=async(_tab,_id,prompt)=>({prompt,prefix:''});
      export const settleTabWorkContext=async()=>{};export const activateTabWorkContext=async()=>{};`,
  };
  const result = await esbuild.build({ stdin: { contents: `export * from './utils/runAfterApplicationBridge';
      export * from './store/usePromptQueueStore'; export * from './store/useAutoCompactStore';
      export {createAutoCompactCoordinator} from './utils/autoCompactCoordinator.mjs';`,
    resolveDir: path.join(__dirname, '../renderer'), loader: 'ts' }, bundle: true, write: false,
    platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent', plugins: [{ name: 'controlled-ports', setup(build) {
      build.onLoad({ filter: /\.(ts|tsx)$/ }, args => {
        const name = path.basename(args.path).replace(/\.tsx?$/, '');
        if (stubs[name]) return { contents: stubs[name], loader: 'ts' };
      });
    } }] });
  bridgeBundle = result.outputFiles[0].text;
  const app = fs.readFileSync(path.join(__dirname, '../renderer/App.tsx'), 'utf8');
  const tree = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  const find = node => { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'handleWebBridge') initializer = node.initializer;
    ts.forEachChild(node, find); };
  find(tree); assert.ok(initializer);
  dispatcher = ts.transpileModule('globalThis.dispatch=' + initializer.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
});
let ownedRoot;
const oldElectron = require.cache[require.resolve('electron')];
require.cache[require.resolve('electron')] = { id: require.resolve('electron'), loaded: true,
  exports: { app: { getPath: () => ownedRoot, isPackaged: false } } };
const DatabaseManager = require('./database');
if (oldElectron) require.cache[require.resolve('electron')] = oldElectron;
else delete require.cache[require.resolve('electron')];

async function fixture(t, { migrated = false } = {}) {
  ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-audit-http-'));
  const root = ownedRoot;
  // Seed a private project before actual ProjectManager.init(), preventing the
  // optional user-JSON migration branch. The complete constructor still runs.
  const seed = new DatabaseManager(); const project = seed.createEmptyProject('PRIVATE');
  seed.saveTabs(project.id, [
    { tabId: 'T', name: 'Codex', cwd: root, tabType: 'terminal', commandType: 'codex', codexSessionId: SID, claudeSessionId: 'old-claude' },
    { tabId: 'C', name: 'Claude', cwd: root, tabType: 'terminal', commandType: 'claude', claudeSessionId: 'claude-A' },
  ], true); seed.close();
  const pmModule = new Module(path.join(__dirname, 'project-manager.js'), module);
  pmModule.filename = path.join(__dirname, 'project-manager.js'); pmModule.paths = module.paths;
  pmModule._compile(fs.readFileSync(pmModule.filename, 'utf8'), pmModule.filename);
  const pm = pmModule.exports;
  const organization = createWorkflowOrganizationApi({ database: pm.db }); pm.workflowOrganization = organization;
  if (migrated) organization.bootstrap({ migrationId: 'private-migrate', mutationId: 'private-activate',
    workspace: { activeSpaceId: 'W', spaces: [{ id: 'W', name: 'PRIVATE', projectIds: [project.id], layout: {} }] } });
  const store = createAgentSendReceiptStore(pm.db.db);
  const callbacks = new Map(), sender = new EventEmitter(), holds = new Map(), trace = [], requests = [], closed = barrier();
  const clock = () => Number(performance.now().toFixed(3));
  const record = (stage, data = {}) => trace.push({ stage, at: clock(), ...data });
  let codexStatus = 'busy', claudeStatus = 'busy', materializations = 0, attachmentReads = 0, runtimeReads = 0;
  const provider = new Map([['T', 'codex'], ['C', 'claude']]);
  sender.id = 7; sender.mainFrame = { processId: 8, routingId: 9 }; sender.isDestroyed = () => false;
  const event = () => ({ sender, senderFrame: sender.mainFrame });
  const electron = { app: { getPath: () => root, isPackaged: false },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: sender }] },
    ipcMain: { on: (name, fn) => callbacks.set(name, fn), removeListener: name => callbacks.delete(name) } };
  const cjs = { exports: {} }, quiet = { log() {}, warn() {}, error() {} };
  const load = Module.createRequire(path.join(__dirname, 'web-server.js'));
  const wrapper = vm.runInNewContext('(function(require,module,exports,__dirname,__filename){' + source + `
    return { route:handleApi, admit:admitQueuedAgentSend, initialize(p) {
      token='private-token'; agentSendReceiptStore=p.store; agentSendReceiptStartupReady=Promise.resolve();
      systemPromptService=p.system; registerBridgeReplyHandler();
      resolveAgentToolType=p.provider; resolveCodexRuntimeProjectionBatch=p.runtime;
      getClaudeSessionMaterialization=p.materialize;
      readAgentRuntimeSnapshot=p.snapshot;
      const original=resolveInboxAttachmentPrompt;
      resolveInboxAttachmentPrompt=(...a)=>{p.attachment();return original(...a);};
    }, api:()=>getRunAfterApi(), freshness:()=>publicHistoryFreshness,
      history(service,owner) {transcriptService=service;publicHistoryFreshness=owner;},
      status(fn) {resolveAgentSessionInfo=fn;},
      queue(value) {agentSendQueue=value;},
      stop:stop };
  })`, { console: quiet, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval });
  const whole = wrapper(id => id === './project-manager' ? pm : id === 'electron' ? electron : load(id),
    cjs, cjs.exports, __dirname, path.join(__dirname, 'web-server.js'));
  whole.initialize({ store, system: createSystemPromptService({ projectManager: pm,
      onChanged: value => sender.emit('service-prompts-change', value) }),
    provider: tab => ({ observed: true, toolType: provider.get(tab) || null }),
    runtime: rows => { runtimeReads++; record('main-source-read'); return Object.fromEntries(rows.map(row => [row.tabId,
      { sessionStatus: codexStatus, status: codexStatus, sessionId: SID, readSessionId: SID,
        inputReady: true, writerConfirmed: true, writerUsableForMutation: true,
        conversationMaterialized: true, timelineCount: 1, lifecycleGeneration: 'private-launch' }])); },
    materialize: () => { materializations++; return { materialized: true, timelineCount: 1 }; },
    attachment: () => { attachmentReads++; },
    snapshot: async tab => ({ coherent: true, toolType: provider.get(tab), status: codexStatus,
      processStatus: 'found', lifecycleGeneration: 'private-launch', sendTarget: { toolType: provider.get(tab), sessionId: SID } }),
  });
  sender.send = (channel, value) => {
    assert.equal(channel, 'web:bridge-request'); record('bridge-start', { action: value.action });
    const data = value.action === 'getClaudeTabStatusBatch'
      ? { statuses: { C: claudeStatus }, inputReady: { C: true }, sessions: { C: 'claude-A' } }
      : value.action === 'getStatusMarkerConfig' ? { shape: 'dot', statuses: [], sizePx: 8 } : {};
    const respond = () => { record('bridge-reply', { action: value.action });
      callbacks.get('web:bridge-reply')(event(), { requestId: value.requestId, ok: true, data }); };
    const hold = holds.get(value.action);
    if (hold) { hold.entered.resolve(); void hold.release.promise.then(respond); }
    else queueMicrotask(respond);
  };
  const server = http.createServer((req, res) => {
    record('http-admitted'); const parsed = new URL(req.url, 'http://private');
    res.once('close', () => { record('observer-close'); closed.resolve(); });
    const task = whole.route(req, res, { pathname: parsed.pathname, query: Object.fromEntries(parsed.searchParams) }, new Map())
      .catch(error => { if (!res.destroyed) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); } });
    requests.push(task);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (route, body, signal) => {
    const response = await fetch(base + route, { signal,
      headers: { authorization: 'Bearer private-token', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const value = await response.json(); record('http-received'); return { status: response.status, value };
  };
  t.after(async () => {
    for (const hold of holds.values()) hold.release.resolve();
    sender.emit('destroyed'); await Promise.allSettled(requests);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    whole.stop(); pm.db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, pm, store, organization, whole, exports: cjs.exports, project, request, trace, sender, closed,
    hold: action => { const hold = { entered: barrier(), release: barrier() }; holds.set(action, hold); return hold; },
    runtime: value => codexStatus = value, claude: value => claudeStatus = value, provider,
    counts: () => ({ materializations, attachmentReads, runtimeReads }),
    stamp: (tab, state, extra = {}) => cjs.exports.__testPublicRuntimeSnapshots.stamp(tab, {
      type: 'snapshot', toolType: provider.get(tab), commandType: provider.get(tab),
      sessionId: tab === 'T' ? SID : 'claude-A', lifecycleGeneration: 'private-launch',
      sessionStatus: state, inputReady: true, busy: state === 'busy', ...extra }),
    callbacks, event,
  };
}

async function mountActualDispatcher(t, f) {
  // Complete bridge module initializes with the real stores, remote adapter,
  // catalogue and Send-now scenario imports; the entire App dispatcher runs.
  const workspace = { isRestoring: false, spaces: [{ id: 'W', name: 'PRIVATE', projectIds: [f.project.id] }], activeSpaceId: 'W',
    organizationReady: true, tabWorkflowMembership: { T: f.organization.service.getMembership('T'), C: f.organization.service.getMembership('C') },
    openProjects: new Map([[f.project.id, { projectPath: f.root, tabs: new Map([
      ['T', { id: 'T', name: 'Codex', commandType: 'codex', codexSessionId: SID, cwd: f.root }],
      ['C', { id: 'C', name: 'Claude', commandType: 'claude', claudeSessionId: 'claude-A', cwd: f.root }],
    ]) }]]) };
  const physical = [], module = { exports: {} }, timers = new Map(), events = new EventEmitter();
  const ports = { workspace, projects: { [f.project.id]: { name: 'PRIVATE' } },
    ui: { codexSettings: { models: [{ id: 'private-model', efforts: ['low', 'max'], visible: true }], removedModelIds: [] },
      claudeCodeSettings: { models: [] } }, runtime: { toolType: 'codex', getPresence: async () => ({ status: 'active', inputReady: true }) } };
  const ipc = { on: (...args) => events.on(...args), removeListener: (...args) => events.removeListener(...args), sendSync() {},
    send: (channel, input) => { assert.equal(channel, 'web:bridge-reply'); f.callbacks.get(channel)(f.event(), input); },
    invoke: async (channel, value) => {
      if (channel === 'app:getState') return f.pm.db.getAppState(value);
      if (channel === 'app:setState') { f.pm.db.setAppState(value.key, value.value); return { success: true }; }
      if (channel === 'ai-prompts:get') return { success: true, data: f.pm.db.getAIPrompts() };
      if (channel === 'ai-prompts:save-content') { f.pm.db.saveAIPromptContent(value.id, value.content); return { success: true }; }
      if (channel === 'run-after:main-epoch') return f.exports.runAfterMainEpoch();
      if (channel === 'run-after:validate-scope') return f.exports.validateRunAfterScope(f.event(), value);
      if (channel === 'run-after:commit') return f.exports.commitRunAfterOperation(f.event(), value);
      if (channel === 'run-after:stage') return f.exports.stageRunAfterOperation(f.event(), value);
      if (channel === 'run-after:owner-busy-proof') return f.exports.runAfterOwnerBusyProof(f.event(), value);
      if (channel === 'app:get-runtime-identity') return { instanceId: 'private-main-lifetime' };
      if (channel === 'provider:get-status') return { type: 'anthropic' };
      if (channel === 'codex:list-models') return { models: [] };
      if (channel === 'agent:enqueue-prompt') { physical.push(value); return { success: true, submitted: true }; }
      throw new Error('unexpected actual dispatcher IPC: ' + channel);
    } };
  const context = vm.createContext({ module, exports: module.exports, require, process, Buffer, ports, console: { log() {}, warn() {}, error() {} },
    crypto: require('node:crypto'), window: { require: () => ({ ipcRenderer: ipc }) },
    setTimeout: fn => { const id = Symbol(); timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) });
  const promptEvent = value => events.emit('ai-prompts:changed', {}, value);
  f.sender.on('service-prompts-change', promptEvent);
  vm.runInContext(bridgeBundle, context); const actual = module.exports;
  await actual.hydratePromptQueueStore(); await actual.hydrateAutoCompactStore();
  context.useWorkspaceStore = { getState: () => workspace }; context.ipcRenderer = ipc;
  context.handleRunAfterApplicationRead = actual.handleRunAfterApplicationRead;
  context.handleRunAfterApplicationMutation = actual.handleRunAfterApplicationMutation;
  vm.runInContext(dispatcher, context);
  f.sender.send = (channel, input) => { assert.equal(channel, 'web:bridge-request'); void context.dispatch({}, input); };
  let blocked = false, compacts = 0;
  ports.coordinator = actual.createAutoCompactCoordinator({ startedAt: 0,
    policy: () => actual.useAutoCompactStore.getState().policy,
    target: () => ({ tabId: 'T', provider: 'codex', sessionId: SID, workflowId: 'W' }),
    blocked: () => blocked, readiness: async () => ({ ready: true, status: 'active' }),
    context: async () => ({ exact: true, provider: 'codex', sessionId: SID, pct: 75, observedAt: Date.now() }),
    compact: async () => { compacts++; }, failure() {},
    activity: (tab, state) => actual.useAutoCompactStore.getState().setActivity(tab, state),
  });
  t.after(() => { ports.coordinator.dispose(); timers.clear(); f.sender.removeListener('service-prompts-change', promptEvent); });
  return { actual, physical, coordinator: ports.coordinator, blocked: value => blocked = value, compacts: () => compacts };
}

test('all advertised24 queue +4 policy ops reach actual App dispatcher/full bridge/stores/coordinator over HTTP', { timeout: 15000 }, async t => {
  const f = await fixture(t, { migrated: true }), d = await mountActualDispatcher(t, f);
  const seenQueue = new Set(), seenPolicy = new Set(); let sequence = 0;
  const read = async () => {
    const response = await f.request('/api/terminal-tabs/T/queue?runAfter=1');
    assert.equal(response.status, 200, JSON.stringify({ response: response.value,
      mainLoop: f.pm.getAIPrompts().find(prompt => prompt.id === 'run-after-loop')?.content,
      rendererLoop: d.actual.usePromptQueueStore.getState().sharedLoopPromptText,
      queueLoop: d.actual.usePromptQueueStore.getState().getQueue('T').loopPromptText }));
    assert.ok(response.value.runAfter, JSON.stringify(response.value));
    return response.value;
  };
  const mutate = async (op, args, editorToken) => {
    const snapshot = await read();
    const result = await f.request('/api/terminal-tabs/T/queue', { op, args,
      runAfter: { version: 1, operationId: 'actual-op-' + (++sequence), expected: snapshot.runAfter.guard,
        ...(editorToken ? { editorToken } : {}) } });
    assert.equal(result.status, 200, op + ': ' + JSON.stringify(result.value)); seenQueue.add(op); return result.value.operation.result;
  };
  const id = (await mutate('add', { text: 'FIRST' })).itemId;
  await mutate('update', { id, text: 'EDITED', title: 'Title' });
  const action = (await mutate('addAction', { kind: 'restart' })).itemId;
  await mutate('updateAction', { id: action, kind: 'model-effort', toolType: 'codex', model: 'private-model', effort: 'max' });
  await mutate('setCondition', { id, value: 50, operator: 'gte' });
  await mutate('setTrigger', { id, trigger: { kind: 'timer', seconds: 7200 } });
  await mutate('clearTrigger', { id });
  await mutate('setFirstDelaySeconds', { value: 7201 });
  await mutate('setRunAfterTab', { value: 'C' });
  await mutate('setAutoRun', { value: false });
  await mutate('setStopAfter', { value: true }); await mutate('setCloseAfter', { value: true });
  await mutate('setPostPromptEnabled', { value: true }); await mutate('setPostPromptText', { value: 'POST' });
  await mutate('setLoopPromptEnabled', { value: false }); await mutate('setLoopPromptText', { value: 'SHARED LOOP' });
  const edit = await mutate('beginEdit', { id }); await mutate('endEdit', {}, edit.editorToken);
  await mutate('reorder', { fromIndex: 0, toIndex: 1 }); await mutate('reorder', { fromIndex: 1, toIndex: 0 });
  await mutate('remove', { id: action });
  const replay = await mutate('replay', { id }); assert.equal(replay.submitted, false); assert.equal(d.physical.length, 0);
  const selected = (await mutate('add', { text: 'EXPLICIT' })).itemId;
  await mutate('sendNow', { id: selected }); assert.equal(d.physical[0].promptQueueAction, 'send-now');
  assert.equal(d.physical[0].prompt, 'EXPLICIT', 'manual selection does not inherit Post');
  f.runtime('busy'); await mutate('quickCompact', {}); await mutate('clear', {});
  const policy = async (op, args) => {
    const current = (await f.request('/api/run-after/auto-compact')).value;
    const response = await f.request('/api/run-after/auto-compact', { op, args,
      runAfter: { version: 1, operationId: 'actual-policy-' + (++sequence), expected: current.guard } });
    assert.equal(response.status, 200, op + ': ' + JSON.stringify(response.value)); seenPolicy.add(op); return response.value;
  };
  await policy('updatePolicy', { patch: { enabled: true, scopeInitialized: true, allWorkflows: true } });
  await policy('setExcluded', { tabId: 'T', excluded: true }); await policy('setExcluded', { tabId: 'T', excluded: false });
  d.blocked(true); const waiting = d.coordinator.request('T');
  const activity = d.actual.useAutoCompactStore.getState().activities.T;
  const cancelled = await policy('cancel', { tabId: 'T', activityId: activity.handoffId, targetGuard: (await read()).runAfter.guard });
  assert.equal(cancelled.operation.result.cancelled, true); assert.equal((await waiting).skipped, 'cancelled');
  d.blocked(false); await policy('requestNow', { tabId: 'T', resume: false, targetGuard: (await read()).runAfter.guard });
  assert.equal(d.compacts(), 1, 'real coordinator reaches controlled compact executor once');
  const caps = (await f.request('/api/me')).value.capabilities.runAfter;
  assert.deepEqual([...seenQueue].sort(), [...caps.queueOperations].sort());
  assert.deepEqual([...seenPolicy].sort(), [...caps.autoCompactOperations].sort());
});

for (const provider of ['codex', 'claude']) for (const next of ['active', 'busy']) test('Catalogue F1 whole HTTP preserves ' + provider + ' source clock during style await →' + next, { timeout: 5000 }, async t => {
  const f = await fixture(t), tab = provider === 'codex' ? 'T' : 'C', initial = next === 'active' ? 'busy' : 'active';
  f.runtime(initial); f.claude(initial); f.stamp(tab, initial);
  const hold = f.hold('getStatusMarkerConfig');
  const request = f.request('/api/projects/' + encodeURIComponent(f.project.id) + '/tabs');
  await hold.entered.promise;
  f.runtime(next); f.claude(next); const current = f.stamp(tab, next);
  hold.release.resolve(); const result = await request;
  assert.equal(result.status, 200, JSON.stringify(result.value));
  const row = result.value.tabs.find(row => row.tabId === tab);
  assert.equal(row.sessionStatus, next); assert.equal(row.turnBusy, next === 'busy');
  assert.equal(row.runtimeRevision, current.runtimeRevision, 'metadata cannot restamp the superseded source');
  assert.equal(f.stamp(tab, next).runtimeRevision, current.runtimeRevision, 'retained source cannot regress');
  assert.equal(f.counts().runtimeReads, 1);
  assert.equal(f.trace.filter(e => e.stage === 'main-source-read')[0].at >= f.trace.find(e => e.stage === 'bridge-reply' && e.action === 'getStatusMarkerConfig').at, true);
});

test('Catalogue F1 newer Claude lifecycle/session survives old batch and metadata held reply', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.stamp('C', 'busy'); const h = f.hold('getStatusMarkerConfig');
  const pending = f.request('/api/projects/' + encodeURIComponent(f.project.id) + '/tabs');
  await h.entered.promise;
  const current = f.stamp('C', 'starting', { sessionId: 'claude-B', launchId: 'new-launch', lifecycleGeneration: 'new-generation', inputReady: false });
  h.release.resolve(); const result = await pending;
  const row = result.value.tabs.find(row => row.tabId === 'C');
  assert.equal(row.sessionId, 'claude-B'); assert.equal(row.sessionStatus, 'starting');
  assert.equal(row.runtimeRevision, current.runtimeRevision); assert.equal(row.inputReady, false);
});

test('Catalogue F8 independent metadata reads are concurrent and observer disconnect stops read-only tail', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const held = ['getProjectCompletionNotifications', 'getClaudeTabStatusBatch', 'getStatusMarkerConfig'].map(a => f.hold(a));
  const abort = new AbortController();
  const request = f.request('/api/projects/' + encodeURIComponent(f.project.id) + '/tabs', undefined, abort.signal).catch(e => e);
  await Promise.all(held.map(h => h.entered.promise));
  const starts = f.trace.filter(e => e.stage === 'bridge-start');
  assert.equal(starts.length, 3);
  assert.ok(starts.at(-1).at - starts[0].at < 50, 'all independent reads begin before any reply, not serial1500ms waits');
  abort.abort(); await request;
  await f.closed.promise;
  for (const h of held) h.release.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.counts().runtimeReads, 0); assert.equal(f.counts().materializations, 0);
  t.diagnostic(JSON.stringify({ stages: f.trace, sourceReads: f.counts() }));
});

test('Catalogue F8 old Claude SID is not materialized for current Codex owner', async t => {
  const f = await fixture(t); const result = await f.request('/api/projects/' + encodeURIComponent(f.project.id) + '/tabs');
  assert.equal(result.status, 200); assert.equal(f.counts().materializations, 1, 'only actual Claude C, never old Claude SID of T');
  assert.equal(result.value.tabs.find(r => r.tabId === 'T').commandType, 'codex');
});

function seedUnknown(f, body, rawIdentity = true) {
  const identity = { operationKey: 'inbox:' + body.runId, surface: 'inbox', runId: body.runId,
    tabId: '__noted_inbox__-tab-private', handoffId: 'external-run:' + body.runId,
    requestFingerprint: fingerprintAgentSendRequest({ prompt: body.prompt, originalAttachments: body.attachments }),
    provider: 'codex', sessionId: null, promptHash: promptAuditFingerprint(body.prompt), promptLength: body.prompt.length };
  assert.equal(f.store.reserveOrGet(identity).ok, true);
  assert.equal(f.store.recordInboxSetup(identity.operationKey, identity.requestFingerprint, {
    runId: body.runId, reservedTabId: identity.tabId, handoffId: identity.handoffId, executionId: 'private-setup',
    conversationKey: body.conversationKey, source: 'private',
    ...(rawIdentity ? { sourceRequestFingerprint: fingerprintAgentSendRequest(body) } : {}),
  }).ok, true);
  assert.equal(f.store.updateInboxSetup(identity.operationKey, 'private-setup', { creationState: 'created',
    creationResult: { tabId: identity.tabId, projectId: '__noted_inbox__', toolType: 'codex' } }).ok, true);
  const started = f.store.beginAttempt(identity); assert.equal(started.action, 'attempt-started');
  f.store.markAttemptState(identity.operationKey, started.attemptId, 'enter-armed');
  f.store.settleAttempt(identity.operationKey, started.attemptId, { success: null, submitted: null,
    deliveryUnknown: true, status: 'delivery-unknown', code: 'private-unknown', handoffId: identity.handoffId });
  return f.store.get(identity.operationKey);
}

for (const legacy of [false, true]) test('Inbox F11 whole initialized HTTP reads unknown receipt BEFORE missing attachment, legacy=' + legacy, async t => {
  const f = await fixture(t);
  const body = { runId: 'private-inbox', provider: 'codex', conversationKey: 'private-chat', prompt: 'PRIVATE',
    attachments: [{ type: 'image', path: path.join(f.root, 'removed-upload.png') }] };
  const before = seedUnknown(f, body, !legacy);
  const result = await f.request('/api/inbox/runs', body);
  assert.equal(result.value.deliveryUnknown, true, JSON.stringify(result.value));
  assert.equal(result.value.submitted, null); assert.equal(result.value.requestIdentityVerified, !legacy);
  assert.equal(f.counts().attachmentReads, 0); assert.equal(f.trace.filter(e => e.stage === 'bridge-start').length, 0);
  const after = f.store.get(before.operationKey);
  assert.equal(after.attemptId, before.attemptId); assert.equal(after.state, before.state);
  assert.deepEqual(after.receipt, before.receipt);
  const conflict = await f.request('/api/inbox/runs', { ...body, prompt: 'DIFFERENT' });
  assert.equal(conflict.status, legacy ? 202 : 409);
  assert.equal(conflict.value.submitted, null); assert.equal(f.counts().attachmentReads, 0);
});

test('whole ProjectManager/RunAfter bootstrap uses Main workflow membership, not execution namespace aliases', async t => {
  const f = await fixture(t, { migrated: true });
  const handshake = await f.request('/api/me'), api = f.whole.api();
  assert.equal(handshake.status, 200);
  assert.equal(handshake.value.capabilities.runAfter.mainEpoch, api.journal.epoch);
  assert.notEqual(handshake.value.service.instanceId, api.journal.epoch);
  const scope = api.scope('T');
  assert.equal(scope.workflowId, 'W'); assert.equal(scope.projectId, f.project.id);
  assert.equal(scope.membershipRevision, f.organization.service.getMembership('T').revision);
  const prior = api.scopeKey('T');
  const publication = f.organization.service.getPublication();
  const inbox = f.organization.service.listWorkflows().find(workflow => workflow.kind === 'inbox');
  f.organization.service.moveTab({ mutationId: 'private-move', expectedRevision: publication.revision, tabId: 'T',
    workflowId: inbox.id, expectedWorkflowRevision: inbox.revision, expectedMembershipRevision: scope.membershipRevision });
  assert.notEqual(api.scopeKey('T'), prior, 'Main membership change revokes a stale RunAfter scope even before renderer hydration');
});

test('F3 actual Main context handler rereads exact binding after context observer await', async t => {
  const f = await fixture(t), entered = barrier(), release = barrier();
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const tree = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
  const resolver = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'resolveAiToolTypeForTab');
  const registration = tree.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(tree) === 'ipcMain.handle' && node.expression.arguments[0].text === 'tab:get-context-pct');
  assert.ok(resolver && registration);
  const usage = require('./agent-context-usage-state').createAgentContextUsageState();
  usage.observe({ tabId: 'T', provider: 'codex', sessionId: SID, contextPct: 90 });
  const factory = vm.runInNewContext('(function(require,ports){ const projectManager=require("./project-manager");'
    + 'const {resolveAiToolOwner}=require("./ai-tool-owner");'
    + 'const ipcMain={handle:(key,fn)=>ports.handler=fn};const bridgeKnownSessions=new Map();'
    + 'const agentContextUsageState=ports.usage;const codexSessionContextObserver=ports.observer;'
    + 'const getLiveAiRuntimeOwners=()=>ports.live;'
    + resolver.getText(tree) + registration.getText(tree) + ';return ports;})', { console: { warn() {} } });
  const ports = { usage, live: ['codex'], observer: { ensure: async () => { entered.resolve(); await release.promise; } } };
  factory(id => id === './project-manager' ? f.pm : require(id), ports);
  const pending = ports.handler({}, { tabId: 'T', provider: 'codex', sessionId: SID, requireExact: true });
  await entered.promise;
  f.pm.db.db.prepare('UPDATE tabs SET codex_session_id=? WHERE tab_id=?').run('private-B', 'T');
  release.resolve(); const result = await pending;
  assert.equal(result.exact, false); assert.equal(result.pct, null); assert.equal(result.reason, 'session-binding-mismatch');
  usage.observe({ tabId: 'T', provider: 'codex', sessionId: 'private-B', contextPct: 0 });
  const zero = await ports.handler({}, { tabId: 'T', provider: 'codex', sessionId: 'private-B', requireExact: true });
  assert.equal(zero.pct, 0); assert.equal(zero.exact, true);
  ports.live = ['claude'];
  const foreign = await ports.handler({}, { tabId: 'T', provider: 'codex', sessionId: 'private-B', requireExact: true });
  assert.equal(foreign.pct, null); assert.equal(foreign.reason, 'provider-owner-mismatch');
});

test('F4 actual FIFO/whole web join preserves original unknown identity across a new renderer arm', async t => {
  const f = await fixture(t), { AgentSendQueue } = require('./agent-send-queue');
  const base = 'run-after-private-item-7-original', key = 'history:T:' + base + '-arm-1';
  const request = { tabId: 'T', provider: 'codex', prompt: 'PRIVATE', source: 'prompt-queue',
    handoffId: base + '-arm-1', sendOperationKey: key,
    promptQueueIntent: { version: 1, kind: 'queue', itemId: 'private-item', baseHandoffId: base, armedAt: 1 } };
  const identity = { operationKey: key, surface: 'desktop-history', tabId: 'T', provider: 'codex',
    handoffId: request.handoffId, requestFingerprint: fingerprintAgentSendRequest(request),
    promptHash: promptAuditFingerprint(request.prompt), promptLength: request.prompt.length, sessionId: null };
  let writes = 0;
  const queue = new AgentSendQueue({ store: f.store, execute: async () => {
    writes++; const started = f.store.beginAttempt(identity);
    f.store.settleAttempt(key, started.attemptId, { success: null, submitted: null, deliveryUnknown: true, status: 'delivery-unknown' });
    return f.store.get(key).receipt;
  } });
  f.whole.queue(queue); t.after(() => { f.whole.queue(null); queue.dispose(); });
  assert.equal(queue.enqueue({ identity, request }).ok, true); await queue.result(key);
  const joined = await f.exports.joinAutomaticAgentPrompt({ tabId: 'T', handoffId: base + '-arm-2', prompt: 'PRIVATE',
    promptQueueIntent: { ...request.promptQueueIntent, armedAt: 2 } });
  assert.equal(joined.found, true); assert.equal(joined.receipt.submitted, null);
  assert.equal(joined.receipt.deliveryUnknown, true); assert.equal(joined.receipt.operationKey, key);
  assert.equal(joined.receipt.handoffId, request.handoffId); assert.equal(writes, 1);
});

async function historyFixture(t) {
  const f = await fixture(t), file = path.join(f.root, 'rollout-' + SID + '.jsonl'), api = codexData._api;
  const rows = text => [{ type: 'session_meta', payload: { id: SID, cwd: f.root } },
    { type: 'response_item', timestamp: '2026-10-08T00:00:02Z', payload: { type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text }] } }];
  const write = text => fs.writeFileSync(file, rows(text).map(r => JSON.stringify(r) + '\n').join(''));
  write('OLD-SOURCE');
  const scoped = { ...api,
    findCodexSessionFile: (id, cwd) => api.findCodexSessionFile(id, cwd, { sessionsDir: f.root, allowContentScan: false }),
    loadSessionRecords: (id, cwd, options) => api.loadSessionRecords(id, cwd, { ...options, sessionsDir: f.root }),
    projectCodexFullHistoryFromFile: (id, cwd, options) => api.projectCodexFullHistoryFromFile(id, cwd, { ...options, sessionsDir: f.root }),
  };
  const cache = new HistoryPreparedCache({ directory: path.join(f.root, 'cache') });
  const service = new SessionTranscriptService({ getMainWindow: () => null, codexData: { _api: scoped },
    promptPresentationStore: f.pm.db, sessionHistoryStore: f.pm.db, preparedHistoryStore: cache });
  const freshness = new HistoryFreshness({ readContext: (scope, ids) => service.getHistoryFreshnessContext(scope, ids) });
  f.whole.history(service, freshness);
  t.after(() => { service.codexVirtualTranscriptStore?.dispose(); api.invalidateJsonlCache(file); });
  return { ...f, file, service, freshness, cache, write,
    invalidate: () => { api.invalidateJsonlCache(file); cache.invalidate(file); },
    read: () => f.request('/api/terminal-tabs/T/history?view=history&last=80&payloads=on-demand-v1&freshness=v1') };
}

test('History R4 actual full HTTP closure cannot certify an event during final context delivery', { timeout: 5000 }, async t => {
  const f = await historyFixture(t), entered = barrier(), release = barrier();
  let active = false, calls = 0;
  const complete = f.freshness.completeRead.bind(f.freshness), context = f.freshness.readContext.bind(f.freshness);
  t.mock.method(f.freshness, 'completeRead', async (...a) => { active = true; try { return await complete(...a); } finally { active = false; } });
  t.mock.method(f.freshness, 'readContext', async (...a) => {
    const value = await context(...a);
    if (active && ++calls === 2) { entered.resolve(); await release.promise; }
    return value;
  });
  const request = f.read(); await entered.promise;
  f.freshness.invalidate('T', 'private-watcher-event'); release.resolve();
  const result = await request;
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.notEqual(result.value.historyFreshness.state, 'known');
  const fresh = await f.read(); assert.equal(fresh.value.historyFreshness.state, 'known');
});

for (const kind of ['base', 'view']) test('History R5 actual HTTP after prepared ' + kind + ' success returns current generation', { timeout: 5000 }, async t => {
  const f = await historyFixture(t), entered = barrier(), release = barrier(), save = f.cache.savePrepared.bind(f.cache);
  let held = false;
  t.mock.method(f.cache, 'savePrepared', async value => {
    const result = await save(value);
    if (!held && (value.kind || 'view') === kind) { held = true; entered.resolve(); await release.promise; }
    return result;
  });
  const request = f.read(); await entered.promise; f.write('NEW-SOURCE'); f.invalidate(); release.resolve();
  const result = await request;
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.ok(JSON.stringify(result.value).includes('NEW-SOURCE'));
  assert.ok(!JSON.stringify(result.value).includes('OLD-SOURCE'));
  assert.equal(result.value.historyFreshness.state, 'known');
});
