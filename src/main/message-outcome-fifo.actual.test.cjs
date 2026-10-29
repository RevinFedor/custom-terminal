'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), Database = require('better-sqlite3');
const { AgentSendQueue } = require('./agent-send-queue');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const registry = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { classifyAgentSendReceipt } = require('./orchestration-runs');
const { compactSendReceiptPresentation } = require('./compact-send-settlement');
const { imagePresentationFromReceipt } = require('./history-authoring-projection');
const { isLocalSlashCommandPrompt } = require('./agent-history-send-receipt');
const { TabWorkContext } = require('./tab-work-context');
const { MessageLoopWaits } = require('./message-loop-waits');
const { TabMessageService } = require('./tab-messages');
const { MessageReturnProofs } = require('./message-return-proofs');
const { _api: codexApi } = require('./ipc/codex-data');
const { classifyCodexTurnRecord } = require('./codex-turn-outcome');
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = fs.readFileSync(process.env.ACTUAL_SOURCE_DIR ? path.join(process.env.ACTUAL_SOURCE_DIR, 'web-server.js')
  : require.resolve('./web-server'), 'utf8');
const ast = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true);
const declaration = name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast);
function exported(name) {
  let result;
  function visit(node) { if (ts.isPropertyAssignment(node) && node.name.getText(ast) === name) result = node.initializer.getText(ast); ts.forEachChild(node, visit); }
  visit(ast); return result;
}
function restoredExecutor() {
  let result;
  function visit(node) {
    if (ts.isNewExpression(node) && node.expression.getText(ast) === 'AgentSendQueue') {
      result = node.arguments[0].properties.find(property => property.name.getText(ast) === 'execute').initializer.getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(result); return result;
}
const harnessFile = require.resolve('./agent-send-application-queue.integration.test.js');
const harnessTree = ts.createSourceFile(harnessFile, fs.readFileSync(harnessFile, 'utf8'), ts.ScriptTarget.Latest, true);
const harnessCode = harnessTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'harness').getText(harnessTree);
async function fixture(t, { deferOutcome = false } = {}) {
  // Reuse the existing actual Main FIFO test fixture, not a second sender.
  const host = vm.createContext({ require, __dirname, Database, AgentSendQueue, createAgentSendReceiptStore, registry,
    promptAuditFingerprint, compactSendReceiptPresentation, imagePresentationFromReceipt, classifyAgentSendReceipt,
    isLocalSlashCommandPrompt, fs, path, vm, ts, assert, Buffer, declaration, exported, tick });
  vm.runInContext(harnessCode + '\nglobalThis.make=harness;', host);
  const h = host.make(t, 'codex'); h.queue.ready = () => false;
  const db = h.store.db, proof = new Map(), notices = [], changed = [];
  const question = { messageId: '26ced46a-0677-44c9-a9b4-c64c8d9173d8', kind: 'question', requestId: 'Q',
    targetTabId: 'B', targetTabName: 'B', deliveryState: 'failed',
    source: { tabId: 'T', projectId: 'P', provider: 'codex', sessionId: 'S', cwd: '/fixture' } };
  const context = new TabWorkContext({ db, listTabs: () => [{ tabId: 'T', projectId: 'P' }] });
  context.publish('T', { sourceTabId: 'B', title: 'Source checkpoint', text: 'actual frozen prefix', requestId: 'ctx' });
  const symbol = Symbol('message-outcome'), owner = new MessageLoopWaits({ db,
    messages: { questionWaitReference: () => question, questionWaitReferences: () => [question] },
    readSource: async () => ({ ...question.source, known: true }),
    readDelivery: delivery => delivery.operationKey ? h.context.readMessageReturnDelivery(delivery) : { state: 'absent', provenNoInput: true },
    readCompletion: async (_source, receipt) => proof.get(receipt.operationKey) || { known: false },
    sendNotice: async (notice, source, ref) => { notices.push(notice); return h.context.sendMessageWaitOutcome(notice, source, ref); },
    changed: entry => changed.push(entry), setDeadline: () => 1, clearDeadline() {} });
  t.after(() => owner.dispose());
  Object.assign(h.context, { MESSAGE_OUTCOME_ADMISSION: symbol, getMessageLoopWaits: () => owner,
    withPromptOriginPresentation: require('../shared/prompt-origin.cjs').withPromptOriginPresentation,
    tabWorkContext: context, OPERATIONAL_ADMISSION: Symbol('operational'), BUILD_CONTINUE_ADMISSION: Symbol('build'),
    readMessageReturnProof: async (_source, receipt) => proof.get(receipt.operationKey),
    getBuildContinueOperations: () => ({ capturing: () => false, pending: () => false, staleLoopAdmission: () => null }), historyMutationInput: null,
    getTabMessageService: () => ({ pendingReplyReferences: () => [] }),
    isPromptLoopAutomationSource: () => false, isAutomaticPromptQueueRequest: () => false, messageLoopWaits: owner });
  vm.runInContext(['readMessageReturnDelivery', 'readMessageReturnReferences', 'resolveMessageWaitOutcome', 'sendMessageWaitOutcome', 'admitQueuedAgentSend']
    .map(declaration).join('\n') + '\nglobalThis.restoreExecute=' + restoredExecutor() + ';', h.context);
  h.queue.execute = h.context.restoreExecute;
  h.queue.admit = h.context.admitQueuedAgentSend;
  let cancelNotice;
  const factory = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getMessageLoopWaits');
  function findCancel(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'cancelNotice') cancelNotice = node.initializer.getText(ast);
    ts.forEachChild(node, findCancel);
  }
  findCancel(factory); assert.ok(cancelNotice);
  owner.cancelNotice = vm.runInContext('(' + cancelNotice + ')', h.context);
  owner.observe(question); if (!deferOutcome) await owner.reconcile();
  assert.equal(notices.length, deferOutcome ? 0 : 1); assert.equal(h.writes.length, 0);
  return { ...h, owner, notices, changed, question, proof, workContext: context };
}
test('finite outcome -> prepared context -> SQLite FIFO -> restored executor preserves canonical delivery without a processing dependency', async t => {
  const h = await fixture(t), notice = h.notices[0], queued = h.queue.item(notice.operationKey);
  assert.ok(queued); assert.equal(h.owner.blocks('T'), false);
  const before = queued.request_json, request = JSON.parse(before);
  assert.deepEqual(request.presentationSnapshot.semanticTags, [
    { kind: 'prompt-origin', source: 'system', systemSource: 'tab-message-outcome' },
  ], 'service origin is durable before the renderer receives the queued prompt');
  if (request.presentationSnapshot.authoringTransport) {
    assert.deepEqual(request.presentationSnapshot.authoringTransport.imageRanges, []);
    assert.match(request.presentationSnapshot.authoringTransport.sourceHash, /^[a-f0-9]{64}$/);
  }
  assert.match(request.prompt, /actual frozen prefix/); assert.match(request.prompt, /waiting outcome/);
  assert.equal(h.workContext.readPreparedHandoff('T', notice.handoffId).prepared_prompt, request.prompt);
  // Drop the process-local executor closure. The real factory must restore
  // its private admission from immutable JSON, never a serialized Symbol.
  h.queue.executors.clear(); h.queue.ready = () => true;
  await h.queue.pump('T'); assert.equal(h.writes.length, 1);
  assert.equal(h.queue.item(notice.operationKey).request_json, before);
  assert.equal(h.store.get(notice.operationKey).state, 'audit-pending');
  assert.equal(h.writes[0].queue, true);
  await h.owner.reconcile(); assert.equal(h.owner.blocks('T'), false); assert.equal(h.notices.length, 1);
  const row = h.store.get(notice.operationKey);
  h.store.promoteFromAudit({ success: true, operationKey: row.operationKey, attemptId: row.attemptId,
    provider: row.provider, sessionId: row.sessionId, promptHash: row.promptHash,
    expectedHash: row.promptHash, actualHash: row.promptHash, entryUuid: 'exact-outcome-user',
    sourceIdentity: 'exact-outcome-source', auditTimestamp: new Date().toISOString() });
  await h.owner.reconcile(); assert.equal(h.owner.blocks('T'), false, 'the status has no mandatory consuming-turn dependency');
  const receipt = h.context.readMessageReturnDelivery(notice);
  assert.equal(h.context.readMessageReturnReferences('T').length, 0);
  assert.equal(receipt.state, 'confirmed');
  assert.equal(h.context.readMessageReturnReferences('other').length, 0);
  assert.equal(h.owner.entrySnapshot(h.question.messageId).processed, undefined);
  await h.owner.reconcile(); assert.equal(h.owner.blocks('T'), false);
  assert.equal(h.context.readMessageReturnReferences('T').length, 0);
  await h.queue.pump('T'); await h.owner.reconcile(); assert.equal(h.writes.length, 1);
});
test('question cancellation before restored FIFO dispatch revokes the outbox without physical input or replacement IDs', async t => {
  const h = await fixture(t), notice = h.notices[0], original = h.queue.item(notice.operationKey);
  h.question.cancelledAt = '2026-10-23T00:00:00Z'; h.owner.observe(h.question);
  h.queue.executors.clear(); h.queue.ready = () => true;
  await h.queue.pump('T'); assert.equal(h.writes.length, 0);
  assert.equal(h.queue.item(notice.operationKey).request_json, original.request_json);
  assert.equal(h.store.get(notice.operationKey).state, 'not-submitted');
  assert.equal(h.store.get(notice.operationKey).attemptId, null);
});
for (const crossed of [false, true]) test('legacy processing notice retirement preserves ' + (crossed ? 'crossed UNKNOWN' : 'unwritten FIFO') + ' evidence', async t => {
  const h = await fixture(t), notice = h.notices[0];
  if (crossed) { h.queue.ready = () => true; await h.queue.pump('T'); }
  const before = h.store.get(notice.operationKey), frozen = h.queue.item(notice.operationKey).request_json;
  const current = h.owner.entries.get(h.question.messageId);
  h.owner.save(current, { contract: null, state: 'returning', disposition: 'reply_processing_timeout',
    notice: { ...current.notice, reason: 'reply_processing_timeout' } });
  await h.owner.reconcile();
  assert.equal(h.owner.blocks('T'), false);
  assert.equal(h.queue.item(notice.operationKey).request_json, frozen);
  const after = h.store.get(notice.operationKey);
  assert.equal(h.store.isDeliveryCancelled(notice.operationKey), true);
  if (crossed) {
    assert.equal(after.attemptId, before.attemptId); assert.equal(after.state, before.state);
    assert.deepEqual(after.receipt, before.receipt, 'cancellation does not manufacture no-input from the crossed attempt');
    assert.equal(h.writes.length, 1);
  } else { assert.equal(after.attemptId, null); assert.equal(after.state, 'not-submitted'); assert.equal(h.writes.length, 0); }
  h.queue.executors.clear(); h.queue.ready = () => true; await h.queue.pump('T'); await h.owner.reconcile();
  assert.equal(h.writes.length, crossed ? 1 : 0, 'retired notice is never replayed');
});
test('actual Reply -> original SQLite FIFO -> native audit settles at delivery with busy/no-final leaves', async t => {
  const h = await fixture(t, { deferOutcome: true });
  h.question.deliveryState = 'sent';
  const reply = { messageId: 'fixture-return', operationKey: 'tab-message:fixture-return', handoffId: 'tab-message:fixture-return',
    targetTabId: 'T', targetProvider: 'codex', targetSessionId: 'S', deliveryState: 'queued' };
  h.question.reply = reply; h.owner.observe(h.question);
  h.owner.readCompletion = () => { throw Error('No historical response read'); };
  await h.context.runAgentSendScenario({ tabId: 'T', prompt: 'exact bounded Reply', handoffId: reply.handoffId,
    sendOperationKey: reply.operationKey, source: 'tab-message:' + reply.messageId, sendSurface: 'tab-message',
    queue: true, ownership: 'project', provider: 'codex', sessionId: 'S',
    expectedTarget: { toolType: 'codex', sessionId: 'S' }, applicationQueueAcceptedResponse: true });
  const queued = h.queue.item(reply.operationKey), frozen = queued.request_json;
  h.queue.executors.clear(); h.queue.ready = () => true; await h.queue.pump('T');
  await h.owner.reconcile(); assert.equal(h.owner.blocks('T'), true);
  const row = h.store.get(reply.operationKey);
  assert.equal(row.state, 'audit-pending');
  h.store.promoteFromAudit({ success: true, operationKey: row.operationKey, attemptId: row.attemptId,
    provider: row.provider, sessionId: row.sessionId, expectedHash: row.promptHash, actualHash: row.promptHash,
    entryUuid: 'exact-reply-user', sourceIdentity: 'exact-reply-source', auditTimestamp: new Date().toISOString() });
  const canonical = h.context.readMessageReturnDelivery(reply); assert.equal(canonical.state, 'confirmed');
  for (const patch of [{ targetTabId: 'other' }, { targetProvider: 'claude' }, { targetSessionId: 'other' }, { messageId: 'other' }]) {
    assert.equal(h.context.readMessageReturnDelivery({ ...reply, ...patch }).state, 'unconfirmed');
  }
  const original = h.queue.item.bind(h.queue);
  h.queue.item = key => { const item = original(key); return item && { ...item, request_hash: 'changed' }; };
  assert.equal(h.context.readMessageReturnDelivery(reply).state, 'unconfirmed');
  h.queue.item = original;
  await h.owner.reconcile(); assert.equal(h.owner.blocks('T'), false);
  const after = h.owner.entrySnapshot(h.question.messageId);
  assert.equal(after.settlement.kind, 'reply-delivered'); assert.equal(after.replyProcessed, undefined);
  assert.equal(after.settlement.receipt.attemptId, row.attemptId);
  assert.equal(h.queue.item(reply.operationKey).request_json, frozen);
  await h.owner.reconcile(); await h.queue.pump('T'); assert.equal(h.writes.length, 1); assert.equal(h.notices.length, 0);
});
test('a stale never-attempted Loop at FIFO HEAD cannot deadlock the Reply/outcome queued behind it; UNKNOWN is never retired here', async t => {
  const h = await fixture(t, { deferOutcome: true });
  const q = { loopPromptEnabled: true, loopPromptMode: 'all-work', loopPromptEpoch: 'E', pendingDelivery: {
    kind: 'loop', loopPromptMode: 'all-work', loopEpoch: 'E', handoffId: 'L', loopCause: { provider: 'codex', sessionId: 'S', turnId: 'parent' } } };
  Object.assign(h.context, require('../shared/loop-dependencies.cjs'), {
    captureTabInspection: () => ({ known: true, loopInputBoundary: 'input-B' }),
    readPersistedLoopQueue: () => q, buildInstallAutomationBlocked: () => false,
    isPromptLoopAutomationSource: source => source === 'prompt-loop' });
  const admission = declaration('acceptedReplyInputPending') + '\n' + declaration('loopSendAdmission');
  const oldGate = admission.replaceAll("return { cancel: true, reason: 'loop-message-dependency-pending' }", 'return false');
  vm.runInContext((process.env.MESSAGE_WAIT_NO_CANCEL_REPRO === '1' ? oldGate : admission)
    + declaration('readMessageLoopDeferredReceipt'), h.context);
  await h.context.runAgentSendScenario({ tabId: 'T', provider: 'codex', sessionId: 'S',
    prompt: 'old loop check', handoffId: 'L', sendOperationKey: 'history:T:L', sendSurface: 'desktop-history',
    source: 'prompt-loop', queue: true, ownership: 'project', applicationQueueAcceptedResponse: true,
    expectedTarget: { toolType: 'codex', sessionId: 'S' } });
  await h.owner.reconcile(); const notice = h.notices[0];
  assert.ok(h.queue.item('history:T:L').id < h.queue.item(notice.operationKey).id);
  h.queue.executors.clear(); h.queue.ready = () => true;
  await h.queue.pump('T');
  assert.equal(h.store.get('history:T:L').state, 'not-submitted', 'unwritten Loop HEAD must release the return input behind it');
  await h.queue.result(notice.operationKey);
  assert.equal(h.store.get('history:T:L').attemptId, null);
  const deferred = h.context.readMessageLoopDeferredReceipt(h.store.get('history:T:L'));
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.causeInvalidated, true, 'expired pre-input cause is retired without turning Loop OFF');
  assert.equal(q.loopPromptEnabled, true);
  assert.deepEqual(Array.from(h.writes, write => write.handoffId), [notice.handoffId]);
  assert.equal(h.context.readMessageLoopDeferredReceipt({ ...h.store.get('history:T:L'), attemptId: 'begun', state: 'delivery-unknown' }), null);
});
for (const beforeReservation of [false, true]) test('full-contract: local X cannot let a never-attempted old Loop overtake an accepted Reply '
  + (beforeReservation ? 'during context preparation before FIFO reservation' : 'with an existing FIFO reservation'), async t => {
  const h = await fixture(t, { deferOutcome: true });
  let arrive, resume;
  const entered = new Promise(resolve => { arrive = resolve; }), preparation = new Promise(resolve => { resume = resolve; });
  h.question.cancelledAt = '2026-01-01T00:00:00Z'; h.owner.observe(h.question);
  const messages = new TabMessageService({ db: h.store.db, requireLoopWait: true,
    resolveTab: async id => ({ tabId: id, projectId: 'P', provider: 'codex', sessionId: id === 'T' ? 'S' : 'S-B' }),
    beforeDelivery: message => h.owner.observe(message), onChanged: message => h.owner.observe(message),
    send: async message => {
      if (message.kind === 'question') return { state: 'confirmed' };
      if (beforeReservation) { arrive(); await preparation; }
      return h.context.runAgentSendScenario({
      tabId: message.targetTabId, prompt: message.prompt, handoffId: message.handoffId, sendOperationKey: message.operationKey,
      source: 'tab-message:' + message.messageId, sendSurface: 'tab-message', provider: 'codex', sessionId: 'S', queue: true,
      ownership: 'project', expectedTarget: { toolType: 'codex', sessionId: 'S' }, applicationQueueAcceptedResponse: true });
    },
  });
  await messages.initialize(); h.owner.messages = messages; t.after(() => messages.dispose());
  const q = (await messages.sendMessage({ source: 'T', target: 'B', text: 'one question', requestId: 'Q' })).message;
  while (messages.lanes.size) await Promise.all([...messages.lanes.values()]);
  const queue = { loopPromptEnabled: true, loopPromptMode: 'all-work', loopPromptEpoch: 'E', pendingDelivery: {
    kind: 'loop', loopPromptMode: 'all-work', loopEpoch: 'E', handoffId: 'L', loopCause: { provider: 'codex', sessionId: 'S', turnId: 'parent', inputBoundary: 'same' } } };
  Object.assign(h.context, require('../shared/loop-dependencies.cjs'), {
    readPersistedLoopQueue: () => queue, getTabMessageService: () => messages, loopNaturalEvidence: new Map(),
    isPromptLoopAutomationSource: source => source === 'prompt-loop',
    captureTabInspection: () => ({ known: true, revision: 'R', toolType: 'codex', sessionId: 'S', busy: false,
      transitioning: false, loopInputBoundary: 'same', backgroundWorkCount: 0, turn: { status: 'completed', turnId: 'parent' } }),
    getOrchestrationRunStore: () => ({ listForTab: async () => [] }), coherentPublicRuntimeSnapshot: async () => ({ status: 'active', inputReady: true }),
    readAutomaticSendFrame: () => ({ ready: true }), buildInstallAutomationBlocked: () => false,
  });
  await h.context.runAgentSendScenario({ tabId: 'T', prompt: 'old Loop', handoffId: 'L', sendOperationKey: 'history:T:L',
    source: 'prompt-loop', sendSurface: 'desktop-history', queue: true, provider: 'codex', sessionId: 'S',
    expectedTarget: { toolType: 'codex', sessionId: 'S' }, applicationQueueAcceptedResponse: true });
  messages.dismissMessage({ tabId: 'T', messageId: q.messageId });
  assert.equal(h.owner.blocks('T'), false, 'local message wait is finished');
  const reply = await messages.replyToMessage({ responder: 'B', messageIds: [q.messageId], text: 'accepted return', requestId: 'R' });
  if (beforeReservation) {
    await entered;
    let pending;
    try {
      assert.equal(h.queue.item(reply.message.operationKey), null);
      vm.runInContext(declaration('acceptedReplyInputPending') + '\n' + declaration('loopSendAdmission')
        + '\nglobalThis.gapAdmission=loopSendAdmission;', h.context);
      pending = await h.context.gapAdmission({ tabId: 'T', handoffId: 'L', sendOperationKey: 'history:T:L', provider: 'codex' });
    } finally { resume(); }
    assert.equal(pending.cancel, true, 'saved accepted Reply must reserve before an old Loop: ' + JSON.stringify(pending));
    assert.equal(h.owner.blocks('T'), false, 'this is FIFO admission, not a revived message wait');
  }
  while (messages.lanes.size) await Promise.all([...messages.lanes.values()]);
  assert(h.queue.item('history:T:L').id < h.queue.item(reply.message.operationKey).id);
  let code = declaration('loopSendAdmission');
  if (source.includes('function acceptedReplyInputPending(')) code = declaration('acceptedReplyInputPending') + '\n' + code;
  vm.runInContext(code + '\nglobalThis.loopAdmission=loopSendAdmission;', h.context);
  const result = await h.context.loopAdmission({ tabId: 'T', handoffId: 'L', sendOperationKey: 'history:T:L', provider: 'codex' });
  assert.equal(result.cancel, true, 'existing input reservation, not a processing dependency, must win: ' + JSON.stringify({ result,
    pending: [...messages.pendingReplyReferences('T')], slot: h.queue.inputReservation(reply.message.operationKey),
    message: messages.getMessage(reply.message.messageId) }));
  assert.equal(result.reason, 'loop-message-dependency-pending'); assert.equal(h.owner.blocks('T'), false);
  assert.equal(h.writes.length, 0); assert.equal(h.store.get('history:T:L').attemptId, null);
  const ref = h.queue.inputReservation(reply.message.operationKey);
  assert.equal(ref.tabId, 'T'); assert.equal(ref.handoffId, reply.message.handoffId);
  assert.equal(ref.request_json, undefined); assert.equal(ref.prompt, undefined);
  const reservation = h.queue.inputReservation;
  try {
    for (const wrong of [{ tabId: 'foreign' }, { handoffId: 'foreign' }]) {
      h.queue.inputReservation = () => ({ ...ref, ...wrong, state: 'completed', receiptState: 'confirmed' });
      assert.equal(h.context.acceptedReplyInputPending('T', 'history:T:L'), true,
        'foreign reservation/receipt cannot release this accepted input');
    }
  } finally { h.queue.inputReservation = reservation; }
  h.queue.executors.clear(); h.queue.ready = () => true; await h.queue.pump('T');
  await h.queue.result(reply.message.operationKey);
  assert.equal(h.store.get('history:T:L').state, 'not-submitted'); assert.equal(h.store.get('history:T:L').attemptId, null);
  assert.deepEqual(Array.from(h.writes, row => row.handoffId), [reply.message.handoffId]);
  assert.equal(queue.loopPromptEnabled, true); assert.equal(h.owner.blocks('T'), false);
});

