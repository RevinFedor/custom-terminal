'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createBuildContinueOperations } = require('./build-continue-operation');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const copy = value => JSON.parse(JSON.stringify(value));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-continue-operation-')), file = path.join(root, 'state.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = id => ({ provider: 'codex', sessionId: id + '-A', turnId: id + '-turn', generation: 1 });
  const view = (tabId, busy) => ({ tabId, known: true, toolType: 'codex', sessionId: tabId + '-A',
    projectId: 'project', cwd: root, revision: 'R', busy, executionContext: context(tabId),
    subject: busy ? { kind: 'codex-execution', toolType: 'codex', sessionId: tabId + '-A', targetExecutionContext: context(tabId) } : null });
  const views = [view('own', true), view('purple', false), view('mixed', true)];
  const runs = [{ runId: 'R', runKind: 'external-research', sourceTabId: 'purple', externalResearchJobId: 'same-SC-job', status: 'running' },
    { runId: 'M', runKind: 'external-research', sourceTabId: 'mixed', externalResearchJobId: 'mixed-SC-job', status: 'running' }];
  const states = new Map(views.map(v => [v.tabId, { known: true, exists: true, toolType: 'codex', sessionId: v.sessionId,
    revision: 'ready', busy: false, transitioning: false, processStatus: 'found', backgroundWorkCount: 0, cwd: root }]));
  const snapshot = { source: 'exact-shutdown-snapshot', capturedAt: 1001, shutdownPid: 11,
    targets: views.map(v => ({ tabId: v.tabId, provider: 'codex', sessionId: v.sessionId })) };
  const records = new Map(), queued = new Map(), sends = [], runCalls = [], changes = [], controls = {};
  const options = { read: () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null,
    write: value => { controls.write?.(); fs.writeFileSync(file, JSON.stringify(value)); return { success: true }; },
    readRuns: async () => { await controls.readRuns?.(); return copy(runs); }, captureTabs: () => copy(views), readMessages: () => [{ messageId: 'same-question', replyTo: null }],
    readMcp: () => ({ known: true, exactRpcOwners: false }), readStartup: () => snapshot,
    readInputFence: () => ({ terminalInstanceId: controls.fenceInstance || 'boot-terminal', stopRevision: controls.stopRevision || 0 }),
    readState: async tabId => { await controls.readState?.(); return copy(states.get(tabId)); },
    readOriginal: async target => { await controls.readOriginal?.(); return { found: true, sourceVerified: true,
      executionContext: target.subject.targetExecutionContext, complete: controls.complete === true }; },
    readLatest: async target => ({ result: { sourceVerified: true }, subject: controls.newer
      ? { targetExecutionContext: { ...target.subject.targetExecutionContext, turnId: 'newer' } } : target.subject }),
    readInputInterval: async target => ({ known: true, complete: true, users: [
      { aliases: [{ sessionId: target.source.sessionId }] }, { aliases: [{ sessionId: target.source.sessionId, userUuid: 'manual-user' }] }], executions: [] }),
    send: async request => { await request.prepareSend(); sends.push(request);
      const plain = copy(request); queued.set(request.sendOperationKey, { operation_key: request.sendOperationKey,
        tab_id: request.tabId, request_hash: fingerprintAgentSendRequest(plain), request_json: JSON.stringify(plain) });
      records.set(request.sendOperationKey, { state: 'reserved' });
      controls.afterSend?.();
      if (controls.lostAck) throw Error('lost-ACK');
      return { success: true, status: 'application-queued', submitted: false }; },
    continueRun: async runId => { runCalls.push(runId); const run = runs.find(r => r.runId === runId);
      run.continuationIntent ||= { operationKey: 'run-owner-operation', handoffId: 'run-owner-handoff',
        operationId: 'owner-intent', createdAt: 1000, baseExecutionContext: run.targetExecutionContext };
      if (controls.runNoInput) {
        records.set('run-owner-operation', { state: 'not-submitted', operationKey: 'run-owner-operation',
          receipt: { submitted: false, pasteWritten: false, enterWritten: false } });
        run.continuationIntent.state = 'blocked'; return { ok: false, error: 'controlled exact no-input refusal' };
      }
      return { ok: true }; }, getRun: async id => copy(runs.find(r => r.runId === id)),
    readReceipt: key => records.get(key), readQueued: key => queued.get(key),
    changed: value => { changes.push(value); controls.changed?.(value); }, now: () => 1000, instanceId: 'source-instance' };
  let service = createBuildContinueOperations({ ...options, pid: 11 });
  const opId = 'continue-test-operation';
  return { views, runs, states, snapshot, records, queued, sends, runCalls, controls, changes, opId,
    get service() { return service; }, capture: () => service.capture(opId, 11),
    boot: () => { service.dispose(); service = createBuildContinueOperations({ ...options, pid: 22 }); },
    activate: async () => { service.activate(opId); await service.reconcile(opId); },
    confirm: tabId => { const target = service.get(opId).targets.find(t => t.source.tabId === tabId),
      request = JSON.parse(queued.get(target.operationKey).request_json), promptHash = promptAuditFingerprint(request.prompt);
      records.set(target.operationKey, { state: 'confirmed', tabId, provider: 'codex', sessionId: states.get(tabId).sessionId,
        operationKey: target.operationKey, handoffId: target.handoffId, attemptId: 'attempt-' + tabId, promptHash,
        auditIdentity: { provider: 'codex', sessionId: states.get(tabId).sessionId, attemptId: 'attempt-' + tabId,
          promptHash, entryUuid: 'native-user-' + tabId, auditTimestamp: new Date(2000).toISOString() },
        receipt: { exactAuditConfirmed: true, actualHash: promptHash, auditExecutionContext: {
          provider: 'codex', sessionId: states.get(tabId).sessionId, turnId: 'continued-' + tabId } } });
    } };
}

