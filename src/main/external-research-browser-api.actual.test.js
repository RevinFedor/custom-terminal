const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const request = require('./external-research-request');
const { OrchestrationRunStore } = require('./orchestration-runs');
const { ScExternalResearchClient } = require('./sc-external-research-client');
const { ExternalResearchCoordinator } = require('./external-research-coordinator');
const { BROWSER_SELECTION_CAPABILITY } = require('./external-research-browser');

const CHROME = '8a72840e-1776-4ba4-a04f-04c24f3ef53d';
const YANDEX = '37c26a49-3eda-4eb3-b7ba-c8cdeb9afea5';
const caps = { version: 1, idempotentRequestId: true, providers: ['chatgpt'], statusRecovery: ['durable-request'],
  continuation: { conversationUrl: true, separateJobPerTurn: true }, browserSelection: {
    ...BROWSER_SELECTION_CAPABILITY, jobMetadataReadOnly: true,
    configuredTargets: { version: 1, state: 'known', primaryInstanceId: YANDEX, aliases: { chrome: CHROME, yandex: YANDEX } },
  } };
const source = fs.readFileSync(require.resolve('./web-server'), 'utf8');
const ast = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true);
const actual = name => {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
};
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-browser-api-'));
  const store = new OrchestrationRunStore(path.join(dir, 'runs.json'));
  const scRequests = [], starts = [], notices = [], changes = [];
  const state = { capabilities: structuredClone(caps), metadata: { id: 'noted_prior', status: 'done', browserInstanceId: CHROME,
    metadataOnly: true, metadataSource: 'durable' },
    sourceCaptures: 0 };
  const sc = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const url = new URL(req.url, 'http://own-sc');
    scRequests.push({ method: req.method, url: req.url });
    if (url.pathname === '/research-capabilities') return json(res, 200, state.capabilities);
    if (url.searchParams.get('metadataOnly') === 'true') return json(res, state.metadata ? 200 : 404, state.metadata || { error: 'missing' });
    if (req.method === 'GET') {
      if (state.snapshotOverride) return json(res, 200, state.snapshotOverride);
      const id = url.searchParams.get('id'), started = starts.find(item => item.requestId === id);
      return json(res, started ? 200 : 404, started ? { id, status: 'done', browserInstanceId: started.browserId || YANDEX,
        conversationUrl: 'https://chatgpt.com/c/own-conversation', result: { text: 'fixture result' } } : { error: 'missing' });
    }
    const body = JSON.parse(text); starts.push(body);
    return json(res, 200, { id: body.requestId, status: 'running', browserInstanceId: body.browserId || YANDEX });
  });
  await new Promise(resolve => sc.listen(0, '127.0.0.1', resolve));
  const client = new ScExternalResearchClient({ baseUrl: 'http://127.0.0.1:' + sc.address().port });
  const ctx = vm.createContext({ ...request, require, crypto, ExternalResearchCoordinator, ScExternalResearchClient,
    externalResearchCoordinator: null, scExternalResearchClient: client,
    getOrchestrationRunStore: () => store, console,
    userNotificationOutbox: { enqueue: async envelope => { notices.push(envelope); return { ok: true, durable: true }; } },
    emitOrchestrationChanges: runs => changes.push(...runs), emitOrchestrationRun: run => changes.push(run),
    finalizeSettledOrchestration: async () => {},
    cleanOptionalString: (value, fallback) => typeof value === 'string' ? value.trim() : fallback,
    findOrchestrationTabDescriptor: id => id === 'own-source'
      ? { tabName: 'Own source', projectId: 'own-project', toolType: 'codex' } : null,
    resolveCausalSourceExecutionContext: () => ({ provider: 'codex', sessionId: 'own-S', turnId: 'own-turn' }),
    getAgentExecutionContext: () => null,
    captureOrchestrationSourceTarget: async () => { state.sourceCaptures++; return { sessionId: 'own-S', toolType: 'codex' }; },
    withOrchestrationUrls: run => run,
    reconcileExternalResearchRun: id => store.get(id),
    isActiveStatus: require('./orchestration-runs').isActiveStatus,
    isScResearchTerminalStatus: require('./sc-external-research-client').isScResearchTerminalStatus,
    readBody: async req => { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text); },
    sendJson: json,
  });
  const begin = source.indexOf("  if (parsed.pathname === '/api/external-research/orchestrations' && req.method === 'POST') {");
  const end = source.indexOf('  const responseObservationMatch =', begin);
  assert.ok(begin > 0 && end > begin);
  vm.runInContext(['getScExternalResearchClient', 'getExternalResearchCoordinator', 'assertExternalResearchCapabilities']
    .map(actual).join('\n') + '\nasync function route(req,res,parsed) {' + source.slice(begin, end) + '}', ctx);
  vm.runInContext(['externalResearchAnswerText', 'boundedExternalResearchResult', 'readExternalResearchResult'].map(actual).join('\n'), ctx);
  const app = http.createServer((req, res) => {
    ctx.route(req, res, new URL(req.url, 'http://own-noted')).catch(error => json(res, 500, { error: error.message }));
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await ctx.externalResearchCoordinator?.stop(); await store.flush();
    for (const server of [app, sc]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, state, starts, scRequests, notices, changes,
    result: runId => ctx.readExternalResearchResult(runId, 1000),
    watch: runId => ctx.getExternalResearchCoordinator().watch(runId),
    post: async body => {
      const response = await fetch('http://127.0.0.1:' + app.address().port + '/api/external-research/orchestrations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceTabId: 'own-source', notifySource: false, ...body }) });
      return { status: response.status, body: await response.json() };
    },
    prior: async ({ legacy = false } = {}) => {
      await store.reserveOrGet({ runId: 'prior', runKind: 'external-research', sourceTabId: 'own-source', requestFingerprint: 'old',
        externalResearchJobId: 'noted_prior', externalResearchIntent: request.normalizeExternalResearchRequest({ prompt: 'old' }) });
      await store.applyExternalResearchSnapshot('prior', { id: 'noted_prior', status: 'done',
        ...(legacy ? {} : { browserInstanceId: CHROME }),
        conversationUrl: 'https://chatgpt.com/c/own-conversation', result: { text: 'old result' } });
    } };
}

test('completed result reader rejects foreign/missing browser and job proof without rewriting the saved completion', async t => {
  const h = await fixture(t);
  await h.post({ runId: 'read-final', prompt: 'x', browserId: 'chrome' }); await h.watch('read-final');
  for (const snapshot of [
    { id: 'noted_read-final', browserInstanceId: YANDEX },
    { id: 'noted_read-final' }, { id: 'wrong', browserInstanceId: CHROME },
  ]) {
    h.state.snapshotOverride = { ...snapshot, status: 'done', result: { text: 'foreign answer' } };
    const result = await h.result('read-final');
    assert.ok([409, 503].includes(result.statusCode)); assert.equal(result.body.ready, false);
    assert.equal(result.body.assistantText, undefined);
  }
  h.state.snapshotOverride = { id: 'noted_read-final', browserInstanceId: CHROME, status: 'done',
    browserAccount: { source: 'browser_auth_session', user_id: 'u', account_id: 'a', observed_at: 1000,
      binding: 'read', email: 'private@example.test', token: 'secret' }, result: { text: 'exact result' } };
  const exact = await h.result('read-final');
  assert.equal(exact.body.browserInstanceId, CHROME); assert.equal(exact.body.browserAccount.binding, 'read');
  assert.equal(exact.body.browserAccount.email, undefined); assert.equal(exact.body.browserAccount.token, undefined);
  assert.equal((await h.store.get('read-final')).status, 'completed');
});

test('actual Noted reservation and coordinator carry selected UUID with original intent and source unchanged', async t => {
  const h = await fixture(t);
  const ack = await h.post({ runId: 'selected-new', prompt: 'new fixture', browserId: 'chrome', notifySource: true });
  assert.equal(ack.status, 202, JSON.stringify(ack.body));
  await h.watch('selected-new');
  assert.equal(h.starts.length, 1); assert.equal(h.starts[0].browserId, CHROME);
  const run = await h.store.getInternal('selected-new');
  assert.equal(run.externalResearchIntent.browserId, 'chrome');
  assert.equal(run.externalResearchExpectedBrowserInstanceId, CHROME);
  assert.equal(run.externalResearchBrowserInstanceId, CHROME);
  assert.equal(run.sourceSendTarget.sessionId, 'own-S');
  assert.equal(h.state.sourceCaptures, 1); assert.equal(h.notices.length, 0);
  h.state.capabilities.browserSelection.configuredTargets.aliases.chrome = YANDEX;
  const count = h.scRequests.length;
  const replay = await h.post({ runId: 'selected-new', prompt: 'new fixture', browserId: 'chrome', notifySource: true });
  assert.equal(replay.status, 200); assert.equal(h.starts.length, 1);
  assert.equal(h.scRequests.length, count, 'same-ID retry does not re-resolve today\'s alias');
  const conflict = await h.post({ runId: 'selected-new', prompt: 'new fixture', browserId: 'yandex', notifySource: true });
  assert.equal(conflict.status, 409); assert.equal(h.starts.length, 1);
});

test('old SC explicit selection fails before durable reservation or start; omitted NEW default stays supported', async t => {
  const h = await fixture(t);
  delete h.state.capabilities.browserSelection;
  const refused = await h.post({ runId: 'old-selected', prompt: 'x', browserId: 'chrome' });
  assert.equal(refused.status, 503); assert.equal(refused.body.code, 'external_research_browser_update_required');
  assert.equal(await h.store.get('old-selected'), null); assert.equal(h.starts.length, 0);
  assert.equal((await h.post({ runId: 'old-default', prompt: 'x' })).status, 202);
  await h.watch('old-default');
  assert.equal(Object.hasOwn(h.starts[0], 'browserId'), false);
  assert.equal((await h.store.get('old-default')).status, 'completed');
});

for (const browserId of [undefined, 'chrome', CHROME]) {
  test('continue inherits exact previous job owner for selector=' + browserId, async t => {
    const h = await fixture(t); await h.prior();
    const ack = await h.post({ runId: 'followup', continueFromRunId: 'prior', prompt: 'follow-up', browserId });
    assert.equal(ack.status, 202, JSON.stringify(ack.body)); await h.watch('followup');
    assert.equal(h.starts[0].browserId, CHROME);
    assert.equal(h.starts[0].conversationUrl, 'https://chatgpt.com/c/own-conversation');
    assert.notEqual(h.starts[0].requestId, 'noted_prior');
    assert.equal(h.scRequests.some(req => req.url.includes('metadataOnly')), false);
  });
}

test('legacy continuation reads exact effect-free job metadata once, never primary/native history', async t => {
  const h = await fixture(t); await h.prior({ legacy: true });
  const ack = await h.post({ runId: 'legacy-followup', continueFromRunId: 'prior', prompt: 'x' });
  assert.equal(ack.status, 202, JSON.stringify(ack.body)); await h.watch('legacy-followup');
  assert.deepEqual(h.scRequests.filter(req => req.url.includes('noted_prior')), [
    { method: 'GET', url: '/research-status?id=noted_prior&metadataOnly=true' },
  ]);
  assert.equal(h.starts[0].browserId, CHROME);
  assert.equal((await h.store.get('prior')).externalResearchBrowserInstanceId, CHROME);
});

test('restored old continuation derives the previous owner without rewriting its original intent', async t => {
  const h = await fixture(t); await h.prior({ legacy: true });
  const intent = request.normalizeExternalResearchRequest({ prompt: 'saved follow-up', conversationUrl: 'https://chatgpt.com/c/own-conversation' });
  await h.store.reserveOrGet({ runId: 'restored-followup', runKind: 'external-research', requestFingerprint: 'old-fixed',
    sourceTabId: 'own-source', notifySource: false, externalResearchContinuedFromRunId: 'prior',
    externalResearchJobId: 'noted_restored-followup', externalResearchIntent: intent });
  await h.watch('restored-followup');
  assert.equal(h.starts.length, 1); assert.equal(h.starts[0].browserId, CHROME);
  assert.deepEqual((await h.store.getInternal('restored-followup')).externalResearchIntent, intent);
  assert.equal(h.scRequests.filter(req => req.url.includes('metadataOnly=true')).length, 1);
});

for (const scenario of ['mismatch', 'mapping-unavailable', 'mapping-missing', 'owner-missing', 'foreign-job', 'old-metadata', 'metadata-not-confirmed']) {
  test('continuation refuses ' + scenario + ' before reservation/provider dispatch', async t => {
    const h = await fixture(t); await h.prior({ legacy: true });
    let browserId;
    if (scenario === 'mismatch') browserId = 'yandex';
    if (scenario === 'mapping-unavailable') { browserId = 'chrome'; h.state.capabilities.browserSelection.configuredTargets = { version: 1, state: 'unavailable' }; }
    if (scenario === 'mapping-missing') { browserId = 'chrome'; h.state.capabilities.browserSelection.configuredTargets.aliases = {}; }
    if (scenario === 'owner-missing') h.state.metadata.browserInstanceId = null;
    if (scenario === 'foreign-job') h.state.metadata.id = 'foreign';
    if (scenario === 'old-metadata') delete h.state.capabilities.browserSelection.jobMetadataReadOnly;
    if (scenario === 'metadata-not-confirmed') h.state.metadata.metadataOnly = false;
    const result = await h.post({ runId: 'negative', continueFromRunId: 'prior', prompt: 'x', browserId });
    assert.ok([409, 503].includes(result.status), JSON.stringify(result.body));
    assert.equal(await h.store.get('negative'), null); assert.equal(h.starts.length, 0);
    if (scenario === 'old-metadata') assert.equal(h.scRequests.some(req => req.url.includes('noted_prior')), false);
  });
}
