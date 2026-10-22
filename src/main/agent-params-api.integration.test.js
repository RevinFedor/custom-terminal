'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const url = require('node:url');
const zlib = require('node:zlib');
const ts = require('typescript');
const { performance: readPerformance } = require('node:perf_hooks');
const { createHttpReadDiagnostics } = require('./http-read-diagnostics');
const { handleStorageMaintenance } = require('./storage-maintenance-api');
const { createAgentParamsOperations, paramsOperationId } = require('./agent-params-operations');
const { createAgentContextUsageState } = require('./agent-context-usage-state');
const { createClaudeThinkingProofStore } = require('./claude-thinking-proof');
const { createCodexLiveSettingsObserver } = require('./codex-live-settings');
const { createCodexServiceTierProof, preserveCodexServiceTierProofForTurnEnd } = require('./codex-runtime-contract');
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const load = filename => {
  const source = fs.readFileSync(require.resolve(filename), 'utf8');
  return { source, ast: ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true,
    filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JS) };
};
const main = load('./main');
const web = load('./web-server');
const app = load('../renderer/App.tsx');
function fn(file, name) {
  const node = file.ast.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
  assert.ok(node, 'actual source function ' + name);
  return node;
}
function declaration(file, name) {
  const node = file.ast.statements.find(value => ts.isVariableStatement(value)
    && value.declarationList.declarations.some(item => item.name.getText(file.ast) === name));
  assert.ok(node, 'actual source declaration ' + name);
  return node.getText(file.ast);
}
function branch(file, condition) {
  let result;
  function visit(node) {
    if (ts.isIfStatement(node) && node.expression.getText(file.ast) === condition) result = node;
    ts.forEachChild(node, visit);
  }
  visit(file.ast); assert.ok(result, 'actual branch ' + condition);
  return result;
}
function evaluate(deps, source) {
  // Source leaves run in this realm: the real store intentionally rejects
  // non-plain cross-realm objects. No fake codec or broad VM host is needed.
  return Function(...Object.keys(deps), source)(...Object.values(deps));
}

function memoryDb() {
  let values = {};
  const db = { writes: 0, getAppState: key => copy(values[key]) ?? null,
    setAppState(key, value) { db.writes++; values[key] = copy(value); return true; } };
  db.db = { transaction(fn) {
    const run = () => { const before = copy(values); try { return fn(); } catch (error) { values = before; throw error; } };
    run.immediate = run; return run;
  } };
  return db;
}

