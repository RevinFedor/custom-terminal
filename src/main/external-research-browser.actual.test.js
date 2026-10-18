const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { normalizeExternalResearchRequest, externalResearchRequestFingerprint } = require('./external-research-request');
const { BROWSER_SELECTION_CAPABILITY, publicBrowserAccount } = require('./external-research-browser');
const { OrchestrationRunStore } = require('./orchestration-runs');
const { ScExternalResearchClient } = require('./sc-external-research-client');
const { ExternalResearchCoordinator } = require('./external-research-coordinator');

const CHROME = '8a72840e-1776-4ba4-a04f-04c24f3ef53d';
const YANDEX = '37c26a49-3eda-4eb3-b7ba-c8cdeb9afea5';
const offline = { code: 'BROWSER_UNAVAILABLE', error: 'profile offline', availability: 'profile_offline',
  browserInstanceId: CHROME, preflightOnly: true, deliveryUnknown: false, retrySafe: true };
const caps = { version: 1, browserSelection: BROWSER_SELECTION_CAPABILITY };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const account = { source: 'browser_auth_session', user_id: 'user-1', account_id: 'account-1',
  observed_at: 1792312164881, binding: 'before_send', email: 'private@example.test', token: 'must-not-leak' };

async function fixture(t, handler, { browserId = 'chrome' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-research-browser-'));
  const file = path.join(directory, 'runs.json');
  const store = new OrchestrationRunStore(file);
  await store.reserveOrGet({ runId: 'browser-test', runKind: 'external-research', requestFingerprint: 'fixed',
    sourceTabId: 'own-source', sourceProjectId: 'own-project', sourceTabName: 'Private source',
    notifySource: false, externalResearchJobId: 'noted_browser-test',
    externalResearchIntent: normalizeExternalResearchRequest({ prompt: 'private fixture', browserId }) });
  const requests = [], emissions = [], notices = [], finalized = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const request = { method: req.method, url: req.url, body: text ? JSON.parse(text) : null };
    requests.push(request);
    try { await handler(request, res); }
    catch (error) { json(res, 500, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new ScExternalResearchClient({ baseUrl: 'http://127.0.0.1:' + server.address().port });
  const coordinator = new ExternalResearchCoordinator({ store, client, longPollMs: 0, retryBaseMs: 1, retryMaxMs: 1,
    emitChanges: runs => emissions.push(...runs), finalizeSettled: async run => finalized.push(run),
    notifyBrowserOffline: async envelope => { notices.push(envelope); return { ok: true, durable: true }; } });
  t.after(async () => { await coordinator.stop(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await store.flush(); await fs.rm(directory, { recursive: true, force: true }); });
  return { store, file, requests, emissions, notices, finalized, coordinator, client };
}

test('selector is strict, top-level, durable and changes only explicit request fingerprints', () => {
  for (const browserId of ['chrome', 'yandex', CHROME]) {
    const value = normalizeExternalResearchRequest({ prompt: 'x', browserId });
    assert.equal(value.browserId, browserId);
    assert.notEqual(externalResearchRequestFingerprint({ request: value }),
      externalResearchRequestFingerprint({ request: normalizeExternalResearchRequest({ prompt: 'x' }) }));
  }
  for (const browserId of ['', null, false, {}, 'Chrome', 'primary', 'http://localhost:1']) {
    assert.throws(() => normalizeExternalResearchRequest({ prompt: 'x', browserId }), /browserId/);
  }
  assert.throws(() => normalizeExternalResearchRequest({ prompt: 'x', options: { browserId: 'chrome' } }), /top-level/);
  assert.throws(() => normalizeExternalResearchRequest({ prompt: 'x', browserInstanceId: CHROME }), /browserId/);
  assert.equal(Object.hasOwn(normalizeExternalResearchRequest({ prompt: 'x' }), 'browserId'), false);
});

test('real HTTP client gates selected start before POST; omitted default does not require the new capability', async t => {
  const h = await fixture(t, (req, res) => json(res, 200, req.url === '/research-capabilities' ? { version: 1 }
    : { id: 'job', status: 'running' }));
  await assert.rejects(h.client.start({ jobId: 'job', prompt: 'x', browserId: 'chrome' }),
    error => error.code === 'external_research_browser_update_required');
  assert.deepEqual(h.requests.map(req => req.url), ['/research-capabilities']);
  await h.client.start({ jobId: 'job', prompt: 'x' });
  assert.equal(h.requests.at(-1).url, '/research-start');
  assert.equal(Object.hasOwn(h.requests.at(-1).body, 'browserId'), false);
});

test('proven new offline profile waits without settlement, pins retry UUID and queues one human-only notice', async t => {
  let starts = 0, accepted = false;
  const h = await fixture(t, (req, res) => {
    if (req.url === '/research-capabilities') return json(res, 200, caps);
    if (req.method === 'GET') return json(res, accepted ? 200 : 404, accepted
      ? { id: 'noted_browser-test', browserInstanceId: CHROME, browserAccount: account, status: 'done', result: { text: 'done' } }
      : { error: 'missing' });
    starts++;
    if (starts <= 2) return json(res, 409, offline);
    accepted = true;
    return json(res, 200, { id: req.body.requestId, status: 'running', browserInstanceId: CHROME });
  });
  await h.coordinator.watch('browser-test');
  const posts = h.requests.filter(req => req.method === 'POST');
  assert.deepEqual(posts.map(req => req.body.browserId), ['chrome', CHROME, CHROME]);
  assert.ok(posts.every(req => req.body.requestId === 'noted_browser-test' && req.body.prompt === 'private fixture'));
  const waiting = h.emissions.filter(run => run.deliveryDeferredReason === 'waiting-for-browser');
  assert.equal(waiting.length, 3, 'two offline preflights plus the durable human-notice publication');
  assert.ok(waiting.every(run => run.resultComplete === false && !run.deliveryAcceptedAt && run.externalResearchBrowserWait.notSubmitted));
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].kind, 'terminal-user');
  assert.equal(h.notices[0].tabId, 'own-source');
  assert.equal(h.notices[0].projectId, 'own-project');
  assert.match(h.notices[0].text, /Chrome/);
  assert.match(h.notices[0].requestId, /^research-browser-offline:/);
  assert.equal(h.finalized.length, 1);
  const run = await h.store.get('browser-test');
  assert.equal(run.status, 'completed');
  assert.equal(run.externalResearchBrowserInstanceId, CHROME);
  assert.deepEqual(run.externalResearchBrowserAccount, publicBrowserAccount(account));
  assert.equal(run.externalResearchBrowserAccount.email, undefined);
  assert.equal(run.externalResearchBrowserWait, null);
  assert.equal(Object.hasOwn(run, 'externalResearchIntent'), false);
  assert.equal(Object.hasOwn(run, 'externalResearchBrowserNotice'), false);
  await h.store.flush();
  const restored = new OrchestrationRunStore(h.file);
  assert.equal((await restored.get('browser-test')).externalResearchBrowserInstanceId, CHROME);
  assert.equal((await restored.getInternal('browser-test')).externalResearchIntent.browserId, 'chrome');
  await restored.flush();
});

for (const kind of ['transport_unknown', 'admitted', 'prior-unknown']) {
  test(kind + ' cannot become safe offline/no-submit or notify to open Chrome', async t => {
    let starts = 0;
    const h = await fixture(t, (req, res) => {
      if (req.url === '/research-capabilities') return json(res, 200, caps);
      if (req.method === 'GET') {
        if (starts >= 2) return json(res, 200, { id: 'noted_browser-test', status: 'done', browserInstanceId: CHROME, result: { text: 'recovered' } });
        return json(res, 404, { error: 'missing' });
      }
      starts++;
      if (kind === 'prior-unknown' && starts === 1) return json(res, 503, { error: 'lost ACK' });
      if (starts === 1 || kind === 'prior-unknown' && starts === 2) {
        return json(res, 409, { ...offline, ...(kind === 'transport_unknown' ? { availability: 'transport_unknown' } : {}),
          ...(kind === 'admitted' ? { deliveryUnknown: true, retrySafe: false } : {}) });
      }
      return json(res, 200, { id: req.body.requestId, status: 'running', browserInstanceId: CHROME });
    });
    await h.coordinator.watch('browser-test');
    assert.equal(h.notices.length, 0);
    assert.equal(h.emissions.some(run => run.deliveryDeferredReason === 'waiting-for-browser'), false);
    assert.ok(h.emissions.some(run => run.deliveryDeferredReason === 'external-research-transport'));
    assert.equal((await h.store.get('browser-test')).status, 'completed');
  });
}

test('exact job browser pin cannot be overwritten, including by a final or by a missing owner', async t => {
  const h = await fixture(t, (_req, res) => json(res, 500, {}));
  await h.store.applyExternalResearchSnapshot('browser-test', { id: 'noted_browser-test', status: 'running', browserInstanceId: CHROME });
  await assert.rejects(h.store.applyExternalResearchSnapshot('browser-test', {
    id: 'noted_browser-test', status: 'done', browserInstanceId: YANDEX, result: { text: 'foreign' },
  }), error => error.code === 'external_research_browser_owner_mismatch');
  await assert.rejects(h.store.applyExternalResearchSnapshot('browser-test', {
    id: 'noted_browser-test', status: 'done', result: { text: 'unproven' },
  }), error => error.code === 'external_research_browser_owner_unproven');
  assert.equal((await h.store.get('browser-test')).resultComplete, false);
  assert.equal((await h.store.get('browser-test')).externalResearchBrowserInstanceId, CHROME);
  const foreign = await h.store.applyExternalResearchSnapshot('browser-test', { id: 'other', browserInstanceId: YANDEX });
  assert.equal(foreign.ignored, true);
});

test('cancel during real client capability await prevents the first POST after that new boundary', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const observed = new Promise(resolve => { entered = resolve; });
  const h = await fixture(t, async (req, res) => {
    if (req.url === '/research-capabilities') { entered(); await gate; return json(res, 200, caps); }
    if (req.method === 'GET') return json(res, 404, { error: 'missing' });
    assert.fail('no start after detach');
  });
  const watching = h.coordinator.watch('browser-test');
  await observed;
  await h.store.cancel('browser-test', { reason: 'detached-by-user', suppressNotification: true });
  release(); await watching;
  assert.equal(h.requests.filter(req => req.method === 'POST').length, 0);
  assert.equal((await h.store.get('browser-test')).status, 'cancelled');
  assert.equal(h.notices.length, 0);
});

test('notice ACK loss retries the identical frozen human envelope, never a model callback', async t => {
  const h = await fixture(t, (_req, res) => json(res, 500, {}));
  await h.store.patch('browser-test', { externalResearchStartHadUncertainty: false });
  await h.store.markExternalResearchBrowserWait('browser-test', { jobId: 'noted_browser-test', owner: CHROME });
  const seen = new Map(); let calls = 0;
  h.coordinator.notifyBrowserOffline = async envelope => {
    calls++;
    const prior = seen.get(envelope.requestId);
    if (prior) assert.deepEqual(envelope, prior); else seen.set(envelope.requestId, envelope);
    if (calls === 1) throw new Error('lost outbox ACK');
    return { ok: true, durable: true };
  };
  await assert.rejects(h.coordinator._noticeBrowserOffline('browser-test', 'noted_browser-test'), /lost outbox ACK/);
  await h.store.patch('browser-test', { sourceTabName: 'renamed' });
  await h.coordinator._noticeBrowserOffline('browser-test', 'noted_browser-test');
  await h.coordinator._noticeBrowserOffline('browser-test', 'noted_browser-test');
  assert.equal(calls, 2); assert.equal(seen.size, 1); assert.equal(h.finalized.length, 0);
  await h.store.cancel('browser-test', { suppressNotification: true });
  await h.coordinator._noticeBrowserOffline('browser-test', 'noted_browser-test');
  assert.equal(calls, 2);
});

test('HTTP 429 waits as bridge throttling; SC native error remains terminal', async t => {
  let reads = 0;
  const h = await fixture(t, (_req, res) => {
    if (++reads === 1) return json(res, 429, { code: 'http_rate_limit', error: 'bridge throttled' });
    return json(res, 200, { id: 'noted_browser-test', status: 'error', browserInstanceId: CHROME,
      code: 'provider_rate_limit', error: 'native provider limit' });
  });
  await h.coordinator.watch('browser-test');
  assert.equal(h.emissions[0].deliveryDeferredReason, 'external-research-transport');
  assert.equal(h.requests.every(req => req.method === 'GET'), true);
  assert.equal((await h.store.get('browser-test')).resultErrorCode, 'provider_rate_limit');
  assert.equal(h.notices.length, 0);
});

test('restored admitted job retries only its persisted owner and cannot downgrade to offline/no-submit', async t => {
  let starts = 0;
  const h = await fixture(t, (req, res) => {
    if (req.url === '/research-capabilities') return json(res, 200, caps);
    if (req.method === 'GET') return json(res, 404, { error: 'missing' });
    if (++starts === 1) return json(res, 409, offline);
    return json(res, 200, { id: req.body.requestId, status: 'done', browserInstanceId: CHROME, result: { text: 'restored' } });
  });
  await h.store.applyExternalResearchSnapshot('browser-test', { id: 'noted_browser-test', status: 'running', browserInstanceId: CHROME });
  await h.store.flush();
  const restored = new OrchestrationRunStore(h.file), emissions = [];
  const coordinator = new ExternalResearchCoordinator({ store: restored, client: h.client, retryBaseMs: 1, retryMaxMs: 1,
    emitChanges: values => emissions.push(...values), notifyBrowserOffline: () => assert.fail('already admitted is not a new offline attempt') });
  t.after(async () => { await coordinator.stop(); await restored.flush(); });
  await coordinator.watch('browser-test');
  assert.deepEqual(h.requests.filter(req => req.method === 'POST').map(req => req.body.browserId), [CHROME, CHROME]);
  assert.equal(emissions.some(run => run.deliveryDeferredReason === 'waiting-for-browser'), false);
  assert.equal((await restored.get('browser-test')).status, 'completed');
  assert.equal((await restored.getInternal('browser-test')).externalResearchIntent.browserId, 'chrome');
  await coordinator.stop();
  await restored.flush();
});

test('durable queued human notice is not re-enqueued by a restored coordinator', async t => {
  const h = await fixture(t, (_req, res) => json(res, 500, {}));
  await h.store.patch('browser-test', { externalResearchStartHadUncertainty: false });
  await h.store.markExternalResearchBrowserWait('browser-test', { jobId: 'noted_browser-test', owner: CHROME });
  await h.coordinator._noticeBrowserOffline('browser-test', 'noted_browser-test');
  await h.store.flush();
  const restored = new OrchestrationRunStore(h.file);
  const coordinator = new ExternalResearchCoordinator({ store: restored, client: h.client,
    notifyBrowserOffline: () => assert.fail('notice was already durably queued') });
  await coordinator._noticeBrowserOffline('browser-test', 'noted_browser-test');
  await coordinator.stop(); await restored.flush();
  assert.equal(h.notices.length, 1);
});

test('offline preflight for a conflicting profile is rejected, not installed as the new pin', async t => {
  const h = await fixture(t, (req, res) => {
    if (req.url === '/research-capabilities') return json(res, 200, caps);
    if (req.method === 'GET') return json(res, 404, { error: 'missing' });
    return json(res, 409, { ...offline, browserInstanceId: YANDEX });
  });
  await h.store.patch('browser-test', { externalResearchExpectedBrowserInstanceId: CHROME });
  await h.coordinator.watch('browser-test');
  const run = await h.store.get('browser-test');
  assert.equal(run.resultErrorCode, 'external_research_browser_owner_mismatch');
  assert.equal(run.externalResearchExpectedBrowserInstanceId, CHROME);
  assert.equal(run.status, 'failed'); assert.equal(h.notices.length, 0);
});

test('unavailable human outbox remains an explicit notice error and never fails the research', async t => {
  let starts = 0;
  const h = await fixture(t, (req, res) => {
    if (req.url === '/research-capabilities') return json(res, 200, caps);
    if (req.method === 'GET') return json(res, starts >= 2 ? 200 : 404, starts >= 2
      ? { id: 'noted_browser-test', status: 'done', browserInstanceId: CHROME, result: { text: 'done' } } : { error: 'missing' });
    if (++starts === 1) return json(res, 409, offline);
    return json(res, 200, { id: req.body.requestId, status: 'running', browserInstanceId: CHROME });
  });
  h.coordinator.notifyBrowserOffline = async () => ({ ok: false, reason: 'outbox_unavailable' });
  await h.coordinator.watch('browser-test');
  assert.ok(h.emissions.some(run => run.externalResearchBrowserNoticeError === 'outbox_unavailable'));
  assert.equal((await h.store.get('browser-test')).status, 'completed');
  assert.equal((await h.store.get('browser-test')).externalResearchBrowserNoticeQueuedAt, undefined);
});
