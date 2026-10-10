'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const esbuild = require('esbuild');
const ts = require('typescript');
const { RunAfterApplicationAPI } = require('./run-after-api');
const { RUN_AFTER_CAPABILITY, runAfterError } = require('../shared/run-after-api.cjs');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { PromptQueueAssetStore } = require('./prompt-queue-assets');
const { collectReferencedAssetIds } = require('./prompt-queue-assets');
const { importMobileUploads } = require('./owned-mobile-attachments');
const { createSystemPromptService } = require('./system-prompt-service');
const { frameKey: switcherFrameKey } = require('./workspace-switcher-api');
let fixtureRoot;
const electronPath = require.resolve('electron'), oldElectron = require.cache[electronPath];
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { isPackaged: false, getPath: () => fixtureRoot } } };
const DatabaseManager = require('./database');
if (oldElectron) require.cache[electronPath] = oldElectron; else delete require.cache[electronPath];
const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const appBridge = fs.readFileSync(path.join(__dirname, '../renderer/utils/runAfterApplicationBridge.ts'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../renderer/App.tsx'), 'utf8');
const tree = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, name.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
const webTree = tree('web.js', web), bridgeTree = tree('bridge.ts', appBridge);
const appTree = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = (ast, name) => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
};
const quiet = { log() {}, warn() {}, error() {} };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let bundle, createRemote, scopeHelpers;
test.before(async () => {
  const compiled = await esbuild.build({ stdin: { contents: `
    export * from './store/usePromptQueueStore';
    export * from './store/useAutoCompactStore';
    export { usePromptsStore } from './store/usePromptsStore';
    export { runAfterActionModels } from './utils/runAfterActionModels';
    export { shouldArmQueueForTrigger } from './utils/promptTriggerArm.mjs';
    export { shouldDisarmAfterTriggerClear } from './utils/runAfterTriggerClear.mjs';
    export { normalizeComposerChips, serializeComposerDraft, buildPasteChipMarker } from './utils/composerChips.mjs';
    export { inspectPromptImageAttachments } from './utils/promptImageAttachments.mjs';
    export { dictationBlocksSend } from './utils/dictationChips.mjs';
    `, resolveDir: path.join(__dirname, '../renderer'), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' });
  bundle = compiled.outputFiles[0].text;
  ({ createRunAfterRemote: createRemote } = await import('../renderer/utils/runAfterRemote.mjs'));
  scopeHelpers = await import('../renderer/utils/runAfterInventory.mjs');
});

async function fixture(t) {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-after-api-'));
  const root = fixtureRoot, db = new DatabaseManager();
  const project = db.createEmptyProject('Private RunAfter');
  db.saveTabs(project.id, [{ tabId: 'T', name: 'Owner', tabType: 'terminal', commandType: 'codex', codexSessionId: 'S', cwd: root }], true);
  const pm = { db, getAIPrompts: () => db.getAIPrompts(), saveAIPrompt: value => db.saveAIPrompt(value) };
  let time = 1000, ownGeneration = 1, hold = null, dispatched = [], commits = [], prepared = [];
  const timers = new Map(), ipcEvents = new EventEmitter(), sender = new EventEmitter();
  sender.id = 7; sender.mainFrame = { processId: 5, routingId: 11 }; sender.isDestroyed = () => false;
  const event = () => ({ sender, senderFrame: sender.mainFrame });
  const storeModule = { exports: {} }; let webContext, remote;
  const systemPromptService = createSystemPromptService({ projectManager: pm,
    onChanged: value => ipcEvents.emit('ai-prompts:changed', {}, value) });
  const assetStore = new PromptQueueAssetStore({ rootDir: path.join(root, 'assets'), logger: quiet });
  const uploadRoot = path.join(root, 'uploads'); fs.mkdirSync(uploadRoot);
  const ws = { isRestoring: false, activeSpaceId: 'W', spaces: [{ id: 'W', name: 'Workflow', projectIds: [project.id], icon: null }],
    openProjects: new Map([[project.id, { projectPath: root, tabs: new Map([
      ['T', { id: 'T', name: 'Owner', tabType: 'terminal', commandType: 'codex', codexSessionId: 'S' }],
      ['fresh', { id: 'fresh', name: 'Fresh', tabType: 'terminal', commandType: 'codex' }],
      ['claude', { id: 'claude', name: 'Claude', tabType: 'terminal', commandType: 'claude', claudeSessionId: 'C' }],
      ['gemini', { id: 'gemini', name: 'Gemini', tabType: 'terminal', commandType: 'gemini' }],
      ['sdk', { id: 'sdk', name: 'SDK', tabType: 'claude-sdk' }],
      ['child', { id: 'child', name: 'Child', commandType: 'codex', parentTabId: 'T' }],
      ['file', { id: 'file', name: 'File', tabType: 'file', filePath: '/not-a-provider' }],
    ]) }]]) };
  const projectMeta = { [project.id]: { name: 'Private RunAfter' } };
  const ipc = {
    on: (...args) => ipcEvents.on(...args), removeListener: (...args) => ipcEvents.removeListener(...args),
    invoke: async (channel, value) => {
      if (channel === 'ai-prompts:get') return { success: true, data: db.getAIPrompts() };
      if (channel === 'ai-prompts:save-content') return { success: true, data: systemPromptService.saveContent(value.id, value.content) };
      if (channel === 'app:getState') return db.getAppState(value);
      if (channel === 'app:setState') { db.setAppState(value.key, value.value); return { success: true }; }
      if (channel === 'prompt-queue:materialize-image-refs') return { refs: await assetStore.materializeRefs(value.refs) };
      throw Error('unexpected IPC ' + channel);
    },
    sendSync: (_channel, value) => { if (value?.key) db.setAppState(value.key, value.value); return { success: true }; },
  };
  class Clock extends Date { static now() { return time; } }
  const vmStore = vm.createContext({ module: storeModule, exports: storeModule.exports, require, process, console: quiet,
    Date: Clock, window: { require: () => ({ ipcRenderer: ipc }) },
    setTimeout: fn => { const id = Symbol(); timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(bundle, vmStore); const owners = storeModule.exports;
  await owners.hydratePromptQueueStore(); await owners.hydrateAutoCompactStore();
  const models = { claudeCodeSettings: { models: [{ id: 'opus', label: 'Opus', visible: true }] },
    codexSettings: { models: [{ id: 'private-model', label: 'Private model', visible: true, efforts: ['low', 'max'] }], removedModelIds: [] } };
  let providerType = 'anthropic', runtime = { pending: false, phase: 'paused', ownBusy: false }, busy = false;
  let api;
  const helpers = vm.createContext({ runAfterActionModels: owners.runAfterActionModels, failure: runAfterError, exports: {}, mainEpoch: null,
    useUIStore: { getState: () => models }, normalizeComposerChips: owners.normalizeComposerChips, clone: value => JSON.parse(JSON.stringify(value)),
    materializeQueuedPromptRecord: owners.materializeQueuedPromptRecord, inspectPromptImageAttachments: owners.inspectPromptImageAttachments,
    dictationBlocksSend: owners.dictationBlocksSend,
    ipcRenderer: { invoke: async (channel, value) => {
      if (channel === 'provider:get-status') return { type: providerType };
      if (channel === 'codex:list-models') return { models: [] };
      if (channel === 'run-after:main-epoch') return { epoch: api.journal.epoch };
      if (channel === 'run-after:commit') return api.commit(event(), value);
      if (channel === 'run-after:stage') return api.stage(event(), value);
      throw Error('unexpected renderer IPC '+channel);
    } },
  });
  for (const name of ['actions', 'validateAction', 'authoring']) vm.runInContext(esbuild.transformSync(declaration(bridgeTree, name), { loader: 'ts' }).code, helpers);
  for (const name of ['validateMain','handleRunAfterApplicationRead','handleRunAfterApplicationMutation']) {
    vm.runInContext(ts.transpileModule(declaration(bridgeTree, name), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, helpers);
  }
  let transferProperty;
  const findTransfer=node=>{if(ts.isPropertyAssignment(node)&&node.name.getText(bridgeTree)==='prepareTransfer')transferProperty=node;ts.forEachChild(node,findTransfer)};
  findTransfer(bridgeTree);assert.ok(transferProperty);
  vm.runInContext(esbuild.transformSync('globalThis.prepareTransfer='+transferProperty.initializer.getText(bridgeTree),{loader:'ts'}).code,helpers);
  const ports = { queue: owners.usePromptQueueStore, autoCompact: owners.useAutoCompactStore,
    workspace: () => ws, projects: () => projectMeta, epoch: () => api.journal.epoch + ':private-renderer',
    hydrated: owners.isPromptQueueStoreHydrated, core: owners.serializePromptQueueCore, countdown: owners.readPromptQueueCountdown,
    editorLock: owners.getPromptQueueEditorLock, acquireEditor: owners.acquirePromptQueueEditorLock, releaseEditor: owners.releasePromptQueueEditorLock,
    runtimeState: () => runtime, now: () => time, hasPending: owners.hasPendingPromptQueueContinuation, loopActive: owners.isLoopPromptActive,
    queuePersistence: owners.takePromptQueuePersistence, policyPersistence: owners.takeAutoCompactPersistence,
    armForTrigger: owners.shouldArmQueueForTrigger, disarmAfterTriggerClear: owners.shouldDisarmAfterTriggerClear,
    mainInstanceId: async () => 'application-A', validateAction: helpers.validateAction, prepareAuthoring: helpers.authoring,
    ownerBusyProof: async () => ({ known: true, busy, provider: 'codex', sessionId: 'S' }),
    validateScope: async ticket => api.validateScope(event(), ticket),
    prepareTransfer: async (item, ticket) => {
      if (hold) await hold.promise;
      const snapshot = await helpers.prepareTransfer(item,ticket);
      prepared.push(snapshot);
      return snapshot;
    },
    sendNow: async (tabId, item, scope) => { dispatched.push({ tabId, item, scope }); return { success: true, submitted: true }; },
    transferred: owners.queueSendTransferredOwnership,
    cancelAutoCompact: () => false, requestAutoCompact: async tabId => ({ skipped: 'controlled', tabId }),
    commit: async (ticket, result, writes, retainAssets) => {
      commits.push({ ticket, writes });
      return api.commit(event(), { ticket, result, writes, retainAssets });
    },
  };
  remote = createRemote(ports);
  helpers.remote = remote;
  webContext = vm.createContext({ console: quiet, Date, JSON, Map, Set, fs, path,
    require: name => name === './project-manager' ? pm : require(name),
    runAfterApi: null, RunAfterApplicationAPI, RUN_AFTER_CAPABILITY, runAfterError, fingerprintAgentSendRequest,
    systemPromptService, mobileAttachmentAssetStore: assetStore, importMobileUploads,
    mobileAttachmentRoot: () => uploadRoot, findOwnedMobileUpload: () => null,
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: sender }] },
    conversationOwners: { current: tabId => ({ ownerToken: tabId + '-owner-' + ownGeneration, currentBinding: { state: 'bound', provider: 'codex', sessionId: 'S' } }) },
    switcherFrameKey, crypto: require('node:crypto'), setTimeout, clearTimeout,
    pendingBridge: new Map(), LATE_BRIDGE_REPLY_RETENTION_MS: 1000, e2eBoundaryTestGate: null, bridgePayloadLabel: () => '',
    sendJson: (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); },
    readBody: req => new Promise((resolve, reject) => { let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (error) { reject(error); } }); }),
    decId: decodeURIComponent,
  });
  const mainIpc = new Map(); webContext.ipcMain = { on: (name,fn)=>mainIpc.set(name,fn) };
  for(const name of ['bridgeRequest','registerBridgeReplyHandler'])vm.runInContext(declaration(webTree,name),webContext);
  webContext.registerBridgeReplyHandler();
  let appBranch; const legacyBranches=[];
  const findBranch=node=>{if(ts.isIfStatement(node)&&node.expression.getText(appTree)==="action === 'readRunAfter' || action === 'mutateRunAfter'")appBranch=node;
    if(ts.isIfStatement(node)&&["action === 'getPromptQueue'","action === 'mutatePromptQueue'","action === 'previewRunAfterImage'"].includes(node.expression.getText(appTree)))legacyBranches.push(node);
    ts.forEachChild(node,findBranch)};
  findBranch(appTree); assert.ok(appBranch);
  const receiver=vm.createContext({handleRunAfterApplicationRead:helpers.handleRunAfterApplicationRead,
    handleRunAfterApplicationMutation:helpers.handleRunAfterApplicationMutation,
    usePromptQueueStore:owners.usePromptQueueStore, serializePromptQueueCore:owners.serializePromptQueueCore,
    getPromptQueueAiTabs:tabId=>scopeHelpers.runAfterTargetInventory(ws,projectMeta,tabId),
    ipcRenderer:{invoke:async(channel,ref)=>{
      assert.equal(channel,'prompt-queue:get-image-preview-data-url');
      return previewHandler(null,ref);
    }},
    sendReply:value=>mainIpc.get('web:bridge-reply')(event(),value)});
  vm.runInContext(ts.transpileModule('async function receive({requestId,action,payload}){const reply=(ok,data,error)=>sendReply({requestId,ok,data,error});'
    +appBranch.getText(appTree)+legacyBranches.map(node=>node.getText(appTree)).join('\n')+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,receiver);
  sender.send=(channel,payload)=>{assert.equal(channel,'web:bridge-request');void receiver.receive(payload)};
  const mainSource=fs.readFileSync(path.join(__dirname,'main.js'),'utf8'),mainAst=tree('main.js',mainSource);
  let previewHandler;
  const previewNode=mainAst.statements.find(node=>node.getText(mainAst).startsWith("ipcMain.handle('prompt-queue:get-image-preview-data-url'"));
  assert.ok(previewNode);
  vm.runInNewContext(previewNode.getText(mainAst),{ipcMain:{handle:(_name,handler)=>previewHandler=handler},promptQueueAssetStore:assetStore,
    nativeImage:{createFromPath:file=>({isEmpty:()=>false,getSize:()=>({width:1,height:1}),toDataURL:()=> 'data:image/png;base64,'+fs.readFileSync(file).toString('base64')})},
    require:()=>({readMobileAttachmentPreview:()=>{throw Error('unowned image cannot fall back to an arbitrary path')}}),path,srcMainDir:__dirname,console:quiet});
  // Keep the production lexical import. The old extracted fixture omitted it
  // and failed before reaching its cases; no invented namespace resolver.
  vm.runInContext("const { executionNamespaceForRow } = require('./workflow-organization-http');", webContext);
  for (const name of ['runAfterMainScope', 'prepareRunAfterAuthoring', 'getRunAfterApi', 'runAfterReply', 'runAfterFailure']) vm.runInContext(declaration(webTree, name), webContext);
  api = webContext.getRunAfterApi();
  const start = web.indexOf('  // Prompt-queue ("Run after")'), end = web.indexOf('  // Explicit task completion', start);
  vm.runInContext('async function route(req,res,parsed){let m;' + web.slice(start, end) + 'return sendJson(res,404,{error:"not-found"});}', webContext);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://private');
    webContext.route(req, res, { pathname: url.pathname, query: Object.fromEntries(url.searchParams) })
      .catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: error.stack })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { hold?.resolve();
    for(const pending of webContext.pendingBridge.values()) { clearTimeout(pending.timer); if(pending.lateCleanupTimer)clearTimeout(pending.lateCleanupTimer); }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const request = async (route, body) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + route,
      body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  let sequence = 0;
  const read = async (tabId = 'T') => request('/api/terminal-tabs/' + tabId + '/queue?runAfter=1');
  const mutate = async (op, args, extra = {}) => {
    const tabId = extra.tabId || 'T';
    const snapshot = extra.snapshot || (await read(tabId)).value;
    const body = { op, args, runAfter: { version: 1, operationId: extra.operationId || 'private-' + (++sequence),
      expected: snapshot.runAfter.guard, ...(extra.editorToken ? { editorToken: extra.editorToken } : {}) } };
    return { ...await request('/api/terminal-tabs/' + tabId + '/queue', body), body };
  };
  return { api, remote, owners, ports, db, pm, systemPromptService, ws, project, assetStore, uploadRoot, request, read, mutate,
    state: () => owners.usePromptQueueStore.getState(), time: n => time = n, scopeChange: () => ownGeneration++,
    busy: value => busy = value, providerType: value => providerType = value,
    runtime: value => runtime = value, hold: () => hold = deferred(), prepared, dispatched, commits, webContext, sender, event, helpers,
    useApi: value => api = value,
    restartMain:()=>{webContext.runAfterApi=null;api=webContext.getRunAfterApi();return api;} };
}

test('the whole CommonJS web service reads and commits through its lazy project singleton without a global', async t => {
  const f = await fixture(t), callbacks = new Map();
  const electron = {
    app: { isPackaged: false, getPath: () => path.dirname(f.db.db.name) },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: f.sender }] },
    ipcMain: { on: (channel, callback) => callbacks.set(channel, callback), emit() {},
      removeListener: (channel, callback) => { if (callbacks.get(channel) === callback) callbacks.delete(channel); } },
  };
  const nativeRequire = createRequire(path.join(__dirname, 'web-server.js'));
  const cjs = { exports: {} };
  const wrapper = vm.runInNewContext('(function(require,module,exports,__dirname,__filename){' + web + `
    return { api: getRunAfterApi, route: handleApi, admit: admitQueuedAgentSend,
      setStatus(value) { resolveAgentSessionInfo = async () => value; },
      setQueue(value) { agentSendQueue = value; },
      setCapacityStore(value) { getOrchestrationRunStore = () => value; scheduleOrchestrationPolicyTimer = async () => {}; },
      initialize(service) { token = 'private-token'; systemPromptService = service; registerBridgeReplyHandler(); } };
  })`, { console: quiet, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval });
  const whole = wrapper(name => name === './project-manager' ? f.pm : name === 'electron' ? electron : nativeRequire(name),
    cjs, cjs.exports, __dirname, path.join(__dirname, 'web-server.js'));
  whole.initialize(f.systemPromptService);
  assert.equal(typeof cjs.exports.runAfterMainEpoch().epoch, 'string');
  const api = whole.api(); f.useApi(api);
  f.helpers.ipcRenderer.invoke = async (channel, value) => {
    if (channel === 'run-after:main-epoch') return cjs.exports.runAfterMainEpoch();
    if (channel === 'run-after:commit') return cjs.exports.commitRunAfterOperation(f.event(), value);
    throw Error('unexpected whole-module IPC: ' + channel);
  };
  f.sender.send = (channel, payload) => {
    assert.equal(channel, 'web:bridge-request');
    const read = payload.action === 'readRunAfter';
    assert.ok(read || payload.action === 'mutateRunAfter');
    void (read ? f.helpers.handleRunAfterApplicationRead(payload.payload)
      : f.helpers.handleRunAfterApplicationMutation(payload.payload)).then(data =>
      callbacks.get('web:bridge-reply')(f.event(), { requestId: payload.requestId, ok: true, data }), error =>
      callbacks.get('web:bridge-reply')(f.event(), { requestId: payload.requestId, ok: false, error: error.message }));
  };
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://private');
    void whole.route(req, res, { pathname: parsed.pathname, query: Object.fromEntries(parsed.searchParams) }, new Map())
      .catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = async (route, body) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + route, {
      headers: { authorization: 'Bearer private-token', 'content-type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, value: await response.json() };
  };
  const initial = await request('/api/terminal-tabs/T/queue?runAfter=1');
  assert.equal(initial.status, 200, JSON.stringify(initial.value));
  const handshake = await request('/api/me');
  assert.equal(handshake.status, 200);
  assert.equal(handshake.value.capabilities.runAfter.mainEpoch, api.journal.epoch);
  assert.equal(initial.value.runAfter.mainEpoch, api.journal.epoch);
  assert.notEqual(handshake.value.service.instanceId, api.journal.epoch);
  assert.equal(api.scope('T').projectId, f.project.id);
  const body = { op: 'add', args: { text: 'whole service persisted item' }, runAfter: { version: 1,
    operationId: 'whole-service-add', expected: initial.value.runAfter.guard } };
  const result = await request('/api/terminal-tabs/T/queue', body);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(api.receipt('whole-service-add').phase, 'applied');
  assert.equal(f.state().getQueue('T').items[0].text, 'whole service persisted item');
  assert.equal(f.db.getAppState('promptQueueByTab').T.items[0].text, 'whole service persisted item');
  assert.equal((await request('/api/terminal-tabs/T/queue', body)).status, 200);
  assert.equal(f.state().getQueue('T').items.length, 1, 'same-ID recovery cannot create another card');
  let admissionReply = { ready: true };
  let readCount = 0;
  f.sender.send = (channel, payload) => {
    assert.equal(channel, 'web:bridge-request');
    assert.equal(payload.action, 'readPromptQueueSendAdmission'); readCount++;
    // A foreign renderer/frame cannot answer the Root owner read.
    callbacks.get('web:bridge-reply')({ sender: f.sender, senderFrame: { processId: 99, routingId: 99 } },
      { requestId: payload.requestId, ok: true, data: { ready: true } });
    callbacks.get('web:bridge-reply')(f.event(), { requestId: payload.requestId, ok: true, data: admissionReply });
  };
  const automatic = { tabId: 'T', source: 'prompt-queue', provider: 'codex',
    promptQueueIntent: { version: 1, kind: 'queue', itemId: 'I', armedAt: 1, triggerTabId: 'T', conditionKey: '', triggerKey: 'null' } };
  whole.setStatus({ status: 'active', inputReady: true, busy: false });
  assert.equal(await whole.admit(automatic), true);
  whole.setStatus({ status: 'busy', inputReady: true, busy: true });
  assert.equal(await whole.admit(automatic), false);
  admissionReply = { ready: false }; whole.setStatus({ status: 'active', inputReady: true });
  assert.equal(await whole.admit(automatic), false);
  admissionReply = { cancel: true };
  assert.equal((await whole.admit(automatic)).cancel, true);
  const before = readCount;
  assert.equal(await whole.admit({ ...automatic, promptQueueAction: 'send-now' }), true);
  assert.equal(readCount, before, 'explicit Send now retains steering and does not enter the automatic idle gate');
  const wakes = [];
  whole.setQueue({ notifyRuntime: tab => wakes.push(tab) });
  cjs.exports.webBroadcast('T', { type: 'queue-update', queue: { items: [], autoRun: true }, runAfter: { viewRevision: 1 } });
  cjs.exports.webBroadcast('T', { type: 'queue-update', queue: { items: [], autoRun: true }, runAfter: { viewRevision: 2 } });
  assert.deepEqual(wakes, ['T'], 'a receipt-only metadata publication cannot retry its own parked attempt');
  cjs.exports.webBroadcast('T', { type: 'queue-update', queue: { items: [], autoRun: false } });
  assert.deepEqual(wakes, ['T', 'T']);
  const { OrchestrationRunStore } = require('./orchestration-runs');
  const settingsPath = path.join(path.dirname(f.db.db.name), 'private-capacity-settings.json');
  const capacityStore = new OrchestrationRunStore(settingsPath);
  whole.setCapacityStore(capacityStore);
  const defaults = await request('/api/orchestrations/settings');
  assert.deepEqual(defaults.value.settings.codexCapacityRetryDelaysMs, [1800000, 3600000]);
  assert.equal((await request('/api/orchestrations/settings', { codexCapacityRetryDelaysMs: [2700000, 5400000] })).status, 200);
  await request('/api/orchestrations/settings', { failureGraceMs: 1234 });
  await capacityStore.flush();
  const restored = new OrchestrationRunStore(settingsPath);
  assert.deepEqual((await restored.getSettings()).codexCapacityRetryDelaysMs, [2700000, 5400000]);
  const removed = await request('/api/orchestrations/settings', { codexCapacityRetryDelaysMs: [] });
  assert.deepEqual(removed.value.settings.codexCapacityRetryDelaysMs, []);
  await capacityStore.flush();
  const pending = api.journal.reserve('old-journal-ticket', 'T', { op: 'add', args: { text: 'pending' } }, api.scope('T')).ticket;
  assert.equal(api.journal.authorize(pending).phase, 'pending');
  whole.setQueue(null);
  await cjs.exports.stop();
  const nextHandshake = await request('/api/me');
  assert.equal(nextHandshake.status, 200);
  assert.equal(nextHandshake.value.service.instanceId, handshake.value.service.instanceId);
  assert.notEqual(nextHandshake.value.capabilities.runAfter.mainEpoch, handshake.value.capabilities.runAfter.mainEpoch);
  assert.equal(nextHandshake.value.capabilities.runAfter.mainEpoch, whole.api().journal.epoch);
  assert.throws(() => whole.api().journal.authorize(pending), /run_after_operation_stale/);
  assert.equal(whole.api().journal.read(pending.operationId).phase, 'unknown');
});

