'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { OrchestrationRunStore, isActiveStatus, isTerminalStatus, isResultProofPending, isExternalResearchRun } = require('./orchestration-runs');
const { isResponseObservation } = require('./orchestration-response-observation');
const { createResponseObservationApi } = require('./response-observation-api');
const { createResponseObservationService } = require('./response-observation-service');
const { ResponseObservationEvidenceStore } = require('./response-observation-evidence');
const { CompletionContentStore, buildOrchestrationCompletionContent } = require('./orchestration-completion-content');

const subject = (uuid = 'prompt-a') => ({ kind: 'transcript', toolType: 'codex', sessionId: 'session', promptUserUuid: uuid });
const answer = (text = 'TARGET FINAL') => ({ found: true, complete: true, sourceVerified: true,
  assistantText: text, assistantChars: text.length, userUuid: 'prompt-a', truncated: false });
const deferred = () => { let resolve; const promise = new Promise(fn => { resolve = fn; }); return { promise, resolve }; };

async function webBoundary(name, scope) {
  const source = await fs.readFile(path.join(__dirname, 'web-server.js'), 'utf8');
  const ast = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, name);
  return vm.runInNewContext(declaration.getText(ast) + '\n' + name, {
    console, isResponseObservation, isExternalResearchRun, isActiveStatus, isTerminalStatus, isResultProofPending, ...scope,
  });
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-response-service-'));
  const db = new Database(path.join(dir, 'evidence.db'));
  const store = new OrchestrationRunStore(path.join(dir, 'runs.json'));
  await store.initialize();
  const evidence = new ResponseObservationEvidenceStore(db), content = new CompletionContentStore({ db });
  const calls = [], notifications = [], watched = new Set();
  let state = { known: true, exists: true, toolType: 'codex', sessionId: 'session', cwd: '/synthetic',
    busy: true, backgroundWorkCount: 0, revision: 'one' };
  let stateRead = async () => ({ ...state });
  let read = async () => ({ subject: subject(), result: answer() });
  const service = createResponseObservationService({ store, evidence,
    readState: () => stateRead(),
    readResponse: async request => { calls.push(request); return read(request); },
    subscribe: async request => { watched.add(request.consumerId); return { success: true }; },
    unsubscribe: async request => watched.delete(request.consumerId),
    onChanged: () => {},
    onSettled: async run => {
      const result = service.readResult(run);
      const frozen = content.freeze(buildOrchestrationCompletionContent(run,
        run.status === 'completed' ? result : { success: false, error: run.error }));
      notifications.push({ runId: run.runId, body: frozen.prompt.slice(frozen.bodyStart, frozen.bodyEnd), run });
    },
    log: { log() {}, warn() {} },
  });
  const api = createResponseObservationApi({ store,
    descriptor: tabId => ['source', 'target'].includes(tabId)
      ? { tabId, tabName: tabId, toolType: 'codex', projectId: 'project', cwd: '/synthetic' } : null,
    readState: async () => ({ ...state }), sourceExecutionContext: () => null,
    captureSourceTarget: async () => ({ toolType: 'codex', sessionId: 'source-session' }),
    onAccepted: () => {},
  });
  t.after(async () => {
    await service.dispose(); await store.flush(); db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, db, store, evidence, service, api, calls, notifications, watched,
    setState: patch => { state = { ...state, ...patch }; }, setRead: fn => { read = fn; },
    setStateRead: fn => { stateRead = fn; },
    async start(extra = {}) {
      const result = await api.start('target', { runId: 'observe', sourceTabId: 'source', ...extra });
      await service.arm(result.run);
      return result;
    },
  };
}

test('busy registration is durable and does not read an incomplete answer; one completion delivers exact text', async t => {
  const h = await fixture(t);
  const ack = await h.start();
  assert.equal(ack.accepted, true);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.store.readInheritedActivity().sourceTabIds, ['source']);
  assert.equal(h.watched.size, 0);
  h.setState({ busy: false, revision: 'complete' });
  await h.service.reconcile('observe', 'test-completion');
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].body, 'TARGET FINAL');
  assert.equal((await h.store.get('observe')).status, 'completed');
  assert.equal(h.watched.size, 0);
  await h.service.reconcile('observe', 'duplicate');
  assert.equal(h.notifications.length, 1);
});

