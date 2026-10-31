'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { isExactProviderNotAcceptedReceipt } = require('./agent-send-receipt-registry');
const limits = require('./agent-provider-input-limit'), rejection = require('./codex-input-rejection');
const text = 'x'.repeat(limits.CODEX_MAX_MESSAGE_SCALARS + 1);
const main = fs.readFileSync(require.resolve('./main'), 'utf8'), tree = ts.createSourceFile('main.js', main, 99, true);
const declaration = name => tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(tree);
function frame(lines = [], generation = 10) { return { success: true, authoritativeFrameCommitted: true,
  mirrorGeneration: 'M', committedFrameGeneration: generation, writeSeq: generation, lines }; }
const banner = ['\u25a0 Message exceeds the maximum length of 1048576 characters (1048577', 'provided).'];
function fixture(t) {
  const db = new Database(':memory:'), store = createAgentSendReceiptStore(db);
  const identity = { operationKey: 'orchestration-target:fixture-run', handoffId: 'orchestration:fixture-run', surface: 'orchestration', runId: 'fixture-run',
    tabId: 'T', provider: 'codex', sessionId: 'S', requestFingerprint: 'fixture-request',
    promptHash: promptAuditFingerprint(text), promptLength: text.length };
  store.reserveOrGet(identity); store.stageQueuedRequest(identity.operationKey, { promptText: text });
  const attempt = store.beginAttempt(identity);
  store.stageAttemptContext(identity.operationKey, attempt.attemptId, { transportText: text, promptText: text });
  store.markAttemptState(identity.operationKey, attempt.attemptId, 'enter-armed');
  store.settleAttempt(identity.operationKey, attempt.attemptId, { submitted: true, pasteWritten: true, enterWritten: true,
    auditPending: true, status: 'audit-pending' });
  const audit = { sendOperationKey: identity.operationKey, sendAttemptId: attempt.attemptId, handoffId: identity.handoffId,
    expectedText: text, expectedHash: identity.promptHash, expectedLen: text.length, submitWritten: true,
    enterRunSeq: 7, enterLifecycleGeneration: 'L', enterInputRevision: 8, source: 'codex-orchestration:source',
    sentAt: Date.now(), finished: false, enterRetryCount: 0 };
  audit.inputRejectionBaseline = rejection.captureCodexInputRejectionBaseline(frame(), audit);
  const input = { tabId: 'T', sessionId: 'S', mirrorGeneration: 'M', sameTerminal: true, writeQueueOwned: true,
    turnBusy: false, runSeq: 7, lifecycleGeneration: 'L', inputRevision: 8 };
  const term = { write() { throw Error('no new payload/Enter is authorized'); } }, mirror = { generation: 'M' }, audits = [audit], details = [];
  const context = vm.createContext({ require, path, srcMainDir: __dirname, console: { log() {}, warn() {}, error() {} },
    ...require('./codex-post-enter-retry'),
    terminals: new Map([['T', term]]), terminalCommandState: new Map([['T', { isRunning: true, runSeq: 7 }]]),
    agentSendReceiptStore: store, AGENT_SEND_DURABLE_STATES: STORE_STATES,
    getHeadlessTerminalMirror: () => mirror, resolveAiToolTypeForTab: () => 'codex',
    getTerminalLifecycleGeneration: () => 'L', getTerminalInputRevision: () => 8,
    codexKnownSessions: new Map([['T', 'S']]), codexTurnWatchers: new Map([['T', { busy: false }]]), ptyLastQueuedWriteOperation: new WeakMap(),
    getPendingCodexPasteAudits: () => audits,
    holdPasteAuditCompletionForTest: () => false,
    removePendingCodexPasteAudit: (_tab, value) => audits.splice(audits.indexOf(value), 1),
    routeAgentPromptAuditDetail: detail => details.push(detail),
    releaseCodexProvisionalSourceAfterMatchedAudit: () => assert.fail('rejection is not a positive audit'),
    setTimeout, clearTimeout,
  });
  vm.runInContext(['compatiblePromptAuditExecutionContext', 'isOrchestrationPromptAudit', 'publishAgentPromptAuditResult',
    'finishCodexPasteAudit', 'observeCodexInputLengthRejectedCommittedFrame', 'waitForCodexPasteAudit',
    'finishCodexPasteAuditAfterWrite', 'retryCodexEnterAfterAuditTimeout'].map(declaration).join('\n'), context);
  t.after(() => { if (audit.timer) clearTimeout(audit.timer); db.close(); });
  return { db, store, identity, attempt, audit, input, term, mirror, context, details,
    classify: (patch = {}) => rejection.classifyCodexInputRejectionFrame({ baseline: audit.inputRejectionBaseline,
      audit, record: store.get(identity.operationKey), snapshot: frame(banner, 11), identity: input, ...patch }) };
}
test('fresh exact CLI length refusal settles the same entered attempt and finishes its real pending audit', async t => {
  const h = fixture(t);
  const pending = h.context.finishCodexPasteAuditAfterWrite(h.term, { tabId: 'T', audit: h.audit, timeoutMs: 8000,
    logPrefix: '[fixture]', startedAt: Date.now(), baseResult: { submitted: true } });
  assert.equal(h.context.observeCodexInputLengthRejectedCommittedFrame('T', h.mirror, frame(banner, 11)), true);
  const result = await pending, record = h.store.get(h.identity.operationKey);
  assert.equal(record.state, 'provider-not-accepted'); assert.equal(record.attemptId, h.attempt.attemptId);
  assert.equal(result.submitted, true); assert.equal(result.code, 'codex_message_too_large');
  assert.equal(result.providerTurnCreated, false); assert.equal(result.draftPreserved, null);
  assert.equal(result.authoringPreserved, true); assert.equal(record.receipt.promptText, text);
  assert.equal(isExactProviderNotAcceptedReceipt(result), true);
  assert.equal(h.details[0].inputLimit.actual, text.length);
  assert.equal(h.details[0].providerInputRejection.attemptId, h.attempt.attemptId);
  assert.equal(h.audit.finished, true);
});
for (const name of ['old-frame', 'replay', 'sync-open', 'wrong-mirror', 'wrong-session', 'wrong-input', 'wrong-run', 'wrong-lifecycle', 'busy',
  'new-writer', 'changed-attempt', 'unknown', 'confirmed', 'queued', 'cancelled', 'wrong-count', 'quoted-warning']) {
  test(name + ' cannot become a negative delivery proof', t => {
    const h = fixture(t), patch = {};
    if (name === 'old-frame') patch.snapshot = frame(banner);
    if (name === 'replay') patch.snapshot = { ...frame(banner, 11), committedFrameReplay: true };
    if (name === 'sync-open') patch.snapshot = { ...frame(banner, 11), synchronizedOutputOpen: true };
    if (name === 'wrong-mirror') patch.snapshot = { ...frame(banner, 11), mirrorGeneration: 'other' };
    if (name === 'wrong-session') patch.identity = { ...h.input, sessionId: 'other' };
    for (const [kind, key, value] of [['wrong-input', 'inputRevision', 99], ['wrong-run', 'runSeq', 99],
      ['wrong-lifecycle', 'lifecycleGeneration', 'other'], ['busy', 'turnBusy', true], ['new-writer', 'writeQueueOwned', false]]) {
      if (name === kind) patch.identity = { ...h.input, [key]: value };
    }
    const record = h.store.get(h.identity.operationKey);
    if (name === 'changed-attempt') patch.record = { ...record, attemptId: 'other' };
    if (name === 'unknown' || name === 'confirmed') patch.record = { ...record, state: name === 'unknown' ? 'delivery-unknown' : 'confirmed' };
    if (name === 'queued') patch.record = { ...record, receipt: { ...record.receipt, providerQueue: { accepted: true } } };
    if (name === 'cancelled') patch.record = { ...record, deliveryControl: { cancelledAt: 1 } };
    if (name === 'wrong-count') patch.snapshot = frame(banner.map(row => row.replace('1048577', '1048578')), 11);
    if (name === 'quoted-warning') patch.snapshot = frame(['quoted: Message exceeds the maximum length of 1048576 characters (1048577 provided).'], 11);
    assert.equal(h.classify(patch).rejected, false);
    assert.equal(h.store.get(h.identity.operationKey).state, 'audit-pending');
  });
}
test('pre-existing matching warning cannot be reassigned by a new repaint', t => {
  const h = fixture(t);
  h.audit.inputRejectionBaseline = rejection.captureCodexInputRejectionBaseline(frame(banner), h.audit);
  assert.equal(h.classify().rejected, false);
});
test('timeout without a fresh refusal stays audit-pending and does not repeat an oversized Enter', async t => {
  const h = fixture(t);
  h.mirror.lastCommittedVisibleSnapshot = frame([], 11);
  const timeout = await h.context.waitForCodexPasteAudit('T', h.audit, 1);
  assert.equal(timeout.error, 'codex_user_message_audit_timeout');
  const retry = await h.context.retryCodexEnterAfterAuditTimeout({ tabId: 'T', term: h.term,
    audit: h.audit, timeoutResult: timeout, logPrefix: '[fixture]' });
  assert.equal(retry.retried, false); assert.equal(retry.reason, 'oversized-input-retry-cannot-help');
  assert.equal(h.store.get(h.identity.operationKey).state, 'audit-pending');
  assert.equal(h.audit.finished, false); assert.equal(h.details.length, 0);
});
test('SQLite refusal persistence failure does not publish a negative receipt or finish the audit', t => {
  const h = fixture(t);
  h.db.exec("CREATE TRIGGER refusal_write_fault BEFORE UPDATE ON agent_send_receipts WHEN NEW.state = 'provider-not-accepted' BEGIN SELECT RAISE(ABORT, 'controlled refusal-write fault'); END");
  assert.equal(h.context.observeCodexInputLengthRejectedCommittedFrame('T', h.mirror, frame(banner, 11)), false);
  assert.equal(h.store.get(h.identity.operationKey).state, 'audit-pending');
  assert.equal(h.audit.finished, false); assert.equal(h.details.length, 0);
});
test('negative receipt owner independently rechecks O/H/A/hash and never rewrites UNKNOWN', t => {
  const h = fixture(t), proof = h.classify().proof;
  const base = { ...limits.codexInputLimitReceipt(proof.actual), ...h.identity, attemptId: h.attempt.attemptId,
    expectedHash: h.audit.expectedHash, submitted: true, pasteWritten: true, enterWritten: true,
    semanticStatus: 'not-submitted', providerAccepted: false, providerTurnCreated: false,
    composerDraftState: 'exact-provider-length-rejection', lateReconciliationPending: false, providerInputRejection: proof };
  for (const changed of [{ handoffId: 'other' }, { promptHash: 'other' }, { expectedHash: 'other' }]) {
    assert.equal(h.store.settleAttempt(h.identity.operationKey, h.attempt.attemptId, { ...base, ...changed }).applied, false);
  }
  h.store.markDeliveryUnknown(h.identity.operationKey, h.attempt.attemptId, { code: 'fixture-lost-owner' });
  assert.equal(h.store.settleAttempt(h.identity.operationKey, h.attempt.attemptId, base).applied, false);
  assert.equal(h.store.get(h.identity.operationKey).state, 'delivery-unknown');
});
test('actual late negative audit projects the durable refusal into a terminal run and survives file-store reopen', async t => {
  const h = fixture(t), os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rejection-run-'));
  const runs = require('./orchestration-runs'), registry = require('./agent-send-receipt-registry');
  const file = path.join(root, 'runs.json'), store = new runs.OrchestrationRunStore(file);
  t.after(async () => { await store.flush(); fs.rmSync(root, { recursive: true, force: true }); });
  await store.create({ runId: h.identity.runId, sourceTabId: 'P', targetTabId: 'T', targetToolType: 'codex',
    sourceProjectId: 'P', targetProjectId: 'P', promptHash: h.identity.promptHash,
    promptChars: text.length, notifySource: false, requiresTargetPromptProof: true });
  await store.markDelivery(h.identity.runId, { sessionId: 'S', auditPending: true });
  const acceptedAt = (await store.get(h.identity.runId)).deliveryAcceptedAt;
  assert.equal(h.context.observeCodexInputLengthRejectedCommittedFrame('T', h.mirror, frame(banner, 11)), true);
  const web = fs.readFileSync(require.resolve('./web-server'), 'utf8'), ast = ts.createSourceFile('web.js', web, 99, true);
  const part = name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast);
  let published = 0;
  const context = vm.createContext({ require, path, srcMainDir: __dirname, ...runs,
    AGENT_SEND_RECEIPT_STATES: registry.RECEIPT_STATES,
    console: { warn() {}, log() {} }, getOrchestrationRunStore: () => store, agentSendReceiptStore: h.store,
    cleanOptionalString: (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback,
    emitOrchestrationChanges() {}, finalizeSettledOrchestrations: async () => { published++; } });
  vm.runInContext(part('applyOrchestrationTargetSendReceipt') + '\n' + part('notifyAgentPromptAuditResult'), context);
  const result = await context.notifyAgentPromptAuditResult(h.details[0]);
  assert.equal(result.failed, true); assert.equal(result.kind, 'provider-not-accepted');
  const run = await store.get(h.identity.runId);
  assert.equal(run.status, 'failed'); assert.equal(run.errorCode, 'codex_message_too_large');
  assert.equal(run.deliveryFailure.inputLimit.actual, 1048577);
  assert.equal(run.deliveryAcceptedAt, acceptedAt, 'physical Enter history is not erased');
  assert.equal(run.targetPromptProofAt ?? null, null);
  assert.equal(run.recoveryDeadlineAt ?? null, null);
  assert.match(run.error, /maximum 1048576/); assert.equal(published, 1);
  await store.flush();
  const reopened = new runs.OrchestrationRunStore(file);
  const restored = await reopened.get(h.identity.runId);
  assert.equal(restored.status, 'failed'); assert.deepEqual(restored.deliveryFailure, run.deliveryFailure);
  assert.equal((await context.notifyAgentPromptAuditResult(h.details[0])).failed, false);
  assert.equal(published, 1, 'duplicate wake cannot publish another failure');
});