function installOrdinaryLoop(h, messages, inputBoundary = 'same') {
  const queue = { loopPromptEnabled: true, loopPromptMode: 'all-work', loopPromptEpoch: 'E', pendingDelivery: {
    kind: 'loop', loopPromptMode: 'all-work', loopEpoch: 'E', handoffId: 'L',
    loopCause: { provider: 'codex', sessionId: 'S', turnId: 'parent', inputBoundary: 'same' } } };
  Object.assign(h.context, require('../shared/loop-dependencies.cjs'), {
    readPersistedLoopQueue: () => queue, getTabMessageService: () => messages,
    loopNaturalEvidence: new Map(), isPromptLoopAutomationSource: source => source === 'prompt-loop',
    captureTabInspection: () => ({ known: true, revision: 'R', toolType: 'codex', sessionId: 'S', busy: false,
      transitioning: false, loopInputBoundary: inputBoundary, backgroundWorkCount: 0, goalWork: { pending: false },
      turn: { status: 'completed', turnId: 'parent' } }),
    getOrchestrationRunStore: () => ({ listForTab: async () => [] }),
    coherentPublicRuntimeSnapshot: async () => ({ status: 'active', inputReady: true }),
    readAutomaticSendFrame: () => ({ ready: true }), buildInstallAutomationBlocked: () => false,
  });
  vm.runInContext(['acceptedReplyInputPending', 'loopSendAdmission', 'readMessageLoopDeferredReceipt'].map(declaration).join('\n'), h.context);
  return queue;
}
const reserveLoop = h => h.context.runAgentSendScenario({ tabId: 'T', prompt: 'same ordinary Loop', handoffId: 'L',
  sendOperationKey: 'history:T:L', source: 'prompt-loop', sendSurface: 'desktop-history', queue: true,
  provider: 'codex', sessionId: 'S', expectedTarget: { toolType: 'codex', sessionId: 'S' }, applicationQueueAcceptedResponse: true });