test('unenveloped legacy GET/POST still use the actual App owner, including preserved remote pause and Rewind ordinal',async t=>{
  const f=await fixture(t); const route='/api/terminal-tabs/T/queue';
  const add=await f.request(route,{op:'add',args:{text:'legacy'}});assert.equal(add.status,200,JSON.stringify(add.value));
  assert.equal(add.value.runAfter,undefined);assert.equal(add.value.queue.items.length,1);
  await f.request(route,{op:'setFirstDelaySeconds',args:{value:100}});
  await f.request(route,{op:'setAutoRun',args:{value:true}});f.state().startFirstDelayCountdown('T');f.time(41000);
  const pause=await f.request(route,{op:'setAutoRun',args:{value:false}});assert.equal(pause.value.queue.firstDelaySeconds,60);
  const added=await f.request(route,{op:'addAction',args:{kind:'rewind',toolType:'codex',sourceSessionId:'S',targetUuid:'exact',targetText:'private',targetIteration:7}});
  assert.equal(added.value.queue.items[1].metaAction.targetIteration,7);
  assert.equal((await f.request(route)).value.queue.items.length,2);assert.equal(f.dispatched.length,0);
});

test('actual HTTP → bridge → existing store/SQLite: add, CAS, same-ID replay and typed unstarted inventory', async t => {
  const f = await fixture(t), initial = await f.read();
  assert.equal(initial.status, 200, JSON.stringify(initial.value));
  assert.ok(initial.value.aiTabs.some(tab => tab.id === 'fresh'));
  assert.ok(initial.value.aiTabs.some(tab => tab.id === 'gemini'));
  assert.ok(!initial.value.aiTabs.some(tab => tab.id === 'child' || tab.id === 'file'));
  const added = await f.mutate('add', { text: 'first' }, { snapshot: initial.value, operationId: 'one' });
  assert.equal(added.status, 200, JSON.stringify(added.value));
  assert.equal(added.value.operation.committed, true); assert.equal(f.state().getQueue('T').autoRun, false);
  assert.equal(f.db.getAppState('promptQueueByTab').T.items.length, 1);
  const replay = await f.request('/api/terminal-tabs/T/queue', added.body);
  assert.equal(replay.status, 200); assert.equal(f.state().getQueue('T').items.length, 1);
  const stale = await f.mutate('add', { text: 'must not add' }, { snapshot: initial.value });
  assert.equal(stale.status, 409); assert.equal(stale.value.operation.phase, 'rejected');
  const conflict = await f.request('/api/terminal-tabs/T/queue', { ...added.body, args: { text: 'different' } });
  assert.equal(conflict.status, 409); assert.equal(f.state().getQueue('T').items.length, 1);
  assert.equal(f.dispatched.length, 0);
});

