'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const ts = require('typescript');
const runs = require('./orchestration-runs');
const { isResponseObservation } = require('./orchestration-response-observation');
const { ExternalResearchCoordinator } = require('./external-research-coordinator');
const { ScExternalResearchHttpError } = require('./sc-external-research-client');
const source = fs.readFileSync(require.resolve('./web-server'), 'utf8');
const ast = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const notFound = () => new ScExternalResearchHttpError('missing', { status: 404 });
const forbidden = () => assert.fail('no real provider/input/Stop in this private fixture');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-cancel-start-'));
  const file = path.join(dir, 'runs.json');
  const store = new runs.OrchestrationRunStore(file);
  await store.reserveOrGet({ runId: 'R', runKind: 'external-research', requestFingerprint: 'immutable-request',
    sourceTabId: 'source', targetTabId: null, sourceSessionId: 'S', sourceSendTarget: { toolType: 'codex', sessionId: 'S' },
    notifySource: true, externalResearchJobId: 'noted_R',
    externalResearchIntent: { provider: 'chatgpt', prompt: 'private fixture', options: {}, files: [] } });
  const emissions = [], finalizations = [], starts = [];
  const ctx = vm.createContext({ ...runs, isResponseObservation,
    require, path, srcMainDir: __dirname, agentSendReceiptStore: null, agentSendQueue: null,
    isAgentSendProviderQueueAccepted: require('./agent-send-receipt-registry').isAgentSendProviderQueueAccepted,
    getOrchestrationRunStore: () => store, withOrchestrationUrls: value => value,
    emitOrchestrationRun: value => emissions.push(value),
    emitOrchestrationChanges: values => emissions.push(...values),
    finalizeSettledOrchestrations: async values => { finalizations.push(...values); },
    dispatchNextDeferredOrchestrationForTarget: async tabId => { assert.equal(tabId, null); },
    scheduleOrchestrationPolicyTimer() {}, runAgentInterruptScenario: forbidden, getScExternalResearchClient: forbidden,
    decId: decodeURIComponent, cleanOptionalString: (value, fallback) => typeof value === 'string' ? value : fallback,
    readBody: async req => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body); },
    sendJson: (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); },
  });
  const action = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'performOrchestrationAction');
  const cancelReceipt = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'externalResearchCancellationReceipt');
  const begin = source.indexOf('  const orchestrationCancelMatch =');
  const end = source.indexOf('  const orchestrationAckMatch =', begin);
  assert.ok(action && begin > 0 && end > begin);
  assert.ok(cancelReceipt);
  vm.runInContext(cancelReceipt.getText(ast) + '\n' + action.getText(ast) + '\nasync function route(req,res,parsed){' + source.slice(begin, end) + '}', ctx);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://private');
    ctx.route(req, res, { pathname: url.pathname }).catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/orchestrations/R/';
  const coordinator = new ExternalResearchCoordinator({ store, longPollMs: 0,
    client: { status: async () => { throw notFound(); }, start: async request => {
      starts.push(request); return { id: request.jobId, status: 'done', result: { text: 'done' } };
    } }, emitChanges: values => emissions.push(...values), finalizeSettled: async value => finalizations.push(value) });
  t.after(async () => { await coordinator.stop(); await store.flush();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, file, coordinator, starts, emissions, finalizations,
    cancel: async (kind = 'detach') => {
      const response = await fetch(endpoint + (kind === 'detach' ? 'action' : 'cancel'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'detach' ? { action: 'detach' } : { interrupt: false }) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.run.status, 'cancelled');
      await store.flush();
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).runs.find(run => run.runId === 'R').status, 'cancelled');
      return result;
    } };
}

