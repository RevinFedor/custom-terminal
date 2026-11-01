'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mainCaptureFixture } = require('./fixtures/build-continue-main-capture.cjs');
const { createBuildContinueOperations } = require('./build-continue-operation');
const { capturedCodexSubject } = require('./build-continue-proofs');
const journals = new WeakMap();

function operation(t, h, extra = {}) {
  let saved = null;
  const service = createBuildContinueOperations({ pid: 11, instanceId: 'private-main', now: () => 1000,
    read: () => saved, write: value => { saved = structuredClone(value); }, readRuns: () => [],
    captureTabs: () => { const view = h.capture(); return [{ ...view, projectId: 'P', subject: capturedCodexSubject(view) }]; },
    captureOne: () => h.capture(), readCaptureSubject: async view => view.subject,
    readReceipt: () => null, readQueued: () => null,
    readOriginal: () => assert.fail('capture must not read History'), readLatest: () => assert.fail('capture must not read History'),
    send: () => assert.fail('capture cannot send'), ...extra });
  t.after(() => service.dispose());
  journals.set(service, () => structuredClone(saved));
  return service;
}

test('actual Main private capture retains its accepted native task with writer unknown, without upgrading public writer/context', async t => {
  const h = mainCaptureFixture(), service = operation(t, h);
  assert.equal(h.publicView().executionContext, null);
  const op = await service.capture('capture-task-one', 11);
  assert.equal(op.targets.length, 1, 'private pre-cut task proof must not depend on public writer availability');
  assert.equal(op.targets[0].subject.targetExecutionContext.turnId, 'own-turn');
  assert.equal(h.publicView().executionContext, null, 'public response/writer policy is unchanged');
  assert.equal(h.state.writerSession, null);
});

for (const writerSession of ['S', 'FOREIGN']) test('actual Main distinguishes exact writer from foreign writer: ' + writerSession, async t => {
  const h = mainCaptureFixture({ writerSession }), service = operation(t, h);
  const op = await service.capture('capture-task-writer', 11);
  assert.equal(op.targets.length, writerSession === 'S' ? 1 : 0);
  if (writerSession === 'FOREIGN') assert.match(op.unresolved[0].reason, /writer|source|owner/);
});

test('busy/native child without an active accepted own task cannot become Continue', async t => {
  const h = mainCaptureFixture(); h.registry.abortTurn('T');
  const op = await operation(t, h).capture('capture-no-task', 11);
  assert.equal(op.targets.length, 0);
  assert.equal(op.unresolved.length, 1);
  assert.match(op.unresolved[0].reason, /task/);
});

for (const [name, change] of [
  ['Stop', h => { h.state.stopRevision++; h.stopping.set('T', true); }],
  ['new input', h => { h.state.inputRevision++; }],
  ['new native input', h => { h.watcher.loopCanonicalInputOffset++; }],
  ['new foreign writer', h => { h.state.writerSession = 'FOREIGN'; }],
  ['new physical generation', h => { h.state.generation = 'physical:2'; }],
  ['new physical run', h => { h.state.command.runSeq++; }],
  ['new task', h => h.registry.beginTurn({ tabId: 'T', provider: 'codex', sessionId: 'S', turnId: 'new-turn' })],
  ['owner change', h => { h.state.owner = { ...h.state.owner, cwd: '/foreign' }; }],
  ['watcher replacement', h => h.watchers.set('T', { ...h.watcher })],
  ['terminal replacement', h => h.terminals.set('T', {})],
  ['task ended', h => { h.registry.abortTurn('T'); h.watcher.busy = false; h.watcher.outcomeKnown = true; }],
]) test('actual pre-cut task bookend rejects ' + name + ' during an asynchronous owner read', async t => {
  const h = mainCaptureFixture();
  const service = operation(t, h, { readRuns: async () => { await Promise.resolve(); change(h); return []; } });
  const op = await service.capture('capture-async-refusal', 11);
  assert.equal(op.targets.length, 0);
  assert.equal(op.unresolved[0].stage, 'capture');
  assert.match(op.unresolved[0].reason, /^capture-/);
  assert.equal(op.unresolved[0].source.sessionId, 'S', 'the frozen source does not retarget');
});

test('writer proof refinement and ordinary output keep the SAME accepted task/cut', async t => {
  const h = mainCaptureFixture();
  const service = operation(t, h, { readRuns: async () => {
    h.state.writerSession = 'S'; h.watcher.liveTurnEvents++; h.watcher.lastEventType = 'agent_message';
    return [];
  } });
  const op = await service.capture('capture-refined-writer', 11);
  assert.equal(op.targets.length, 1);
  assert.equal(op.targets[0].subject.targetExecutionContext.turnId, 'own-turn');
});

