'use strict';
// Real response observation + continuation-input bookends + restart owner.
// Main facts, OS lookup, persistence and provider input are finite controlled leaves.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const vm = require('node:vm'), ts = require('typescript');
const { createAgentResponseObservationReader } = require('./agent-response-observation-reader');
const { createContinuationInputReader } = require('./orchestration-continuation-input');
let createBuildContinueOperations;
if (process.env.BUILD_CONTINUE_STARTUP_PRE) {
  const name = path.join(__dirname, 'build-continue-startup.saved.cjs'), mod = new Module(name, module);
  mod.filename = name; mod.paths = module.paths;
  mod._compile(fs.readFileSync(process.env.BUILD_CONTINUE_STARTUP_PRE, 'utf8'), name);
  ({ createBuildContinueOperations } = mod.exports);
} else ({ createBuildContinueOperations } = require('./build-continue-operation'));
const clone = value => JSON.parse(JSON.stringify(value));
async function fixture(t, phase = 'coherence-race') {
  const old = { provider: 'codex', sessionId: 'same-A', turnId: 'captured-own-T', generation: 7, processId: null, startedAt: 100 };
  const controls = { phase, revision: 0, fence: { terminalInstanceId: 'same-restored-terminal', stopRevision: 0, order: 1 },
    complete: false, newer: false, lostAck: false };
  let saved = null, service;
  const sends = [], runtimeReads = [], results = [], changes = [], receipts = new Map();
  const sid = () => controls.phase === 'provisional' ? null : controls.phase === 'foreign' ? 'foreign-B' : old.sessionId;
  const raw = () => ({ known: controls.phase !== 'capture-unknown', exists: controls.phase !== 'closed',
    toolType: controls.phase === 'wrong-provider' ? 'claude' : 'codex', sessionId: sid(),
    cwd: controls.phase === 'wrong-cwd' ? '/other-source' : '/private-fixture',
    revision: controls.phase === 'coherence-race' ? String(++controls.revision) : String(controls.revision),
    busy: null, transitioning: controls.phase === 'starting', backgroundWorkCount: 0 });
  const observer = createAgentResponseObservationReader({ captureState: raw,
    readLifecycle: async () => ({ processStatus: controls.phase === 'lookup-unknown' ? 'unknown' : 'found',
      processName: controls.phase === 'physical-mismatch' ? 'claude' : raw().toolType, processPid: 222 }) });
  const input = createContinuationInputReader({ readResponseState: observer.getAgentResponseState,
    readRuntimeSnapshot: async () => {
      runtimeReads.push(controls.phase);
      if (controls.phase === 'input-bookend-race') controls.revision++;
      return { coherent: true, toolType: 'codex', processStatus: 'found', status: 'active', busy: false,
        inputReady: true, starting: false, stopping: false, lifecycleGeneration: 'restored-launch',
        sendTarget: { toolType: 'codex', sessionId: sid(), terminalInstanceId: 'same-restored-terminal',
          launchId: 'restored-launch', lifecycleGeneration: 'restored-launch' } };
    } });
  const options = { instanceId: 'same-operation-private-owner', now: () => 1000,
    read: () => saved, write: value => { saved = clone(value); return { success: true }; },
    captureTabs: () => [{ tabId: 'own', known: true, toolType: 'codex', sessionId: old.sessionId, cwd: '/private-fixture',
      projectId: 'project', busy: true, executionContext: old,
      subject: { kind: 'codex-execution', toolType: 'codex', sessionId: old.sessionId, targetExecutionContext: old }, revision: 'captured' }],
    readRuns: async () => [], readMessages: () => [], readInputFence: () => clone(controls.fence),
    readStartup: () => ({ source: 'exact-shutdown-snapshot', capturedAt: 1001, shutdownPid: 101,
      targets: [{ tabId: 'own', provider: 'codex', sessionId: old.sessionId }] }),
    readState: input, readOriginal: async () => { results.push('original'); return {
      found: true, sourceVerified: true, complete: controls.complete, executionContext: old, userUuid: 'captured-user' }; },
    readLatest: async () => ({ result: { sourceVerified: true }, subject: { targetExecutionContext:
      controls.newer ? { ...old, turnId: 'new-user-turn' } : old } }),
    readInputInterval: async () => ({ known: true, complete: true, users: [
      { aliases: [{ sessionId: old.sessionId, userUuid: 'captured-user' }] },
      { aliases: [{ sessionId: old.sessionId, userUuid: 'new-manual-user' }] },
    ] }),
    send: async request => { await request.prepareSend(); sends.push(request);
      if (controls.lostAck) throw Error('controlled lost ACK'); return { success: true, submitted: false, status: 'application-queued' }; },
    readReceipt: key => receipts.get(key), readQueued: () => null, getRun: () => null,
    changed: value => changes.push(value),
  };
  service = createBuildContinueOperations({ ...options, pid: 101 }); await service.capture('startup-same-operation', 101);
  service.dispose(); service = createBuildContinueOperations({ ...options, pid: 202 });
  t.after(() => service.dispose());
  return { controls, sends, runtimeReads, results, changes, receipts,
    get service() { return service; }, target: () => service.get('startup-same-operation').targets[0],
    activate: async () => { service.activate('startup-same-operation'); await service.reconcile('startup-same-operation'); },
    recheck: () => service.reconcile('startup-same-operation'),
    reopen: () => { service.dispose(); service = createBuildContinueOperations({ ...options, pid: 202 }); },
    state: () => input('own') };
}