test('timer pause and per-item trigger/condition edits use the same owners; no fake completion', async t => {
  const f = await fixture(t), added = await f.mutate('add', { text: '/compact' });
  const id = added.value.operation.result.itemId;
  assert.equal(f.state().getQueue('T').items[0].condition.percent, 50);
  await f.mutate('setCondition', { id, value: null }); await f.mutate('update', { id, text: '/compact with note' });
  assert.equal(f.state().getQueue('T').items[0].condition, undefined);
  await f.mutate('setTrigger', { id, trigger: { kind: 'timer', seconds: 7200 } });
  assert.equal(f.state().getQueue('T').autoRun, false);
  await f.mutate('setAutoRun', { value: true }); f.state().startFirstDelayCountdown('T'); f.time(41000);
  const paused = await f.mutate('setAutoRun', { value: false }); assert.equal(paused.status, 200, JSON.stringify(paused.value));
  assert.equal(f.state().getQueue('T').items[0].trigger.seconds, 7160);
  assert.equal(f.state().getQueue('T').firstDelayCountdownAt, null); assert.equal(f.dispatched.length, 0);
  await f.mutate('setTrigger', { id, trigger: { kind: 'onTab', tabId: 'fresh' } });
  assert.equal(f.state().getQueue('T').autoRun, true);
  await f.mutate('clearTrigger', { id }); assert.equal(f.state().getQueue('T').autoRun, false);
  await f.mutate('setTrigger', { id, trigger: { kind: 'app-restart' } });
  assert.equal(f.state().getQueue('T').items[0].trigger.armedInstanceId, 'application-A');
});

