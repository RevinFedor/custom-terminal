'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const test = require('node:test');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { AgentSendQueue } = require('./agent-send-queue');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { reconcileAgentSendStartupRecords } = require('./agent-send-startup-reconcile');
const { createAgentSendReceiptReconciler } = require('./agent-send-receipt-reconcile');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const webSource = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
function declarations(source, names) {
  const parsed = ts.createSourceFile('actual.js', source, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = parsed.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, name);
    return node.getText(parsed);
  }).join('\n');
}
const mainFunctions = declarations(mainSource, ['reconcileExactAgentSendReceipt',
  'publishDurableAgentSendReceiptAudit', 'publishAgentPromptAuditResult', 'reconcileDurableCodexPromptAuditsForTab']);
const webFunctions = declarations(webSource, ['reconcileAgentSendReceiptForApi',
  'releaseAgentSendQueueHeadForApi',
  'publicAgentSendReceipt', 'durableAgentSendReplay', 'durableRecordHasProviderQueueAcceptance']);
const routeStart = webSource.indexOf('  // Explicit proof read; only the existing exact auditor');
const routeEnd = webSource.indexOf('  // Durable delivery receipts for reconnect', routeStart);
assert.ok(routeStart > 0 && routeEnd > routeStart);
const route = webSource.slice(routeStart, routeEnd);
const tick = () => new Promise(resolve => setImmediate(resolve));
const sessionId = '6f0c6848-b8f3-4fb4-90dd-31986902d74c';
const prompt = 'Approved SOURCE repair; preserve the original continuation.';
const user = message => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(),
  payload: { type: 'user_message', message } }) + '\n';

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-exact-receipt-'));
  const file = path.join(dir, `rollout-${sessionId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }) + '\n');
  for (const record of options.beforeBoundaryRecords || [options.beforeBoundaryRecord].filter(Boolean)) {
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
  }
  let db = new Database(path.join(dir, 'receipts.sqlite'));
  let store = createAgentSendReceiptStore(db);
  let queue;
  const sent = [], publications = [], tabFlights = new Map();
  const request = handoffId => ({ tabId: 'T', provider: 'codex', prompt: handoffId === 'head-429' ? prompt : 'original task440',
    handoffId, source: 'history-panel', sendOperationKey: 'history:T:' + handoffId, expectedTarget: { toolType: 'codex', sessionId } });
  const identity = req => ({ operationKey: req.sendOperationKey, tabId: 'T', handoffId: req.handoffId,
    surface: 'desktop-history', provider: 'codex', sessionId, requestFingerprint: fingerprintAgentSendRequest(req),
    promptHash: promptAuditFingerprint(req.prompt), promptLength: req.prompt.length });
  const makeQueue = () => new AgentSendQueue({ store, reconcile: request => context.reconcileExactAgentSendReceipt(request), execute: async req => {
    sent.push(req.handoffId);
    const begun = store.beginAttempt(identity(req));
    const boundary = { sessionId, filePath: file, fileSize: fs.statSync(file).size, capturedAt: Date.now() };
    const activeState = req.handoffId === 'head-429' ? options.activeState : null;
    if (!options.omitContext || req.handoffId !== 'head-429') {
      store.stageAttemptContext(req.sendOperationKey, begun.attemptId, { sessionId, transcriptBoundary: boundary,
        transportText: req.prompt, source: 'codex-tab-message:' + req.handoffId });
    }
    if (activeState !== 'in-flight') store.markAttemptState(req.sendOperationKey, begun.attemptId, 'enter-armed');
    if (!activeState) {
      store.settleAttempt(req.sendOperationKey, begun.attemptId, { submitted: true, auditPending: true });
      store.markProviderQueueAccepted(req.sendOperationKey, begun.attemptId, { provider: 'codex', sessionId,
        sourceIdentity: 'codex-tui-queue:fixture:' + req.handoffId });
    }
    return store.get(req.sendOperationKey).receipt;
  } });
  queue = makeQueue();
  const head = request('head-429'), follower = request('task-440');
  queue.enqueue({ identity: identity(head), request: head });
  await tick();
  queue.enqueue({ identity: identity(follower), request: follower });
  await tick();
  if (!options.activeState) {
    const startup = store.reconcileStartup();
    const decisions = await reconcileAgentSendStartupRecords(startup.records.filter(record =>
      ['audit-pending', 'delivery-unknown'].includes(record.state)), { allRecords: startup.records });
    for (const decision of decisions) store.markStartupUnconfirmed(decision.operationKey, decision.attemptId, decision);
  }
  const attemptId = store.get(head.sendOperationKey).attemptId;
  const exact = { operationKey: head.sendOperationKey, attemptId };
  let scans = 0;
  let firstScan;
  const scanStarted = new Promise(resolve => { firstScan = resolve; });
  const scan = async (...args) => { scans++; firstScan();
    return options.scan ? options.scan(...args) : reconcileAgentSendStartupRecords(...args); };
  const context = vm.createContext({ path, srcMainDir: __dirname,
    agentSendReceiptStore: store, agentSendQueue: queue, AGENT_SEND_DURABLE_STATES: STORE_STATES,
    AGENT_SEND_RECEIPT_STATES: STORE_STATES, agentSendReceiptStartupReady: Promise.resolve(),
    durableCodexAuditReconcileInflight: tabFlights,
    reconcileAgentSendStartupRecords,
    console: { log() {}, warn() {} },
    require: name => name.endsWith('agent-send-receipt-reconcile') ? {
      ...require('./agent-send-receipt-reconcile'),
      createAgentSendReceiptReconciler: args => createAgentSendReceiptReconciler({ ...args, scan }),
    } : require(name),
    isAgentSendProviderQueueAccepted: receipt => receipt?.providerQueue?.accepted === true,
    compactSendReceiptPresentation: () => null,
    compatiblePromptAuditExecutionContext: () => ({ context: null, reason: 'fixture-service-message' }),
    isOrchestrationPromptAudit: () => false,
    enrichCodexAuditAddress: () => {},
    routeAgentPromptAuditDetail: detail => { publications.push(detail); },
  });
  vm.runInContext('let exactAgentSendReceiptReconciler = null;\n' + mainFunctions + '\n' + webFunctions, context);
  context.reconcileAgentSendReceipt = context.reconcileExactAgentSendReceipt;
  context.readBody = async req => { let body = ''; for await (const chunk of req) body += chunk;
    return body ? JSON.parse(body) : {}; };
  context.sendJson = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  context.decId = decodeURIComponent;
  vm.runInContext('globalThis.actualRoute = async (req,res,parsed) => { let m;\n' + route
    + '\nreturn sendJson(res,404,{error:"route-not-found"}); };', context);
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer fixture-token') return context.sendJson(res, 401, { error: 'unauthorized' });
    return context.actualRoute(req, res, { pathname: new URL(req.url, 'http://fixture').pathname })
      .catch(error => context.sendJson(res, 500, { error: error.message }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/terminal-tabs/T/send-receipts/reconcile`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    queue.dispose(); await tick(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return {
    context, exact, file, head, follower, sent, publications, tabFlights, scanStarted,
    get store() { return store; }, get queue() { return queue; }, get scans() { return scans; },
    append(text = prompt) { fs.appendFileSync(file, user(text)); },
    async post(body = exact, auth = true, tab = 'T') {
      const r = await fetch(url.replace('/T/', '/' + tab + '/'), { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer fixture-token' } : {}) }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    },
    async release(body = { ...exact, requestId: 'release-head-v1', acknowledgeDeliveryUnknown: true }, auth = true) {
      const r = await fetch(url.replace('/reconcile', '/release'), { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer fixture-token' } : {}) }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    },
    async reopen() {
      queue.dispose(); await tick(); db.close(); db = new Database(path.join(dir, 'receipts.sqlite'));
      store = createAgentSendReceiptStore(db); queue = makeQueue();
      context.agentSendReceiptStore = store; context.agentSendQueue = queue;
      vm.runInContext('exactAgentSendReceiptReconciler = null', context);
      queue.resume(); await tick();
    },
  };
}

test('actual HTTP -> Main publisher -> existing scanner -> SQLite frees ONLY the original follower after late exact proof', async t => {
  const h = await fixture(t);
  h.append();
  const result = await h.post(); await tick();
  assert.equal(result.status, 200);
  assert.equal(result.body.reconciliation.decision, 'found');
  assert.equal(result.body.reconciliation.confirmed, true);
  assert.equal(result.body.receipt.exactAuditConfirmed, true);
  assert.equal(h.store.get(h.head.sendOperationKey).state, 'confirmed');
  assert.deepEqual(h.sent, ['head-429', 'task-440']);
  assert.equal(h.publications.length, 1);
  const repeat = await h.post(); await tick();
  assert.equal(repeat.body.reconciliation.reason, 'already-exact-confirmed');
  assert.equal(h.scans, 1); assert.deepEqual(h.sent, ['head-429', 'task-440']);
});

for (const activeState of ['enter-armed']) {
  test(`active ${activeState}: absent proof preserves attempt/slot; late exact proof confirms without a second head Send`, async t => {
    const h = await fixture(t, { activeState });
    const before = h.store.get(h.head.sendOperationKey);
    const absent = await h.post(); await tick();
    assert.equal(absent.status, 200);
    assert.equal(absent.body.reconciliation.confirmed, false);
    assert.equal(absent.body.reconciliation.decision, 'absent');
    assert.deepEqual(h.store.get(h.head.sendOperationKey), before);
    assert.equal(h.queue.item(h.follower.sendOperationKey).state, 'waiting');
    assert.deepEqual(h.sent, ['head-429']);
    h.append();
    const found = await h.post(); await tick();
    assert.equal(found.status, 200);
    assert.equal(found.body.reconciliation.confirmed, true);
    assert.equal(found.body.receipt.attemptId, before.attemptId);
    assert.equal(found.body.receipt.sessionId, before.sessionId);
    assert.equal(h.publications.length, 1);
    assert.deepEqual(h.sent, ['head-429', 'task-440']);
    await h.post(); await tick();
    assert.deepEqual(h.sent, ['head-429', 'task-440']);
  });
}

test('3359-shaped in-flight without a staged boundary is a truthful unknown proof read, not no-submit or queue release', async t => {
  const h = await fixture(t, { activeState: 'in-flight', omitContext: true });
  const before = h.store.get(h.head.sendOperationKey);
  const result = await h.post(); await tick();
  assert.equal(result.status, 200);
  assert.equal(result.body.reconciliation.decision, 'unknown');
  assert.equal(result.body.reconciliation.reason, 'enter-not-recorded');
  assert.equal(result.body.receipt.deliveryUnknown, true);
  assert.equal(result.body.receipt.submitted, null);
  assert.equal(result.body.receipt.inputSlot.state, 'held');
  assert.deepEqual(h.store.get(h.head.sendOperationKey), before);
  assert.deepEqual(h.sent, ['head-429']);
  assert.equal(h.publications.length, 0);
  assert.equal(h.queue.item(h.follower.sendOperationKey).state, 'waiting');
});

test('a matching manual row after a pre-Enter boundary cannot claim an in-flight attempt', async t => {
  const h = await fixture(t, { activeState: 'in-flight' });
  const before = h.store.get(h.head.sendOperationKey);
  h.append();
  const result = await h.post(); await tick();
  assert.equal(result.status, 200);
  assert.equal(result.body.reconciliation.decision, 'unknown');
  assert.equal(result.body.reconciliation.reason, 'enter-not-recorded');
  assert.equal(h.scans, 0);
  assert.equal(h.publications.length, 0);
  assert.deepEqual(h.store.get(h.head.sendOperationKey), before);
  assert.deepEqual(h.sent, ['head-429']);
});

test('active read pins staged transport as well as source boundary before publication', async t => {
  let release;
  const h = await fixture(t, { activeState: 'enter-armed', scan: (...args) => new Promise(resolve => {
    release = async () => resolve(await reconcileAgentSendStartupRecords(...args));
  }) });
  h.append();
  const pending = h.post(); await Promise.race([h.scanStarted, pending]);
  assert.equal(typeof release, 'function', 'active proof read must reach the scanner');
  h.store.settleAttempt(h.head.sendOperationKey, h.exact.attemptId, {
    submitted: true, auditPending: true, transportText: prompt + ' changed',
  });
  await release();
  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'send_receipt_source_changed');
  assert.equal(h.publications.length, 0);
  assert.deepEqual(h.sent, ['head-429']);
});

test('ordinary startup scanning does not gain live-attempt eligibility', async t => {
  const h = await fixture(t, { activeState: 'in-flight' });
  h.append();
  const [decision] = await reconcileAgentSendStartupRecords([h.store.get(h.head.sendOperationKey)]);
  assert.equal(decision.decision, 'unknown');
  assert.equal(decision.reason, 'receipt-state-not-unresolved');
  assert.equal(h.publications.length, 0);
  assert.deepEqual(h.sent, ['head-429']);
});

test('a real startup-shaped absent/queue-accepted head stays UNKNOWN; old FIFO and original waiting440 survive reopen', async t => {
  const h = await fixture(t); await h.reopen();
  const before = h.store.get(h.head.sendOperationKey);
  const result = await h.post(); await tick();
  assert.equal(result.status, 200);
  assert.equal(result.body.reconciliation.decision, 'absent');
  assert.equal(result.body.reconciliation.confirmed, false);
  assert.equal(result.body.receipt.state, 'delivery-unknown');
  assert.equal(result.body.receipt.submitted, true);
  assert.equal(result.body.receipt.providerQueueAccepted, true);
  assert.deepEqual(h.store.get(h.head.sendOperationKey), before);
  assert.equal(h.queue.item(h.follower.sendOperationKey).state, 'waiting');
  assert.deepEqual(h.sent, ['head-429']);
  h.append();
  assert.equal((await h.post()).body.reconciliation.confirmed, true); await tick();
  assert.deepEqual(h.sent, ['head-429', 'task-440']);
});

test('explicit release re-audits exact head, preserves UNKNOWN/submitted/frozen receipt and sends only the original follower once', async t => {
  const h = await fixture(t);
  const original = h.store.get(h.head.sendOperationKey);
  const request = { ...h.exact, requestId: 'release-exact-429', acknowledgeDeliveryUnknown: true };
  const result = await h.release(request); await tick();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.released, true);
  assert.equal(result.body.receipt.state, 'delivery-unknown');
  assert.equal(result.body.receipt.submitted, true);
  assert.deepEqual(h.store.get(h.head.sendOperationKey), original);
  assert.equal(h.queue.item(h.head.sendOperationKey).state, 'released-unknown');
  assert.deepEqual(h.sent, ['head-429', 'task-440']);
  const scans = h.scans;
  await h.reopen();
  const replay = await h.release(request); await tick();
  assert.equal(replay.body.idempotent, true);
  assert.equal(h.scans, scans, 'ACK recovery/reopen does not rerun the auditor or input');
  assert.deepEqual(h.sent, ['head-429', 'task-440']);
  assert.equal((await h.release({ ...request, requestId: 'different-release' })).status, 409);
});

test('explicit unknown release keeps the original idle admission and cannot revive a cancelled follower', async t => {
  const h = await fixture(t);
  h.queue.admit = async () => false;
  await h.release(); await tick();
  assert.deepEqual(h.sent, ['head-429']);
  assert.equal(h.queue.item(h.follower.sendOperationKey).state, 'waiting');
  h.queue.cancelWaiting('T');
  h.queue.admit = async () => true;
  h.queue.notifyRuntime('T'); await tick();
  assert.deepEqual(h.sent, ['head-429']);
  assert.equal(h.queue.item(h.follower.sendOperationKey).state, 'cancelled');
});

test('release rejects missing acknowledgement, foreign IDs, wrong attempt and unauthenticated input without mutation', async t => {
  const h = await fixture(t);
  const original = h.store.get(h.head.sendOperationKey);
  const base = { ...h.exact, requestId: 'release-head', acknowledgeDeliveryUnknown: true };
  for (const [body, auth] of [[{ ...base, acknowledgeDeliveryUnknown: false }, true],
    [{ ...base, attemptId: 'foreign' }, true], [{ ...base, operationKey: 'foreign' }, true],
    [{ ...base, tabId: 'other' }, true], [base, false]]) {
    assert.notEqual((await h.release(body, auth)).status, 200);
    assert.deepEqual(h.store.get(h.head.sendOperationKey), original);
    assert.equal(h.queue.item(h.head.sendOperationKey).state, 'awaiting-receipt');
    assert.deepEqual(h.sent, ['head-429']);
  }
});

test('a positive exact re-audit consumes the head normally instead of recording an unknown release', async t => {
  const h = await fixture(t); h.append();
  const result = await h.release(); await tick();
  assert.equal(result.body.released, false);
  assert.equal(result.body.confirmed, true);
  assert.equal(h.queue.item(h.head.sendOperationKey).release_json, null);
  assert.deepEqual(h.sent, ['head-429', 'task-440']);
});

test('foreign tab/attempt, unknown operation, caller-supplied proof and unauthenticated calls do not enter scanner', async t => {
  const h = await fixture(t);
  for (const [body, auth, tab, expected] of [
    [{ ...h.exact, attemptId: 'foreign-attempt' }, true, 'T', 409],
    [{ ...h.exact, operationKey: 'missing' }, true, 'T', 404],
    [h.exact, true, 'other-tab', 404], [h.exact, false, 'T', 401],
    [{ ...h.exact, provider: 'codex' }, true, 'T', 400],
    [{ ...h.exact, transcriptPath: h.file }, true, 'T', 400],
    [{ ...h.exact, audit: { success: true } }, true, 'T', 400],
    [{ operationKey: h.exact.operationKey }, true, 'T', 400],
  ]) assert.equal((await h.post(body, auth, tab)).status, expected);
  h.store.db.prepare('UPDATE agent_send_receipts SET provider = ? WHERE operation_key = ?').run('claude', h.exact.operationKey);
  assert.equal((await h.post()).body.error, 'send_receipt_reconciliation_provider_unsupported');
  assert.equal(h.scans, 0); assert.deepEqual(h.sent, ['head-429']);
});

test('same text before the boundary or a different first user never becomes exact receipt consumption', async t => {
  const h = await fixture(t);
  h.append('a different post-boundary user'); h.append();
  const result = await h.post(); await tick();
  assert.equal(result.body.reconciliation.confirmed, false);
  assert.equal(result.body.reconciliation.reason, 'first-post-boundary-user-message-mismatch');
  assert.equal(h.publications.length, 0); assert.deepEqual(h.sent, ['head-429']);
});

test('an already claimed canonical row cannot be adopted by the addressed old receipt', async t => {
  const h = await fixture(t); h.append();
  const [audit] = await reconcileAgentSendStartupRecords([h.store.get(h.head.sendOperationKey)],
    { allRecords: h.store.list({ tabId: 'T' }) });
  const other = h.store.get(h.follower.sendOperationKey);
  const start = h.store.beginAttempt({ ...other, operationKey: other.operationKey });
  h.store.settleAttempt(other.operationKey, start.attemptId, { submitted: true, auditPending: true });
  h.store.promoteFromAudit({ ...audit.audit, operationKey: other.operationKey, attemptId: start.attemptId,
    promptHash: other.promptHash, expectedHash: other.promptHash, actualHash: other.promptHash });
  const response = await h.post();
  assert.equal(response.body.reconciliation.confirmed, false);
  assert.equal(response.body.reconciliation.reason, 'canonical-user-already-owned');
  assert.equal(h.publications.length, 0);
});

test('another tab sharing the historical source cannot donate its claimed canonical user to the old head', async t => {
  const h = await fixture(t); h.append();
  const [decision] = await reconcileAgentSendStartupRecords([h.store.get(h.head.sendOperationKey)]);
  const other = { operationKey: 'history:foreign:claimed', tabId: 'foreign', handoffId: 'claimed',
    surface: 'desktop-history', provider: 'codex', sessionId,
    requestFingerprint: 'different-caller', promptHash: promptAuditFingerprint(prompt), promptLength: prompt.length };
  const begun = h.store.beginAttempt(other);
  h.store.settleAttempt(other.operationKey, begun.attemptId, { submitted: true, auditPending: true });
  h.store.promoteFromAudit({ ...decision.audit, operationKey: other.operationKey, attemptId: begun.attemptId });
  const references = h.store.listAuditReferences('codex');
  assert.ok(references.find(row => row.tabId === 'foreign'));
  assert.equal(references.some(row => row.receipt?.transportText || row.receipt?.promptText), false);
  const result = await h.post();
  assert.equal(result.body.reconciliation.reason, 'canonical-user-already-owned');
  assert.equal(result.body.reconciliation.confirmed, false);
  assert.equal(h.publications.length, 0); assert.deepEqual(h.sent, ['head-429']);
});

for (const ingress of ['startup-store', 'live-main', 'explicit-post']) {
  test(`${ingress}: an early carrier claimed by another tab also owns its paired canonical carrier`, async t => {
    const h = await fixture(t);
    fs.appendFileSync(h.file, JSON.stringify({ uuid: 'response-claimed', type: 'response_item',
      timestamp: new Date().toISOString(), payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: prompt }] } }) + '\n');
    h.append();
    const [decision] = await reconcileAgentSendStartupRecords([h.store.get(h.head.sendOperationKey)]);
    assert.equal(decision.audit.entryUuidAliases[0], 'response-claimed');
    assert.equal(decision.audit.sourceIdentityAliases.length, 1);
    const other = { operationKey: 'history:foreign:early', tabId: 'foreign', handoffId: 'early',
      surface: 'desktop-history', provider: 'codex', sessionId, requestFingerprint: 'other-caller',
      promptHash: promptAuditFingerprint(prompt), promptLength: prompt.length };
    const attempt = h.store.beginAttempt(other);
    h.store.settleAttempt(other.operationKey, attempt.attemptId, { submitted: true, auditPending: true });
    assert.equal(h.store.promoteFromAudit({ ...decision.audit, operationKey: other.operationKey,
      attemptId: attempt.attemptId, entryUuid: 'response-claimed',
      sourceIdentity: decision.audit.sourceIdentityAliases[0], entryUuidAliases: [], sourceIdentityAliases: [] }).promoted, true);
    if (ingress === 'startup-store') {
      assert.equal(h.store.promoteFromAudit(decision.audit).reason, 'canonical-user-already-owned');
    } else if (ingress === 'live-main') {
      assert.equal(h.context.reconcileDurableCodexPromptAuditsForTab('T'), true);
      await h.tabFlights.get('T');
    } else {
      const result = await h.post();
      assert.equal(result.body.reconciliation.reason, 'canonical-user-already-owned');
      assert.equal(result.body.reconciliation.confirmed, false);
    }
    await tick();
    assert.equal(h.store.get(h.head.sendOperationKey).state, 'delivery-unknown');
    assert.equal(h.queue.item(h.follower.sendOperationKey).state, 'waiting');
    assert.equal(h.publications.length, 0);
    assert.deepEqual(h.sent, ['head-429']);
  });
}

for (const order of ['response-first', 'event-first']) for (const ingress of ['startup-store', 'live-main', 'explicit-post']) {
  test(`${ingress}: attempt boundary inside ${order} pair cannot confirm a second operation`, async t => {
    const carrier = kind => ({ uuid: kind + '-old-user', type: kind, timestamp: new Date().toISOString(),
      payload: kind === 'event_msg' ? { type: 'user_message', message: prompt }
        : { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } });
    const first = carrier(order === 'response-first' ? 'response_item' : 'event_msg');
    const h = await fixture(t, { beforeBoundaryRecord: first });
    const beforeOffset = fs.readFileSync(h.file).indexOf(Buffer.from(JSON.stringify(first)));
    const owner = { operationKey: 'history:previous:logical-user', tabId: 'previous', handoffId: 'old',
      surface: 'desktop-history', provider: 'codex', sessionId, requestFingerprint: 'previous-operation',
      promptHash: promptAuditFingerprint(prompt), promptLength: prompt.length };
    const attempt = h.store.beginAttempt(owner);
    h.store.settleAttempt(owner.operationKey, attempt.attemptId, { submitted: true, auditPending: true });
    assert.equal(h.store.promoteFromAudit({ success: true, ...owner, attemptId: attempt.attemptId,
      entryUuid: first.uuid, sourceIdentity: `codex-user-source-${sessionId}-${beforeOffset}` }).promoted, true);
    fs.appendFileSync(h.file, JSON.stringify(carrier(order === 'response-first' ? 'event_msg' : 'response_item')) + '\n');
    if (ingress === 'startup-store') {
      const [decision] = await reconcileAgentSendStartupRecords([h.store.get(h.head.sendOperationKey)],
        { allRecords: h.store.listAuditReferences('codex') });
      if (decision.audit) h.store.promoteFromAudit(decision.audit);
      assert.notEqual(h.store.get(h.head.sendOperationKey).state, 'confirmed');
    } else if (ingress === 'live-main') {
      h.context.reconcileDurableCodexPromptAuditsForTab('T'); await h.tabFlights.get('T');
    } else assert.equal((await h.post()).body.reconciliation.confirmed, false);
    await tick();
    assert.equal(h.store.get(h.head.sendOperationKey).state, 'delivery-unknown');
    assert.equal(h.queue.item(h.follower.sendOperationKey).state, 'waiting');
    assert.deepEqual(h.sent, ['head-429']);
    assert.equal(h.publications.length, 0);
  });
}

test('all neighbouring receipt boundaries exclude a later matching user from the old causal range', async t => {
  const h = await fixture(t);
  fs.appendFileSync(h.file, JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted' } }) + '\n');
  const other = h.store.get(h.follower.sendOperationKey);
  const begun = h.store.beginAttempt({ ...other, operationKey: other.operationKey });
  h.store.stageAttemptContext(other.operationKey, begun.attemptId, { sessionId,
    transcriptBoundary: { sessionId, filePath: h.file, fileSize: fs.statSync(h.file).size, capturedAt: Date.now() } });
  h.store.markAttemptState(other.operationKey, begun.attemptId, 'enter-armed');
  h.append();
  const result = await h.post();
  assert.equal(result.body.reconciliation.confirmed, false);
  assert.equal(result.body.reconciliation.evidence.causalUpperBoundaryOffset, h.store.get(other.operationKey).transcriptBoundary.fileSize);
  assert.equal(h.publications.length, 0); assert.deepEqual(h.sent, ['head-429']);
});

test('pairing context crosses a large UTF-8 tool row without treating its body as another user', async t => {
  const prior = { uuid: 'early-unclaimed', type: 'response_item', payload: { type: 'message', role: 'user', text: prompt } };
  const h = await fixture(t, { beforeBoundaryRecords: [
    { type: 'event_msg', payload: { type: 'task_started' } }, prior,
    { type: 'response_item', payload: { type: 'function_call_output', output: '\u03bb'.repeat(300000) } },
  ] });
  h.append();
  const result = await h.post();
  assert.equal(result.body.reconciliation.decision, 'absent');
  assert.equal(h.store.get(h.head.sendOperationKey).state, 'delivery-unknown');
  assert.equal(h.publications.length, 0);
});

test('a second pre-boundary start separates the old response from a legitimate equal prompt', async t => {
  const h = await fixture(t, { beforeBoundaryRecords: [
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', text: prompt } },
    { type: 'event_msg', payload: { type: 'task_started' } },
  ] });
  h.append();
  assert.equal((await h.post()).body.reconciliation.confirmed, true);
  assert.equal(h.store.get(h.head.sendOperationKey).state, 'confirmed');
});

test('first task start clears an old event while preserving legitimate response-only delivery', async t => {
  const h = await fixture(t, { beforeBoundaryRecords: [
    { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
    { type: 'event_msg', payload: { type: 'task_started' } },
  ] });
  fs.appendFileSync(h.file, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', text: prompt } }) + '\n');
  assert.equal((await h.post()).body.reconciliation.confirmed, true);
});

test('one exact request single-flights and joins the existing live tab auditor', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const h = await fixture(t, { scan: async (...args) => { await held; return reconcileAgentSendStartupRecords(...args); } });
  h.append();
  const a = h.post(), b = h.post();
  await h.scanStarted;
  assert.equal(h.scans, 1); release();
  for (const result of await Promise.all([a, b])) assert.equal(result.body.reconciliation.confirmed, true);
  await tick(); assert.deepEqual(h.sent, ['head-429', 'task-440']);
  assert.equal(h.publications.length, 1);
});

test('scope replacement during proof I/O refuses a late audit without publishing or freeing the slot', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const h = await fixture(t, { scan: async (...args) => { const result = await reconcileAgentSendStartupRecords(...args); await held; return result; } });
  h.append(); const pending = h.post();
  await h.scanStarted;
  h.store.db.prepare('UPDATE agent_send_receipts SET attempt_id = ? WHERE operation_key = ?')
    .run('new-attempt', h.exact.operationKey);
  release(); const response = await pending;
  assert.equal(response.status, 409); assert.equal(response.body.error, 'send_receipt_attempt_changed');
  assert.equal(h.publications.length, 0); assert.deepEqual(h.sent, ['head-429']);
});

test('source identity change during proof I/O is rejected before Main publication', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const h = await fixture(t, { scan: async (...args) => { const result = await reconcileAgentSendStartupRecords(...args); await held; return result; } });
  h.append(); const pending = h.post(); await h.scanStarted;
  h.store.db.prepare('UPDATE agent_send_receipts SET session_id = ? WHERE operation_key = ?')
    .run('foreign-session', h.exact.operationKey);
  release(); const result = await pending;
  assert.equal(result.status, 409); assert.equal(result.body.error, 'send_receipt_source_changed');
  assert.equal(h.publications.length, 0); assert.deepEqual(h.sent, ['head-429']);
});

test('an existing live audit flight is joined, not overlapped or cancelled by the explicit proof read', async t => {
  const h = await fixture(t); h.append();
  let release;
  const live = new Promise(resolve => { release = resolve; });
  h.tabFlights.set('T', live);
  const request = h.context.reconcileExactAgentSendReceipt({ tabId: 'T', ...h.exact });
  assert.equal(h.scans, 0); assert.equal(h.tabFlights.get('T'), live);
  h.tabFlights.delete('T'); release();
  assert.equal((await request).reconciliation.confirmed, true);
  assert.equal(h.scans, 1);
});

test('missing source and scanner exception keep the original uncertain receipt and waiting follower', async t => {
  for (const throws of [false, true]) {
    const h = await fixture(t, throws ? { scan: async () => { throw new Error('fixture audit I/O failure'); } } : {});
    const before = h.store.get(h.head.sendOperationKey);
    if (!throws) fs.unlinkSync(h.file);
    const result = await h.post();
    if (throws) assert.equal(result.status, 500);
    else assert.equal(result.body.reconciliation.confirmed, false);
    assert.deepEqual(h.store.get(h.head.sendOperationKey), before);
    assert.equal(h.queue.item(h.follower.sendOperationKey).state, 'waiting');
    assert.deepEqual(h.sent, ['head-429']);
  }
});

test('publication failure after exact durable promotion does not undo receipt or repeat either send', async t => {
  const h = await fixture(t); h.append();
  h.context.routeAgentPromptAuditDetail = () => { throw new Error('fixture renderer unavailable'); };
  const result = await h.post(); await tick();
  assert.equal(result.body.reconciliation.confirmed, true);
  assert.equal(result.body.reconciliation.publicationError, 'fixture renderer unavailable');
  assert.equal(result.body.receipt.exactAuditConfirmed, true);
  assert.deepEqual(h.sent, ['head-429', 'task-440']);
  assert.equal((await h.post()).body.reconciliation.reason, 'already-exact-confirmed');
});

test('positive head proof still leaves an independent continuation waiting until its existing idle admission passes', async t => {
  const h = await fixture(t); h.append();
  let idle = false;
  h.queue.admit = async req => req.handoffId === 'head-429' || idle;
  assert.equal((await h.post()).body.reconciliation.confirmed, true); await tick();
  assert.deepEqual(h.sent, ['head-429']);
  assert.equal(h.queue.item(h.follower.sendOperationKey).state, 'waiting');
  idle = true; h.queue.notifyRuntime('T'); await tick();
  assert.deepEqual(h.sent, ['head-429', 'task-440']);
});

test('unavailable auditor and foreign scanner decision cannot synthesize a successful reconciliation', async t => {
  const h = await fixture(t, { scan: async () => [{ operationKey: 'foreign', attemptId: 'foreign', decision: 'found', audit: { success: true } }] });
  assert.equal((await h.post()).body.error, 'send_receipt_audit_identity_mismatch');
  assert.equal(h.publications.length, 0); assert.deepEqual(h.sent, ['head-429']);
  h.context.reconcileAgentSendReceipt = null;
  assert.equal((await h.post()).status, 503);
});