test('whole-work wait includes the existing child gate and internal background activity', async t => {
  const h = await fixture(t);
  await h.start();
  await h.store.create({ runId: 'child', sourceTabId: 'target', targetTabId: 'worker', notifySource: false });
  h.setState({ busy: false, backgroundWorkCount: 1, revision: 'own-finished' });
  await h.service.reconcile('observe');
  assert.equal(h.calls.length, 0);
  assert.equal((await h.store.get('observe')).status, 'waiting_descendants');
  await h.store.patch('child', { status: 'completed', resultComplete: true, sourceFollowupPending: false });
  await h.service.reconcile('observe');
  assert.equal(h.calls.length, 0);
  h.setState({ backgroundWorkCount: 0, revision: 'all-finished' });
  await h.service.reconcile('observe');
  assert.equal(h.notifications[0].body, 'TARGET FINAL');
});

test('a new turn during latest-response read discards the earlier candidate', async t => {
  const h = await fixture(t), gate = deferred(), entered = deferred();
  await h.start();
  h.setState({ busy: false, revision: 'a-complete' });
  h.setRead(async () => { entered.resolve(); return gate.promise; });
  const pending = h.service.reconcile('observe');
  await entered.promise;
  h.setState({ busy: true, revision: 'b-started' });
  gate.resolve({ subject: subject(), result: answer('OLD A') });
  await pending;
  assert.equal(h.notifications.length, 0);
  assert.equal((await h.store.getInternal('observe')).observationSubject, undefined);
  h.setRead(async () => ({ subject: subject('prompt-b'), result: { ...answer('FINAL B'), userUuid: 'prompt-b' } }));
  h.setState({ busy: false, revision: 'b-complete' });
  await h.service.reconcile('observe');
  assert.equal(h.notifications[0].body, 'FINAL B');
});

test('unknown state after the read keeps the wait recoverable instead of claiming the target changed', async t => {
  const h = await fixture(t);
  await h.start(); h.setState({ busy: false, revision: 'done' });
  h.setRead(async () => {
    h.setState({ known: false });
    return { subject: subject(), result: answer() };
  });
  await h.service.reconcile('observe');
  assert.equal((await h.store.get('observe')).status, 'waiting_recovery');
  assert.equal(h.notifications.length, 0);
  h.setState({ known: true });
  h.setRead(async () => ({ subject: subject(), result: answer() }));
  await h.service.reconcile('observe', 'explicit-recheck');
  assert.equal(h.notifications.length, 1);
});

test('a child notification problem is attention, not successful completion or a spin loop', async t => {
  const h = await fixture(t);
  await h.start();
  await h.store.create({ runId: 'child', sourceTabId: 'target', targetTabId: 'worker' });
  await h.store.patch('child', { status: 'completed', resultComplete: true, notificationStatus: 'waiting-for-input' });
  h.setState({ busy: false });
  await h.service.reconcile('observe');
  const run = await h.store.getInternal('observe');
  assert.equal(run.status, 'waiting_recovery');
  assert.equal(run.observationWaitReason, 'child-attention');
  assert.equal(h.calls.length, 0);
  assert.equal(h.notifications.length, 0);
});

test('the durable result keeps COW view ownership without rewriting the physical execution identity', async t => {
  const h = await fixture(t);
  await h.start(); h.setState({ busy: false });
  const observed = { kind: 'codex-historical-execution', toolType: 'codex', sessionId: 'session',
    targetExecutionContext: { provider: 'codex', sessionId: 'parent-physical', turnId: 'parent-turn',
      generation: null, processId: null, startedAt: 1000 } };
  h.setRead(async () => ({ subject: observed, result: answer('FROZEN PARENT FINAL') }));
  await h.service.reconcile('observe');
  const saved = h.evidence.readSelected('observe');
  assert.equal(saved.subject.sessionId, 'session');
  assert.equal(saved.subject.targetExecutionContext.sessionId, 'parent-physical');
  assert.equal(h.notifications[0].body, 'FROZEN PARENT FINAL');
});

test('current-turn-only mode keeps its subject while an unrelated successor is busy', async t => {
  const h = await fixture(t);
  const currentSubject = { kind: 'codex-execution', toolType: 'codex', sessionId: 'session',
    targetExecutionContext: { provider: 'codex', sessionId: 'session', turnId: 'turn-a', generation: 4 } };
  h.setState({ currentSubject });
  h.setRead(async request => {
    assert.equal(request.subject.targetExecutionContext.turnId, 'turn-a');
    return { subject: currentSubject, result: answer('A FINAL') };
  });
  await h.start({ waitForDescendants: false });
  assert.equal(h.notifications.length, 0);
  h.setState({ revision: 'successor', currentSubject: { ...currentSubject,
    targetExecutionContext: { ...currentSubject.targetExecutionContext, turnId: 'turn-b', generation: 5 } } });
  await h.service.reconcile('observe');
  assert.equal(h.notifications[0].body, 'A FINAL');
});