test('audit: stale input cause returns the guarded deferred receipt instead of a generic Loop-OFF cancellation', async t => {
  const h = await fixture(t, { deferOutcome: true });
  h.question.cancelledAt = '2026-01-01'; h.owner.observe(h.question);
  installOrdinaryLoop(h, { pendingReplyReferences: () => [] }, 'new-input');
  await reserveLoop(h); h.queue.executors.clear(); h.queue.ready = () => true;
  await h.queue.pump('T');
  const record = h.store.get('history:T:L'), result = h.context.durableAgentSendReplay(record);
  assert.equal(record.state, 'not-submitted'); assert.equal(record.attemptId, null);
  assert.equal(result.deferred, true, JSON.stringify(result));
  assert.equal(result.causeInvalidated, true); assert.equal(result.code, 'loop_cause_stale');
  assert.equal(h.writes.length, 0);
  for (const changed of [
    { attemptId: 'begun', state: 'delivery-unknown' },
    { receipt: { ...record.receipt, pasteWritten: true } },
    { receipt: { ...record.receipt, enterWritten: true } },
    { receipt: { ...record.receipt, deliveryUnknown: true } },
    { receipt: { ...record.receipt, auditPending: true } },
    { deliveryControl: { ...record.deliveryControl, deliveryOutcomeUnknown: true } },
    { deliveryControl: { ...record.deliveryControl, reason: 'user-cancel' } },
  ]) assert.equal(h.context.readMessageLoopDeferredReceipt({ ...record, ...changed }), null);
  const original = h.queue.item.bind(h.queue), item = original(record.operationKey);
  const nonLoop = { ...JSON.parse(item.request_json), source: 'history-panel' };
  h.queue.item = () => ({ ...item, request_json: JSON.stringify(nonLoop), request_hash: registry.fingerprintAgentSendRequest(nonLoop) });
  assert.equal(h.context.readMessageLoopDeferredReceipt(record), null);
  h.queue.item = original;
});

