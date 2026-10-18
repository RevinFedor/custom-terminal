'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ScExternalResearchClient } = require('./sc-external-research-client');
const { ExternalResearchCoordinator } = require('./external-research-coordinator');
const { OrchestrationRunStore } = require('./orchestration-runs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const capabilities = { navigation: { version: 1, renderedAck: true },
  browserNavigation: { version: 1, exactJob: true, confirmedTab: true },
  browserSelection: { version: 1, field: 'browserId', jobOwnerPinned: true, offlinePreflight: true, jobMetadataReadOnly: true } };

async function within(promise, ms = 1000) {
  let timer;
  try {
    return await Promise.race([promise.then(value => ({ settled: true, value }), error => ({ settled: true, error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false }), ms); })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t, targetPath) {
  const headers = deferred(), calls = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    req.resume(); const pathname = new URL(req.url, 'http://private').pathname; calls.push(pathname);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (pathname === targetPath) { res.flushHeaders(); res.write('{"pending":'); }
    else res.end(JSON.stringify(capabilities));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = async () => { for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve)); };
  t.after(close);
  const client = new ScExternalResearchClient({ baseUrl: 'http://127.0.0.1:' + server.address().port,
    capabilityTimeoutMs: 75, startTimeoutMs: 75, statusOverheadMs: 75, stopTimeoutMs: 75,
    fetchImpl: async (...args) => {
      const response = await fetch(...args);
      if (new URL(args[0]).pathname === targetPath) headers.resolve();
      return response;
    } });
  return { client, calls, headers: headers.promise, close };
}

const methods = {
  capabilities: client => options => client.capabilities(options),
  start: client => options => client.start({ jobId: 'private-job', provider: 'chatgpt', prompt: 'fixture' }, options),
  status: client => options => client.status('private-job', options),
  jobMetadata: client => options => client.jobMetadata('private-job', { ...options, capabilities }),
  stop: client => options => client.stop('private-job', options),
  openJob: client => options => client.openJob('private-job', { ...options, requestId: 'nav' }),
  openBrowser: client => options => client.openBrowser('private-job', { ...options, requestId: 'nav' }),
};
const paths = { capabilities: '/research-capabilities', start: '/research-start', status: '/research-status',
  jobMetadata: '/research-status', stop: '/research-stop', openJob: '/research-open', openBrowser: '/research-open-browser' };

for (const method of Object.keys(methods)) test('actual HTTP body remains abortable after headers: ' + method, async t => {
  const h = await fixture(t, paths[method]);
  // Leave ample room for the explicit abort; this case is not a timeout check.
  h.client.capabilityTimeoutMs = h.client.startTimeoutMs = h.client.statusOverheadMs = h.client.stopTimeoutMs = 10000;
  const abort = new AbortController(), pending = methods[method](h.client)({ signal: abort.signal });
  const outcome = within(pending);
  await h.headers;
  await new Promise(setImmediate); // _request has returned headers; body is still pending.
  abort.abort();
  const result = await outcome;
  assert.equal(result.settled, true, 'abort must finish body consumption, not just fetch headers');
  assert.ok(result.error); assert.equal(h.calls.filter(value => value === paths[method]).length, 1);
});

for (const method of ['capabilities', 'start', 'status', 'jobMetadata', 'stop']) test('actual HTTP body uses the existing deadline: ' + method, async t => {
  const h = await fixture(t, paths[method]);
  const result = await within(methods[method](h.client)({}));
  assert.equal(result.settled, true, 'partial body must not wait forever');
  assert.equal(result.error?.code, 'sc_research_request_timeout');
  assert.equal(h.calls.length, 1);
});

test('real coordinator shutdown cancels a watcher blocked after SC status headers', async t => {
  const h = await fixture(t, '/research-status');
  h.client.statusOverheadMs = 10000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-body-stop-'));
  const store = new OrchestrationRunStore(path.join(dir, 'runs.json'));
  await store.reserveOrGet({ runId: 'R', runKind: 'external-research', requestFingerprint: 'F',
    sourceTabId: 'source', notifySource: false, externalResearchJobId: 'J',
    externalResearchIntent: { provider: 'chatgpt', prompt: 'fixture', options: {}, files: [] } });
  const coordinator = new ExternalResearchCoordinator({ store, client: h.client });
  t.after(async () => { await h.close(); await coordinator.stop(); await store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  coordinator.watch('R'); await h.headers; await new Promise(setImmediate);
  const result = await within(coordinator.stop());
  assert.equal(result.settled, true); assert.equal(coordinator.watchers.size, 0);
  assert.deepEqual(h.calls, ['/research-status']);
  assert.notEqual((await store.get('R')).status, 'completed');
});

test('all public methods preserve JSON results and typed HTTP errors over real loopback', async t => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://private'); seen.push({ path: url.pathname, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    if (url.searchParams.get('id') === 'missing') {
      res.writeHead(404); res.end(JSON.stringify({ code: 'job_not_found', error: 'absent job' })); return;
    }
    if (url.pathname === '/research-capabilities') res.end(JSON.stringify(capabilities));
    else if (url.pathname.startsWith('/research-open')) res.end(JSON.stringify({ ok: true, opened: true,
      jobId: 'private-job', requestId: 'nav', tabId: 7 }));
    else res.end(JSON.stringify({ id: 'private-job', status: 'running',
      ...(url.searchParams.get('metadataOnly') === 'true' ? { metadataOnly: true, metadataSource: 'memory' } : {}) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const client = new ScExternalResearchClient({ baseUrl: 'http://127.0.0.1:' + server.address().port });
  for (const method of Object.keys(methods)) {
    const result = await methods[method](client)({});
    if (method === 'capabilities') assert.equal(result.navigation.version, 1);
    else if (method.startsWith('open')) assert.equal(result.opened, true);
    else assert.equal(result.id, 'private-job');
  }
  await assert.rejects(client.status('missing'), error => error.status === 404
    && error.code === 'job_not_found' && error.message === 'absent job');
  assert.equal(seen.filter(row => row.path === '/research-start').length, 1);
  assert.equal(seen.find(row => row.path === '/research-start').body.requestId, 'private-job');
});