function mainFixture(database = memoryDb()) {
  const state = { version: 1, provider: 'claude', tabType: 'terminal', inputRevision: 1,
    model: 'gpt-6-astra', effort: 'max', claudeModel: null, claudeEffort: 'max',
    tier: 'priority', processStatus: 'found', fileInode: 1,
    fileMtime: 1, contextObservedAt: 1, contextPct: 42, runtimeCalls: 0, captureCalls: 0,
    confirmedCalls: 0, settingsCalls: 0, contextReads: 0, runtimeHook: null, confirmedHook: null,
    capturedRequest: null, apply: () => pending.promise };
  const pending = deferred(), started = deferred();
  const terminals = new Map(), terminalCommandState = new Map(), terminalLifecycleEpochs = new WeakMap();
  const bridgeKnownSessions = new Map(), providerStates = new Map(), codexTuiReadyMeta = new Map();
  const claudeStartupGateRevisions = new Map([['T', 1]]);
  const contextState = createAgentContextUsageState(), thinkingProofs = createClaudeThinkingProofStore();
  const claudeSettingsSemanticState = new Map();
  const row = () => ({ tab_type: state.tabType, command_type: state.provider, project_id: 'P', cwd: '/fixture',
    claude_session_id: state.provider === 'claude' ? 'S' + state.version : null,
    codex_session_id: state.provider === 'codex' ? 'S' + state.version : null });
  if (!database.fixtureSqlite) database.db.prepare = sql => {
    assert.match(sql, /SELECT tab_type, command_type, COALESCE\(project_id,execution_namespace\) AS project_id, cwd, claude_session_id, codex_session_id/);
    return { get: tabId => tabId === 'T' ? row() : undefined };
  };
  database.getTabCodexSettingsState = () => ({ model: 'saved-codex', effort: 'high' });
  database.getTabContextPct = () => 83;
  const physical = () => ({ terminal: terminals.get('T'), generation: 'G' + state.version,
    runSeq: state.version, commandRunning: state.processStatus !== 'absent',
    claudeLaunchId: 'L' + state.version, codexLaunchId: 'L' + state.version, cwd: '/fixture', projectId: 'P' });
  const thinkingScope = () => ({ terminal: terminals.get('T'), runSeq: state.version,
    lifecycleGeneration: 'G' + state.version, inputRevision: state.inputRevision,
    sessionId: 'S' + state.version, processAlive: state.processStatus !== 'absent' });
  const liveObserver = createCodexLiveSettingsObserver({
    capture: () => ({ terminal: terminals.get('T'), lifecycleGeneration: 'G' + state.version,
      runSeq: state.version, live: state.processStatus !== 'absent', ownerId: 'S' + state.version,
      sessionId: 'S' + state.version }), publish() {}, now: () => 1000 + state.version,
  });
  let frameSeq = 0;
  function paint() {
    liveObserver.observe('T', { valid: true, seq: ++frameSeq,
      text: '› Ask Codex to do anything\n' + state.model + ' ' + state.effort + ' · Context 42% used' });
  }
  function publishContext() {
    contextState.observe({ tabId: 'T', provider: state.provider, sessionId: 'S' + state.version,
      contextPct: state.contextPct, observedAt: ++state.contextObservedAt });
  }
  function synchronize(replaceTerminal = false) {
    if (!terminals.has('T') || replaceTerminal) {
      const terminal = { privateMarker: 'RAW_TERMINAL_PRIVATE', write: () => assert.fail('read fixture must never write PTY') };
      terminals.set('T', terminal); terminalLifecycleEpochs.set(terminal, 'terminal-' + state.version);
    }
    terminalCommandState.set('T', { isRunning: state.processStatus !== 'absent', runSeq: state.version });
    bridgeKnownSessions.set('T', 'S' + state.version);
    if (database.fixtureSqlite) {
      const value = row();
      database.db.prepare('INSERT OR REPLACE INTO tabs VALUES (?,?,?,?,?,?,?,?)')
        .run('T', value.tab_type, value.command_type, value.project_id, null, value.cwd, value.claude_session_id, value.codex_session_id);
    }
    thinkingProofs.confirm(thinkingScope(), state.version % 2 === 1);
    publishContext(); paint();
    codexTuiReadyMeta.set('T', { serviceTierProof: createCodexServiceTierProof({
      ownerId: 'S' + state.version, serviceTier: state.tier, proofAt: 1000, source: 'tui-service-tier-feedback',
      terminalToken: terminals.get('T'), terminalLifecycleGeneration: 'G' + state.version,
      terminalRunSeq: state.version, generationMode: 'terminal-run', generationId: 'G' + state.version,
    }) });
  }
  synchronize();
  const operationListeners = new Set();
  const operationStore = createAgentParamsOperations(database, {
    onChanged: operation => { for (const listener of [...operationListeners]) listener(operation); },
  });
  const ipc = new Map();
  const deps = {
    require, path, srcMainDir: __dirname,
    fs: { statSync: () => ({ dev: 1, ino: state.fileInode, mtimeMs: state.fileMtime, size: state.fileMtime * 100 }) },
    projectManager: { db: database },
    captureAiProcessLookupScope: () => { state.captureCalls++; return physical(); },
    resolveAiToolTypeForTab: () => state.provider,
    conversationOwners: { current: () => ({ ownerToken: 'O' + state.version, ownerOrder: { epoch: 'E', revision: state.version } }) },
    getCodexWriterProofSnapshot: () => state.provider === 'codex' ? { sessionId: 'S' + state.version } : null,
    getCodexProvisionalSettingsSnapshot: () => null,
    bridgeKnownSessions, providerStates, codexLiveSettingsObserver: liveObserver,
    claudeThinkingProofs: thinkingProofs, readClaudeThinkingProofScope: thinkingScope,
    resolveClaudeSessionFileForTab: () => '/fixture/transcript.jsonl',
    agentContextUsageState: { read: (...args) => { state.contextReads++; return contextState.read(...args); } },
    codexTuiReadyMeta, claudeStartupGateRevisions,
    getTerminalInputRevision: () => state.inputRevision,
    terminals, terminalCommandState, getTerminalLifecycleGeneration: () => 'G' + state.version,
    codexTuiReadyTabs: new Set(['T']), preserveCodexServiceTierProofForTurnEnd,
    readMainPublicRuntimeSnapshot: async () => {
      state.runtimeCalls++;
      const value = { toolType: state.provider, sessionId: 'S' + state.version,
        processStatus: state.processStatus, provenWriterSessionId: state.provider === 'codex' ? 'S' + state.version : null };
      return state.runtimeHook ? state.runtimeHook(value) : value;
    },
    claudeDataApi: { getConfirmedSettings: async request => {
      state.confirmedCalls++;
      const model = state.claudeModel || 'observed-claude-' + state.version;
      const value = { success: true, sessionId: request.sessionId, model,
        observedModel: { modelId: model, label: model },
        modelProofAt: 1000, modelProofSessionId: request.sessionId, proof: 'active-jsonl-branch',
        effort: state.claudeEffort, effortHistorical: state.claudeEffort,
        effortCurrentRuntime: true, runtimeGeneration: 'L' + state.version };
      return state.confirmedHook ? state.confirmedHook(value) : value;
    } },
    readDefaultCodexSetting: key => key === 'defaultCodexModel' ? 'default-codex' : 'xhigh',
    ipcMain: { handle: (name, callback) => ipc.set(name, callback) },
    agentParamsOperations: operationStore, terminalLifecycleEpochs,
    claudeSettingsSemanticState,
    claudeStartupMainRuntime: { snapshot: () => ({ transaction: { attemptId: 'startup-' + state.version } }) },
    claudeSettingsSendRuntime: { applySettings: async request => {
      state.settingsCalls++; state.capturedRequest = request; started.resolve(request); return state.apply(request);
    } },
    claudeParamsOperationOutcome: value => value,
    console: { warn() {} },
  };
  const ipcNode = main.ast.statements.find(node => node.getText(main.ast).startsWith("ipcMain.handle('agent:get-current-params'"));
  assert.ok(ipcNode, 'actual main params IPC');
  const source = ['aiProcessLookupScopeCurrent', 'getCurrentCodexServiceTierProofIdentity',
    'noteClaudeSettingsSemanticChange', 'observeClaudeSettingsSemanticSnapshot',
    'captureMainAgentParams', 'readMainCodexParamsSettings'].map(name => fn(main, name).getText(main.ast)).join('\n')
    + '\n' + declaration(main, 'mainAgentParamsReader') + '\n' + ipcNode.getText(main.ast)
    + '\n' + declaration(main, 'mainAgentParamsService')
    + '\nreturn {capture:captureMainAgentParams, reader:mainAgentParamsReader, service:mainAgentParamsService,'
    + ' noteSettings:noteClaudeSettingsSemanticChange};';
  const wired = evaluate(deps, source);
  return { ...wired, state, store: operationStore, database, providerStates, ipc, started: started.promise,
    pending, paint, publishContext, synchronize,
    advance() { state.version++; state.inputRevision++; synchronize(true); },
    waitForPhase(operationId, phase) {
      const current = operationStore.get(operationId);
      if (current?.phase === phase) return Promise.resolve(current);
      const done = deferred();
      const listener = operation => {
        if (operation.operationId === operationId && operation.phase === phase) {
          operationListeners.delete(listener); done.resolve(operation);
        }
      };
      operationListeners.add(listener);
      return done.promise;
    },
  };
}