test('durable selected response is recovered even before its JSON status projection was written', async t => {
  const h = await fixture(t);
  await h.start();
  h.evidence.freeze('observe', subject(), answer('ALREADY SAVED'));
  assert.equal((await h.store.getInternal('observe')).observationSubject, undefined);
  h.setRead(async () => { throw Error('Do not reselect after result commit'); });
  await h.service.reconcile('observe', 'restart-recovery');
  assert.equal(h.notifications[0].body, 'ALREADY SAVED');
  assert.equal(h.calls.length, 0);
});

test('an immutable observation slot cannot be replaced by a later response', async t => {
  const h = await fixture(t);
  h.evidence.freeze('observe', subject(), answer('FIRST'));
  const later = h.evidence.freeze('observe', subject('later'), answer('SECOND'));
  assert.equal(later.result.assistantText, 'FIRST');
  assert.equal(later.subject.promptUserUuid, 'prompt-a');
});

test('cancel during a read never revives the observation or delivers the late answer', async t => {
  const h = await fixture(t), gate = deferred(), entered = deferred();
  await h.start(); h.setState({ busy: false, revision: 'done' });
  h.setRead(async () => { entered.resolve(); return gate.promise; });
  const pending = h.service.reconcile('observe');
  await entered.promise;
  await h.store.cancel('observe', { suppressNotification: true });
  gate.resolve({ subject: subject(), result: answer() });
  await pending;
  assert.equal((await h.store.get('observe')).status, 'cancelled');
  assert.equal(h.notifications.length, 0);
});

test('aborted work returns its error instead of an earlier successful response', async t => {
  const h = await fixture(t);
  await h.start(); h.setState({ busy: false, revision: 'aborted' });
  h.setRead(async () => ({ subject: subject(), result: { found: true, complete: false, sourceVerified: true,
    terminalEvent: 'turn_aborted', terminalOutcomeReason: 'interrupted', assistantText: 'PARTIAL' } }));
  await h.service.reconcile('observe');
  assert.equal((await h.store.get('observe')).status, 'failed');
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].body, /interrupted/);
  assert.doesNotMatch(h.notifications[0].body, /PARTIAL/);
});

test('a reader error with a known subject is explicit failure, not an endless proof wait', async t => {
  const h = await fixture(t);
  await h.start(); h.setState({ busy: false, revision: 'done' });
  h.setRead(async () => ({ subject: subject(), error: 'Saved response could not be read', code: 'response_read_failed' }));
  await h.service.reconcile('observe');
  assert.equal((await h.store.get('observe')).status, 'failed');
  assert.match(h.notifications[0].body, /Saved response could not be read/);
});

test('saved evidence reopens from real SQLite and rejects corrupted bytes', async t => {
  const h = await fixture(t);
  h.evidence.freeze('saved', subject(), answer('DURABLE'));
  const reopened = new Database(path.join(h.dir, 'evidence.db'));
  try {
    const store = new ResponseObservationEvidenceStore(reopened);
    assert.equal(store.read('saved', subject()).result.assistantText, 'DURABLE');
    reopened.prepare('UPDATE response_observation_evidence SET evidence_json = ? WHERE run_id = ?').run('{}', 'saved');
    assert.throws(() => store.read('saved', subject()), /response_observation_evidence_corrupt/);
  } finally { reopened.close(); }
});

test('same request retry does not reselect a later target session', async t => {
  const h = await fixture(t);
  await h.start(); h.setState({ sessionId: 'new-session', revision: 'changed' });
  const retry = await h.api.start('target', { runId: 'observe', sourceTabId: 'source' });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.run.observationTarget.sessionId, 'session');
  await h.service.reconcile('observe');
  assert.equal((await h.store.get('observe')).status, 'failed');
  assert.match(h.notifications[0].body, /Сессия/);
});

test('actual detach action only cancels the observer and releases its transcript subscription', async t => {
  const h = await fixture(t);
  await h.start(); h.setState({ busy: false });
  h.setRead(async () => ({ pending: true, reason: 'final-not-flushed' }));
  await h.service.reconcile('observe');
  assert.equal(h.watched.size, 1);
  const action = await webBoundary('performOrchestrationAction', {
    getOrchestrationRunStore: () => h.store, getResponseObservationService: () => h.service,
    emitOrchestrationChanges: () => {}, finalizeSettledOrchestrations: async () => {},
    dispatchNextDeferredOrchestrationForTarget: () => { throw Error('Observer must not dispatch target input'); },
    scheduleOrchestrationPolicyTimer: () => {}, withOrchestrationUrls: value => value,
  });
  const result = await action('observe', 'detach');
  assert.equal(result.ok, true);
  assert.equal(result.run.status, 'cancelled');
  assert.equal(h.watched.size, 0);
  assert.equal(h.notifications.length, 0);
});

