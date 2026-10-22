'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const vm = require('node:vm');
const { AsyncLocalStorage } = require('node:async_hooks');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { basename, join, resolve: resolvePath } = require('node:path');
const { promisify } = require('node:util');
const ts = require('typescript');
const { nextCodexModelEffortIntent } = require('./codex-model-effort-intent');
const { nextCodexFastIntent } = require('./codex-fast-intent');
const control = require('./codex-settings-control');
const { resolveAgentModelRequest } = require('./agent-provider-model-contract');

function file(name, kind = ts.ScriptKind.JS) {
  const source = fs.readFileSync(require.resolve(name), 'utf8');
  return { source, ast: ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, kind) };
}
const main = file('./main');
const app = file('../renderer/App.tsx', ts.ScriptKind.TSX);
const web = file('./web-server');
const evaluate = (deps, source) => Function(...Object.keys(deps), source)(...Object.values(deps));
function fn(file, name) {
  const node = file.ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, name); return node.getText(file.ast);
}
function ipc(name) {
  const node = main.ast.statements.find(item => ts.isExpressionStatement(item)
    && ts.isCallExpression(item.expression) && item.expression.expression.getText(main.ast) === 'ipcMain.handle'
    && item.expression.arguments[0]?.text === name);
  assert.ok(node, name); return node.expression.arguments[1].getText(main.ast);
}
function appBranch(predicate) {
  let selected;
  function visit(node) {
    if (ts.isIfStatement(node) && predicate(node.expression.getText(app.ast))) selected = node;
    ts.forEachChild(node, visit);
  }
  visit(app.ast); assert.ok(selected, 'actual App bridge branch');
  return ts.transpileModule(selected.getText(app.ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

const settingsRoute = web.source.slice(web.source.indexOf('  // Standalone Codex choices'), web.source.indexOf('  // SDK params (model/effort/thinking)'));
const fastStart = web.source.indexOf("  m = parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/codex\\/fast$/)");
assert.ok(settingsRoute && fastStart >= 0, 'actual standalone API routes');
const fastRoute = web.source.slice(fastStart, web.source.indexOf('  // Prompt-queue', fastStart));
const modelBridge = appBranch(expression => expression === "action === 'setSDKParams'");
const fastBridge = appBranch(expression => expression.includes("action === 'sendCodexFast'"));

async function fixture(t, { busy = true, running = true } = {}) {
  const settingsPlan = await import('../renderer/utils/codexHistorySettingsPlan.mjs');
  const effective = await import('../renderer/utils/codexEffectiveSettings.mjs');
  const tab = { tabId: 'T', commandType: 'codex', tabType: 'terminal', codexSessionId: 'S',
    codexModel: 'gpt-old', codexEffort: 'medium', codexSettingsProofSessionId: 'S' };
  const state = { provider: 'codex', sessionId: 'S', busy, running, catalogHook: null, persistenceFails: false, oldRenderer: false };
  const calls = [], writes = [], reconciles = [];
  const providerStates = new Map([['T', { type: 'anthropic', unrelated: 'KEEP',
    codexFastIntent: true, codexFastIntentRevision: 1 }]]);
  let persisted = null;
  const deps = {
    console: { log() {}, warn() {} }, providerStates,
    terminals: new Map([['T', { write() { assert.fail('intent acceptance must not write PTY'); } }]]),
    nextCodexModelEffortIntent, nextCodexFastIntent,
    retireCodexScopedModelEffortIntent: () => false,
    codexNativeSettingsIntentTracker: { hasPending: () => false },
    getHeadlessTerminalMirror: () => null, codexTuiReadyMeta: new Map(),
    setProviderState: (id, value) => providerStates.set(id, value), broadcastProviderState() {},
    clearCodexLifecycleWarning() {}, resolveAiToolTypeForTab: () => state.provider,
    projectManager: { db: { updateTabProviderState(_id, value) {
      if (state.persistenceFails) throw Error('EIO');
      persisted = JSON.stringify(value); writes.push(value);
    }, db: { prepare: () => ({ get: () => ({ provider_state: persisted }) }) } } },
    scheduleCodexModelEffortIntentReconcile: (...args) => { reconciles.push(['pair', ...args]); return Promise.resolve(); },
    scheduleCodexFastIntentReconcile: (...args) => { reconciles.push(['fast', ...args]); return Promise.resolve(); },
  };
  for (const name of ['getCodexModelEffortIntentRecord', 'persistCodexModelEffortIntent',
    'persistCodexFastIntentValue', 'persistNextCodexFastIntent']) {
    deps[name] = evaluate(deps, fn(main, name) + '\nreturn ' + name + ';');
  }
  const handlers = Object.fromEntries(['codex:set-model-effort-intent', 'codex:set-fast-intent', 'codex:toggle-fast-intent']
    .map(name => [name, evaluate(deps, 'return ' + ipc(name) + ';')]));
  const runtime = () => ({ liveLifecycle: state.running, writerConfirmed: state.running,
    provenWriterSessionId: state.running ? state.sessionId : null,
    codexCurrentSettingsOwnerId: state.running ? state.sessionId : null,
    codexCurrentModel: 'gpt-old', codexCurrentEffort: 'medium', codexCurrentSettingsProofAt: 1 });
  const appDeps = {
    ...settingsPlan, ...effective, console: { log() {}, warn() {} },
    DEFAULT_CODEX_MODEL: 'gpt-old', DEFAULT_CODEX_EFFORT: 'medium',
    cleanDefaultSetting: value => typeof value === 'string' && value.trim() ? value.trim() : undefined,
    state: { openProjects: new Map([['P', { tabs: new Map([['T', tab]]) }]]) },
    findTabProject: id => id === 'T' ? { projectId: 'P', tab } : null,
    resolvePtyAgentOwner: () => state.provider,
    useUIStore: { getState: () => ({ defaultCodexModel: 'gpt-old', defaultCodexEffort: 'medium' }) },
    recoverAgentDraftTransferToHistory: async () => {},
    ipcRenderer: { invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel === 'codex:get-runtime-session') return runtime();
      if (handlers[channel]) return handlers[channel]({ sender: {} }, payload);
      assert.fail('unexpected IPC ' + channel);
    } },
  };
  const bridgeRequest = async (action, payload) => {
    if (state.oldRenderer && action === 'setCodexFast') throw Error('unknown bridge action setCodexFast');
    if (state.overrideReply) return state.overrideReply(action, payload);
    const reply = (ok, data, error) => {
      if (!ok) throw Object.assign(Error(error), { bridgeData: data });
      return data;
    };
    const source = action === 'setSDKParams' ? modelBridge : fastBridge;
    return evaluate({ ...appDeps, action, payload, reply }, 'return (async () => {\n' + source + '\n})();');
  };
  const findTab = id => id === 'T' ? { tabId: id, toolType: state.provider, tabType: tab.tabType,
    projectId: 'P', cwd: '/fixture', sessionId: state.sessionId } : null;
  const readAgentParams = async id => ({ tabId: id, provider: state.provider, coherent: true,
    model: 'gpt-old', effort: 'medium', fastKnown: state.running, fastCurrent: state.running ? true : null,
    fast: providerStates.get(id)?.codexFastIntent, busy: state.busy,
    requestedModel: providerStates.get(id)?.codexSettingsIntentModel || null,
    requestedEffort: providerStates.get(id)?.codexSettingsIntentEffort || null,
    settingsPending: !!providerStates.get(id)?.codexSettingsIntentRevision });
  const models = [{ id: 'gpt-new', runtimeId: 'gpt-5.6-luna', efforts: ['low', 'medium', 'high', 'max'] }];
  const routeDeps = {
    ...control, codexSettingsError: control.settingsError,
    checkAuth: req => req.headers.authorization === 'Bearer fixture',
    decId: decodeURIComponent, findOrchestrationTabDescriptor: findTab,
    readAgentParams, bridgeRequest, projectManager: {},
    readBody: evaluate({ Buffer }, fn(web, 'readBody') + '\nreturn readBody;'),
    resolveProjectAgentModelRequest: async (_manager, args) => resolveAgentModelRequest({ ...args,
      catalogModels: args.catalogModels || models }),
    projectedModelsForProvider: async () => { if (state.catalogHook) await state.catalogHook(); return models; },
    sendJson: (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); },
  };
  const handle = evaluate(routeDeps, 'return async (req, res, parsed) => { let m;\n' + settingsRoute + '\n' + fastRoute
    + '\nres.writeHead(404);res.end("{}"); };');
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://fixture');
    if (parsed.pathname === '/api/me') return routeDeps.sendJson(res, 200,
      { capabilities: { codexSettings: control.CODEX_SETTINGS_CAPABILITY } });
    void handle(req, res, parsed).catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { state, calls, writes, reconciles, providerStates, handlers, bridgeRequest, base,
    async request(path, body, auth = true) {
      const response = await fetch(base + '/api/terminal-tabs/T/codex/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(auth ? { Authorization: 'Bearer fixture' } : {}), 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('actual HTTP → App → Main intent accepts a busy pair without user input or lifecycle mutation', async t => {
  const h = await fixture(t);
  const result = await h.request('settings', { modelSelection: { kind: 'catalog', id: 'gpt-new' }, effort: 'high' });
  assert.equal(result.status, 200);
  assert.equal(result.body.accepted, true);
  assert.equal(result.body.queued, true);
  assert.equal(result.body.applied, false);
  assert.equal(h.providerStates.get('T').codexSettingsIntentModel, 'gpt-5.6-luna');
  assert.equal(h.providerStates.get('T').codexSettingsIntentEffort, 'high');
  assert.equal(h.providerStates.get('T').unrelated, 'KEEP');
  assert.deepEqual(h.calls.map(call => call.channel), ['codex:set-model-effort-intent']);
  assert.equal(h.state.busy, true);
  assert.equal(h.reconciles[0][0], 'pair');
});

test('busy effort-only request keeps the runtime-proven model', async t => {
  const h = await fixture(t);
  const result = await h.request('settings', { effort: 'max' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.queued, true);
  assert.equal(h.providerStates.get('T').codexSettingsIntentModel, 'gpt-old');
  assert.equal(h.providerStates.get('T').codexSettingsIntentEffort, 'max');
});

test('stopped complete pair is a next-launch choice and does not resume Codex', async t => {
  const h = await fixture(t, { running: false, busy: false });
  assert.equal((await h.request('settings', { modelSelection: { kind: 'catalog', id: 'gpt-new' }, effort: 'low' })).status, 200);
  assert.equal(h.state.running, false);
  assert.deepEqual(h.calls.map(call => call.channel), ['codex:set-model-effort-intent']);
});

test('absolute Fast false, repeated false and true preserve revision/no-toggle semantics while busy', async t => {
  const h = await fixture(t);
  const first = await h.request('fast', { enabled: false });
  const second = await h.request('fast', { enabled: false });
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(first.body.desiredFast, false);
  assert.equal(second.body.desiredFast, false);
  assert.equal(first.body.revision, second.body.revision);
  assert.equal(h.providerStates.get('T').unrelated, 'KEEP');
  assert.equal((await h.request('fast', { enabled: true })).body.desiredFast, true);
  assert.ok(h.calls.every(call => call.channel === 'codex:set-fast-intent'));
  assert.equal(h.state.busy, true);
});

test('legacy empty Fast POST still toggles through its original owner', async t => {
  const h = await fixture(t);
  assert.equal((await h.request('fast', {})).body.desiredFast, false);
  assert.equal(h.calls[0].channel, 'codex:toggle-fast-intent');
});

test('settings read is side-effect-free and separates current from requested', async t => {
  const h = await fixture(t);
  await h.request('settings', { effort: 'high' });
  const before = h.writes.length, calls = h.calls.length;
  const result = await h.request('settings');
  assert.equal(result.body.model, 'gpt-old');
  assert.equal(result.body.effort, 'medium');
  assert.equal(result.body.requestedEffort, 'high');
  assert.equal(result.body.settingsPending, true);
  assert.equal(h.writes.length, before); assert.equal(h.calls.length, calls);
});

test('unsupported model/effort and foreign provider fail before any settings intent', async t => {
  const h = await fixture(t);
  for (const body of [
    { modelSelection: { kind: 'catalog', id: 'missing' }, effort: 'high' },
    { modelSelection: { kind: 'catalog', id: 'gpt-new' }, effort: 'ultra' },
    { model: 'guessed', effort: 'high' }, { effort: 'high', prompt: 'forged' }, {},
  ]) assert.ok((await h.request('settings', body)).status >= 400);
  h.state.provider = 'claude';
  assert.equal((await h.request('settings', { effort: 'high' })).status, 409);
  assert.equal((await h.request('fast', { enabled: false })).status, 409);
  assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
});

test('conversation replacement during catalog lookup cannot persist the old selection', async t => {
  const h = await fixture(t);
  h.state.catalogHook = () => { h.state.sessionId = 'replacement'; };
  const result = await h.request('settings', { modelSelection: { kind: 'catalog', id: 'gpt-new' }, effort: 'high' });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'codex_settings_target_changed');
  assert.equal(h.calls.length, 0);
});

test('absolute control rejects malformed booleans, absent auth and foreign Main provider', async t => {
  const h = await fixture(t);
  assert.equal((await h.request('fast', { enabled: 'false' })).status, 400);
  assert.equal((await h.request('fast', { enabled: false }, false)).status, 401);
  assert.equal((await h.request('settings', { effort: 'high' }, false)).status, 401);
  const malformed = await h.handlers['codex:set-fast-intent']({}, { tabId: 'T', enabled: 'false' });
  assert.equal(malformed.success, false);
  h.state.provider = 'claude';
  assert.equal((await h.handlers['codex:set-fast-intent']({}, { tabId: 'T', enabled: true })).success, false);
  assert.equal(h.writes.length, 0);
});

test('old renderer cannot silently convert the absolute Fast action into a toggle', async t => {
  const h = await fixture(t);
  h.state.oldRenderer = true;
  const result = await h.request('fast', { enabled: false });
  assert.equal(result.status, 409);
  assert.equal(h.providerStates.get('T').codexFastIntent, true);
  assert.equal(h.calls.length, 0);
});

test('incomplete or mismatched bridge ACK is unconfirmed, not accepted settings', async t => {
  const h = await fixture(t);
  for (const reply of [{ tabId: 'T' }, { tabId: 'other', queued: true }]) {
    h.state.overrideReply = () => reply;
    const result = await h.request('settings', { effort: 'high' });
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'codex_settings_acceptance_unconfirmed');
  }
  for (const reply of [{ tabId: 'T', desiredFast: false },
    { tabId: 'other', desiredFast: false, revision: 1 },
    { tabId: 'T', desiredFast: true, revision: 1 }]) {
    h.state.overrideReply = () => reply;
    const result = await h.request('fast', { enabled: false });
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'codex_settings_acceptance_unconfirmed');
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.writes.length, 0);
});