test('multi-tab wait roundtrips through the existing API; clients cannot submit fabricated completion progress', async t => {
  const f = await fixture(t), added = await f.mutate('add', { text: 'WAIT ALL' });
  const id = added.value.operation.result.itemId;
  const set = await f.mutate('setTrigger', { id, trigger: { kind: 'onTab', tabId: 'fresh',
    dependencies: [{ tabId: 'fresh', armedAt: 0, completedAt: 99999 }, { tabId: 'claude', armedAt: 0, completedAt: 99999 }] } });
  assert.equal(set.status, 200, JSON.stringify(set.value));
  const stored = f.state().getQueue('T').items[0].trigger;
  assert.equal(stored.dependencies.length, 2);
  assert.equal(stored.dependencies.some(dep => dep.completedAt !== undefined), false);
  assert.equal(f.state().getQueue('T').autoRun, true);
  const seen = (await f.read()).value.queue.items[0].trigger;
  assert.equal(seen.dependencies.length, 2);
  const invalid = await f.mutate('setTrigger', { id, trigger: { kind: 'onTab', tabId: 'fresh', dependencies: [{ tabId: 'missing' }] } });
  assert.equal(invalid.status, 400);
  assert.equal(f.state().getQueue('T').items[0].trigger.dependencies.length, 2);
  f.state().completePromptTabDependency('T', id, 'fresh', stored.dependencies[0].armedAt + 1);
  const partial = (await f.read()).value.queue.items[0].trigger;
  assert.equal(partial.dependencies[0].completedAt !== undefined, true);
  assert.equal(partial.dependencies[1].completedAt, undefined);
  await f.owners.persistPromptQueueDeliveryPointer();
  assert.equal(f.db.getAppState('promptQueueByTab').T.items[0].trigger.dependencies[0].completedAt,
    partial.dependencies[0].completedAt, 'partial progress belongs to the existing SQLite queue owner');
  assert.equal(f.dispatched.length, 0);
});

