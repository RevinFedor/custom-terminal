'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { ROUTE_ENV } = require('./codex-auth-profile-route');

// Actual Main configuration/capture, generation and payload-consumption functions.
// No Electron, real credentials, provider, filesystem profile or process lookup.
const mainPath = process.env.CODEX_AUTH_MAIN_SOURCE || path.join(__dirname, 'main.js');
const source = fs.readFileSync(mainPath, 'utf8');
const ast = ts.createSourceFile(mainPath, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
const wanted = ['createConfiguredCodexAuthProfileRoute', 'getTerminalLifecycleGeneration', 'clearCodexLaunchPayload'];
const functions = wanted.map(name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return source.slice(node.getStart(ast), node.end);
}).join('\n');

function harness() {
  const terminal = { pid: 44 }, tab = 'T', cwd = '/fixture/project';
  const terminals = new Map([[tab, terminal]]), terminalProjects = new Map([[tab, cwd]]);
  const terminalCommandState = new Map([[tab, { runSeq: 1, isRunning: true }]]);
  const terminalLifecycleEpochs = new WeakMap([[terminal, 'physical-one']]);
  const codexLastRunCommandPayload = new Map([[tab, { launchId: 'L1', command: 'codex-c', sessionId: 'S1' }]]);
  let reads = 0;
  let auth = { accessToken: 'only-fixture-token', accountId: 'fixture-account', accountKey: 'aaaaaaaaaaaaaaaa', accessExpiresAtMs: 9e15 };
  const noop = () => {};
  const context = vm.createContext({ path, crypto: require('node:crypto'), process: { env: { NOTED_E2E_TEST: 'true' } },
    isDev: true, srcMainDir: __dirname, terminals, terminalProjects, terminalCommandState, terminalLifecycleEpochs,
    codexLastRunCommandPayload, codexPreclaimedCommandGenerations: new Map(),
    getMainProcessEnvValue: () => '/fixture/config.json',
    fs: { readFileSync: () => JSON.stringify({ homePath: '/authorized/profile', accountKey: auth.accountKey, fixtureCwd: cwd }), realpathSync: p => p },
    require: name => name.endsWith('e2e-cli-isolation') ? { assertE2ECliIsolation: () => ({ root: '/fixture' }) } : require(name),
    codexDataModule: { _api: { readCodexAuthSession: () => { reads++; return auth; } } },
    clearCodexServiceTierLaunchCandidate: noop, clearCodexPendingModelMigration: noop,
    clearCodexStartupNoStateTimeoutTimer: noop, clearCodexLaunchAcceptancePending: noop,
    console: { log: noop },
  });
  vm.runInContext(functions, context);
  const route = vm.runInContext('createConfiguredCodexAuthProfileRoute()', context);
  route.launchOverrides(tab, 'http://127.0.0.1:4999/codex/t/T');
  const headers = () => ({ authorization: 'Bearer ' + route.childEnvironment()[ROUTE_ENV] });
  return { route, terminals, terminal, terminalProjects, terminalCommandState, terminalLifecycleEpochs, codexLastRunCommandPayload,
    headers, reads: () => reads, setAuth: patch => { auth = { ...auth, ...patch }; },
    clear: () => vm.runInContext('clearCodexLaunchPayload("T", "source-proof-replay-task_started", "L1")', context),
    http: () => route.authorizeRequest(tab, '/_noted_profile/L1/responses', headers()),
  };
}

test('actual Main: initial registered launch is authorized', () => {
  const h = harness(); assert.equal(h.http().headers.authorization, 'Bearer only-fixture-token');
});
test('actual Main: tool continuation survives real startup-payload consumption', () => {
  const h = harness(); h.http(); assert.equal(h.clear(), true); assert.equal(h.codexLastRunCommandPayload.has('T'), false);
  assert.equal(h.http().headers.authorization, 'Bearer only-fixture-token');
  assert.equal(h.http().launchId, 'L1');
});
test('actual Main: existing WebSocket frame assertion survives payload consumption', () => {
  const h = harness(); h.http(); h.clear(); assert.doesNotThrow(() => h.route.assertCurrent('T', 'L1'));
});
for (const [name, mutate] of [
  ['new run on same PTY', h => h.terminalCommandState.get('T').runSeq++],
  ['new physical generation', h => h.terminalLifecycleEpochs.set(h.terminal, 'physical-two')],
  ['replaced terminal object', h => { const t={pid:44};h.terminals.set('T',t);h.terminalLifecycleEpochs.set(t,'physical-one'); }],
  ['changed cwd', h => h.terminalProjects.set('T','/other')],
  ['explicit replacement launch', h => h.codexLastRunCommandPayload.set('T',{launchId:'L2'})],
  ['unknown launch record', h => h.codexLastRunCommandPayload.set('T',{})],
]) test('actual Main: cleared payload does not authorize '+name, () => {
  const h=harness();h.clear();mutate(h);const before=h.reads();
  assert.throws(h.http,e=>e.code==='codex_auth_route_owner_changed');assert.equal(h.reads(),before);
});
test('actual Main: stopped command refuses before credential read, even with startup payload retained', () => {
  const h=harness();h.terminalCommandState.get('T').isRunning=false;const before=h.reads();
  assert.throws(h.http,e=>e.code==='codex_auth_route_owner_changed');assert.equal(h.reads(),before);
});
test('actual Main: incomplete physical generation is not a substitute for a consumed payload', () => {
  const h=harness();h.clear();h.terminalCommandState.get('T').runSeq=0;
  assert.throws(h.http,e=>e.code==='codex_auth_route_owner_changed');
});
test('actual Main: complete physical proof does not authorize another URL launch', () => {
  const h=harness();h.clear();assert.throws(()=>h.route.authorizeRequest('T','/_noted_profile/OLD/responses',h.headers()),e=>e.code==='codex_auth_route_owner_changed');
});
test('actual Main: token rotation works after adoption, account change still rejects', () => {
  const h=harness();h.clear();h.setAuth({accessToken:'rotated-fixture-token'});
  assert.equal(h.http().headers.authorization,'Bearer rotated-fixture-token');
  h.setAuth({accountKey:'bbbbbbbbbbbbbbbb'});assert.throws(h.http,e=>e.code==='codex_auth_profile_changed');
});