test('audit: a question-only hold parks the same FIFO row and source X allows one ordinary dispatch', async t => {
  const h = await fixture(t, { deferOutcome: true });
  h.question.cancelledAt = '2026-01-01'; h.owner.observe(h.question);
  const messages = new TabMessageService({ db: h.store.db, requireLoopWait: true,
    resolveTab: async id => ({ tabId: id, projectId: 'P', provider: 'codex', sessionId: id === 'T' ? 'S' : 'B-S' }),
    beforeDelivery: message => h.owner.observe(message), onChanged: message => h.owner.observe(message),
    send: async () => ({ state: 'confirmed' }),
  });
  await messages.initialize(); h.owner.messages = messages; t.after(() => messages.dispose());
  installOrdinaryLoop(h, messages);
  await reserveLoop(h);
  const frozen = h.queue.item('history:T:L');
  const question = await messages.sendMessage({ source: 'T', target: 'B', text: 'Q after Loop admission', requestId: 'after-loop' });
  while (messages.lanes.size) await Promise.all([...messages.lanes.values()]);
  assert.equal(h.owner.blocks('T'), true);
  let resolved = false;
  const result = h.queue.result('history:T:L').then(value => { resolved = true; return value; });
  h.queue.executors.clear(); h.queue.ready = () => true;
  await h.queue.pump('T'); await tick();
  assert.equal(h.queue.item('history:T:L').state, 'waiting', 'Q-only hold is not permanent cancellation');
  assert.equal(h.store.get('history:T:L').attemptId, null); assert.equal(resolved, false);
  messages.dismissMessage({ tabId: 'B', messageId: question.message.messageId });
  await h.queue.pump('T'); assert.equal(h.owner.blocks('T'), true); assert.equal(h.writes.length, 0);
  messages.dismissMessage({ tabId: 'T', messageId: question.message.messageId });
  assert.equal(h.owner.blocks('T'), false);
  h.queue.notifyRuntime('T'); await result;
  assert.equal(h.queue.item('history:T:L').id, frozen.id);
  assert.equal(h.queue.item('history:T:L').request_json, frozen.request_json);
  assert.equal(h.queue.item('history:T:L').request_hash, frozen.request_hash);
  assert.deepEqual(Array.from(h.writes, row => row.handoffId), ['L']);
  h.queue.notifyRuntime('T'); h.queue.notifyRuntime('T'); await tick(); await tick();
  assert.equal(h.writes.length, 1, 'no replay or second dispatch');
});
