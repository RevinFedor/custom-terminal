'use strict';
// Actual current API route bodies + HTTP + JSON persistence. Authentication,
// renderer, provider and physical input are independent controlled leaves.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), vm = require('node:vm'), ts = require('typescript');
const { OrchestrationRunStore } = require('./orchestration-runs');
const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const tree = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true);
const handle = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleApi');
const routes = handle.body.statements.filter(n => ts.isIfStatement(n) && n.expression.getText(tree).includes("parsed.pathname === '/api/orchestrations/maintenance'"));
assert.equal(routes.length, 2);
async function fixture(t) {
  const parent = path.join(os.homedir(), 'Library/Application Support/sc-desktop/test-artifacts/research-autonomy-20261019');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'maintenance-http-')), file = path.join(root, 'runs.json');
  let store = new OrchestrationRunStore(file);
  await store.updateSettings({ externalResearchOperationalPrompts: true });
  const context = vm.createContext({ getOrchestrationRunStore: () => store,
    readBody: async req => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body); },
    sendJson: (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } });
  vm.runInContext('this.route=async function(req,res,parsed){' + routes.map(n => n.getText(tree)).join('\n') + '}', context);
  const server = http.createServer((req, res) => {
    context.route(req, res, { pathname: new URL(req.url, 'http://127.0.0.1').pathname })
      .catch(error => { res.writeHead(error.statusCode || 500); res.end(JSON.stringify({ code: error.code })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = async body => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/orchestrations/maintenance',
      body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await store.flush(); fs.rmSync(root, { recursive: true }); });
  return { request, file, get store() { return store; }, reopen: async () => { await store.flush(); store = new OrchestrationRunStore(file); } };
}
test('operator HTTP begin, restart, exact complete and duplicate begin preserve the same quiet operation', async t => {
  const f = await fixture(t);
  const begin = await f.request({ version: 1, action: 'begin', operationId: 'install:http:1' });
  assert.equal(begin.status, 200); assert.equal(begin.body.maintenance.activeOperationId, 'install:http:1');
  await f.reopen();
  assert.equal((await f.request()).body.maintenance.activeOperationId, 'install:http:1');
  const other = await f.request({ version: 1, action: 'begin', operationId: 'install:http:other' });
  assert.equal(other.status, 409); assert.equal(other.body.code, 'research_maintenance_busy');
  const end = await f.request({ version: 1, action: 'complete', operationId: 'install:http:1' });
  assert.equal(end.status, 200); assert.equal(end.body.maintenance.activeOperationId, null);
  const repeated = await f.request({ version: 1, action: 'begin', operationId: 'install:http:1' });
  assert.equal(repeated.body.maintenance.repeated, true); assert.equal(repeated.body.maintenance.activeOperationId, null);
});
test('operator HTTP rejects a missing version or wrong owner without altering active maintenance', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ action: 'begin', operationId: 'install:http:bad' })).status, 400);
  assert.equal((await f.request()).body.maintenance.activeOperationId, null);
  await f.request({ version: 1, action: 'begin', operationId: 'install:http:2' });
  assert.equal((await f.request({ version: 1, action: 'complete', operationId: 'wrong-owner' })).status, 409);
  assert.equal((await f.request()).body.maintenance.activeOperationId, 'install:http:2');
});
test('operator HTTP cannot ACK a failed strict begin write, same-ID retry durably recovers it', async t => {
  const f = await fixture(t), rename = fs.promises.rename;
  fs.promises.rename = async (...args) => { if (args[1] === f.file) throw Object.assign(Error('owned HTTP commit EIO'), { code: 'EIO' }); return rename(...args); };
  let failed;
  try { failed = await f.request({ version: 1, action: 'begin', operationId: 'install:http:3' }); }
  finally { fs.promises.rename = rename; }
  assert.equal(failed.status, 503); assert.equal(failed.body.code, 'EIO');
  const recovered = await f.request({ version: 1, action: 'begin', operationId: 'install:http:3' });
  assert.equal(recovered.status, 200); assert.equal(recovered.body.maintenance.repeated, true);
  await f.reopen(); assert.equal((await f.request()).body.maintenance.activeOperationId, 'install:http:3');
});