test('capture freezes own vs inherited before build; external-only0/mixed1, same jobs/refs retained', async t => {
  const h = fixture(t), op = await h.capture();
  assert.deepEqual(op.targets.map(t => t.source.tabId), ['own', 'mixed']);
  assert.equal(op.participants.find(p => p.source.tabId === 'purple').busy, false);
  assert.deepEqual(op.references.runs.map(r => r.externalResearchJobId), ['same-SC-job', 'mixed-SC-job']);
  h.views[1].busy = true;
  assert.deepEqual((await h.capture()).targets.map(t => t.source.tabId), ['own', 'mixed'], 'duplicate capture never moves the cut');
  h.boot(); await h.activate(); assert.deepEqual(h.sends.map(s => s.tabId), ['own', 'mixed']);
  assert.equal(h.sends.every(s => s.prompt === 'continue'), true);
  h.confirm('own'); h.confirm('mixed'); await h.service.reconcile(h.opId);
  assert.equal(h.service.get(h.opId).phase, 'settled');
  h.boot(); await h.activate(); assert.equal(h.sends.length, 2, 'reopen cannot submit a second continuation');
});

test('capture freezes new FIFO input globally before async persistence, including an idle or newly created tab', async t => {
  const h = fixture(t); let release;
  h.controls.readRuns = () => new Promise(resolve => { release = resolve; });
  const work = h.capture(); await Promise.resolve();
  const idleHeld = h.service.capturing('purple'), lateHeld = h.service.capturing('late-new-tab');
  const idleContinuation = h.service.pending('purple'); release(); await work;
  assert.equal(idleHeld, true); assert.equal(lateHeld, true); assert.equal(idleContinuation, false);
  assert.equal(h.service.capturing('late-new-tab'), true, 'frozen quit applies to whole old Main, not only its earlier catalog');
  h.boot(); assert.equal(h.service.capturing('late-new-tab'), false);
  assert.equal(h.service.get(h.opId).targets.some(target => target.source.tabId === 'purple'), false);
});

test('incoming accepted agent uses only the existing run continuation input, never generic continue', async t => {
  const h = fixture(t); h.views.length = 1;
  h.runs.push({ runId: 'delegation', runKind: 'agent', targetTabId: 'own', sourceTabId: 'parent',
    status: 'running', targetExecutionContext: h.views[0].executionContext });
  await h.capture(); h.boot(); await h.activate();
  assert.deepEqual(h.runCalls, ['delegation']); assert.equal(h.sends.length, 0);
  assert.equal(h.service.get(h.opId).targets[0].operationKey, 'run-owner-operation');
});

