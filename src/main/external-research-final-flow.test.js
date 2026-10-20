'use strict';
// Two owned headless runtimes: SC34/SQLite -> real HTTP client -> Noted28 JSON
// and SQLite FIFO. One control uses a completion adapter; the stronger case runs
// actual notification/result/content functions. Provider, source runtime/watcher,
// bottom send-to-FIFO adapter and physical model input/audit remain controlled.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { fork } = require('node:child_process'), { once } = require('node:events'), { createRequire } = require('node:module'), vm = require('node:vm');
const Database = require('better-sqlite3');
const ts = require('typescript'), crypto = require('node:crypto');
const runApi = require('./orchestration-runs');
const { OrchestrationRunStore, classifyAgentSendReceipt } = runApi;
const { AgentSendQueue } = require('./agent-send-queue'), { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { fingerprintAgentSendRequest, RECEIPT_STATES, isAgentSendProviderQueueAccepted } = require('./agent-send-receipt-registry');
const completionApi = require('./orchestration-completion-content');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { agentPromptAuditMatchesHash } = require('./agent-prompt-audit-identity');
const { isResponseObservation } = require('./orchestration-response-observation');
const { resolveOrchestrationSourceNotificationSendOptions } = require('./orchestration-request-plan');
const { createOperationalDelivery, resolveOperationalRequest } = require('./external-research-operational-delivery');
const { ScExternalResearchClient, isScResearchTerminalStatus } = require('./sc-external-research-client'), { ExternalResearchCoordinator } = require('./external-research-coordinator');
const bounded = (promise, label) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('owned final flow deadline: ' + label)), 10000); })]).finally(() => clearTimeout(timer)); };
const reproduceReadFailure = process.env.SC_OWN_FINAL_READ_FAILURE === '1';
const sizedAnswer = length => {
  const prefix = 'BEGIN 🧪\r\n', suffix = '\nEND 👀';
  return prefix + 'Ж'.repeat(length - prefix.length - suffix.length) + suffix;
};
const cases = reproduceReadFailure ? [{ actualNotification: true, answer: 'FULL OWNED RESULT', mode: 'inline', label: 'small' }] : [
  { actualNotification: false, answer: 'FULL OWNED RESULT', mode: 'adapter', label: 'small' },
  { actualNotification: true, answer: 'FULL OWNED RESULT', mode: 'inline', label: 'small' },
  { actualNotification: true, answer: sizedAnswer(completionApi.MAX_INLINE_ASSISTANT_CHARS), mode: 'inline', label: 'exact 250k UTF16 Unicode limit' },
  { actualNotification: true, answer: sizedAnswer(completionApi.MAX_INLINE_ASSISTANT_CHARS + 1), mode: 'reference', label: 'over 250k, honest reference without partial body' },
];
for (const { actualNotification, answer, mode, label } of cases) test((reproduceReadFailure ? 'one-shot final-body 503 recovers automatically under the same handoff; ' : '') + 'SC final revokes queued wake, survives reopen, then delivers via ' + (actualNotification ? 'actual result/content/notification functions' : 'controlled completion adapter') + '; ' + label, { timeout: 20000 }, async t => {
  const sc = process.env.SC_RESEARCH_SOURCE_ROOT || path.resolve(__dirname, '../../../sc-desktop');
  const parent = path.join(os.homedir(), 'Library/Application Support/sc-desktop/test-artifacts/research-autonomy-20261019');
  fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'noted-final-flow-'));
  const child = fork(path.join(sc, 'scripts/research-reliability-ui/sc-final-notice-worker.cjs'), [root], {
    execPath: process.env.SC_RESEARCH_TEST_EXEC_PATH || path.join(sc, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const pending = new Map(); let sequence = 0, readyResolve, childExited = false;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  child.once('exit', () => { childExited = true; });
  child.on('message', value => { if (value.ready) readyResolve(value); else { const request = pending.get(value.id); if (request) { pending.delete(value.id); value.ok ? request.resolve(value) : request.reject(Error(value.error)); } } });
  const command = (action, params = {}) => bounded(new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, action, ...params }); }), action);
  const db = new Database(path.join(root, 'noted-queue.db')), receipts = createAgentSendReceiptStore(db);
  const contents = new completionApi.CompletionContentStore({ db });
  let sourceReady = false, runs, finalInput; const inputs = [], committedInput = new Promise(resolve => { finalInput = resolve; });
  let finalAdmission; const finalAdmitted = new Promise(resolve => { finalAdmission = resolve; });
  const identity = request => ({ operationKey: request.sendOperationKey, surface: 'desktop-history', tabId: request.tabId,
    provider: request.provider, handoffId: request.handoffId, sessionId: 'owned-source-session',
    requestFingerprint: fingerprintAgentSendRequest(request), promptHash: promptAuditFingerprint(request.prompt), promptLength: request.prompt.length });
  const queue = new AgentSendQueue({ store: receipts, ready: () => sourceReady, execute: async (request, scope) => {
    if (request.completionDeliveryRef) await require('./external-research-completion-delivery').resolveCompletionRequest(runs, request);
    if (request.operationalNoticeRef) await resolveOperationalRequest(runs, request); // Actual active-head guard.
    // The executor receives the admission fingerprint separately: JSON storage
    // intentionally drops undefined presentation fields in the prepared request.
    const key = { ...identity(request), requestFingerprint: scope.requestFingerprint };
    const begun = receipts.beginAttempt(key); assert.equal(begun.action, 'attempt-started');
    receipts.markAttemptState(key.operationKey, begun.attemptId, 'enter-armed'); inputs.push(request);
    receipts.settleAttempt(key.operationKey, begun.attemptId, { success: true, submitted: true, auditPending: true, status: 'audit-pending' });
    const promoted = receipts.promoteFromAudit({ success: true, operationKey: key.operationKey, attemptId: begun.attemptId,
      provider: 'codex', sessionId: 'owned-source-session', promptHash: key.promptHash, actualHash: key.promptHash, expectedHash: key.promptHash,
      entryUuid: 'owned-final-input', sourceIdentity: 'owned-source-proof', auditTimestamp: new Date().toISOString(), transcriptBoundary: { byteOffset: 1 } });
    assert.equal(promoted.promoted, true); finalInput(); return receipts.get(key.operationKey).receipt;
  } });
  const webFile = path.join(__dirname, 'web-server.js'), web = fs.readFileSync(webFile, 'utf8');
  const begin = web.indexOf('function revokeExternalOperationalDelivery(run, notice)'), end = web.indexOf('\nfunction getExternalOperationalDelivery()', begin);
  assert(begin >= 0 && end > begin);
  const context = vm.createContext({ require: createRequire(webFile), path, srcMainDir: __dirname,
    agentSendReceiptStore: receipts, agentSendQueue: queue });
  vm.runInContext(web.slice(begin, end), context);
  runs = new OrchestrationRunStore(path.join(root, 'noted-runs.json'), { onOperationalRevoked: context.revokeExternalOperationalDelivery });
  await runs.updateSettings({ externalResearchOperationalPrompts: true }); // Explicit legacy opt-in for queued-wake revocation controls.
  const delivery = createOperationalDelivery({ store: runs, classify: classifyAgentSendReceipt, logger: { warn() {} },
    prepare: async (_run, notice) => ({ prompt: notice.body, sendOptions: { provider: 'codex', queue: true, statusAtSend: 'busy' } }),
    pin: notice => receipts.pinForOwner(notice.operationKey, 'research-operational'),
    lookup: async notice => ({ result: receipts.get(notice.operationKey)?.receipt || null }),
    send: async request => { await resolveOperationalRequest(runs, request); return queue.enqueue({ identity: identity(request), request }).receipt; },
  });
  t.after(async () => {
    delivery.stop(); context.externalCompletionDelivery?.stop(); queue.dispose(); await runs.flush();
    if (!childExited) { await command('close'); if (!childExited) await bounded(once(child, 'exit'), 'SC exit'); }
    db.close(); assert(childExited); fs.rmSync(root, { recursive: true });
  });
  const worker = await bounded(ready, 'SC ready');
  assert.equal(worker.snapshot.execution.attention.state, 'open');
  await runs.reserveOrGet({ runId: 'own', runKind: 'external-research', requestFingerprint: 'owned-original', notifySource: true,
    sourceTabId: 'owned-source', sourceSessionId: 'owned-source-session', sourceSendTarget: { toolType: 'codex', sessionId: 'owned-source-session' },
    externalResearchJobId: 'noted_own', externalResearchIntent: { provider: 'chatgpt', prompt: 'owned prompt', options: {}, files: [] } });
  const client = new ScExternalResearchClient({ baseUrl: 'http://127.0.0.1:' + worker.port });
  let coordinator;
  if (actualNotification) {
    const ast = ts.createSourceFile(webFile, web, ts.ScriptTarget.Latest, true);
    const names = ['prepareOrchestrationCompletionContent', 'readExternalResearchResult', 'reconcileExternalResearchRun',
      'externalResearchAnswerText', 'boundedExternalResearchResult', 'orchestrationUrls', 'withOrchestrationUrls',
      'orchestrationNotificationText', 'orchestrationPresentationSnapshot', 'sendOrchestrationCompletionNotification',
      'orchestrationSourceReceiptProof', 'reconcileOrchestrationSourceFollowup', 'releaseOrchestrationSourceProof',
      'promptFingerprint', 'shortId', 'getExternalCompletionDelivery', 'prepareExternalCompletionRequest'];
    const actual = names.map(name => {
      const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
      assert(node, 'production function exists: ' + name); return node.getText(ast);
    }).join('\n');
    Object.assign(context, runApi, completionApi, { crypto, console, externalCompletionDelivery: null,
      COMPLETION_ADMISSION: Symbol('test-completion'), getExternalOperationalDelivery: () => delivery, promptAuditFingerprint, agentPromptAuditMatchesHash,
      isResponseObservation, isScResearchTerminalStatus, isAgentSendProviderQueueAccepted,
      AGENT_SEND_RECEIPT_STATES: RECEIPT_STATES, resolvedPort: 0, tabWorkContext: null,
      orchestrationNotificationInflight: new Set(), agentSendReceiptStartupReady: Promise.resolve(),
      getOrchestrationRunStore: () => runs, getCompletionContentStore: () => contents,
      getScExternalResearchClient: () => client, getExternalResearchCoordinator: () => coordinator,
      resolveOrchestrationSourceNotificationSendOptions,
      resolveAgentSessionInfo: async () => ({ toolType: 'codex', sessionId: 'owned-source-session', status: 'busy', busy: true }),
      armOrchestrationSourceProof: async () => ({ success: true }),
      orchestrationSourceProofCoordinator: { release: async () => true },
      emitOrchestrationChanges() {}, emitOrchestrationRun() {}, finalizeSettledOrchestrations: async () => {},
      getAgentTurnResult: null,
      runAgentSendScenario: async request => {
        assert.equal(request.expectedTarget.sessionId, 'owned-source-session'); assert.equal(request.queue, true);
        const admitted = queue.enqueue({ identity: identity(request), request }); assert.equal(admitted.ok, true);
        finalAdmission(); return (await queue.result(request.sendOperationKey)).receipt;
      },
    });
    vm.runInContext(actual, context);
  }
  await runs.applyExternalResearchSnapshot('own', await client.status('noted_own', { waitMs: 0 }));
  delivery.schedule('own'); await delivery.drain();
  const before = await runs.getInternal('own'), notice = Object.values(before.externalResearchOperational.notices)[0];
  assert.equal(notice.delivery, 'queued'); assert.equal(queue.item(notice.operationKey).state, 'waiting'); assert.equal(inputs.length, 0);
  const committed = await command('commit', { answer }); assert.equal(committed.snapshot.execution.attention.state, 'cleared');
  assert.equal(committed.snapshot.result.text, answer, 'SC primary commit preserves the entire original answer');
  if (reproduceReadFailure) await command('fail-read', { read: 3 });
  coordinator = new ExternalResearchCoordinator({ store: runs, client, longPollMs: 0, notifyOperational: id => delivery.schedule(id),
    finalizeSettled: async run => {
      const saved = JSON.parse(fs.readFileSync(path.join(root, 'noted-runs.json'))).runs.find(value => value.runId === run.runId);
      assert.equal(saved.status, 'completed');
      if (actualNotification) return context.sendOrchestrationCompletionNotification(run);
      const request = { tabId: 'owned-source', provider: 'codex', expectedTarget: { toolType: 'codex', sessionId: 'owned-source-session' },
        handoffId: 'orchestration-complete:own', sendOperationKey: 'history:owned-source:orchestration-complete:own',
        prompt: committed.snapshot.result.text, source: 'orchestration-complete', sendSurface: 'desktop-history' };
      assert.equal(queue.enqueue({ identity: identity(request), request }).ok, true);
    } });
  try {
    const watched = coordinator.watch('own');
    if (reproduceReadFailure) {
      await bounded(finalAdmitted, 'same-handoff automatic retry after 503');
      const recovering = await runs.getInternal('own');
      assert.equal(recovering.status, 'completed'); assert.equal(inputs.length, 0);
      assert.equal((await command('stats')).reads, 4, 'original full-body read retried automatically');
      assert.equal(recovering.externalResearchDelivery.failures, 1);
      assert(Object.values(recovering.externalResearchOperational.notices).some(n => n.origin === 'noted-delivery'));
      sourceReady = true; queue.resume();
    } else if (actualNotification) {
      await bounded(finalAdmitted, 'actual final admitted');
      assert.equal((await runs.getInternal('own')).notificationStatus, 'sending');
      assert.equal(inputs.length, 0, 'busy parent admits the final without losing it or bypassing FIFO');
    } else await bounded(watched, 'controlled final admitted');
    sourceReady = true; queue.resume(); await bounded(watched, 'coordinator final'); await bounded(committedInput, 'final input');
  }
  finally { await coordinator.stop(); }
  await new Promise(resolve => setImmediate(resolve)); await delivery.drain();
  const after = await runs.getInternal('own');
  assert.equal(after.externalResearchOperational.notices[notice.id].delivery, 'suppressed');
  assert.equal(after.externalResearchOperational.notices[notice.id].cancellationConfirmed, true);
  assert.equal(queue.item(notice.operationKey).state, 'cancelled'); assert.equal(receipts.get(notice.operationKey).attemptId, null);
  assert.equal(inputs.length, 1);
  if (actualNotification) {
    const frozen = contents.get('own'); assert.equal(frozen.mode, mode);
    assert.equal(frozen.assistantChars, answer.length);
    const body = frozen.prompt.slice(frozen.bodyStart, frozen.bodyEnd);
    if (mode === 'inline') assert.equal(body, answer, 'large Unicode body and trusted UTF16 offsets are exact');
    else {
      assert.equal(frozen.reason, 'result-truncated');
      assert.match(body, /get_delegation_result\(\{"runId":"own","maxChars":250000\}\)/);
      assert.match(body, /Частичный текст не выдаётся за полный/);
      assert.doesNotMatch(frozen.prompt, /Полный проверенный ответ уже здесь/);
      assert(!body.includes(answer.slice(0, 100)), 'bounded prefix is not pasted as an alleged full answer');
      assert.equal(frozen.metadata.conversationUrl, 'https://chatgpt.com/c/owned-cid');
    }
    assert.equal(frozen.metadata.jobId, 'noted_own'); assert.equal(frozen.metadata.sourceSessionId, 'owned-source-session');
    assert.equal(inputs[0].prompt, frozen.prompt); assert.equal(after.notificationStatus, 'sent'); assert(after.sourceFollowupStartedAt);
    await context.sendOrchestrationCompletionNotification(await runs.getInternal('own'));
    assert.equal(inputs.length, 1, 'same completed notification does not write again');
  } else assert.equal(inputs[0].prompt, answer);
  const stats = await command('stats'); assert.equal(stats.starts, 0); assert.equal(stats.reads, actualNotification ? (reproduceReadFailure ? 4 : 3) : 2);
  assert.equal(stats.answerChars, answer.length);
  assert.equal(stats.answerSha256, crypto.createHash('sha256').update(answer, 'utf8').digest('hex'));
  assert.equal(receipts.get(inputs[0].sendOperationKey).state, 'confirmed');
  const reopened = new OrchestrationRunStore(path.join(root, 'noted-runs.json'));
  const restored = await reopened.getInternal('own'); await reopened.flush();
  assert.equal(restored.status, 'completed'); assert.equal(restored.externalResearchOperational.notices[notice.id].delivery, 'suppressed');
  const secondDb = new Database(path.join(root, 'noted-queue.db')), secondReceipts = createAgentSendReceiptStore(secondDb);
  try {
    assert(secondReceipts.get(notice.operationKey).deliveryControl.cancelledAt); assert.equal(secondReceipts.get(inputs[0].sendOperationKey).state, 'confirmed');
    if (actualNotification) {
      assert(restored.sourceFollowupStartedAt); assert.equal(new completionApi.CompletionContentStore({ db: secondDb }).get('own').prompt, inputs[0].prompt);
    }
  }
  finally { secondDb.close(); }
});