test('existing editor lock blocks another writer, paired action update preserves ordering/title and rewind ordinal', async t => {
  const f = await fixture(t);
  const added = await f.mutate('addAction', { kind: 'restart' }); const id = added.value.operation.result.itemId;
  const edit = await f.mutate('beginEdit', { id }); assert.equal(edit.status, 200);
  const token = edit.value.operation.result.editorToken;
  const blocked = await f.mutate('remove', { id }); assert.equal(blocked.status, 423);
  const updated = await f.mutate('updateAction', { id, action: { kind: 'model-effort', toolType: 'codex', model: 'private-model', effort: 'max' } }, { editorToken: token });
  assert.equal(updated.status, 200, JSON.stringify(updated.value));
  assert.equal(f.state().getQueue('T').items[0].metaAction.effort, 'max');
  await f.mutate('endEdit', {}, { editorToken: token }); assert.equal(f.owners.getPromptQueueEditorLock('T'), null);
  const bad = await f.mutate('updateAction', { id, action: { kind: 'model-effort', toolType: 'codex', model: 'private-model', effort: 'unknown' } });
  assert.equal(bad.status, 422);
  const rewind = await f.mutate('updateAction', { id, action: { kind: 'rewind', toolType: 'codex', sourceSessionId: 'S', targetUuid: 'exact', targetText: 'source', targetIteration: 23 } });
  assert.equal(rewind.status, 200); assert.equal(f.state().getQueue('T').items[0].metaAction.targetIteration, 23);
  assert.equal((await f.mutate('replay', { id })).status, 422);
});

test('Replay stores the complete draft before consume, no Enter; explicit Send-now ignores Post and scheduling', async t => {
  const f = await fixture(t);
  const added = await f.mutate('add', { text: 'body [Prompt #p]', chips: [{ id: 'p', kind: 'prompt', text: 'opaque instructions', label: 'Saved' }] });
  const id = added.value.operation.result.itemId;
  await f.mutate('setPostPromptText', { value: 'POST suffix' }); await f.mutate('setPostPromptEnabled', { value: true });
  const replay = await f.mutate('replay', { id }); assert.equal(replay.status, 200, JSON.stringify(replay.value));
  assert.equal(replay.value.operation.result.draft.chips[0].text, 'opaque instructions');
  assert.equal(replay.value.operation.result.submitted, false); assert.equal(f.state().getQueue('T').items.length, 0);
  assert.equal(f.dispatched.length, 0);
  const second = await f.mutate('add', { text: 'chosen' }); const secondId = second.value.operation.result.itemId;
  await f.mutate('setTrigger', { id: secondId, trigger: { kind: 'timer', seconds: 999 } });
  const sent = await f.mutate('sendNow', { id: secondId }); assert.equal(sent.status, 200, JSON.stringify(sent.value));
  assert.equal(f.dispatched.length, 1); assert.equal(f.dispatched[0].item.text, 'chosen');
  assert.equal(f.state().getQueue('T').items.length, 0);
  await f.request('/api/terminal-tabs/T/queue', sent.body); assert.equal(f.dispatched.length, 1);
});

test('quick Compact has atomic busy auto-arm; global Loop updates the canonical prompt owner', async t => {
  const f = await fixture(t); f.busy(true);
  const quick = await f.mutate('quickCompact', {}); assert.equal(quick.status, 200, JSON.stringify(quick.value));
  assert.equal(quick.value.operation.result.autoArmed, true); assert.equal(f.state().getQueue('T').autoRun, true);
  assert.equal(f.state().getQueue('T').items[0].condition.percent, 50);
  const loop = await f.mutate('setLoopPromptText', { value: 'new shared instruction' });
  assert.equal(loop.status, 200, JSON.stringify(loop.value));
  assert.equal(f.systemPromptService.get('run-after-loop').content, 'new shared instruction');
  assert.equal(f.state().getQueue('T').loopPromptText, 'new shared instruction');
  assert.equal(f.dispatched.length, 0);
});

test('quick Compact with unknown runtime still stages the existing card and never invents busy/off proof',async t=>{
  const f=await fixture(t);f.ports.ownerBusyProof=async()=>({known:false,error:'private-runtime-unknown'});
  const result=await f.mutate('quickCompact',{});
  assert.equal(result.status,200);assert.equal(result.value.operation.result.autoArmed,false);
  assert.equal(result.value.operation.result.ownerProof.known,false);
  assert.equal(f.state().getQueue('T').items[0].condition.percent,50);
  assert.equal(f.state().getQueue('T').autoRun,false);assert.equal(f.dispatched.length,0);
});

test('actual global overview is metadata only; AutoCompact policy uses existing store, guards and bounds', async t => {
  const f = await fixture(t); await f.mutate('add', { text: 'SECRET_QUEUE_BODY' });
  const overview = await f.request('/api/run-after'); assert.equal(overview.status, 200, JSON.stringify(overview.value));
  assert.equal(JSON.stringify(overview.value).includes('SECRET_QUEUE_BODY'), false);
  assert.ok(overview.value.stagedTabIds.includes('T'));
  const policy = (await f.request('/api/run-after/auto-compact')).value;
  assert.equal(policy.policy.enabled, false); assert.equal(policy.policy.percent, 50);
  const body = { op: 'updatePolicy', args: { patch: { enabled: true, scopeInitialized: true, workflowIds: ['W'], percent: 70 } },
    runAfter: { version: 1, operationId: 'policy-one', expected: policy.guard } };
  const enabled = await f.request('/api/run-after/auto-compact', body); assert.equal(enabled.status, 200, JSON.stringify(enabled.value));
  assert.equal(f.owners.useAutoCompactStore.getState().policy.percent, 70);
  assert.equal(f.db.getAppState('globalAutoCompact').enabled, true);
  const stale = await f.request('/api/run-after/auto-compact', { ...body, runAfter: { ...body.runAfter, operationId: 'policy-stale' } });
  assert.equal(stale.status, 409); assert.equal(f.dispatched.length, 0);
});

test('durable image occurrences survive temp deletion, Replay and GC; same names/paths never guess bytes', async t => {
  const f=await fixture(t), png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=','base64');
  const folder1=path.join(f.uploadRoot,'upload-one'),folder2=path.join(f.uploadRoot,'upload-two');
  fs.mkdirSync(folder1);fs.mkdirSync(folder2);
  const source1=path.join(folder1,'same.png'),source2=path.join(folder2,'same.png');
  fs.writeFileSync(source1,png);fs.writeFileSync(source2,Buffer.concat([png,Buffer.from('different owned bytes')]));
  const importHandle=f.assetStore.importUploadHandle.bind(f.assetStore);let imports=0;
  f.assetStore.importUploadHandle=async(...args)=>{
    const result=await importHandle(...args);
    if(++imports===1)fs.writeFileSync(source1,Buffer.concat([png,Buffer.from('changed after capture')]));
    return result;
  };
  const added=await f.mutate('add',{text:'[Image #1] [Image #2] [Image #3]',images:3,imagePaths:[
    {id:1,path:source1,mediaType:'image/png',size:png.length},
    {id:2,path:source1,mediaType:'image/png',size:png.length},
    {id:3,path:source2,mediaType:'image/png',size:png.length},
  ]});
  assert.equal(added.status,200,JSON.stringify(added.value));
  const item=f.state().getQueue('T').items[0],refs=item.imagePaths;
  assert.equal(refs.length,3);assert.equal(refs[0].assetId,refs[1].assetId);assert.notEqual(refs[0].assetId,refs[2].assetId);
  assert.equal(imports,2,'same upload is captured once despite repeated occurrences');
  assert.equal(refs[0].sourcePath,source1);assert.ok(refs.every(ref=>fs.existsSync(ref.path)));
  fs.unlinkSync(source1);fs.unlinkSync(source2);
  const replayAdd=await f.request('/api/terminal-tabs/T/queue',added.body);
  assert.equal(replayAdd.status,200);assert.equal(f.state().getQueue('T').items.length,1);
  let gcNow=Date.now()+35*24*60*60*1000;f.assetStore.now=()=>gcNow;
  const kept=await f.assetStore.garbageCollect(collectReferencedAssetIds(f.db.getAppState('promptQueueByTab')));
  assert.equal(kept.removed.length,0);
  const draft=await f.mutate('replay',{id:item.id});assert.equal(draft.status,200,JSON.stringify(draft.value));
  assert.equal(draft.value.operation.result.draft.imagePaths.length,3);
  assert.equal(f.state().getQueue('T').items.length,0);
  gcNow+=35*24*60*60*1000;
  const retained=await f.assetStore.garbageCollect(f.api.journal.referencedAssetIds());assert.equal(retained.removed.length,0);
  const released=await f.request('/api/run-after/operations/'+draft.value.operation.operationId+'/release',{tabId:'T'});
  assert.equal(released.status,200);assert.equal(released.value.operation.released,true);
  const collected=await f.assetStore.garbageCollect(f.api.journal.referencedAssetIds());assert.equal(collected.removed.length,2);
  assert.equal(f.dispatched.length,0);
});