test('a terminal no-input agent refusal releases the restart hold as unresolved, without retry or false acceptance', async t => {
  const h = fixture(t); h.views.length = 1; h.controls.runNoInput = true;
  h.runs.push({ runId: 'delegation', runKind: 'agent', targetTabId: 'own', sourceTabId: 'parent', status: 'running',
    targetExecutionContext: h.views[0].executionContext });
  await h.capture(); h.boot(); await h.activate();
  assert.equal(h.service.get(h.opId).targets[0].state, 'unresolved'); assert.equal(h.service.get(h.opId).phase, 'settled');
  assert.equal(h.service.pending('own'), false); assert.equal(h.sends.length, 0);
  h.service.wake(); await h.service.reconcile(h.opId); assert.equal(h.runCalls.length, 1);
  assert.equal(h.records.get('run-owner-operation').receipt.submitted, false);
});

test('lost ACK/restart reads the same operation; unknown is not resent; late exact receipt can settle', async t => {
  const h = fixture(t); h.views.length = 1; h.controls.lostAck = true;
  await h.capture(); h.boot(); await h.activate(); assert.equal(h.sends.length, 1);
  h.boot(); await h.activate(); assert.equal(h.sends.length, 1);
  h.confirm('own'); await h.service.reconcile(h.opId);
  assert.equal(h.service.get(h.opId).targets[0].state, 'confirmed'); assert.equal(h.sends.length, 1);
});

test('startup restores the durable captured intent even when the CLI lost its capture ACK', async t => {
  const h = fixture(t); h.views.length = 1; await h.capture(); h.boot();
  h.service.restore(); await h.service.reconcile(h.opId);
  assert.equal(h.sends.length, 1); assert.equal(h.service.get(h.opId).phase, 'restoring');
  h.boot(); h.service.restore(); await h.service.reconcile(h.opId);
  assert.equal(h.sends.length, 1, 'startup does not create a new handoff or replay admitted input');
});

for (const [name, mutate, expected] of [
  ['natural final before Quit', h => { h.controls.complete = true; }, 'result-ready'],
  ['newer manual input', h => { h.controls.newer = true; }, 'superseded'],
  ['replacement owner', h => { h.states.get('own').sessionId = 'foreign'; }, 'superseded'],
  ['Goal', h => { h.states.get('own').goalWork = { pending: true }; }, 'pending'],
  ['own process busy', h => { h.states.get('own').busy = true; }, 'pending'],
  ['manual Stop after boot', h => { h.controls.stopRevision = 1; }, 'superseded'],
]) test(name + ' cannot send a stale continue', async t => {
  const h = fixture(t); h.views.length = 1; await h.capture(); h.boot(); mutate(h); await h.activate();
  assert.equal(h.sends.length, 0); assert.equal(h.service.get(h.opId).targets[0].state, expected);
});

test('manual Stop/terminal replacement after initial admission is rechecked before FIFO input', async t => {
  const h = fixture(t); h.views.length = 1; await h.capture(); h.boot(); await h.activate();
  assert.equal(h.sends.length, 1);
  h.controls.stopRevision = 1;
  await assert.rejects(h.sends[0].prepareSend(), { code: 'build_continue_owner_changed' });
  h.controls.stopRevision = 0; h.controls.fenceInstance = 'replacement-terminal';
  await assert.rejects(h.sends[0].prepareSend(), { code: 'build_continue_owner_changed' });
  assert.equal(h.sends.length, 1);
});

test('unconfirmed durable cut and foreign shutdown cannot authorize Quit/restore', async t => {
  let h = fixture(t); h.controls.write = () => { throw Error('controlled disk failure'); };
  await assert.rejects(h.capture(), /disk failure/); assert.equal(h.sends.length, 0);
  h = fixture(t); await h.capture(); h.boot(); h.snapshot.shutdownPid = 999;
  assert.throws(() => h.service.activate(h.opId), { code: 'build_continue_shutdown_unproven' });
  assert.equal(h.sends.length, 0);
});

test('native proof arriving during the sender await is processed by its event without a second input', { timeout: 2000 }, async t => {
  const h = fixture(t); h.views.length = 1; await h.capture(); h.boot();
  const done = new Promise(resolve => { h.controls.changed = op => { if (op.phase === 'settled') resolve(); }; });
  h.controls.afterSend = () => { h.confirm('own'); h.service.wake(); };
  h.service.activate(h.opId); await done;
  assert.equal(h.sends.length, 1); assert.equal(h.service.get(h.opId).targets[0].state, 'confirmed');
});