test('Fast persistence failure does not acknowledge success or dispatch native reconciliation', async t => {
  const h = await fixture(t);
  h.state.persistenceFails = true;
  const result = await h.request('fast', { enabled: false });
  assert.equal(result.status, 409);
  assert.equal(h.providerStates.get('T').codexFastIntent, true);
  assert.equal(h.reconciles.length, 0);
});

test('actual MCP dispatcher reaches the loopback API, App bridge and Main intents without a prompt', async t => {
  const h = await fixture(t);
  const source = fs.readFileSync(require.resolve('../../mcp/terminal-server.mjs'), 'utf8');
  const executable = source.slice(0, source.lastIndexOf('// stdio transport')).replace(/^import .*;\n/gm, '');
  const context = vm.createContext({
    AsyncLocalStorage, Buffer, URL, URLSearchParams, basename, join, resolve: resolvePath, promisify, execFile, randomUUID,
    homedir: () => '/fixture-home', readdirSync: () => [], fetch,
    process: { env: {}, argv: ['node', 'terminal-server.mjs'], cwd: () => '/fixture', stderr: { write() {} } },
    testPickInstance: () => ({ port: Number(new URL(h.base).port) }),
  });
  vm.runInContext(executable + '\npickWebInstance = testPickInstance; readSharedToken = () => "fixture"; globalThis.dispatch = handleRequest;', context);
  let id = 0;
  const call = async (name, args) => JSON.parse(await context.dispatch({ id: ++id, method: 'tools/call',
    params: { name, arguments: args, _meta: { noted: { tabId: 'source', projectId: 'P', cwd: '/fixture' } } } })).result;
  const pair = await call('set_codex_model_effort', { tabId: 'T', modelSelection: { kind: 'catalog', id: 'gpt-new' }, effort: 'high' });
  assert.equal(pair.isError, undefined, pair.content[0].text);
  assert.equal(pair.structuredContent.applied, false);
  const fast = await call('set_codex_fast', { tabId: 'T', enabled: false });
  assert.equal(fast.isError, undefined, fast.content[0].text);
  const read = await call('get_codex_settings', { tabId: 'T' });
  assert.equal(read.isError, undefined, read.content[0].text);
  assert.equal(read.structuredContent.requestedModel, 'gpt-5.6-luna');
  assert.equal(read.structuredContent.requestedEffort, 'high');
  assert.equal(read.structuredContent.fast, false);
  assert.deepEqual(h.calls.map(item => item.channel), ['codex:set-model-effort-intent', 'codex:set-fast-intent']);
  assert.equal(h.state.busy, true);
});
