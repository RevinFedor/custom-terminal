'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const http = require('node:http');
const { createClaudeSettingsSendRuntime } = require('./claude-settings-send');

const main = fs.readFileSync(require.resolve('./main'), 'utf8');
const app = fs.readFileSync(require.resolve('../renderer/App.tsx'), 'utf8');
const ast = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let branch;
const visit = node => {
  if (ts.isIfStatement(node) && node.expression.getText(ast) === "action === 'setSDKParams'") branch = node.thenStatement.getText(ast);
  ts.forEachChild(node, visit);
};
visit(ast);
assert.ok(branch, 'test must execute the real App bridge action');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

function harness(overrides = {}) {
  const start = main.indexOf('const pasteInflight = new WeakMap();');
  const end = main.indexOf('\nfunction markActivePtySubmit(', start);
  const queue = vm.runInNewContext(main.slice(start, end) + '\n({withPtyWriteLock})');
  const term = {}, commands = [], calls = [];
  const runtime = createClaudeSettingsSendRuntime({
    getTerminal: () => term, withWriteLock: queue.withPtyWriteLock,
    captureRuntime: () => ({ term }), isRuntimeCurrent: () => true,
    sendCommand: async (_tab, command) => { commands.push(command); return { success: true }; },
    readProof: async () => ({ success: true }), settleClaim() {},
    confirmDialog: () => assert.fail('no picker in this fixture'),
    retryExactInput: () => assert.fail('no retry after a terminal result'),
    ...overrides,
  });
  const maps = { __modelSentForTab: new Map(), __effortSentForTab: new Map() };
  const context = vm.createContext({
    console: { log() {}, warn() {} }, window: maps, Date, Map,
    state: { openProjects: new Map([['P', { tabs: new Map([['T', { commandType: 'claude' }]]) }]]) },
    resolvePtyAgentOwner: () => 'claude', reply: (success, data, error) => ({ success, data, error }),
    applyClaudePtySetting: request => { calls.push(['single', request]); return runtime.applySetting(request); },
    applyClaudePtySettings: request => { calls.push(['batch', request]); return runtime.applySettings(request); },
  });
  vm.runInContext(ts.transpileModule('async function invoke(payload) ' + branch, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return { invoke: context.invoke, runtime, maps, commands, calls };
}

test('actual App model/effort request stays one PTY owner against a concurrent external setting', async () => {
  const started = deferred(), release = deferred();
  let first = true;
  const h = harness({ readProof: async () => {
    if (first) { first = false; started.resolve(); await release.promise; }
    return { success: true };
  } });
  const request = h.invoke({ tabId: 'T', model: 'A', effort: 'low' });
  await started.promise;
  const external = h.runtime.applySetting({ tabId: 'T', kind: 'effort', value: 'high', source: 'other-client' });
  release.resolve();
  const result = await request;
  await external;
  assert.equal(result.success, true);
  assert.deepEqual(h.commands, ['/model A', '/effort low', '/effort high']);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], 'batch');
});

test('actual API partial failure keeps the confirmed model and reports the rejected effort without retry', async () => {
  const h = harness({ readProof: async ({ command }) => command.startsWith('/effort')
    ? { success: false, terminal: true, failureCode: 'claude_rate_limit', outputText: 'API error: 429' }
    : { success: true } });
  h.maps.__effortSentForTab.set('T', { level: 'before' });
  const result = await h.invoke({ tabId: 'T', model: ' B ', effort: 'max' });
  assert.equal(result.success, false);
  assert.equal(result.data.appliedSettings.model, 'B');
  assert.equal(result.data.appliedSettings.effort, undefined);
  assert.equal(h.maps.__modelSentForTab.get('T').model, 'B');
  assert.equal(h.maps.__effortSentForTab.get('T').level, 'before');
  assert.deepEqual(h.commands, ['/model B', '/effort max']);
});

test('a failed older API request cannot roll back a newer client UI mirror', async () => {
  let h;
  h = harness({ readProof: async () => {
    h.maps.__modelSentForTab.set('T', { model: 'newer', via: 'other-client' });
    return { success: false, terminal: true, outputText: 'rejected' };
  } });
  const result = await h.invoke({ tabId: 'T', model: 'A' });
  assert.equal(result.success, false);
  assert.equal(h.maps.__modelSentForTab.get('T').model, 'newer');
});

test('invalid half of an API pair is rejected before any setting command', async () => {
  const h = harness();
  const result = await h.invoke({ tabId: 'T', model: null, effort: 'high' });
  assert.equal(result.success, false);
  assert.deepEqual(h.commands, []);
});

async function httpFixture(t, bridgeRequest) {
  const web = fs.readFileSync(require.resolve('./web-server'), 'utf8');
  const marker = "m = parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/params$/);";
  const start = web.indexOf(marker);
  const end = web.indexOf('\n  // Fast is a durable desired state.', start);
  assert.ok(start >= 0 && end > start, 'actual params HTTP route');
  const context = vm.createContext({
    bridgeRequest, decId: decodeURIComponent,
    prepareClosedCodexSettings: async () => ({ restored: false }),
    findOrchestrationTabDescriptor() {}, findRestorableAgentTabDescriptor() {}, ensureExplicitAgentTabOpen() {},
    readBody: async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()); },
    sendJson: (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
  });
  vm.runInContext('async function handle(req, res, parsed) { let m; ' + web.slice(start, end) + ' }', context);
  const server = http.createServer((req, res) => context.handle(req, res, new URL(req.url, 'http://fixture')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return async () => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/terminal-tabs/T/params', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'B', effort: 'max' }),
    });
    return { status: response.status, body: await response.json() };
  };
}

test('actual HTTP→App→main pair preserves confirmed half on a terminal settings failure', async t => {
  const h = harness({ readProof: async ({ command }) => command.startsWith('/effort')
    ? { success: false, terminal: true, failureCode: 'claude_rate_limit', outputText: 'API error: 429' }
    : { success: true } });
  const request = await httpFixture(t, async (_action, payload) => {
    const reply = await h.invoke(payload);
    if (!reply.success) throw Object.assign(new Error(reply.error), { bridgeData: reply.data });
    return reply.data;
  });
  const result = await request();
  assert.equal(result.status, 409);
  assert.deepEqual(result.body.appliedSettings, { model: 'B' });
  assert.equal(result.body.failedCommand, '/effort max');
  assert.equal(result.body.code, 'claude_rate_limit');
  assert.deepEqual(h.commands, ['/model B', '/effort max']);
});

test('HTTP unknown delivery or foreign bridge data never fabricates a partial settings result', async t => {
  let error = Object.assign(new Error('Bridge timeout'), { code: 'bridge_timeout' });
  const request = await httpFixture(t, async () => { throw error; });
  assert.equal(Object.hasOwn((await request()).body, 'appliedSettings'), false);
  error = Object.assign(new Error('foreign'), { bridgeData: { tabId: 'another', appliedSettings: { model: 'B' } } });
  assert.equal(Object.hasOwn((await request()).body, 'appliedSettings'), false);
});