test('foreign image refs and unsupported per-prompt flags fail before any store mutation', async t => {
  const f=await fixture(t);
  const foreign=path.join(path.dirname(f.uploadRoot),'outside.png');fs.writeFileSync(foreign,'not upload authority');
  const denied=await f.mutate('add',{text:'[Image #1]',imagePaths:[{id:1,path:foreign,mediaType:'image/png'}]});
  assert.equal(denied.status,403,JSON.stringify(denied.value));assert.equal(denied.value.operation.phase,'rejected');
  for(const field of ['fast','thinking','repeatCount','cron']){
    const response=await f.mutate('add',{text:'no', [field]:true});
    assert.equal(response.status,400);assert.equal(response.value.mutationOutcome,'not-started');
  }
  assert.equal(f.state().getQueue('T').items.length,0);assert.equal(f.dispatched.length,0);
});

test('a main scope change while preparing is rejected before mutation; reorder uses exact order and revision', async t => {
  const f=await fixture(t), entered=deferred(),release=deferred();
  f.ports.prepareAuthoring=async value=>{entered.resolve();await release.promise;return value};
  const pending=f.mutate('add',{text:'must not enter a changed owner'});await entered.promise;
  f.scopeChange();release.resolve();const result=await pending;
  assert.equal(result.status,409,JSON.stringify(result.value));assert.equal(result.value.operation.phase,'rejected');
  assert.equal(f.state().getQueue('T').items.length,0);
  f.ports.prepareAuthoring=f.helpers.authoring;
  const first=await f.mutate('add',{text:'first'}),second=await f.mutate('add',{text:'second'});
  const snapshot=(await f.read()).value;
  f.state().reorderPrompt('T',0,1);
  const stale=await f.mutate('reorder',{fromIndex:0,toIndex:1},{snapshot});assert.equal(stale.status,409);
  assert.deepEqual(Array.from(f.state().getQueue('T').items,row=>row.id),[second.value.operation.result.itemId,first.value.operation.result.itemId]);
});

test('lost HTTP response leaves one operation; late exact commit and same-ID GET never dispatch again', async t => {
  const f=await fixture(t);const first=await f.mutate('add',{text:'one explicit send'});
  const guard=(await f.read()).value;
  const hold=f.hold(),done=deferred(),commit=f.ports.commit;
  f.ports.commit=async(...args)=>{const value=await commit(...args);done.resolve();return value};
  const bridge=f.webContext.bridgeRequest;
  f.webContext.bridgeRequest=(action,payload)=>bridge(action,payload,10);
  const sent=await f.mutate('sendNow',{id:first.value.operation.result.itemId},{snapshot:guard,operationId:'lost-ack'});
  assert.equal(sent.status,202,JSON.stringify(sent.value));assert.equal(sent.value.operation.phase,'unknown');
  assert.equal(f.dispatched.length,0);
  hold.resolve();await done.promise;
  const receipt=await f.request('/api/run-after/operations/lost-ack');assert.equal(receipt.value.operation.phase,'applied');
  assert.equal(f.dispatched.length,1);f.scopeChange();
  const same=await f.request('/api/terminal-tabs/T/queue',sent.body);assert.equal(same.status,200);
  assert.equal(f.dispatched.length,1);assert.equal(f.state().getQueue('T').items.length,0);
});

test('global graph keeps SDK/Gemini dependency identity without pretending they execute RunAfter', async t => {
  const f=await fixture(t), added=await f.mutate('add',{text:'after Gemini'});
  await f.mutate('setTrigger',{id:added.value.operation.result.itemId,trigger:{kind:'onTab',tabId:'gemini'}});
  const overview=(await f.request('/api/run-after')).value;
  assert.ok(overview.dependencies.some(edge=>edge.source==='T'&&edge.target==='gemini'));
  assert.equal(overview.dependencyTargets.find(tab=>tab.id==='gemini').kind,'gemini');
  assert.equal((await f.read('sdk')).status,422);assert.equal((await f.read('file')).status,422);
  assert.equal(f.dispatched.length,0);
});

test('provider catalog validates exact pairs; unavailable Claude proxy does not become subscription support', async t => {
  const f=await fixture(t);
  const catalog=await f.request('/api/terminal-tabs/T/queue?runAfter=1&includeActions=1');
  assert.equal(catalog.status,200);assert.equal(catalog.value.runAfter.mainEpoch,f.api.journal.epoch);
  assert.ok(catalog.value.actions.models.find(model=>model.id==='private-model').efforts.includes('max'));
  f.providerType('zen');
  const claude=await f.request('/api/terminal-tabs/claude/queue?runAfter=1&includeActions=1');
  assert.equal(claude.value.actions.modelEffortSupported,false);assert.equal(claude.value.actions.models.length,0);
  const action=await f.mutate('addAction',{kind:'model-effort',toolType:'claude',model:'opus',effort:'high'},{tabId:'claude'});
  assert.equal(action.status,422);assert.equal(f.state().getQueue('claude').items.length,0);
});

test('actual Main quick-Compact proof is same-owner, coherent and preserves only proven Resume aliases',async t=>{
  const f=await fixture(t);
  vm.runInContext(declaration(webTree,'runAfterOwnerBusyProof'),f.webContext);
  let snapshot={coherent:true,toolType:'codex',status:'busy',processStatus:'found',lifecycleGeneration:'G',
    sendTarget:{toolType:'codex',sessionId:'S',terminalInstanceId:'P',launchId:'L'}};
  f.webContext.readAgentRuntimeSnapshot=async()=>snapshot;
  const scope={provider:'codex',configuredSessionId:'S'};
  const saved={frame:f.api.frameSnapshot(),scopeKey:f.api.scopeKey('T')};
  const admitted=f.api.journal.reserve('busy-proof','T',{op:'quickCompact'},saved);
  const input={tabId:'T',scope,ticket:admitted.ticket};
  assert.equal((await f.webContext.runAfterOwnerBusyProof(f.event(),input)).busy,true);
  snapshot={...snapshot,sendTarget:{...snapshot.sendTarget,sessionId:'child',acceptedResumeSourceSessionId:'S'}};
  assert.equal((await f.webContext.runAfterOwnerBusyProof(f.event(),input)).known,true);
  snapshot={...snapshot,sendTarget:{...snapshot.sendTarget,sessionId:'foreign',acceptedResumeSourceSessionId:null}};
  assert.equal((await f.webContext.runAfterOwnerBusyProof(f.event(),input)).known,false);
  snapshot={...snapshot,status:'inactive',processStatus:'absent',sendTarget:null};
  const stopped=await f.webContext.runAfterOwnerBusyProof(f.event(),input);
  assert.equal(stopped.known,true);assert.equal(stopped.busy,false);assert.equal(stopped.sessionId,null);
  snapshot={...snapshot,status:'busy',processStatus:'unknown'};
  assert.equal((await f.webContext.runAfterOwnerBusyProof(f.event(),input)).known,false);
  f.scopeChange();await assert.rejects(f.webContext.runAfterOwnerBusyProof(f.event(),input),/scope_changed/);
  assert.equal(f.dispatched.length,0);
});