for (const [name, change] of [
  ['catch-up', h => { h.watcher.catchUpPending = true; }],
  ['unproven source', h => { h.watcher.sourceObservationLaunchId = 'pending-source'; }],
  ['suppression', h => { h.watcher.publicTurnStateSuppressed = true; }],
  ['foreign source generation', h => { h.watcher.processGeneration = 'old:life'; }],
  ['foreign source terminal', h => { h.watcher.sourceObservationTerminal = {}; }],
  ['foreign source run', h => { h.watcher.sourceObservationRunSeq = 2; }],
  ['no admitted live event', h => { h.watcher.liveTurnEvents = 0; }],
  ['foreign task source', h => { h.watcher.sessionId = 'FOREIGN'; }],
  ['proven inactive process', h => { h.state.command.isRunning = false; }],
]) test('private task capture does not guess through ' + name, async t => {
  const h = mainCaptureFixture(); change(h);
  const op = await operation(t, h).capture('capture-rejected-source', 11);
  assert.equal(op.targets.length, 0);
  assert.equal(op.unresolved[0].stage, 'capture');
  assert.match(op.unresolved[0].reason, /^capture-/);
});

test('a process-unknown observation does not erase the SAME admitted task, and does not become process-found', async t => {
  const h = mainCaptureFixture(); h.state.command.processLookupUnknown = true;
  const op = await operation(t, h).capture('capture-process-unknown', 11);
  assert.equal(op.targets.length, 1);
  assert.equal(h.state.command.processLookupUnknown, true);
  assert.equal(h.state.writerSession, null);
});

test('serialized metadata alone cannot stand in for the original Main read bookend', async t => {
  const h = mainCaptureFixture(), view = JSON.parse(JSON.stringify(h.capture()));
  const service = operation(t, h, { captureTabs: () => [{ ...view, projectId: 'P', subject: capturedCodexSubject(view) }] });
  const op = await service.capture('capture-bookend-missing', 11);
  assert.equal(op.targets.length, 0);
  assert.equal(op.unresolved[0].reason, 'capture-task-bookend-unavailable');
});

test('missing shutdown capture owner refuses before a cut, without borrowing the public saved SID', async t => {
  const h = mainCaptureFixture();
  const service = operation(t, h, { hasTaskCaptureShutdownOwner: () => false });
  await assert.rejects(service.capture('capture-no-seal-port', 11), { code: 'build_continue_task_shutdown_owner_unavailable' });
  assert.equal(journals.get(service)(), null);
  assert.equal(service.capturing(), false);
});

for (const change of ['unchanged', 'Stop', 'new input', 'ended', 'replacement']) test('actual shutdown seal freezes the original task: ' + change, async t => {
  const h = mainCaptureFixture(), service = operation(t, h);
  await service.capture('capture-shutdown-cut', 11); service.prepareTaskShutdown();
  if (change === 'Stop') { h.state.stopRevision++; h.stopping.set('T', true); }
  if (change === 'new input') h.state.inputRevision++;
  if (change === 'ended') { h.registry.abortTurn('T'); h.watcher.busy = false; h.watcher.outcomeKnown = true; }
  if (change === 'replacement') h.watchers.set('T', { ...h.watcher });
  const binding = service.taskShutdownBindings();
  const before = service.get('capture-shutdown-cut');
  assert.equal(binding[0].captureDigest, before.captureDigest);
  assert.equal(before.taskShutdownEvidence.targets[0].disposition,
    change === 'unchanged' ? 'own-turn-interrupted' : 'owner-or-input-changed');
  h.state.stopRevision++; h.stopping.set('T', true); h.registry.abortTurn('T');
  assert.deepEqual(service.taskShutdownBindings(), binding, 'planned Stop after the first cut cannot rewrite it');
  assert.deepEqual(service.get('capture-shutdown-cut').taskShutdownEvidence, before.taskShutdownEvidence);
});

test('same-PID component reopen cannot repin a lost private capture closure to current state', async t => {
  const h = mainCaptureFixture(), first = operation(t, h);
  await first.capture('capture-no-repin', 11); const stored = journals.get(first)(); first.dispose();
  const reopened = createBuildContinueOperations({ pid: 11, instanceId: 'new-web', read: () => stored, write: () => assert.fail('no reconstructed proof'),
    captureTabs: () => [h.capture()], readRuns: () => [] });
  t.after(() => reopened.dispose());
  assert.throws(() => reopened.taskShutdownBindings(), { code: 'build_continue_task_capture_unavailable' });
});

