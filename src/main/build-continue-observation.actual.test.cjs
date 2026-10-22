'use strict';
// Real observation/run/evidence/restart factories, private JSON + SQLite.
// Provider responses, native attempts and OS lifecycle are controlled leaves.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { NodeSqlite } = require('./fixtures/build-install-posthook.cjs');
const { OrchestrationRunStore } = require('./orchestration-runs');
const { createResponseObservationApi } = require('./response-observation-api');
const { createResponseObservationService } = require('./response-observation-service');
const { ResponseObservationEvidenceStore } = require('./response-observation-evidence');
const { CompletionContentStore, buildOrchestrationCompletionContent } = require('./orchestration-completion-content');
const { createBuildContinueOperations } = require('./build-continue-operation');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const clone = value => JSON.parse(JSON.stringify(value));
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-continue-observation-')), stateFile = path.join(root, 'operation.json');
  const db = new NodeSqlite(path.join(root, 'evidence.sqlite'));
  const store = new OrchestrationRunStore(path.join(root, 'runs.json'), { readRecoveryHold: run => operations?.recoveryHold(run) });
  await store.initialize();
  const evidence = new ResponseObservationEvidenceStore(db), content = new CompletionContentStore({ db });
  const context = { provider: 'codex', sessionId: 'A', turnId: 'original-T', generation: 1, processId: null };
  const originalSubject = { kind: 'codex-execution', toolType: 'codex', sessionId: 'A', targetExecutionContext: context };
  let state = { known: true, exists: true, toolType: 'codex', sessionId: 'A', cwd: root,
    processStatus: 'found', busy: true, transitioning: false, revision: 'old-running', backgroundWorkCount: 0,
    currentSubject: originalSubject, executionContext: context };
  const controls = { complete: false, originalComplete: false, readHook: null }, sends = [], notifications = [], reads = [];
  const receipts = new Map(), queued = new Map(); let operations, observer;
  function makeOperation(pid) { return createBuildContinueOperations({ pid, instanceId: 'instance-' + pid, now: () => 1000,
    read: () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null,
    write: value => fs.writeFileSync(stateFile, JSON.stringify(value)), readRuns: () => store.installSnapshot(),
    captureTabs: () => [{ tabId: 'worker', known: true, toolType: 'codex', sessionId: 'A', projectId: 'project',
      cwd: root, busy: true, revision: 'captured', subject: originalSubject, executionContext: context }],
    readStartup: () => ({ source: 'exact-shutdown-snapshot', capturedAt: 1001, shutdownPid: 11,
      targets: [{ tabId: 'worker', provider: 'codex', sessionId: 'A' }] }),
    readState: async () => ({ ...state }),
    readOriginal: async () => ({ found: true, complete: controls.originalComplete, sourceVerified: true, executionContext: context }),
    readLatest: async () => ({ subject: originalSubject, result: { sourceVerified: true } }),
    readReceipt: key => receipts.get(key), readQueued: key => queued.get(key),
    continueRun: async () => ({ ok: false, code: 'continuation_history_changed' }), getRun: id => store.getInternal(id),
    send: async request => { await request.prepareSend(); sends.push(request);
      const plain = clone(request), promptHash = promptAuditFingerprint(request.prompt);
      queued.set(request.sendOperationKey, { operation_key: request.sendOperationKey, tab_id: request.tabId,
        request_hash: fingerprintAgentSendRequest(plain), request_json: JSON.stringify(plain) });
      receipts.set(request.sendOperationKey, { state: 'confirmed', operationKey: request.sendOperationKey,
        tabId: 'worker', provider: 'codex', sessionId: 'B', handoffId: request.handoffId, attemptId: 'native-attempt', promptHash,
        auditIdentity: { provider: 'codex', sessionId: 'B', attemptId: 'native-attempt', promptHash,
          entryUuid: 'continue-user', auditTimestamp: new Date(2000).toISOString() },
        receipt: { exactAuditConfirmed: true, actualHash: promptHash,
          auditExecutionContext: { provider: 'codex', sessionId: 'B', turnId: 'continued-T', generation: 2 } } });
      return { success: true, status: 'sent' };
    },
  }); }
  function makeObserver() { return createResponseObservationService({ store, evidence,
    readRestartBinding: run => operations.observationBinding(run), readState: async () => ({ ...state }),
    readResponse: async request => { reads.push(request); await controls.readHook?.();
      if (!controls.complete) return { pending: true, code: 'not-finished' };
      return { subject: request.subject, result: { found: true, complete: true, sourceVerified: true,
        userUuid: 'continue-user', assistantText: 'ONE CONTINUED FINAL', assistantChars: 19,
        executionContext: { provider: 'codex', sessionId: 'B', turnId: 'continued-T', generation: 2 } } }; },
    subscribe: async () => ({ success: true }), unsubscribe: async () => {}, onChanged() {},
    onSettled: async run => { const result = observer.readResult(run);
      assert.equal(typeof result?.then, 'undefined', 'result accessor remains synchronous');
      const frozen = content.freeze(buildOrchestrationCompletionContent(run, result || { success: false, error: run.error }));
      notifications.push({ run: clone(run), result, frozen }); }, log: { log() {}, warn() {} },
  }); }
  operations = makeOperation(11); observer = makeObserver();
  const api = createResponseObservationApi({ store, descriptor: tabId => ({ tabId, toolType: 'codex', projectId: 'project', cwd: root }),
    readState: async () => ({ ...state }), sourceExecutionContext: () => null,
    captureSourceTarget: async () => ({ toolType: 'codex', sessionId: 'source-S' }), onAccepted() {} });
  t.after(async () => { await observer.dispose(); operations.dispose(); await store.flush(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, evidence, controls, sends, notifications, reads, context, originalSubject,
    get operations() { return operations; }, get observer() { return observer; },
    setState: patch => { state = { ...state, ...patch }; },
    start: async (waitForDescendants = false) => {
      const ack = await api.start('worker', { runId: 'original-observation', sourceTabId: 'source', waitForDescendants });
      await observer.arm(ack.run); return ack.run; },
    capture: () => operations.capture('observation-restart', 11),
    boot: async () => { await observer.dispose(); operations.dispose(); operations = makeOperation(22);
      state = { ...state, sessionId: 'B', acceptedResumeSourceSessionId: 'A', busy: false, revision: 'restored', currentSubject: null };
      observer = makeObserver(); await observer.restore(); },
    activate: async () => { operations.activate('observation-restart'); await operations.reconcile('observation-restart');
      await operations.reconcile('observation-restart'); },
    reopenObserver: async () => { await observer.dispose(); observer = makeObserver(); await observer.restore(); },
  };
}

test('same observation survives capture→shutdown abort→boot, reads exact continuation, one final/notification with immutable old evidence', async t => {
  const h = await fixture(t); await h.start(); await h.capture();
  await h.observer.handleLifecycle('worker', { type: 'done', reason: 'manual_interrupt', executionContext: h.context });
  await h.observer.reconcile('original-observation');
  assert.equal((await h.store.get('original-observation')).status, 'running');
  assert.equal(h.evidence.readSelected('original-observation'), null);
  h.evidence.freezeFailure('original-observation', { code: 'manual_interrupt', error: 'Preserved original interrupted turn' });
  const old = h.evidence.readSelected('original-observation');
  await h.boot(); assert.equal(h.notifications.length, 0); await h.activate(); assert.equal(h.sends.length, 1);
  await h.observer.reconcile('original-observation'); assert.equal(h.notifications.length, 0);
  h.controls.complete = true; h.setState({ busy: false, revision: 'final' });
  await h.observer.reconcile('original-observation');
  assert.equal(h.notifications.length, 1); assert.equal(h.notifications[0].result.assistantText, 'ONE CONTINUED FINAL');
  assert.equal(h.notifications[0].result.restartProvenance.operationId, 'observation-restart');
  assert.equal(h.reads.at(-1).expectedSessionId, 'B'); assert.equal(h.reads.at(-1).subject.promptUserUuid, 'continue-user');
  assert.deepEqual(h.evidence.readSelected('original-observation'), old, 'no rewrite of original failure/subject');
  assert.equal((await h.store.get('original-observation')).observationTarget.sessionId, 'A');
  await h.reopenObserver(); assert.equal(h.notifications.length, 1);
  assert.equal(h.observer.readResult(await h.store.get('original-observation')).assistantText, 'ONE CONTINUED FINAL');
  assert.equal(h.sends.length, 1);
});

test('verified original success wins the captured restart and requires no new continue', async t => {
  const h = await fixture(t); await h.start();
  h.evidence.freeze('original-observation', h.originalSubject, { found: true, sourceVerified: true, complete: true,
    assistantText: 'ORIGINAL FINAL', assistantChars: 14, executionContext: h.context });
  h.controls.originalComplete = true; await h.capture(); await h.boot(); await h.activate();
  assert.equal(h.sends.length, 0); assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].result.assistantText, 'ORIGINAL FINAL');
});

