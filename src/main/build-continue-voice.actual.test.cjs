'use strict';
// Real operation owner and binding validation. OS restart, native audit, runtime
// facts and Voice transport are finite controlled leaves; no live app is touched.
const test = require('node:test'), assert = require('node:assert/strict');
const { createBuildContinueOperations } = require('./build-continue-operation');
const { assertVoiceInstallJob } = require('./voice-install-binding');
const copy = value => JSON.parse(JSON.stringify(value));
function fixture(t) {
  const source = { tabId: 'caller', projectId: 'P', toolType: 'codex', sessionId: 'caller-S',
    expectedTarget: { toolType: 'codex', sessionId: 'caller-S' } };
  const makeView = tabId => { const context = { provider: 'codex', sessionId: tabId + '-S', turnId: tabId + '-T', generation: 1 };
    return { tabId, projectId: 'P', toolType: 'codex', sessionId: context.sessionId, known: true,
      busy: true, revision: 'cut-' + tabId, executionContext: context,
      subject: { kind: 'codex-execution', toolType: 'codex', sessionId: context.sessionId, targetExecutionContext: context } }; };
  const views = [makeView('caller'), makeView('worker'), { ...makeView('external-only'), busy: false }];
  const job = { id: 'install-J', requestId: 'request-I', requestHash: 'a'.repeat(64), requestHashVersion: 2,
    returnSource: source, returnTo: { tabId: 'caller', sessionId: 'caller-S', notifyOnSuccess: true },
    force: true, autoContinueInterruptedTabs: true, running: true, autoContinue: null };
  const raw = { version: 1, requestId: job.requestId, requestHash: job.requestHash, requestHashVersion: 2,
    jobId: job.id, operationId: 'voice-force-' + job.id, maintenanceOperationId: 'install:noted:' + job.id,
    callbackHandoffId: 'build-install-return:' + job.id, source };
  let saved = null, callback = null, currentPid = 11, ready = true, originalComplete = false;
  let snapshot = { source: 'exact-shutdown-snapshot', capturedAt: 1200, shutdownPid: 11,
    targets: views.map(view => ({ tabId: view.tabId, provider: view.toolType, sessionId: view.sessionId })) };
  const sends = [], checks = [], records = new Map(), queued = new Map(), runs = [];
  const make = pid => createBuildContinueOperations({ pid, instanceId: 'main-' + pid,
    now: () => currentPid === 11 ? 1000 : 2000, read: () => copy(saved), write: value => { saved = copy(value); },
    captureTabs: () => views, captureOne: tabId => views.find(view => view.tabId === tabId),
    readRuns: () => runs, readMessages: () => [], readStartup: () => snapshot,
    verifyInstallJob: async (binding, stage) => { checks.push(stage); assertVoiceInstallJob(binding, job, stage); return copy(job); },
    readInstallCallback: async () => callback,
    readState: async tabId => ({ ...copy(views.find(view => view.tabId === tabId)),
      exists: true, busy: false, processStatus: 'found', transitioning: false, backgroundWorkCount: 0 }),
    readOriginal: async target => ({ found: true, sourceVerified: true, complete: originalComplete,
      executionContext: target.subject.targetExecutionContext }),
    readLatest: async target => ({ result: { sourceVerified: true }, subject: target.subject }),
    prepareReturns: async () => ({ ready, reason: 'captured-return-not-admitted' }),
    readReceipt: key => records.get(key), readQueued: key => queued.get(key),
    send: async request => { await request.prepareSend(); sends.push(request);
      records.set(request.sendOperationKey, { state: 'delivery-unknown', attemptId: 'one-physical-attempt' });
      return { success: null, submitted: true, deliveryUnknown: true }; },
  });
  let service = make(11);
  t.after(() => service.dispose());
  const register = async () => {
    const op = await service.registerInstall(raw); job.autoContinue = { binding: op.installBinding }; return op;
  };
  const capture = async () => {
    if (!job.autoContinue) await register(); job.autoContinue.quitAuthorizedAt = 1001;
    const op = await service.capture(raw.operationId, 11, job.autoContinue.binding);
    snapshot.installBindings = service.shutdownEvidence(views); return op;
  };
  const boot = (nextPid = 22) => { service.dispose(); currentPid = nextPid; service = make(nextPid); service.restore(); };
  const permit = () => { job.running = false; job.installResult = { protocol: 1, nonce: job.id, force: true,
    installed: true, launchRequested: true, maintenance: { operationId: raw.maintenanceOperationId, complete: true } }; };
  return { views, job, raw, sends, checks, records, queued, runs, snapshot, register, capture, boot, permit,
    get service() { return service; }, get saved() { return saved; }, ready: value => ready = value,
    complete: value => originalComplete = value, callback: value => callback = value,
    activate: async () => { await service.activateInstall(raw.operationId, job.autoContinue.binding); await service.reconcile(raw.operationId); } };
}
test('registered FORCE has no hold during compilation; exact pre-Quit capture excludes external-only and delegates source to callback', async t => {
  const h = fixture(t); const registered = await h.register();
  assert.equal(registered.phase, 'registered'); assert.equal(h.service.capturing(), false); assert.equal(h.service.pending('worker'), false);
  assert.equal(h.saved.version, 2, 'older reader must reject this envelope');
  const cut = await h.capture(); assert.deepEqual(cut.targets.map(target => [target.source.tabId, target.route.kind]), [['caller', 'install-callback'], ['worker', 'local']]);
  assert.equal(h.service.capturing(), true); h.boot();
  assert.equal(h.sends.length, 0); assert.equal(h.service.get(cut.id).phase, 'captured', 'a new PID is not Voice activation');
  h.permit(); await h.activate(); assert.deepEqual(h.sends.map(request => request.tabId), ['worker']);
  assert.equal(h.sends[0].prompt, require('./build-continue-prompt').RESTART_PROMPT);
  await h.activate(); h.boot(); await h.activate(); assert.equal(h.sends.length, 1, 'UNKNOWN never invokes a replacement sender');
});
for (const key of ['requestId', 'requestHash', 'jobId', 'maintenanceOperationId', 'sourceInstanceId']) test('bound capture rejects changed ' + key, async t => {
  const h = fixture(t); await h.register();
  const binding = { ...h.job.autoContinue.binding, [key]: 'foreign' };
  await assert.rejects(h.service.capture(h.raw.operationId, 11, binding)); assert.equal(h.sends.length, 0);
  assert.equal(h.service.get(h.raw.operationId).phase, 'registered');
});
test('missing exact shutdown binding or unrelated reboot never activates a bound operation', async t => {
  const h = fixture(t); await h.capture(); h.snapshot.installBindings = [];
  h.boot(); h.permit(); await assert.rejects(h.activate(), /shutdown_unproven/); assert.equal(h.sends.length, 0);
});
test('work ending or being replaced between cut and shutdown receives no Continue', async t => {
  const h = fixture(t); await h.register(); h.job.autoContinue.quitAuthorizedAt = 1001;
  await h.service.capture(h.raw.operationId, 11, h.job.autoContinue.binding);
  h.views[1].revision = 'new-user-input'; h.views[1].executionContext.turnId = 'new-user-turn';
  h.snapshot.installBindings = h.service.shutdownEvidence(h.views); h.boot(); h.permit(); await h.activate();
  assert.equal(h.sends.length, 0); assert.equal(h.service.get(h.raw.operationId).targets[1].state, 'superseded');
});
test('source callback failure/UNKNOWN has no generic Continue fallback; confirmed callback uses its exact proof', async t => {
  const h = fixture(t); await h.capture(); h.boot(); h.permit(); await h.activate();
  h.callback({ state: 'unknown' }); await h.service.reconcile(h.raw.operationId);
  assert.equal(h.service.get(h.raw.operationId).targets[0].state, 'pending');
  h.callback({ binding: { operationKey: 'same-callback-O', handoffId: h.raw.callbackHandoffId,
    sessionId: 'caller-S', executionContext: { provider: 'codex', sessionId: 'caller-S', turnId: 'callback-T' } } });
  await h.service.reconcile(h.raw.operationId);
  assert.equal(h.service.get(h.raw.operationId).targets[0].binding.kind, 'install-callback');
  assert.equal(h.sends.filter(request => request.tabId === 'caller').length, 0);
});
test('ready captured returns hold continuation before reservation; releasing them permits one ordinary input', async t => {
  const h = fixture(t); h.ready(false); await h.capture(); h.boot(); h.permit(); await h.activate(); assert.equal(h.sends.length, 0);
  assert.equal(h.service.get(h.raw.operationId).targets[1].reason, 'captured-return-not-admitted');
  h.ready(true); await h.service.reconcile(h.raw.operationId); assert.equal(h.sends.length, 1);
});
test('exact original final before dispatch needs no new input; cancel only withdraws unattempted continuations', async t => {
  const h = fixture(t); await h.capture(); h.boot(); h.permit(); h.complete(true); await h.activate();
  assert.equal(h.sends.length, 0); assert.equal(h.service.get(h.raw.operationId).targets[1].state, 'result-ready');
  const h2 = fixture(t); await h2.capture(); h2.boot(); h2.permit();
  await h2.service.cancelInstall(h2.raw.operationId, h2.job.autoContinue.binding); await h2.activate();
  assert.equal(h2.sends.length, 0); assert.equal(h2.service.get(h2.raw.operationId).targets[1].state, 'cancelled');
});