function startCallbacks(callbacks) {
  // Execute the exact start() binding/assignment leaves without its unrelated
  // network/process lifecycle. The real server is the private HTTP fixture.
  const start = fn(web, 'start');
  const names = ['readAgentParams', 'agentParamsService'];
  const bindings = start.parameters[0].name.elements.filter(node => names.includes(node.propertyName?.text));
  const assignments = start.body.statements.filter(node => ts.isExpressionStatement(node)
    && ts.isBinaryExpression(node.expression) && names.includes(node.expression.left.getText(web.ast)));
  assert.equal(bindings.length, 2); assert.equal(assignments.length, 2);
  return evaluate({ callbacks }, 'let readAgentParams,agentParamsService; const {'
    + bindings.map(node => node.getText(web.ast)).join(',') + '}=callbacks;'
    + assignments.map(node => node.getText(web.ast)).join('\n') + ';return {readAgentParams,agentParamsService};');
}

function appGetParams(h, tab) {
  const body = branch(app, "action === 'getSDKParams'").thenStatement.getText(app.ast);
  const calls = [];
  const invoke = evaluate({ ipcRenderer: { invoke: async (channel, payload) => {
    calls.push(channel); return h.ipc.get(channel)({}, payload);
  } }, state: { openProjects: new Map([['P', { tabs: new Map([['T', tab]]) }]]) },
  reply: (success, data, error) => ({ success, data, error }) },
  ts.transpileModule('return async function invoke(payload) ' + body,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
  return { invoke, calls };
}

async function httpFixture(t, h, options = {}) {
  const bridgeCalls = [], dropped = [];
  const bindings = startCallbacks({ readAgentParams: tabId => h.reader.read(tabId), agentParamsService: h.service });
  const deps = { ...bindings, token: 'params-fixture-bearer', url, Buffer, zlib, GZIP_THRESHOLD: 4096,
    httpReadDiagnostics: createHttpReadDiagnostics({ serviceId: 'params-fixture', enabled: false, log() {} }),
    readPerformance, handleStorageMaintenance, storageMaintenance: null,
    handleDictationClipboardHttp: async () => false,
    workflowOrganizationHttp: async () => false,
    handleSystemPromptApi: async () => false, systemPromptService: null,
    require: name => {
      if (name === './project-manager') return {};
      assert.equal(name, './external-research-browser'); return require(name);
    },
    WORKSPACE_SWITCHER_CAPABILITY: require('./workspace-switcher-api').WORKSPACE_SWITCHER_CAPABILITY,
    CODEX_SETTINGS_CAPABILITY: require('./codex-settings-control').CODEX_SETTINGS_CAPABILITY,
    RUN_AFTER_CAPABILITY: require('../shared/run-after-api.cjs').RUN_AFTER_CAPABILITY,
    getRunAfterApi: () => ({ journal: { epoch: 'params-fixture-main' } }),
    completionNotificationCapability: require('./tab-completion-notification-api').completionNotificationCapability,
    projectCardSignals: null, publicTabActivity: null, captureTabInspection: null, readTabInspectionResponse: null,
    publicHistoryFreshness: null, userNotificationOutbox: null, sendIntentCancellationAvailable: () => false,
    agentSendQueue: null, savedPromptService: null, transcriptService: null, codexGoalActions: null,
    agentSendReceiptStore: null, getAgentResponseState: null,
    decId: decodeURIComponent,
    bridgeRequest: async (action, payload) => {
      bridgeCalls.push({ action, payload });
      if (options.bridge) return options.bridge(action, payload);
      throw Error('legacy bridge unavailable in PTY fixture');
    },
    prepareClosedCodexSettings: async () => ({ restored: false }), findOrchestrationTabDescriptor() {},
    findRestorableAgentTabDescriptor() {}, ensureExplicitAgentTabOpen() {},
    getLanIp: () => '127.0.0.1', webServerServiceHealth: () => ({ state: 'fixture' }),
    readAgentTabTiming: null, readAgentUsage: null, readCodexAuthProfile: null, readAgentRuntimeSnapshot: null,
    savedHistoryOperations: null, conversationOwners: null, inboxSavedHistoryOperations: null,
    MAX_EVENT_TABS: 10, STRUCTURED_AUTHORING_LIMITS: { bytes: 1000 },
    MAX_CONTEXT_FILES: 1, MAX_CONTEXT_FILE_BYTES: 1000, MAX_CONTEXT_TOTAL_BYTES: 1000,
  };
  const handle = evaluate(deps, ['checkAuth', 'sendJson', 'readBody', 'handleApi']
    .map(name => fn(web, name).getText(web.ast)).join('\n') + '\nreturn handleApi;');
  const server = http.createServer((req, res) => {
    if (req.headers['x-fixture-drop-response'] === '1') {
      // Fault injection only at the socket transport: execute the actual route
      // and sendJson, but lose the reply after durable admission.
      res.end = data => { dropped.push({ status: res.statusCode, body: JSON.parse(String(data)) }); res.destroy(); return res; };
    }
    Promise.resolve(handle(req, res, url.parse(req.url, true), new Map())).catch(error => {
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ fixtureError: error.message }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const request = (method = 'GET', pathname = '/api/terminal-tabs/T/params', body = undefined, extraHeaders = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: pathname,
      headers: { authorization: 'Bearer params-fixture-bearer', 'content-type': 'application/json', ...extraHeaders } }, res => {
      let value = ''; res.on('data', data => { value += data; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(value) }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { request, bridgeCalls, dropped };
}

test('actual authenticated HTTP route + main service keeps one operation after lost 202 and late partial/full proof', async t => {
  const h = mainFixture(), http = await httpFixture(t, h);
  const payload = { requestId: 'lost-reply', model: 'requested', effort: 'max' };
  await assert.rejects(http.request('POST', undefined, payload, { 'x-fixture-drop-response': '1' }));
  assert.equal(http.dropped[0].status, 202, JSON.stringify(http.dropped[0]));
  const execute = await h.started;
  assert.equal(http.dropped[0].status, 202);
  const operationId = paramsOperationId('T', payload.requestId);
  const endpoint = '/api/terminal-tabs/T/params?operationId=' + encodeURIComponent(operationId);
  const pending = await http.request('GET', endpoint);
  assert.equal(pending.status, 200); assert.equal(pending.body.operation.phase, 'pending');
  const retry = await http.request('POST', undefined, payload);
  assert.equal(retry.status, 202); assert.equal(retry.body.action, 'join');
  execute.paramsOutcome({ phase: 'partial-unknown', appliedSettings: { model: 'observed' }, failedCommand: '/effort max' });
  const partial = await http.request('GET', endpoint);
  assert.equal(partial.body.operation.phase, 'partial-unknown'); assert.equal(partial.body.model, 'observed');
  assert.equal(partial.body.effort, undefined);
  execute.paramsOutcome({ phase: 'applied', appliedSettings: { model: 'observed', effort: 'max' } });
  h.pending.resolve();
  const final = await http.request('GET', endpoint);
  assert.equal(final.body.operation.phase, 'applied'); assert.equal(final.body.effort, 'max');
  assert.equal(h.state.settingsCalls, 1); assert.deepEqual(http.bridgeCalls, []);
  assert.doesNotMatch(JSON.stringify(final.body), /RAW_TERMINAL_PRIVATE|params-fixture-bearer|paramsPhysical|executeContext/);
});

test('actual auth/capability boundary rejects unauthorized reads and writes before dependencies', async t => {
  const h = mainFixture(), http = await httpFixture(t, h);
  for (const method of ['GET', 'POST']) {
    const response = await http.request(method, undefined, method === 'POST' ? { requestId: 'bad', model: 'A' } : undefined,
      { authorization: 'Bearer wrong-fixture' });
    assert.equal(response.status, 401); assert.deepEqual(response.body, { error: 'unauthorized' });
  }
  assert.equal(h.state.runtimeCalls, 0); assert.equal(h.state.captureCalls, 0); assert.equal(h.state.settingsCalls, 0);
  const me = await http.request('GET', '/api/me');
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.deepEqual(me.body.capabilities.agentParams.providers, ['codex', 'claude']);
  assert.deepEqual(me.body.capabilities.agentParams.operationProviders, ['claude']);
  assert.equal(me.body.capabilities.agentParams.requestId, 'client-stable');
});

test('actual HTTP duplicate/conflict, historical receipt, current other owner and unavailable current stay independent', async t => {
  const h = mainFixture(), http = await httpFixture(t, h);
  const payload = { requestId: 'stable-id', model: 'requested' };
  const [first, duplicate] = await Promise.all([http.request('POST', undefined, payload), http.request('POST', undefined, payload)]);
  assert.equal(first.status, 202); assert.equal(duplicate.status, 202);
  const execute = await h.started;
  execute.paramsOutcome({ phase: 'applied-different', appliedSettings: { model: 'observed' } }); h.pending.resolve();
  const mismatch = await http.request('POST', undefined, { ...payload, model: 'other' });
  assert.equal(mismatch.status, 409); assert.equal(mismatch.body.code, 'settings_request_conflict');
  h.advance();
  const endpoint = '/api/terminal-tabs/T/params?operationId=' + encodeURIComponent(first.body.operation.operationId);
  const read = await http.request('GET', endpoint);
  assert.equal(read.status, 200); assert.equal(read.body.operation.owner.sessionId, 'S1');
  assert.equal(read.body.current.sessionId, 'S2'); assert.equal(read.body.current.model, 'observed-claude-2');
  assert.equal(read.body.model, 'observed');
  const writes = h.database.writes;
  await http.request('GET', endpoint); assert.equal(h.database.writes, writes, 'receipt GET writes no operation');
  h.state.runtimeHook = () => { throw Object.assign(Error('params_snapshot_unstable'), { code: 'params_snapshot_unstable', statusCode: 503 }); };
  const unavailable = await http.request('GET', endpoint);
  assert.equal(unavailable.status, 200); assert.equal(unavailable.body.current, null);
  assert.equal(unavailable.body.currentError.code, 'params_snapshot_unstable');
  assert.equal(unavailable.body.operation.owner.sessionId, 'S1');
  const missing = await http.request('GET', '/api/terminal-tabs/foreign/params?operationId=' + encodeURIComponent(first.body.operation.operationId));
  assert.equal(missing.status, 404); assert.equal(h.state.settingsCalls, 1);
});

test('actual App getSDKParams calls one main IPC; only explicit SDK null permits local fallback', async t => {
  const h = mainFixture();
  const renderer = appGetParams(h, { tabType: 'claude-sdk', sdkModel: 'sdk-model', sdkEffort: 'high', sdkThinking: false });
  const pty = await renderer.invoke({ tabId: 'T' });
  assert.equal(pty.data.model, 'observed-claude-1'); assert.deepEqual(renderer.calls, ['agent:get-current-params']);
  h.state.tabType = 'claude-sdk'; h.synchronize();
  const http = await httpFixture(t, h, { bridge: async (action, payload) => {
    assert.equal(action, 'getSDKParams'); const result = await renderer.invoke(payload);
    if (!result.success) throw Error(result.error); return result.data;
  } });
  const sdk = await http.request();
  assert.equal(sdk.status, 200); assert.equal(sdk.body.model, 'sdk-model'); assert.equal(sdk.body.thinking, 'disabled');
  assert.equal(http.bridgeCalls.length, 1);
  h.state.tabType = 'terminal'; h.synchronize();
  h.state.runtimeHook = () => { throw Error('fixture PTY read failure'); };
  const failed = await http.request();
  assert.equal(failed.status, 503); assert.equal(failed.body.code, 'params_read_failed');
  assert.equal(http.bridgeCalls.length, 1, 'PTY failure never crosses SDK/legacy bridge');
  await assert.rejects(renderer.invoke({ tabId: 'T' }), { code: 'params_read_failed' });
});

test('actual main read retries a replaced owner and excludes animated frame/context timestamps from the capture key', async () => {
  const h = mainFixture();
  const claudeKey = h.capture('T').semanticKey;
  h.state.fileMtime++; h.publishContext();
  assert.equal(h.capture('T').semanticKey, claudeKey, 'Claude append metadata/context heartbeat is not a physical owner change');
  const entered = deferred(), release = deferred(); let first = true;
  h.state.confirmedHook = async value => { if (first) { first = false; entered.resolve(); await release.promise; } return value; };
  const read = h.reader.read('T'); await entered.promise; h.advance(); release.resolve();
  const result = await read;
  assert.equal(result.sessionId, 'S2'); assert.equal(result.model, 'observed-claude-2');
  assert.equal(result.thinkingProof.sessionId, 'S2'); assert.equal(h.state.runtimeCalls, 2);
  h.state.provider = 'codex'; h.synchronize();
  const before = h.capture('T');
  h.paint(); h.publishContext(); h.state.fileMtime++;
  const after = h.capture('T');
  assert.equal(before.semanticKey, after.semanticKey);
  h.state.model = 'gpt-reserve'; h.state.effort = 'high'; h.paint();
  assert.notEqual(after.semanticKey, h.capture('T').semanticKey);
  h.providerStates.set('T', { codexFastIntent: false, codexFastIntentRevision: 1,
    codexSettingsIntentModel: 'gpt-6-astra', codexSettingsIntentEffort: 'max', codexSettingsIntentRevision: 1 });
  const current = await h.reader.read('T');
  assert.equal(current.model, 'gpt-reserve'); assert.equal(current.modelSource, 'committed-composer-footer');
  assert.equal(current.requestedModel, 'gpt-6-astra'); assert.equal(current.savedSettings.model, 'saved-codex');
  assert.equal(current.fast, false); assert.equal(current.fastCurrent, true); assert.equal(current.fastPending, true);
  assert.equal(h.state.settingsCalls, 0, 'model/Fast GET never invokes any settings executor');
});

test('actual HTTP Codex current/Fast stays read-only and durable requestId opt-in cannot replace its legacy intent route', async t => {
  const h = mainFixture();
  h.state.provider = 'codex'; h.synchronize();
  h.providerStates.set('T', { codexFastIntent: false, codexFastIntentRevision: 1 });
  const http = await httpFixture(t, h, { bridge: (action, payload) => {
    assert.equal(action, 'setSDKParams'); return { tabId: payload.tabId, queued: true, model: payload.model };
  } });
  const current = await http.request();
  assert.equal(current.status, 200); assert.equal(current.body.provider, 'codex');
  assert.equal(current.body.model, 'gpt-6-astra'); assert.equal(current.body.fastCurrent, true);
  assert.equal(current.body.fast, false); assert.equal(current.body.fastPending, true);
  const legacy = await http.request('POST', undefined, { model: 'legacy-choice', effort: 'high' });
  assert.equal(legacy.status, 200); assert.equal(legacy.body.queued, true);
  assert.deepEqual(http.bridgeCalls.map(call => call.action), ['setSDKParams']);
  const durable = await http.request('POST', undefined, { requestId: 'codex-unsupported', model: 'new-choice' });
  assert.equal(durable.status, 409); assert.equal(durable.body.code, 'settings_provider_unsupported');
  assert.equal(http.bridgeCalls.length, 1, 'unsupported durable protocol never silently dispatches legacy settings');
  assert.equal(h.state.settingsCalls, 0);
  assert.equal(h.store.get(paramsOperationId('T', 'codex-unsupported')), null);
});

test('actual main semantic key allows repaints across await but rereads provider fallback and context zero', async () => {
  for (const change of ['repaint', 'fallback']) {
    const h = mainFixture(); h.state.provider = 'codex'; h.synchronize();
    const entered = deferred(), release = deferred(); let first = true;
    h.state.runtimeHook = async value => { if (first) { first = false; entered.resolve(); await release.promise; } return value; };
    const read = h.reader.read('T'); await entered.promise;
    if (change === 'fallback') { h.state.model = 'gpt-reserve'; h.state.effort = 'high'; h.state.contextPct = 0; }
    h.paint(); h.publishContext(); release.resolve();
    const result = await read;
    assert.equal(h.state.runtimeCalls, change === 'fallback' ? 2 : 1);
    assert.equal(result.model, change === 'fallback' ? 'gpt-reserve' : 'gpt-6-astra');
    assert.equal(result.modelSource, 'committed-composer-footer');
    assert.equal(result.contextPct, change === 'fallback' ? 0 : 42);
    assert.equal(result.contextKnown, true); assert.equal(h.state.settingsCalls, 0);
  }
});

test('actual main semantic revisions reject settings/context ABA and return one coexisting snapshot', async () => {
  const h = mainFixture();
  h.state.claudeModel = 'A'; h.state.claudeEffort = 'low'; h.state.contextPct = 20;
  h.publishContext();
  await h.reader.read('T'); // establish the current observed-settings signature
  const baselineCalls = h.state.runtimeCalls;
  let first = true;
  h.state.confirmedHook = async value => {
    if (!first) return value;
    first = false;
    h.state.claudeModel = 'B'; h.state.claudeEffort = 'high';
    h.noteSettings('T', 'transcript-setting-record');
    h.state.contextPct = 50; h.publishContext();
    h.state.contextPct = 20; h.publishContext();
    return value;
  };
  const result = await h.reader.read('T');
  assert.equal(h.state.runtimeCalls - baselineCalls, 2);
  assert.equal(result.model, 'B');
  assert.equal(result.effort, 'high');
  assert.equal(result.contextPct, 20);
});

test('actual main service rechecks admitted physical owner before invoking existing scenario', async () => {
  const h = mainFixture();
  const submitted = h.service.submit({ tabId: 'T', requestId: 'replace-before-thunk', model: 'new' });
  const settled = h.waitForPhase(submitted.operation.operationId, 'rejected');
  h.advance();
  await settled;
  const result = await h.service.read({ tabId: 'T', operationId: submitted.operation.operationId });
  assert.equal(result.operation.phase, 'rejected'); assert.equal(result.operation.code, 'settings_target_changed');
  assert.equal(h.state.settingsCalls, 0);
});

test('actual HTTP receipt uses real SQLite app-state ABI, survives service reconstruction, and never redispatches', async t => {
  const Database = require('better-sqlite3');
  let sqlite;
  try { sqlite = new Database(':memory:'); }
  catch (error) {
    if (error.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error.message)) {
      t.skip('Use ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test for SQLite ABI acceptance'); return;
    }
    throw error;
  }
  t.after(() => sqlite.close());
  sqlite.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);'
    + 'CREATE TABLE tabs(tab_id TEXT PRIMARY KEY,tab_type TEXT,command_type TEXT,project_id TEXT,execution_namespace TEXT,cwd TEXT,claude_session_id TEXT,codex_session_id TEXT);');
  const manager = Object.create(require('./database').prototype); manager.db = sqlite; manager.fixtureSqlite = true;
  const h = mainFixture(manager), http = await httpFixture(t, h);
  const payload = { requestId: 'sqlite-id', model: 'requested' };
  const initial = await http.request('POST', undefined, payload); await h.started;
  assert.equal(initial.status, 202);
  const restarted = mainFixture(manager);
  const restartedHttp = await httpFixture(t, restarted);
  const replay = await restartedHttp.request('POST', undefined, payload);
  assert.equal(replay.status, 202); assert.equal(replay.body.operation.phase, 'unknown');
  assert.equal(replay.body.operation.attemptId, initial.body.operation.attemptId);
  assert.equal(restarted.state.settingsCalls, 0);
  const read = await restartedHttp.request('GET', '/api/terminal-tabs/T/params?operationId=' + encodeURIComponent(initial.body.operation.operationId));
  assert.equal(read.status, 200); assert.equal(read.body.operation.code, 'settings_restart_during_operation');
});