test('held overdue agent is absent from next timer; unrelated deadline expires and release never renews old time', async t => {
  const h = await fixture(t);
  await h.store.create({ runId: 'agent-run', sourceTabId: 'source', targetTabId: 'worker', targetToolType: 'codex',
    targetExecutionContext: h.context });
  await h.store.patch('agent-run', { status: 'running', targetExecutionContext: h.context });
  await h.capture();
  await h.store.patch('agent-run', { status: 'waiting_recovery', outcome: 'interrupted', recoveryDeadlineAt: 1 });
  await h.store.create({ runId: 'other-run', sourceTabId: 'other-source', targetTabId: 'other-worker' });
  await h.store.patch('other-run', { status: 'waiting_recovery', outcome: 'interrupted', recoveryDeadlineAt: 2 });
  assert.equal(await h.store.nextRecoveryDeadline(), 2);
  const expired = await h.store.expireRecoveryDeadlines(10000);
  assert.deepEqual(expired.settled.map(run => run.runId), ['other-run']);
  assert.equal((await h.store.getInternal('agent-run')).recoveryDeadlineAt, 1);
  assert.equal(await h.store.nextRecoveryDeadline(), null, 'no past-deadline 0ms loop for captured run');
  await h.boot(); await h.activate();
  assert.equal(await h.store.nextRecoveryDeadline(), 1, 'release preserves the original due time');
  const afterRelease = await h.store.expireRecoveryDeadlines(10000);
  assert.deepEqual(afterRelease.settled.map(run => run.runId), ['agent-run']);
  assert.equal(h.sends.length, 0, 'unrelated/newer work does not receive another continue');
});

test('cancel during resumed read wins; no new evidence or successful notification is published', async t => {
  const h = await fixture(t); await h.start(); await h.capture(); await h.boot(); await h.activate();
  h.controls.complete = true;
  h.controls.readHook = async () => { h.controls.readHook = null; await h.store.cancel('original-observation'); };
  await h.observer.reconcile('original-observation');
  const binding = h.operations.observationBinding(await h.store.get('original-observation'));
  assert.equal(h.evidence.readSelected(binding.evidenceKey), null);
  assert.equal((await h.store.get('original-observation')).status, 'cancelled');
  assert.equal(h.notifications.length, 0); assert.equal(h.sends.length, 1);
});