test('a manual Stop/Close followed by a second restart cannot revive a still-unattempted target', async t => {
  const h = fixture(t); h.ready(false); await h.capture(); h.boot(); h.permit(); await h.activate();
  assert.equal(h.sends.length, 0);
  h.snapshot.shutdownPid = 22; h.snapshot.targets = h.snapshot.targets.filter(row => row.tabId !== 'worker');
  h.boot(33); h.ready(true); await h.service.reconcile(h.raw.operationId);
  assert.equal(h.sends.length, 0); assert.equal(h.service.get(h.raw.operationId).targets[1].reason, 'subsequent-shutdown-target-not-interrupted');
});

test('an unproven crash never invents restore authority; exact next shutdown can preserve the same pending operation', async t => {
  const h = fixture(t); h.ready(false); await h.capture(); h.boot(); h.permit(); await h.activate();
  h.boot(33); h.ready(true); await h.service.reconcile(h.raw.operationId);
  assert.equal(h.sends.length, 0); assert.equal(h.service.get(h.raw.operationId).targets[1].reason, 'subsequent-restore-proof-pending');
  h.snapshot.shutdownPid = 22; await h.service.reconcile(h.raw.operationId);
  assert.equal(h.sends.length, 1); assert.equal(h.sends[0].handoffId, h.service.get(h.raw.operationId).targets[1].handoffId);
});

test('matching SID/turn without the captured run generation cannot become a generic local continuation', async t => {
  const h = fixture(t); h.runs.push({ runId: 'original-agent-run', runKind: 'agent', status: 'running',
    targetTabId: 'worker', targetExecutionContext: { ...h.views[1].executionContext, generation: 99 } });
  const cut = await h.capture(); assert.equal(cut.targets.some(target => target.source.tabId === 'worker'), false);
  assert.equal(cut.unresolved.find(row => row.tabId === 'worker').reason, 'incoming-generation-unproven');
  h.boot(); h.permit(); await h.activate(); assert.equal(h.sends.length, 0);
  assert.equal(h.runs[0].runId, 'original-agent-run');
});