test('transaction/storage failure after owner mutation remains unknown and never reports no-write',async t=>{
  const f=await fixture(t),commit=f.ports.commit;
  f.ports.commit=async()=>{throw Error('controlled commit acknowledgement loss')};
  const added=await f.mutate('add',{text:'uncertain mutation'},{operationId:'uncertain'});
  assert.equal(added.status,202);assert.equal(added.value.operation.phase,'unknown');
  assert.equal(f.state().getQueue('T').items.length,1);
  const duplicate=await f.request('/api/terminal-tabs/T/queue',added.body);
  assert.equal(duplicate.status,202);assert.equal(f.state().getQueue('T').items.length,1);
  f.ports.commit=commit;
  const created=await f.mutate('add',{text:'explicit later operation'});assert.equal(created.status,200);
  const id=created.value.operation.result.itemId;
  f.ports.sendNow=async()=>{throw Error('controlled transport unknown')};
  const originalUnknown=f.api.journal.unknown.bind(f.api.journal);
  f.api.journal.unknown=()=>{throw Error('controlled journal disk failure')};
  const send=await f.mutate('sendNow',{id},{operationId:'unknown-disk'});
  assert.equal(send.status,503);assert.equal(send.value.mutationOutcome,'unknown');assert.equal(send.value.operationId,'unknown-disk');
  f.api.journal.unknown=originalUnknown;
});

test('GET is revision-bound through metadata wakes; replaced renderer and a restarted Main reject stale admission',async t=>{
  const f=await fixture(t),old=(await f.read()).value;
  const added=await f.mutate('add',{text:'new revision'}); const latest=(await f.read()).value;
  assert.ok(latest.runAfter.revision>old.runAfter.revision);
  assert.equal(old.queue.items.length,0,'an old response is never relabelled with the new revision');
  const bridge=f.api.bridge,entered=deferred(),release=deferred();
  f.api.bridge=async(...args)=>{const value=await bridge(...args);entered.resolve();await release.promise;return value};
  const pending=f.read();await entered.promise;
  f.sender.mainFrame={processId:6,routingId:12};release.resolve();
  const rejected=await pending;assert.equal(rejected.status,409);assert.equal(rejected.value.error,'run_after_scope_changed');
  f.api.bridge=bridge;
  const next=f.restartMain();const restarted=(await f.read()).value;
  assert.notEqual(restarted.runAfter.epoch,latest.runAfter.epoch);
  const stale=await f.mutate('clear',{}, {snapshot:latest});assert.equal(stale.status,409);
  const replay=await f.request('/api/terminal-tabs/T/queue',added.body);
  assert.equal(replay.status,200);assert.equal(next.journal.read(added.body.runAfter.operationId).committed,true);
  assert.equal(f.state().getQueue('T').items.length,1);assert.equal(f.dispatched.length,0);
  f.sender.isDestroyed=()=>true;
  assert.equal((await f.read()).status,503,'renderer absence is explicit, not an empty queue');
});

test('actual metadata IPC and existing 80ms Main scheduler coalesce into one lightweight project wake',async t=>{
  const f=await fixture(t); const timers=[],frames=[];
  Object.assign(f.webContext,{runAfterWakeRevision:0,runAfterMetadataVersions:new Map(),
    publicTabActivity:null,computeProjectActivity:()=>({projects:[]}),workspaceSwitcherWake:()=>({version:1,revision:0}),
    stampPublicRuntimeSnapshot:(_id,value)=>value});
  for(const name of ['projectRunAfterMetadata','noteRunAfterWake','runAfterWake','projectActivitySnapshot']) {
    vm.runInContext(declaration(webTree,name),f.webContext);
  }
  const mainSource=fs.readFileSync(path.join(__dirname,'main.js'),'utf8'),mainTree=tree('main.js',mainSource);
  const main=vm.createContext({path,srcMainDir:__dirname,projectActivityBroadcastTimer:null,projectLayoutChangedIds:new Set(),projectOrderChanged:false,projectCardSignals:null,
    setTimeout:(callback,ms)=>{assert.equal(ms,80);timers.push(callback);return callback},require:()=>({invalidateTabActivity(){},
      broadcastProjectActivity:reason=>frames.push(f.webContext.projectActivitySnapshot(reason))})});
  vm.runInContext(declaration(mainTree,'scheduleProjectActivityBroadcast'),main);
  f.webContext.scheduleTabActivityBroadcast=main.scheduleProjectActivityBroadcast;
  const before=(await f.read()).value;
  const initial=f.webContext.projectRunAfterMetadata(f.event(),{tabId:'T',queue:before.queue,runAfter:before.runAfter});
  assert.equal(initial.guard.mainScopeKey,before.runAfter.guard.mainScopeKey);
  for(let i=0;i<4;i++) {
    f.state().addPrompt('T','not in the wake '+i);
    const snapshot=(await f.read()).value;
    f.webContext.projectRunAfterMetadata(f.event(),{tabId:'T',queue:snapshot.queue,runAfter:snapshot.runAfter});
  }
  assert.equal(timers.length,1);timers.shift()();assert.equal(frames.length,1);
  assert.equal(frames[0].runAfter.sequence,5);assert.equal(frames[0].runAfter.revalidate,true);
  assert.ok(Buffer.byteLength(JSON.stringify(frames[0].runAfter))<180);
  assert.equal(JSON.stringify(frames[0]).includes('not in the wake'),false);
  assert.equal(f.webContext.noteRunAfterWake({sender:{id:99},senderFrame:f.sender.mainFrame},{epoch:before.runAfter.epoch}),false);
  assert.equal(f.webContext.noteRunAfterWake(f.event(),{epoch:'old-main:renderer'}),false);
  f.sender.isDestroyed=()=>true;
  assert.equal(f.webContext.projectRunAfterMetadata(f.event(),{tabId:'T',queue:before.queue,runAfter:before.runAfter}),null);
  assert.equal(f.dispatched.length,0);
});

test('AutoCompact CAS is rechecked after scope validation; a remote write cannot overwrite a newer desktop policy',async t=>{
  const f=await fixture(t),policy=(await f.request('/api/run-after/auto-compact')).value;
  const validate=f.ports.validateScope;
  f.ports.validateScope=async ticket=>{await validate(ticket);f.owners.useAutoCompactStore.getState().updatePolicy({percent:71})};
  const result=await f.request('/api/run-after/auto-compact',{op:'updatePolicy',args:{patch:{percent:64}},
    runAfter:{version:1,operationId:'policy-race',expected:policy.guard}});
  assert.equal(result.status,409);assert.equal(result.value.operation.result.error,'run_after_policy_conflict');
  assert.equal(f.owners.useAutoCompactStore.getState().policy.percent,71);assert.equal(f.dispatched.length,0);
});

