'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { OrchestrationRunStore, isTerminalStatus } = require('./orchestration-runs');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { targetInputOwnerFromAudit } = require('./orchestration-target-input-owner');
const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const ast = ts.createSourceFile('web.js', web, ts.ScriptTarget.Latest, true);
const part = name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast);

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-target-input-owner-'));
  const db = new Database(':memory:'), receipts = createAgentSendReceiptStore(db);
  const store = new OrchestrationRunStore(path.join(dir, 'runs.json'));
  t.after(async () => { await store.flush(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const hash = promptAuditFingerprint('original task');
  await store.create({ runId: 'R', sourceTabId: 'P', sourceProjectId: 'P', targetTabId: 'T', targetProjectId: 'P',
    targetToolType: 'codex', promptHash: 'long-request-hash', promptChars: 13, targetPromptAuditHash: hash,
    requiresTargetPromptProof: true });
  const identity = { operationKey: 'orchestration-target:R', surface: 'orchestration', runId: 'R',
    tabId: 'T', handoffId: 'orchestration:R', requestFingerprint: 'immutable-original', provider: 'codex',
    sessionId: 'S', promptHash: hash, promptLength: 13 };
  assert.equal(receipts.reserveOrGet(identity).ok, true);
  const attempt = receipts.beginAttempt(identity);
  assert.equal(attempt.action, 'attempt-started');
  receipts.markAttemptState(identity.operationKey, attempt.attemptId, 'enter-armed', {
    inputLease: { version: 1, tabId: 'T', provider: 'codex', lifecycleGeneration: 'G7', runSeq: 7, inputRevision: 6 } });
  const executionContext = { provider: 'codex', sessionId: 'S', turnId: 'E1', generation: 47, startedAt: 100 };
  const audit = { success: true, operationKey: identity.operationKey, attemptId: attempt.attemptId,
    provider: 'codex', toolType: 'codex', tabId: 'T', handoffId: identity.handoffId, source: 'orchestration:P',
    sessionId: 'S', expectedHash: hash, actualHash: hash, promptHash: hash, entryUuid: 'user-1',
    sourceIdentity: 'codex-user-source-exact', auditTimestamp: new Date().toISOString(), executionContext };
  assert.equal(receipts.promoteFromAudit(audit).promoted, true);
  const record = receipts.get(identity.operationKey);
  const detail = { ...audit, sendAttemptId: attempt.attemptId };
  const inputOwner = targetInputOwnerFromAudit('R', record, detail);
  assert.ok(inputOwner, 'actual durable Main Enter lease and accepted canonical audit must join');
  const proof = { ...detail, targetTabId: 'T', userUuid: detail.entryUuid, inputOwner };
  let sends = 0, runtimeReads = 0;
  const context = vm.createContext({ getOrchestrationRunStore: () => store, isTerminalStatus,
    classifyAgentSendReceipt: () => ({ state: 'confirmed' }), AGENT_SEND_RECEIPT_STATES: {},
    isAgentSendProviderQueueAccepted: () => false, reconcileOrchestrationRun: async () => store.get('R'),
    resolveAgentSessionInfo: async () => { runtimeReads++; return { lifecycleGeneration: 'UNRELATED-CURRENT' }; },
    emitOrchestrationChanges() {}, releaseOrchestrationResultProof: async () => {},
    scheduleOrchestrationPolicyTimer: async () => {}, runAgentSendScenario: async options => {
      sends++; assert.equal(options.prompt, 'continue'); return { submitted: true };
    } });
  vm.runInContext(part('applyOrchestrationTargetSendReceipt') + '\n' + part('sendCodexCapacityContinuation'), context);
  const retry = () => context.sendCodexCapacityContinuation({ tabId: 'T', sessionId: 'S', turnId: 'E1',
    generation: 'G7', handoffId: 'capacity:E1', isCurrent: async () => true });
  return { dir, db, store, record, detail, proof, inputOwner, context, retry, sends: () => sends, runtimeReads: () => runtimeReads };
}

test('canonical audit before transport ACK binds the exact Enter generation; capacity can send one continuation', async t => {
  const f = await fixture(t);
  const confirmed = await f.store.confirmTargetPromptDelivery('R', f.proof);
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.run.targetLifecycleGeneration, 'G7');
  assert.equal(confirmed.run.targetLifecycleProof.attemptId, f.record.attemptId);
  await f.context.applyOrchestrationTargetSendReceipt('R', { submitted: true });
  assert.equal(f.runtimeReads(), 0, 'a later generic tab read is not the original Send owner');
  const result = await f.retry(); assert.equal(result.submitted, true, result.error); assert.equal(f.sends(), 1);
});

test('legacy missing Enter proof still refuses, and the refusal retains the exact reason and generations', async t => {
  const f = await fixture(t);
  await f.store.confirmTargetPromptDelivery('R', { ...f.proof, inputOwner: null });
  const result = await f.retry();
  assert.equal(result.code, 'capacity-recovery-owner-changed');
  assert.equal(result.reason, 'target-generation-unproven');
  assert.equal(result.expectedLifecycleGeneration, null); assert.equal(result.observedLifecycleGeneration, 'G7');
  assert.equal(f.sends(), 0);
});

test('idempotent audit can enrich the same legacy run; JSON restart preserves the proof', async t => {
  const f = await fixture(t);
  await f.store.confirmTargetPromptDelivery('R', { ...f.proof, inputOwner: null });
  const result = await f.store.confirmTargetPromptDelivery('R', f.proof);
  assert.equal(result.idempotent, true); assert.equal(result.run.targetLifecycleGeneration, 'G7');
  await f.store.flush();
  const reopened = new OrchestrationRunStore(path.join(f.dir, 'runs.json'));
  assert.equal((await reopened.get('R')).targetLifecycleProof.attemptId, f.record.attemptId);
});

test('known replacement generation, resumed new turn and changed attempt cannot be overwritten by old audit', async t => {
  const f = await fixture(t);
  await f.store.patch('R', { targetLifecycleGeneration: 'OTHER' });
  let result = await f.store.confirmTargetPromptDelivery('R', f.proof);
  assert.equal(result.inputOwnerReason, 'target-input-owner-generation-conflict');
  assert.equal(result.run.targetLifecycleGeneration, 'OTHER');
  await f.store.patch('R', { targetLifecycleGeneration: null, resumeAwaitingNewTurn: true });
  result = await f.store.confirmTargetPromptDelivery('R', f.proof);
  assert.equal(result.inputOwnerReason, 'target-input-owner-proof-mismatch');
  assert.equal(result.run.targetLifecycleGeneration, null);
  await f.store.patch('R', { resumeAwaitingNewTurn: false });
  await f.store.confirmTargetPromptDelivery('R', f.proof);
  result = await f.store.confirmTargetPromptDelivery('R', { ...f.proof,
    inputOwner: { ...f.inputOwner, attemptId: 'other-attempt' } });
  assert.equal(result.inputOwnerReason, 'target-input-owner-attempt-conflict');
});

test('receipt mapper rejects foreign/missing/unknown proof instead of blessing a current tab', async t => {
  const f = await fixture(t);
  for (const patch of [{ state: 'delivery-unknown' }, { attemptId: 'foreign' }, { tabId: 'other' },
    { surface: 'project-api' }, { handoffId: 'other' }, { inputLease: null },
    { inputLease: { ...f.record.inputLease, runSeq: 0 } },
    { receipt: { ...f.record.receipt, auditExecutionContext: null } }]) {
    assert.equal(targetInputOwnerFromAudit('R', { ...f.record, ...patch }, f.detail), null);
  }
  for (const patch of [{ sendAttemptId: 'wrong' }, { actualHash: 'wrong' }, { sessionId: 'other' },
    { executionContext: { ...f.detail.executionContext, turnId: 'other' } }]) {
    assert.equal(targetInputOwnerFromAudit('R', f.record, { ...f.detail, ...patch }), null);
  }
});

test('actual live target audit branch forwards only the durable accepted record to the owner mapper', () => {
  const branch = web.slice(web.indexOf('const targetRunId = orchestrationTargetRunIdFromAudit(detail);'));
  assert.match(branch.slice(0, 500), /durableAuditAccepted[\s\S]*targetInputOwnerFromAudit\([\s\S]*durablePromotion\?\.record/);
  assert.match(branch.slice(0, 1700), /executionContext: detail\.executionContext \|\| null,\s+inputOwner,/);
});