test('actual startup reconciliation hands a saved unattempted observer notification to its existing delivery owner', async t => {
  const h = await fixture(t);
  await h.start();
  h.evidence.freeze('observe', subject(), answer('SAVED BEFORE RESTART'));
  await h.store.bindResponseObservationSubject('observe', subject());
  const run = await h.store.getInternal('observe');
  await h.store.settleResponseObservation('observe', { expectedRevision: run.observationRevision,
    result: answer('SAVED BEFORE RESTART'), evidenceCommitted: true });
  await h.store.persistStrict();
  const notifications = [];
  const reconcile = await webBoundary('reconcileActiveOrchestrations', {
    getOrchestrationRunStore: () => h.store, getResponseObservationService: () => h.service,
    finalizeSettledOrchestration: async run => {
      notifications.push(h.service.readResult(run).assistantText);
      await h.store.patch(run.runId, { sourceFollowupStartedAt: Date.now(), notificationStatus: 'sent' });
    },
    recoverMissingOrchestrationTarget: () => { throw Error('A read observer must never restore a target'); },
    dispatchNextDeferredOrchestrationForTarget: () => { throw Error('Observer does not own the target FIFO'); },
    processDueOrchestrationPolicies: async () => {}, scheduleOrchestrationPolicyTimer: async () => {},
  });
  await reconcile();
  assert.deepEqual(notifications, ['SAVED BEFORE RESTART']);
});

test('cancelling during a slow runtime read cannot be overwritten by its late waiting projection', async t => {
  const h = await fixture(t), entered = deferred(), gate = deferred();
  await h.start();
  h.setStateRead(async () => { entered.resolve(); return gate.promise; });
  const work = h.service.reconcile('observe');
  await entered.promise;
  await h.store.cancel('observe', { suppressNotification: true });
  gate.resolve({ known: true, exists: true, sessionId: 'session', toolType: 'codex', busy: true });
  await work;
  assert.equal((await h.store.get('observe')).status, 'cancelled');
  assert.equal(h.notifications.length, 0);
  assert.equal(h.calls.length, 0);
});

test('cancellation ACK waits for disk commit and an identical retry repairs a failed write', async t => {
  const h = await fixture(t), gate = deferred(), entered = deferred();
  await h.start();
  h.evidence.freeze('observe', subject(), answer('IMMUTABLE SELECTED ANSWER'));
  const persist = h.store.persistStrict.bind(h.store);
  h.store.persistStrict = async () => { entered.resolve(); await gate.promise; return persist(); };
  let acknowledged = false;
  const cancelled = h.store.cancel('observe').then(() => { acknowledged = true; });
  await entered.promise;
  assert.equal(acknowledged, false);
  const before = JSON.parse(await fs.readFile(path.join(h.dir, 'runs.json'), 'utf8'));
  assert.equal(before.runs.find(run => run.runId === 'observe').status, 'running');
  gate.resolve(); await cancelled;
  const reopened = new OrchestrationRunStore(path.join(h.dir, 'runs.json'));
  await reopened.initialize();
  assert.equal((await reopened.get('observe')).status, 'cancelled');
  await reopened.flush();
  assert.equal(h.evidence.readSelected('observe').result.assistantText, 'IMMUTABLE SELECTED ANSWER');
  h.store.persistStrict = async () => { throw Error('private disk failure'); };
  await assert.rejects(h.store.cancel('observe'), /private disk failure/);
  h.store.persistStrict = persist;
  assert.equal((await h.store.cancel('observe')).run.status, 'cancelled');
});

test('a read failure or a missing registry never deletes saved SQLite evidence', async t => {
  const h = await fixture(t);
  h.evidence.freeze('saved-old-run', subject(), answer('PRESERVE'));
  const brokenFile = path.join(h.dir, 'broken-runs.json');
  await fs.writeFile(brokenFile, '{broken');
  for (const file of [brokenFile, path.join(h.dir, 'missing-runs.json')]) {
    const store = new OrchestrationRunStore(file);
    const service = createResponseObservationService({ store, evidence: h.evidence,
      readState: () => { throw Error('No target read from an unknown catalog'); },
      readResponse: () => { throw Error('No answer reselect'); },
      subscribe: () => { throw Error('No subscription from an unknown catalog'); }, unsubscribe: async () => {},
      onChanged: () => {}, onSettled: () => {}, log: { log() {}, warn() {} },
    });
    if (file === brokenFile) await assert.rejects(service.restore(), { code: 'response_observation_registry_unavailable' });
    else await service.restore();
    assert.equal(h.evidence.readSelected('saved-old-run').result.assistantText, 'PRESERVE');
    await service.dispose(); await store.flush();
  }
});