for (const phase of ['coherence-race', 'input-bookend-race', 'capture-unknown', 'provisional', 'starting', 'lookup-unknown']) {
  test(`actual ${phase} is pending, then SAME operation submits exactly one continuation after readiness`, async t => {
    const h = await fixture(t, phase); await h.activate();
    assert.equal(h.target().state, 'pending', 'lack of owner proof must never become terminal superseded');
    assert.equal(h.service.get('startup-same-operation').phase, 'restoring');
    assert.equal(h.sends.length, 0); assert.equal(h.results.length, 0, 'no provider result/history work while runtime is unknown');
    const H = h.target().handoffId, O = h.target().operationKey;
    h.reopen(); h.controls.phase = 'ready'; await h.activate();
    assert.equal((await h.state()).busy, null, 'response busy stays unknown: only the existing input proof is used');
    assert.equal(h.sends.length, 1); assert.equal(h.sends[0].handoffId, H); assert.equal(h.sends[0].sendOperationKey, O);
    assert.equal(h.sends[0].expectedTarget.sessionId, 'same-A');
    h.reopen(); await h.activate(); await h.recheck(); assert.equal(h.sends.length, 1, 'no second input after ACK loss/reopen');
  });
}

for (const phase of ['physical-mismatch', 'wrong-provider', 'foreign', 'wrong-cwd', 'closed']) {
  test(`actual ${phase} remains a terminal refusal`, async t => {
    const h = await fixture(t, phase); await h.activate();
    assert.equal(h.target().state, 'superseded'); assert.equal(h.sends.length, 0);
    assert.ok(h.target().refusalObservation, 'terminal refusal retains bounded owner evidence');
    assert.equal(h.target().refusalObservation.kind, phase === 'physical-mismatch' ? 'physical-provider-mismatch'
      : phase === 'closed' ? 'tab-missing' : 'confirmed-source-mismatch');
    h.controls.phase = 'ready'; await h.recheck(); assert.equal(h.sends.length, 0, 'a later matching owner cannot revive a real refusal');
  });
}

test('Stop/replacement fence remains effective even during an unknown runtime read', async t => {
  const h = await fixture(t); await h.activate();
  assert.equal(h.target().state, 'pending');
  h.controls.fence.stopRevision = 1; await h.recheck();
  assert.equal(h.target().state, 'superseded'); assert.equal(h.sends.length, 0);
});

test('missing pinned fence is unknown, not a proved replacement, and cannot allow input', async t => {
  const h = await fixture(t); await h.activate(); assert.equal(h.target().state, 'pending');
  const fence = h.controls.fence; h.controls.fence = null; h.controls.phase = 'ready'; await h.recheck();
  assert.equal(h.target().state, 'pending'); assert.equal(h.sends.length, 0);
  h.controls.fence = fence; await h.recheck(); assert.equal(h.sends.length, 1);
});

test('a proved change of the already pinned PTY does not follow startup readiness', async t => {
  const h = await fixture(t); await h.activate(); assert.equal(h.target().state, 'pending');
  h.controls.phase = 'ready'; h.controls.fence.terminalInstanceId = 'replacement-terminal';
  await h.recheck(); assert.equal(h.target().state, 'superseded'); assert.equal(h.sends.length, 0);
});

test('a newer user turn and a completed original remain distinct from startup unknown', async t => {
  const h = await fixture(t); await h.activate(); assert.equal(h.target().state, 'pending');
  h.controls.phase = 'ready'; h.controls.newer = true; await h.recheck();
  assert.equal(h.target().state, 'superseded'); assert.equal(h.sends.length, 0);
});

test('original completion during startup needs no extra continue', async t => {
  const h = await fixture(t); await h.activate(); h.controls.phase = 'ready'; h.controls.complete = true;
  await h.recheck(); assert.equal(h.target().state, 'result-ready'); assert.equal(h.sends.length, 0);
});

test('lost send ACK after recovered readiness is retained as UNKNOWN, never replayed', async t => {
  const h = await fixture(t); await h.activate(); h.controls.phase = 'ready'; h.controls.lostAck = true;
  await h.recheck(); assert.equal(h.target().state, 'unknown'); assert.equal(h.sends.length, 1);
  h.reopen(); await h.activate(); await h.recheck(); assert.equal(h.sends.length, 1);
});

test('production Web readiness wake retries the pending original once without timer or duplicate persistence', async t => {
  const h = await fixture(t); await h.activate(); assert.equal(h.target().state, 'pending');
  const text = fs.readFileSync(require.resolve('./web-server'), 'utf8');
  const tree = ts.createSourceFile('web-server.js', text, ts.ScriptTarget.Latest, true);
  const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'wakeLoopDependencies');
  assert.ok(fn); const context = vm.createContext({ buildContinueOperations: h.service, loopDependencies: null });
  vm.runInContext(fn.getText(tree), context);
  const writes = h.changes.length;
  context.wakeLoopDependencies('own'); await h.recheck();
  assert.equal(h.changes.length, writes, 'unknown repeats do not publish their own fresh wake endlessly');
  assert.equal(h.sends.length, 0);
  h.controls.phase = 'ready'; context.wakeLoopDependencies('own'); await h.recheck();
  assert.equal(h.sends.length, 1); context.wakeLoopDependencies('own'); await h.recheck();
  assert.equal(h.sends.length, 1);
});