test('owned image version survives source replace/delete and Main restart; failed copy releases no foreign lease',async t=>{
  const f=await fixture(t);const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7WQAAAAASUVORK5CYII=','base64');
  const uploadDir=path.join(f.uploadRoot,'private-upload');fs.mkdirSync(uploadDir);
  const upload=path.join(uploadDir,'version.png');fs.writeFileSync(upload,png);
  const first=await f.mutate('add',{text:'[Image #1]',imagePaths:[{id:1,path:upload,mediaType:'image/png'}]});
  assert.equal(first.status,200);const ref=f.state().getQueue('T').items[0].imagePaths[0];
  fs.writeFileSync(upload,Buffer.concat([png,Buffer.from('version B')]));
  const retained=await f.mutate('add',{text:'[Image #1]',imagePaths:[{...ref,path:ref.path}]});
  assert.equal(retained.status,200);assert.equal(f.state().getQueue('T').items[1].imagePaths[0].assetId,ref.assetId);
  assert.deepEqual(fs.readFileSync(ref.path),png);fs.unlinkSync(upload);
  const api=f.restartMain();const repeated=await f.request('/api/terminal-tabs/T/queue',first.body);
  assert.equal(repeated.status,200);assert.equal(f.state().getQueue('T').items.length,2);
  assert.ok(collectReferencedAssetIds(f.db.getAppState('promptQueueByTab')).has(ref.assetId));
  const lease=await f.assetStore.lease(ref.assetId),importer=f.assetStore.importUploadHandle;
  fs.writeFileSync(upload,png);f.assetStore.importUploadHandle=async()=>{throw Object.assign(Error('private copy failure'),{code:'private_copy_failure'})};
  const failed=await f.mutate('add',{text:'[Image #1]',imagePaths:[{id:1,path:upload,mediaType:'image/png'}]});
  assert.equal(failed.status,503);assert.equal(failed.value.operation.phase,'rejected');
  assert.equal(f.state().getQueue('T').items.length,2);assert.equal(f.dispatched.length,0);
  f.assetStore.importUploadHandle=importer;f.assetStore.now=()=>Date.now()+40*24*60*60*1000;
  const gc=await f.assetStore.garbageCollect(api.journal.referencedAssetIds());assert.equal(gc.removed.length,0,'foreign lease still owns bytes');lease();
});

test('explicit AutoCompact pins its selected tab; its own Resume may settle a historical result without another action',async t=>{
  const f=await fixture(t),policy=(await f.request('/api/run-after/auto-compact')).value;
  const target=(await f.read()).value;
  const body={op:'requestNow',args:{tabId:'T',resume:true,targetGuard:target.runAfter.guard},
    runAfter:{version:1,operationId:'compact-pinned',expected:policy.guard}};
  f.scopeChange();const stale=await f.request('/api/run-after/auto-compact',body);
  assert.equal(stale.status,409);assert.equal(stale.value.mutationOutcome,'not-started');
  body.args.targetGuard=(await f.read()).value.runAfter.guard;
  let requests=0;f.ports.requestAutoCompact=async(tabId,resume)=>{requests++;assert.equal(tabId,'T');assert.equal(resume,true);
    f.scopeChange();return {completed:true}};
  const result=await f.request('/api/run-after/auto-compact',body);
  assert.equal(result.status,200,JSON.stringify(result.value));assert.equal(result.value.operation.result.outcome.completed,true);
  assert.ok(result.value.operation.executionAdmittedAt);assert.equal(requests,1);
  await f.request('/api/run-after/auto-compact',body);assert.equal(requests,1);
});

test('explicit Send-now historical settlement survives its own first-binding change; authoring writes still require current scope',async t=>{
  const f=await fixture(t),added=await f.mutate('add',{text:'first scoped Send'}),id=added.value.operation.result.itemId;
  f.ports.sendNow=async()=>{f.scopeChange();return {submitted:true,success:true}};
  const sent=await f.mutate('sendNow',{id});assert.equal(sent.status,200,JSON.stringify(sent.value));
  assert.ok(sent.value.operation.executionAdmittedAt);assert.equal(sent.value.current,undefined,'historical completion is not current-scope metadata');
  assert.equal(f.state().getQueue('T').items.length,0);
  assert.equal(f.db.getAppState('promptQueueByTab').T?.items.length??0,0);
  const commit=f.ports.commit;f.ports.commit=async(...args)=>{f.scopeChange();return commit(...args)};
  const editing=await f.mutate('add',{text:'changed while persisting'});
  assert.equal(editing.status,202);assert.equal(editing.value.operation.phase,'unknown');
  assert.equal(editing.value.operation.executionAdmittedAt,null);
});

test('AutoCompact cancellation addresses one current activity, not a replacement task in the same tab',async t=>{
  const f=await fixture(t);let cancelled=0;
  f.ports.cancelAutoCompact=()=>{cancelled++;return true};
  f.owners.useAutoCompactStore.getState().setActivity('T',{phase:'waiting',message:'same phase',handoffId:'task-A'});
  const policy=(await f.request('/api/run-after/auto-compact')).value,target=(await f.read()).value;
  f.owners.useAutoCompactStore.getState().setActivity('T',{phase:'waiting',message:'same phase',handoffId:'task-B'});
  const body={op:'cancel',args:{tabId:'T',targetGuard:target.runAfter.guard,activityId:'task-A'},
    runAfter:{version:1,operationId:'cancel-old',expected:policy.guard}};
  const stale=await f.request('/api/run-after/auto-compact',body);assert.equal(stale.status,409);assert.equal(cancelled,0);
  const fresh=await f.request('/api/run-after/auto-compact',{...body,args:{...body.args,activityId:'task-B'},
    runAfter:{...body.runAfter,operationId:'cancel-current'}});
  assert.equal(fresh.status,200);assert.equal(fresh.value.operation.result.cancelled,true);assert.equal(cancelled,1);
});

test('checked decoder wire includes owned preview and full Replay, never a path-based preview capability',async t=>{
  const f=await fixture(t),folder=path.join(f.uploadRoot,'wire-upload');fs.mkdirSync(folder);
  const image=path.join(folder,'wire.png'),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7WQAAAAASUVORK5CYII=','base64');fs.writeFileSync(image,png);
  const add=await f.mutate('add',{text:'draft [Image #1] [Prompt #p]',chips:[{id:'p',kind:'prompt',text:'retained instruction',label:'Owned chip'}],
    imagePaths:[{id:1,path:image,mediaType:'image/png',size:png.length}]});
  assert.equal(add.status,200);const id=add.value.operation.result.itemId;
  await f.mutate('setTrigger',{id,trigger:{kind:'timer',seconds:7200}});
  const snapshot=(await f.request('/api/terminal-tabs/T/queue?runAfter=1&includeActions=1')).value;
  fs.unlinkSync(image);
  const preview=await f.request('/api/run-after/image-preview',{assetId:snapshot.queue.items[0].imagePaths[0].assetId,variant:'detail'});
  assert.equal(preview.status,200,JSON.stringify(preview.value));assert.equal(preview.value.dataUrl,'data:image/png;base64,'+png.toString('base64'));
  assert.equal(preview.value.variant,'detail');
  const foreign=await f.request('/api/run-after/image-preview',{assetId:snapshot.queue.items[0].imagePaths[0].assetId,path:'/not-owned'});
  assert.equal(foreign.status,400);
  const overview=(await f.request('/api/run-after')).value,policy=(await f.request('/api/run-after/auto-compact')).value;
  const replay=await f.mutate('replay',{id});assert.equal(replay.status,200);
  const stale=await f.mutate('remove',{id},{snapshot});assert.equal(stale.status,409);
  if(process.env.NOTED_RUN_AFTER_EVIDENCE)fs.writeFileSync(path.join(process.env.NOTED_RUN_AFTER_EVIDENCE,'wire-examples.json'),JSON.stringify({capability:RUN_AFTER_CAPABILITY,
    queueGet:snapshot,addPost:add.body,addResponse:add.value,replayPost:replay.body,replayResponse:replay.value,
    previewResponse:preview.value,overview,autoCompact:policy,conflictResponse:stale.value},null,2));
});
