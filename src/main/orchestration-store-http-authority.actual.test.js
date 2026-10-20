'use strict';
// Real private HTTP + JSON store and actual outer WebServer callback. The
// diagnostics and unrelated renderer/provider dependencies are controlled.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), url = require('node:url'), vm = require('node:vm');
const ts = require('typescript');
const { OrchestrationRunStore } = require('./orchestration-runs');
const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const tree = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true);
const fn = name => tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
const handle = fn('handleApi'), start = fn('start');
assert(handle && start);
const readRoutes = handle.body.statements.filter(n => ts.isIfStatement(n) && [
  "parsed.pathname === '/api/orchestrations' && req.method === 'GET'",
  "parsed.pathname === '/api/orchestrations/settings' && req.method === 'GET'",
].includes(n.expression.getText(tree)));
assert.equal(readRoutes.length, 2);
let callback;
function walk(n) {
  if (ts.isCallExpression(n) && n.expression.getText(tree) === 'http.createServer') callback = n.arguments[0].getText(tree);
  ts.forEachChild(n, walk);
}
walk(start); assert(callback);
async function fixture(t) {
  const parent = path.join(os.homedir(), 'Library/Application Support/sc-desktop/test-artifacts/research-autonomy-20261019/http-load-tests');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(parent, 'own-')), file = path.join(root, 'runs.json');
  fs.writeFileSync(file, JSON.stringify({ version: 4, settings: { failureGraceMs: 4321 },
    createdTargetTabIds: [], targetActivityByTab: {}, runs: [{ runId: 'original', runKind: 'external-research',
      externalResearchJobId: 'noted_original', status: 'running', notifySource: false }] }));
  const bytes = fs.readFileSync(file), store = new OrchestrationRunStore(file);
  const read = fs.promises.readFile; let unavailable = true;
  fs.promises.readFile = async (...args) => {
    if (unavailable && args[0] === file) throw Object.assign(Error('owned transient read EIO'), { code: 'EIO' });
    return read(...args);
  };
  const context = vm.createContext({ http, url, process, Date, sdkSessions: {},
    webServerInstanceId: 'owned-web', webServerLastRequestAt: null, webServerLastRequest: null, webServerRequestCount: 0,
    httpReadDiagnostics: { run: (_req, _res, run) => run(), phase() {} },
    getOrchestrationRunStore: () => store, withOrchestrationUrls: value => value, decId: decodeURIComponent,
    sendJson: (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); },
    console: { error() {} }, serveStatic: () => assert.fail('API never serves static data'),
  });
  vm.runInContext('async function handleApi(req,res,parsed){' + readRoutes.map(n => n.getText(tree)).join('\n') + '}\nthis.callback=' + callback, context);
  const server = http.createServer(context.callback);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { fs.promises.readFile = read; server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await store.flush(); fs.rmSync(root, { recursive: true }); });
  return { store, context, file, bytes, recover: () => { unavailable = false; },
    get: async route => { const r = await fetch('http://127.0.0.1:' + server.address().port + route);
      return { status: r.status, body: await r.json() }; } };
}
for (const route of ['/api/orchestrations', '/api/orchestrations/settings']) {
  test('actual HTTP exposes load-unavailable identity then recovers original registry: ' + route, async t => {
    const f = await fixture(t), failed = await f.get(route);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.code, 'orchestration_store_unavailable'); assert.equal(failed.body.retryable, true);
    assert.deepEqual(fs.readFileSync(f.file), f.bytes); assert.equal(f.store.runs.size, 0);
    f.recover(); const recovered = await f.get(route); assert.equal(recovered.status, 200); assert.equal(recovered.body.ok, true);
    assert.equal((await f.store.getInternal('original')).externalResearchJobId, 'noted_original');
    assert.equal((await f.store.getSettings()).failureGraceMs, 4321);
  });
}
test('unrelated handler errors keep their existing generic500 contract', async t => {
  const f = await fixture(t);
  f.context.handleApi = async () => { throw Object.assign(Error('owned unrelated failure'), { code: 'other_error', statusCode: 418 }); };
  const r = await f.get('/api/orchestrations');
  assert.equal(r.status, 500); assert.deepEqual(r.body, { error: 'owned unrelated failure' });
});