test('typed capture refusal has no target/H/O, survives reopen, and its X hides presentation only with exact acknowledgement', async t => {
  const h = mainCaptureFixture({ writerSession: 'FOREIGN' }), service = operation(t, h);
  const op = await service.capture('capture-visible-refusal', 11);
  assert.equal(op.targets.length, 0); assert.equal(service.forTab('T').length, 0);
  const issue = service.captureIssuesForTab('T')[0];
  assert.equal(issue.kind, 'capture-unresolved'); assert.equal(issue.inputCreated, false);
  assert.equal(issue.handoffId, undefined); assert.equal(issue.operationKey, undefined);
  assert.equal(issue.reason, 'capture-foreign-writer');
  const request = { version: 1, operationId: op.id, tabId: 'T', issueId: issue.issueId, requestId: 'dismiss-capture-one' };
  assert.throws(() => service.dismissCaptureIssue(op.id, { ...request, issueId: 'a'.repeat(64) }), { code: 'build_continue_capture_issue_changed' });
  const acknowledgement = service.dismissCaptureIssue(op.id, request);
  assert.equal(acknowledgement.issueId, issue.issueId); assert.equal(acknowledgement.requestId, request.requestId);
  assert.equal(service.captureIssuesForTab('T').length, 0);
  assert.deepEqual(service.dismissCaptureIssue(op.id, request), acknowledgement);
  assert.equal(service.get(op.id).unresolved[0].reason, issue.reason, 'the refusal itself remains historical fact');
  assert.equal(service.get(op.id).targets.length, 0);
  const reopened = createBuildContinueOperations({ pid: 22, read: journals.get(service), write: () => assert.fail('read-only reopen'), captureTabs: () => [], readRuns: () => [] });
  t.after(() => reopened.dispose());
  assert.equal(reopened.captureIssuesForTab('T').length, 0);
  assert.deepEqual(reopened.dismissCaptureIssue(op.id, request), acknowledgement);
});

test('CLI explicitly identifies a skipped capture even when targets=0', async t => {
  const h = mainCaptureFixture({ writerSession: 'FOREIGN' }), service = operation(t, h);
  const op = await service.capture('capture-cli-refusal', 11), output = [];
  const summary = require('../../scripts/build-and-continue-immediate.cjs').logRestoration(op, line => output.push(line));
  assert.equal(summary.needsAttention, true);
  assert.ok(output.some(line => line.includes('not captured tab=T') && line.includes('private worker') && line.includes('capture-foreign-writer')));
});

test('exact natural final during capture is not an error or another Continue; Goal completion is not asserted', async t => {
  const h = mainCaptureFixture();
  const service = operation(t, h, { readRuns: async () => {
    h.registry.finishTurn({ tabId: 'T', provider: 'codex', sessionId: 'S', turnId: 'own-turn', success: true });
    Object.assign(h.watcher, { busy: false, outcomeKnown: true, lastOutcomeTurnId: 'own-turn',
      lastOutcomeReason: 'task_complete', lastOutcomeHasFinalResult: true });
    return [];
  } });
  const op = await service.capture('capture-ended-naturally', 11);
  assert.equal(op.unresolved.length, 0); assert.equal(op.targets.length, 1);
  assert.equal(op.targets[0].state, 'not-needed');
  assert.equal(h.publicView().executionContext, null, 'private outcome does not invent public writer');
});

test('natural final after capture but before actual shutdown is sealed as own-turn-ended, not a new task', async t => {
  const h = mainCaptureFixture(), service = operation(t, h);
  await service.capture('capture-ended-at-cut', 11); service.prepareTaskShutdown();
  h.registry.finishTurn({ tabId: 'T', provider: 'codex', sessionId: 'S', turnId: 'own-turn', success: true });
  Object.assign(h.watcher, { busy: false, outcomeKnown: true, lastOutcomeTurnId: 'own-turn',
    lastOutcomeReason: 'task_complete', lastOutcomeHasFinalResult: true });
  service.taskShutdownBindings();
  assert.equal(service.get('capture-ended-at-cut').taskShutdownEvidence.targets[0].disposition, 'own-turn-ended');
});

test('presentation dismissal with a lost storage ACK recovers the SAME acknowledgement without changing refusal/input', async t => {
  const h = mainCaptureFixture({ writerSession: 'FOREIGN' }); let disk = null, lose = false;
  const service = operation(t, h, { read: () => disk, write: value => { disk = structuredClone(value); if (lose) return false; } });
  const op = await service.capture('capture-dismiss-lost-ack', 11), issue = service.captureIssuesForTab('T')[0];
  const request = { version: 1, tabId: 'T', issueId: issue.issueId, requestId: 'same-dismiss-request' };
  lose = true;
  assert.throws(() => service.dismissCaptureIssue(op.id, request), { code: 'build_continue_write_unconfirmed' });
  const reopened = createBuildContinueOperations({ read: () => disk, write: () => assert.fail('do not write a second dismissal'), captureTabs: () => [], readRuns: () => [] });
  t.after(() => reopened.dispose());
  const acknowledgement = reopened.dismissCaptureIssue(op.id, request);
  assert.equal(acknowledgement.requestId, request.requestId); assert.equal(reopened.captureIssuesForTab('T').length, 0);
  assert.equal(reopened.get(op.id).targets.length, 0); assert.equal(reopened.get(op.id).unresolved[0].reason, issue.reason);
});