for (const stage of ['status', 'patch-initialize', 'persist']) for (const action of ['detach', 'cancel']) {
  test('actual HTTP ' + action + ' during ' + stage + ' forbids first research start and terminal resurrection', async t => {
    const h = await fixture(t), entered = deferred(), release = deferred();
    let held = false;
    if (stage === 'status') h.coordinator.client.status = async () => {
      entered.resolve(); await release.promise; throw notFound();
    };
    if (stage === 'patch-initialize') {
      const initialize = h.store.initialize.bind(h.store), patch = h.store.patch.bind(h.store);
      let patchEntering = false;
      h.store.patch = (...args) => { patchEntering = true; const result = patch(...args); patchEntering = false; return result; };
      // Capture the call before its first await; the wrapper is a controlled I/O boundary.
      h.store.initialize = (() => { const original = initialize; return async () => {
        const hold = patchEntering && !held; if (hold) held = true;
        await original(); if (hold) { entered.resolve(); await release.promise; }
      }; })();
    }
    if (stage === 'persist') {
      const persist = h.store.persistStrict.bind(h.store);
      h.store.persistStrict = async () => {
        if (!held && h.store.runs.get('R')?.status === 'sending') {
          held = true; entered.resolve(); await release.promise;
        }
        return persist();
      };
    }
    const watching = h.coordinator.watch('R');
    try { await entered.promise; await h.cancel(action); }
    finally { release.resolve(); }
    await watching;
    assert.equal(h.starts.length, 0, 'cancelled reservation must not create its first SC job');
    assert.equal((await h.store.get('R')).status, 'cancelled');
    assert.equal(h.emissions.some(run => run.status === 'sending' && run.notificationSuppressed === true), false);
    await h.store.persistStrict();
    const restored = new runs.OrchestrationRunStore(h.file);
    assert.equal((await restored.get('R')).status, 'cancelled');
    await restored.flush();
  });
}

test('normal research starts once with the frozen identity and finishes through the real store', async t => {
  const h = await fixture(t);
  await h.coordinator.watch('R');
  assert.deepEqual(h.starts.map(value => value.jobId), ['noted_R']);
  assert.equal(h.starts[0].prompt, 'private fixture');
  const result = await h.store.get('R');
  assert.equal(result.status, 'completed'); assert.equal(result.sourceSendTarget.sessionId, 'S');
});

test('late existing final after HTTP detach never starts or reactivates the run', async t => {
  const h = await fixture(t), entered = deferred(), release = deferred();
  h.coordinator.client.status = async jobId => {
    entered.resolve(); await release.promise; return { id: jobId, status: 'done', result: { text: 'late' } };
  };
  const watching = h.coordinator.watch('R');
  try { await entered.promise; await h.cancel(); } finally { release.resolve(); }
  await watching;
  assert.equal(h.starts.length, 0); assert.equal((await h.store.get('R')).status, 'cancelled');
  assert.equal(h.finalizations.some(run => run.status === 'completed'), false);
});

test('detach after the network start boundary preserves cancellation without pretending no request happened', async t => {
  const h = await fixture(t), entered = deferred(), release = deferred();
  h.coordinator.client.start = async request => {
    h.starts.push(request); entered.resolve(); await release.promise;
    return { id: request.jobId, status: 'done', result: { text: 'already started' } };
  };
  const watching = h.coordinator.watch('R');
  try { await entered.promise; await h.cancel(); } finally { release.resolve(); }
  await watching;
  assert.equal(h.starts.length, 1); assert.equal((await h.store.get('R')).status, 'cancelled');
});

test('coordinator shutdown while status is pending cannot launch a first job after that await', async t => {
  const h = await fixture(t), entered = deferred(), release = deferred();
  h.coordinator.client.status = async () => { entered.resolve(); await release.promise; throw notFound(); };
  const watching = h.coordinator.watch('R'); await entered.promise;
  const stopping = h.coordinator.stop(); release.resolve(); await stopping; await watching;
  assert.equal(h.starts.length, 0);
});

for (const status of ['completed', 'failed', 'cancelled']) test('optional store guard protects terminal ' + status + ' without changing legacy patch', async t => {
  const h = await fixture(t);
  await h.store.patch('R', { status });
  assert.equal(await h.store.patch('R', { status: 'sending' }, { unlessTerminal: true }), null);
  assert.equal((await h.store.get('R')).status, status);
  assert.equal((await h.store.patch('R', { fixtureMetadata: true })).fixtureMetadata, true,
    'ordinary callers can still update non-admission metadata');
});

for (const replacement of ['job', 'kind', 'missing']) test('final start check refuses changed ' + replacement + ' after persistence', async t => {
  const h = await fixture(t);
  const persist = h.store.persistStrict.bind(h.store); let changed = false;
  h.store.persistStrict = async () => {
    await persist();
    if (changed) return; changed = true;
    if (replacement === 'missing') h.store.runs.delete('R');
    else await h.store.patch('R', replacement === 'job'
      ? { externalResearchJobId: 'different-job' } : { runKind: 'agent' });
  };
  await h.coordinator.watch('R');
  assert.equal(h.starts.length, 0);
});
