'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { spawn } = require('node:child_process');
const runs = require('./orchestration-runs');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const { agentPromptAuditMatchesHash } = require('./agent-prompt-audit-identity');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { promptFingerprint } = require('./claude-prompt-carriers');
const { RECEIPT_STATES, isAgentSendProviderQueueAccepted, createAgentSendReceiptRegistry } = require('./agent-send-receipt-registry');
const { isResponseObservation } = require('./orchestration-response-observation');

const source = ts.createSourceFile('web-server.js', fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8'), ts.ScriptTarget.Latest, true);
const functions = ['orchestrationSourceReceiptProof', 'reconcileOrchestrationSourceReceiptPins',
  'releaseOrchestrationSourceProof', 'reconcileOrchestrationSourceFollowup', 'sendOrchestrationCompletionNotification',
  'notifyAgentPromptAuditResult', 'reconcileActiveOrchestrations'];
const actual = functions.map(name => source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)?.getText(source))
  .filter(Boolean).join('\n');
const body = 'Complete immutable answer';
const executionContext = { provider: 'codex', sessionId: 'S', turnId: 'source-turn', processId: 'P', generation: 2, startedAt: 100 };

async function fixture(t, { parent = false, provider = 'codex' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-source-ack-'));
  const databasePath = path.join(dir, 'receipts.sqlite');
  const filePath = path.join(dir, 'runs.json');
  let db = new Database(databasePath);
  let receiptStore = createAgentSendReceiptStore(db, { now: () => 1000, settledRetentionMs: 10 });
  let store = new runs.OrchestrationRunStore(filePath);
  if (parent) {
    await store.create({ runId: 'parent', sourceTabId: 'ancestor', targetTabId: 'T',
      promptHash: 'parent-prompt', targetToolType: provider,
      targetExecutionContext: { ...executionContext, provider, turnId: 'old-turn', generation: 1 } });
    await store.patch('parent', { status: 'waiting_descendants', outcome: 'success', ownCompletedAt: 90 });
  }
  await store.create({ runId: 'R', sourceTabId: 'T', targetTabId: 'executor', promptHash: 'task-prompt',
    sourceToolType: provider, sourceSendTarget: { toolType: provider, sessionId: 'S' },
    ...(parent ? { parentRunId: 'parent' } : {}) });
  await store.patch('R', { status: 'completed', outcome: 'success', resultComplete: true, completedAt: Date.now(),
    notificationStatus: 'sending', notificationAttemptedAt: 100,
    notificationPromptHash: promptFingerprint(body), notificationPromptAuditHash: promptAuditFingerprint(body),
    notificationHandoffId: 'orchestration-complete:R', notificationSourceSessionId: 'S' });
  await store.persistStrict();
  const identity = { operationKey: 'history:T:orchestration-complete:R', surface: 'desktop-history',
    tabId: 'T', handoffId: 'orchestration-complete:R', requestFingerprint: 'request-R', provider, sessionId: 'S',
    promptHash: promptAuditFingerprint(body), promptLength: body.length };
  const effects = { reads: 0, writes: 0, released: 0, arms: 0 };
  const context = vm.createContext({ ...runs, agentSendReceiptStore: receiptStore, agentPromptAuditMatchesHash,
    agentSendReceiptRegistry: createAgentSendReceiptRegistry(), tabMessageService: null, isResponseObservation,
    cleanOptionalString: (value, fallback = '') => typeof value === 'string' ? value.trim() : fallback,
    AGENT_SEND_DURABLE_STATES: STORE_STATES,
    agentSendReceiptStartupReady: Promise.resolve({ ready: true }),
    getAgentResponseState: null, readAgentObservedResponse: null,
    AGENT_SEND_RECEIPT_STATES: RECEIPT_STATES, isAgentSendProviderQueueAccepted, promptFingerprint, promptAuditFingerprint,
    console: { log() {}, warn() {} }, getOrchestrationRunStore: () => store,
    orchestrationSourceProofCoordinator: { release: async () => { effects.released++; return true; } },
    getAgentTurnResult: async () => { effects.reads++; return { found: false }; },
    resolveAgentSessionInfo: async () => ({ toolType: provider, sessionId: 'S', cwd: dir }),
    reconcileOrchestrationRun: async () => {},
    emitOrchestrationChanges() {}, finalizeSettledOrchestrations: async () => {},
    orchestrationNotificationInflight: new Set(), tabWorkContext: null,
    orchestrationNotificationText: () => body, prepareOrchestrationCompletionContent: async () => ({ prompt: body, metadata: { sourceSessionId: 'S' } }),
    resolveOrchestrationSourceNotificationSendOptions: () => ({ statusAtSend: 'active', queue: false }),
    armOrchestrationSourceProof: async () => { effects.arms++; return { success: true }; }, orchestrationPresentationSnapshot: () => null,
    processDueOrchestrationPolicies: async () => {}, scheduleOrchestrationPolicyTimer: async () => {},
    runAgentSendScenario: async () => { effects.writes++; return { submitted: true, deliveryUnknown: true }; },
    shortId: value => String(value || '').slice(-12),
  });
  vm.runInContext(actual, context);
  const audit = (attemptId, extra = {}) => ({ success: true, operationKey: identity.operationKey, attemptId,
    provider, sessionId: 'S', promptHash: identity.promptHash, expectedHash: identity.promptHash,
    actualHash: identity.promptHash, entryUuid: 'notification-user', sourceIdentity: 'notification-source',
    auditTimestamp: '2026-10-12T00:00:00.000Z', ...extra });
  const begin = () => {
    const attempt = receiptStore.beginAttempt(identity);
    receiptStore.markAttemptState(identity.operationKey, attempt.attemptId, 'enter-armed');
    receiptStore.settleAttempt(identity.operationKey, attempt.attemptId, { submitted: true, deliveryUnknown: true });
    return attempt.attemptId;
  };
  const reopen = async () => {
    await store.flush();
    db.close(); db = new Database(databasePath);
    receiptStore = createAgentSendReceiptStore(db, { now: () => 1000, settledRetentionMs: 10 });
    store = new runs.OrchestrationRunStore(filePath); await store.initialize();
    context.agentSendReceiptStore = receiptStore;
  };
  t.after(async () => { await store.flush(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, get receipts() { return receiptStore; }, identity, context, effects, audit, begin, reopen, filePath, databasePath, dir };
}

test('atomic canonical promotion retains its exact execution context and explicit queue flag across reopen', async t => {
  const h = await fixture(t);
  const attempt = h.begin();
  assert.equal(h.receipts.promoteFromAudit(h.audit(attempt, { executionContext, queuedAtSubmit: true })).promoted, true);
  await h.reopen();
  assert.deepEqual(h.receipts.get(h.identity.operationKey).receipt.auditExecutionContext, executionContext);
  assert.equal(h.receipts.get(h.identity.operationKey).receipt.auditQueuedAtSubmit, true);
});

test('same canonical audit enriches missing metadata, but never replaces conflicting accepted context/queue proof', async t => {
  const h = await fixture(t);
  const attempt = h.begin();
  h.receipts.promoteFromAudit(h.audit(attempt));
  assert.equal(h.receipts.get(h.identity.operationKey).receipt.auditQueuedAtSubmit, undefined);
  const enriched = h.receipts.promoteFromAudit(h.audit(attempt, { executionContext, queuedAtSubmit: false }));
  assert.equal(enriched.idempotent, true);
  assert.deepEqual(enriched.record.receipt.auditExecutionContext, executionContext);
  assert.equal(enriched.record.receipt.auditQueuedAtSubmit, false);
  h.receipts.promoteFromAudit(h.audit(attempt, { executionContext: { ...executionContext, turnId: 'foreign' }, queuedAtSubmit: true }));
  const receipt = h.receipts.get(h.identity.operationKey).receipt;
  assert.deepEqual(receipt.auditExecutionContext, executionContext);
  assert.equal(receipt.auditQueuedAtSubmit, false);
  const stale = h.receipts.promoteFromAudit(h.audit('stale', { executionContext, queuedAtSubmit: true }));
  assert.equal(stale.ok, false);
});

test('audit context from another session is not retained and absent legacy queue state stays unknown', async t => {
  const h = await fixture(t);
  const attempt = h.begin();
  h.receipts.promoteFromAudit(h.audit(attempt, { executionContext: { ...executionContext, sessionId: 'wrong' } }));
  const receipt = h.receipts.get(h.identity.operationKey).receipt;
  assert.equal(receipt.auditExecutionContext, undefined);
  assert.equal(receipt.auditQueuedAtSubmit, undefined);
});

test('same-row enrichment fills unknown execution fields but cannot overwrite a known generation', async t => {
  const h = await fixture(t);
  const attempt = h.begin();
  h.receipts.promoteFromAudit(h.audit(attempt, { executionContext: { ...executionContext, generation: null, processId: null } }));
  h.receipts.promoteFromAudit(h.audit(attempt, { executionContext, queuedAtSubmit: true }));
  assert.deepEqual(h.receipts.get(h.identity.operationKey).receipt.auditExecutionContext, executionContext);
  h.receipts.promoteFromAudit(h.audit(attempt, { executionContext: { ...executionContext, generation: 3 } }));
  assert.equal(h.receipts.get(h.identity.operationKey).receipt.auditExecutionContext.generation, 2);
});

for (const [provider, reason] of [['codex', 'codex_trimmed_boundary_whitespace'], ['claude', 'claude_owned_composer_provider_transform']]) {
  test(`${provider}: exact canonical provider transformation remains recoverable without equating request and transcript hashes`, async t => {
    const h = await fixture(t, { provider });
    const attempt = h.begin();
    const transformed = h.audit(attempt, { actualHash: 'different-canonical-transcript-hash',
      canonicalized: true, canonicalReason: reason, executionContext: { ...executionContext, provider } });
    assert.equal(h.receipts.promoteFromAudit(transformed).promoted, true);
    const answer = await h.context.reconcileOrchestrationSourceFollowup(await h.store.getInternal('R'));
    assert.equal(answer.confirmed, true);
    assert.equal(h.effects.reads, 0);
    assert.equal(h.effects.writes, 0);
  });
}

test('reopen after receipt commit but before run confirmation recovers parent and child without history or Send', async t => {
  const h = await fixture(t, { parent: true });
  h.receipts.pinForOwner(h.identity.operationKey, 'orchestration-source-followup');
  const attempt = h.begin();
  h.receipts.promoteFromAudit(h.audit(attempt, { executionContext, queuedAtSubmit: false }));
  await h.reopen();
  h.receipts.prune(5000);
  assert.ok(h.receipts.get(h.identity.operationKey));
  const confirmation = await h.context.reconcileOrchestrationSourceFollowup(await h.store.getInternal('R'), 'startup-test');
  assert.equal(confirmation.confirmed, true);
  assert.equal(confirmation.contextDisposition, 'advanced-turn');
  assert.equal(h.effects.reads, 0);
  assert.equal(h.effects.writes, 0);
  assert.equal((await h.store.get('R')).notificationStatus, 'sent');
  const saved = JSON.parse(fs.readFileSync(h.filePath, 'utf8'));
  assert.ok(saved.runs.find(r => r.runId === 'R').sourceFollowupStartedAt);
  assert.equal(saved.runs.find(r => r.runId === 'parent').targetExecutionContext.turnId, executionContext.turnId);
  h.receipts.prune(5000);
  assert.equal(h.receipts.get(h.identity.operationKey), null, 'durable projection releases its receipt pin');
  await h.reopen();
  assert.equal((await h.context.reconcileOrchestrationSourceFollowup(await h.store.getInternal('R'))).idempotent, true);
  assert.equal(h.effects.writes, 0);
});

test('legacy canonical delivery without causal context falls back to exact transcript proof, never current turn', async t => {
  const h = await fixture(t, { parent: true });
  h.receipts.promoteFromAudit(h.audit(h.begin()));
  const answer = await h.context.reconcileOrchestrationSourceFollowup(await h.store.getInternal('R'));
  assert.equal(answer.confirmed, false);
  assert.equal(h.effects.reads, 1);
  assert.equal((await h.store.get('parent')).targetExecutionContext.turnId, 'old-turn');
  assert.equal(h.effects.writes, 0);
});

test('actual startup recovers a durable receipt before arming the transcript watcher', async t => {
  const h = await fixture(t);
  h.receipts.promoteFromAudit(h.audit(h.begin(), { executionContext }));
  await h.reopen();
  await h.context.reconcileActiveOrchestrations();
  assert.equal((await h.store.get('R')).notificationStatus, 'sent');
  assert.equal(h.effects.arms, 0);
  assert.equal(h.effects.reads, 0);
  assert.equal(h.effects.writes, 0);
});

test('canonical receipt survives an owned process SIGKILL before source run projection', { timeout: 10000 }, async t => {
  const h = await fixture(t, { parent: true });
  h.receipts.pinForOwner(h.identity.operationKey, 'orchestration-source-followup');
  const attempt = h.begin();
  const code = `const Database = require('better-sqlite3');
    const { createAgentSendReceiptStore } = require(${JSON.stringify(path.join(__dirname, 'agent-send-receipt-store.js'))});
    const db = new Database(${JSON.stringify(h.databasePath)});
    const store = createAgentSendReceiptStore(db);
    const result = store.promoteFromAudit(${JSON.stringify(h.audit(attempt, { executionContext, queuedAtSubmit: false }))});
    if (!result.promoted) throw new Error(JSON.stringify(result));
    process.stdin.resume(); process.stdout.write('committed\\n');`;
  const child = spawn(process.execPath, ['--eval', code], {
    cwd: path.join(__dirname, '../..'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let committed = false, output = '', errors = '';
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('committed\n')) { committed = true; child.kill('SIGKILL'); } });
    child.on('exit', (_code, signal) => committed && signal === 'SIGKILL' ? resolve() : reject(new Error(errors || output || 'child exited before commit')));
  });
  await h.reopen();
  assert.equal((await h.context.reconcileOrchestrationSourceFollowup(await h.store.getInternal('R'))).confirmed, true);
  assert.equal(h.effects.writes, 0);
  assert.equal(h.effects.reads, 0);
});

test('cancelled delivery remains cancelled when its historical canonical receipt arrives later', async t => {
  const h = await fixture(t, { parent: true });
  const attempt = h.begin();
  h.receipts.cancelDelivery({ ...h.identity, attemptId: attempt });
  h.receipts.promoteFromAudit(h.audit(attempt, { executionContext }));
  h.context.getAgentTurnResult = async () => { h.effects.reads++; return { found: true, complete: true,
    userUuid: 'notification-user', sourceIdentity: 'notification-source', executionContext }; };
  const answer = await h.context.reconcileOrchestrationSourceFollowup(await h.store.getInternal('R'));
  assert.equal(answer.confirmed, false);
  assert.equal(answer.reason, 'source-followup-delivery-cancelled');
  assert.equal(h.receipts.get(h.identity.operationKey).state, 'confirmed', 'past delivery and future cancellation are different axes');
  assert.equal((await h.store.get('R')).sourceFollowupStartedAt, null);
  assert.equal(h.effects.reads, 0);
  assert.equal(h.effects.writes, 0);
});

for (const queuedAtSubmit of [true, undefined]) {
  test(`same active parent turn requires an explicit queued witness, queuedAtSubmit=${queuedAtSubmit}`, async t => {
    const h = await fixture(t, { parent: true });
    await h.store.patch('parent', { status: 'running', outcome: null, ownCompletedAt: null,
      targetBusySeen: true, targetExecutionContext: executionContext });
    h.receipts.promoteFromAudit(h.audit(h.begin(), { executionContext,
      ...(queuedAtSubmit === true ? { queuedAtSubmit } : {}) }));
    const answer = await h.context.reconcileOrchestrationSourceFollowup(await h.store.getInternal('R'));
    assert.equal(answer.confirmed, queuedAtSubmit === true);
    assert.equal(h.effects.writes, 0);
    if (queuedAtSubmit === true) {
      assert.equal(answer.contextDisposition, 'same-active-turn');
      assert.equal(h.effects.reads, 0);
    } else {
      assert.equal(h.effects.reads, 1);
      assert.equal((await h.store.get('R')).sourceFollowupStartedAt, null);
    }
  });
}

test('live audit routing consumes the persisted context, never conflicting duplicate metadata', async t => {
  const h = await fixture(t, { parent: true });
  const attempt = h.begin();
  h.receipts.promoteFromAudit(h.audit(attempt, { executionContext, queuedAtSubmit: false }));
  const answer = await h.context.notifyAgentPromptAuditResult({ ...h.audit(attempt), toolType: 'codex',
    sendOperationKey: h.identity.operationKey, sendAttemptId: attempt, tabId: 'T', handoffId: h.identity.handoffId,
    source: 'orchestration-completion:R', executionContext: { ...executionContext, turnId: 'wrong-later-turn' } });
  assert.equal(answer.confirmed, true);
  assert.equal((await h.store.get('parent')).targetExecutionContext.turnId, executionContext.turnId);
});

test('actual Main publisher commits its provided exact context before asynchronous web routing', async t => {
  const h = await fixture(t);
  const attempt = h.begin();
  const main = ts.createSourceFile('main.js', fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'), ts.ScriptTarget.Latest, true);
  const code = ['compatiblePromptAuditExecutionContext', 'publishAgentPromptAuditResult'].map(name => {
    const node = main.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, name); return node.getText(main);
  }).join('\n');
  Object.assign(h.context, { enrichCodexAuditAddress() {}, routeAgentPromptAuditDetail() {},
    isOrchestrationPromptAudit: () => true, deferCodexPromptAuditExecutionContext() {},
    getActiveAgentExecutionContext: () => { throw new Error('must not substitute current turn'); } });
  vm.runInContext(code, h.context);
  h.context.publishAgentPromptAuditResult('T', { handoffId: h.identity.handoffId,
    sendOperationKey: h.identity.operationKey, sendAttemptId: attempt,
    source: 'orchestration-completion:R', queuedAtSubmit: true }, h.audit(attempt, { executionContext }), 'codex');
  const receipt = h.receipts.get(h.identity.operationKey).receipt;
  assert.deepEqual(receipt.auditExecutionContext, executionContext);
  assert.equal(receipt.auditQueuedAtSubmit, true);
  assert.equal((await h.store.get('R')).sourceFollowupStartedAt, null, 'web projection deliberately has not run');
});

test('a stale audit callback cannot confirm an orchestration notification after durable promotion rejected its attempt', async t => {
  const h = await fixture(t, { parent: true });
  h.begin();
  const answer = await h.context.notifyAgentPromptAuditResult({ ...h.audit('wrong-attempt'), toolType: 'codex',
    sendOperationKey: h.identity.operationKey, sendAttemptId: 'wrong-attempt', tabId: 'T', handoffId: h.identity.handoffId,
    source: 'orchestration-completion:R', executionContext });
  assert.equal(answer.confirmed, false);
  assert.equal((await h.store.get('R')).sourceFollowupStartedAt, null);
});

test('a failed projection write cannot release the retained receipt even after its in-memory confirmation', async t => {
  const h = await fixture(t);
  h.receipts.pinForOwner(h.identity.operationKey, 'orchestration-source-followup');
  h.receipts.promoteFromAudit(h.audit(h.begin(), { executionContext }));
  h.store.persistStrict = async () => { throw new Error('projection write failed'); };
  await assert.rejects(h.context.reconcileOrchestrationSourceFollowup(await h.store.getInternal('R')), /projection write failed/);
  await assert.rejects(h.context.reconcileOrchestrationSourceFollowup(await h.store.getInternal('R')), /projection write failed/);
  h.receipts.prune(5000);
  assert.ok(h.receipts.get(h.identity.operationKey));
});

test('unknown transport, foreign hash and history-only rows never act as a durable canonical completion witness', async t => {
  for (const kind of ['unknown', 'foreign-hash', 'history-only', 'foreign-session']) {
    await t.test(kind, async t => {
      const h = await fixture(t);
      const attempt = h.begin();
      if (kind !== 'unknown') {
        h.receipts.promoteFromAudit(h.audit(attempt, { executionContext, historyOnly: kind === 'history-only' }));
        if (kind === 'foreign-hash') await h.store.patch('R', { notificationPromptAuditHash: 'different-hash' });
        if (kind === 'foreign-session') await h.store.patch('R', { notificationSourceSessionId: 'different-session' });
      }
      const answer = await h.context.reconcileOrchestrationSourceFollowup(await h.store.getInternal('R'));
      assert.equal(answer.confirmed, false);
      assert.equal(h.effects.writes, 0);
      assert.equal(h.effects.reads, 1);
    });
  }
});

test('failed strict notification checkpoint permits no physical send', async t => {
  const h = await fixture(t);
  await h.store.patch('R', { notificationStatus: 'pending', notificationAttemptedAt: null });
  h.store.persistStrict = async () => { throw new Error('fixture checkpoint disk failure'); };
  await h.context.sendOrchestrationCompletionNotification(await h.store.getInternal('R'));
  assert.equal(h.effects.writes, 0);
});

test('an exact proof arriving while the source watcher arms prevents another send even without a retained receipt', async t => {
  const h = await fixture(t);
  await h.store.patch('R', { notificationStatus: 'pending', notificationAttemptedAt: null });
  h.context.armOrchestrationSourceProof = async () => {
    await h.store.confirmSourceFollowup('R', { kind: 'transcript', sourceTabId: 'T',
      notificationPromptHash: promptFingerprint(body), sessionId: 'S', executionContext });
    return { success: true };
  };
  await h.context.sendOrchestrationCompletionNotification(await h.store.getInternal('R'));
  assert.equal(h.effects.writes, 0);
});

test('source confirmation waits for strict persistence, including an idempotent retry after a failed write', async t => {
  const h = await fixture(t);
  const proof = { kind: 'prompt-audit', sourceTabId: 'T', handoffId: h.identity.handoffId,
    source: 'orchestration-completion:R', actualHash: h.identity.promptHash, expectedHash: h.identity.promptHash,
    toolType: 'codex', sessionId: 'S', executionContext };
  const realPersist = h.store.persistStrict.bind(h.store);
  let calls = 0;
  h.store.persistStrict = async () => { calls++; throw new Error('fixture confirm disk failure'); };
  await assert.rejects(h.store.confirmSourceFollowup('R', proof), /confirm disk failure/);
  await assert.rejects(h.store.confirmSourceFollowup('R', proof), /confirm disk failure/);
  assert.equal(calls, 2);
  h.store.persistStrict = realPersist;
  assert.equal((await h.store.confirmSourceFollowup('R', proof)).idempotent, true);
  assert.ok(JSON.parse(fs.readFileSync(h.filePath, 'utf8')).runs.find(r => r.runId === 'R').sourceFollowupStartedAt);
});

test('startup rebuilds pending pins and releases only durably settled/suppressed/orphan pins owned by this projection', async t => {
  const h = await fixture(t);
  const attempt = h.begin();
  h.receipts.promoteFromAudit(h.audit(attempt, { executionContext }));
  h.receipts.pinForOwner('missing-operation', 'orchestration-source-followup');
  h.receipts.pinForOwner('other-owner-operation', 'tab-message');
  assert.equal(typeof h.context.reconcileOrchestrationSourceReceiptPins, 'function');
  await h.context.reconcileOrchestrationSourceReceiptPins();
  h.receipts.prune(5000);
  assert.ok(h.receipts.get(h.identity.operationKey));
  assert.deepEqual(h.receipts.listOwnerPins('orchestration-source-followup'), [h.identity.operationKey]);
  await h.store.markNotification('R', 'suppressed');
  await h.context.reconcileOrchestrationSourceReceiptPins();
  assert.equal(h.receipts.listOwnerPins('orchestration-source-followup').length, 0);
  assert.deepEqual(h.receipts.listOwnerPins('tab-message'), ['other-owner-operation']);
  assert.equal((await h.context.reconcileOrchestrationSourceFollowup(await h.store.getInternal('R'))).confirmed, false);
  assert.equal(h.effects.writes, 0);
});