test('captured private task cancelled before the cut cannot regain native interruption authority', async t => {
  const h = mainCaptureFixture(), service = operation(t, h);
  const op = await service.capture('capture-cancelled-target', 11), target = op.targets[0];
  await service.cancelTarget(op.id, { tabId: 'T', handoffId: target.handoffId, operationKey: target.operationKey, requestId: 'cancel-private-task' });
  service.prepareTaskShutdown(); service.taskShutdownBindings();
  assert.equal(service.get(op.id).taskShutdownEvidence.targets[0].disposition, 'cancelled');
  assert.ok(service.get(op.id).targets[0].cancellation.acknowledgedAt);
});

test('cancel during asynchronous install capture cannot persist a task or borrow its later current state', async t => {
  const h = mainCaptureFixture(); let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const service = operation(t, h, { verifyInstallJob: async () => ({}),
    readRuns: () => new Promise(resolve => { release = resolve; started(); }) });
  const binding = { version: 1, requestId: 'capture-request-one', requestHash: 'a'.repeat(64), requestHashVersion: 2,
    jobId: 'capture-job-one', operationId: 'voice-force-capture-job-one', maintenanceOperationId: 'install:noted:capture-job-one',
    callbackHandoffId: 'build-install-return:capture-job-one', source: { tabId: 'T', projectId: 'P', toolType: 'codex', sessionId: 'S',
      expectedTarget: { toolType: 'codex', sessionId: 'S' } } };
  const registration = await service.registerInstall(binding);
  const capture = service.capture(binding.operationId, 11, registration.installBinding);
  await entered;
  await service.cancelInstall(binding.operationId, registration.installBinding); release([]);
  await assert.rejects(capture, { code: 'voice_install_capture_revoked' });
  assert.equal(service.get(binding.operationId).phase, 'settled');
  assert.equal(service.get(binding.operationId).targets.length, 0); assert.equal(service.capturing(), false);
});

for (const change of ['digest missing', 'digest foreign', 'target turn changed', 'target source changed', 'participant changed']) {
  test('restart cannot use a missing/changed captured task or shutdown binding: ' + change, async t => {
    const h = mainCaptureFixture(), first = operation(t, h);
    const op = await first.capture('capture-restart-negative', 11);
    const bindings = first.taskShutdownBindings(), stored = journals.get(first)();
    const snapshot = { source: 'exact-shutdown-snapshot', capturedAt: 1001, shutdownPid: 11,
      targets: [{ tabId: 'T', provider: 'codex', sessionId: 'S' }], buildContinueBindings: structuredClone(bindings) };
    if (change === 'digest missing') delete snapshot.buildContinueBindings;
    if (change === 'digest foreign') snapshot.buildContinueBindings[0].evidenceDigest = 'a'.repeat(64);
    if (change === 'target turn changed') stored.operations[0].targets[0].subject.targetExecutionContext.turnId = 'foreign-turn';
    if (change === 'target source changed') stored.operations[0].targets[0].source.sessionId = 'FOREIGN';
    if (change === 'participant changed') stored.operations[0].participants[0].subject.targetExecutionContext.generation++;
    const reopened = createBuildContinueOperations({ pid: 22, instanceId: 'new-main', read: () => stored,
      write: () => assert.fail('changed proof cannot gain restore authority'), readStartup: () => snapshot,
      captureTabs: () => [h.capture()], readRuns: () => [], send: () => assert.fail('no Send') });
    t.after(() => reopened.dispose());
    assert.throws(() => reopened.activate(op.id), { code: change.startsWith('digest')
      ? 'build_continue_task_shutdown_unproven' : 'build_continue_task_capture_changed' });
  });
}

for (const change of ['schema downgrade', 'invalid explicit proof', 'missing explicit proof']) test('new task-capture journal does not masquerade as legacy: ' + change, async t => {
  const h = mainCaptureFixture(), first = operation(t, h);
  const op = await first.capture('capture-schema-negative', 11), stored = journals.get(first)();
  if (change === 'schema downgrade') stored.version = 4;
  if (change === 'invalid explicit proof') stored.operations[0].captureProofVersion = '1';
  if (change === 'missing explicit proof') delete stored.operations[0].captureProofVersion;
  const reopened = createBuildContinueOperations({ read: () => stored, write: () => assert.fail('do not migrate invalid authority'), captureTabs: () => [], readRuns: () => [] });
  t.after(() => reopened.dispose());
  assert.throws(() => reopened.get(op.id), { code: 'build_continue_journal_invalid' });
});
