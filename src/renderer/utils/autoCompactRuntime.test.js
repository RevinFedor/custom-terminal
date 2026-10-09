const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const { createCompactOperationRegistry } = require('../../main/compact-operation-state');

let compiled;
async function source() {
  compiled ||= esbuild.build({
    entryPoints: [path.join(__dirname, 'autoCompactRuntime.ts')], bundle: true, write: false,
    platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'scenario-ports', setup(build) {
      build.onResolve({ filter: /historyAgentRuntimes|agentScenarios|agentSendSettingsContract/ }, (args) => ({ path: args.path, namespace: 'ports' }));
      build.onLoad({ filter: /.*/, namespace: 'ports' }, () => ({ contents: `
        export const getHistoryAgentRuntime = () => ({ toolType: 'codex' });
        export const AGENT_SETTINGS_INTENT_NONE = { kind: 'none' };
        export const sendAgentPromptScenario = (...args) => globalThis.testSend(...args);` }));
    } }],
  }).then((r) => r.outputFiles[0].text);
  return compiled;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function virtualClock() {
  let now = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay) {
      const id = Symbol('compact-timer');
      timers.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}
async function harness({ send, settled = [], snapshot, clock = virtualClock() } = {}) {
  const ipc = new EventEmitter();
  ipc.invoke = async (channel) => {
    assert.equal(channel, 'agent:get-operational-phase'); return snapshot ? snapshot() : { settled };
  };
  const module = { exports: {} };
  const calls = [];
  vm.runInNewContext(await source(), { module, exports: module.exports, console,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    window: { require: () => ({ ipcRenderer: ipc }) }, testSend: async (args) => {
      calls.push(args); return send ? send(args) : { success: true, submitted: true };
    },
  });
  const target = { tabId: 'A', provider: 'codex', sessionId: 'S', projectId: 'P', workflowId: 'main' };
  return { run: (handoffId = 'OWN') => module.exports.executeAutoCompact(target, handoffId), ipc, calls, clock, target,
    outcome: (patch = {}) => ipc.emit('agent:operational-phase', null, {
      tabId: 'A', provider: 'codex', sessionId: 'S', handoffId: 'OWN', active: false, outcome: 'completed', ...patch,
    }),
  };
}
test('Enter acknowledgement and foreign compact do not finish this exact request', async () => {
  const h = await harness(); let done = false;
  const result = h.run().then(() => { done = true; }); await tick();
  assert.equal(done, false);
  h.outcome({ handoffId: 'OTHER' }); h.outcome({ sessionId: 'OTHER' }); h.outcome({ active: true });
  await tick(); assert.equal(done, false);
  h.outcome(); await result;
  assert.equal(h.calls[0].prompt, '/compact'); assert.equal(h.calls[0].requireLive, true);
  assert.equal(h.calls[0].returnDraftOnConflict, false); assert.equal(h.ipc.listenerCount('agent:operational-phase'), 0);
});
test('a fast matching completion before send IPC resolves is retained', async () => {
  let resolve;
  const h = await harness({ send: () => new Promise((done) => { resolve = done; }) });
  const result = h.run(); await tick(); h.outcome(); resolve({ submitted: true, success: true });
  await result; assert.equal(h.ipc.listenerCount('agent:operational-phase'), 0);
});
test('cancelled provider operation fails without claiming completion', async () => {
  const h = await harness(); const result = h.run(); await tick();
  h.outcome({ outcome: 'aborted', reason: 'input-escape' });
  await assert.rejects(result, /input-escape/); assert.equal(h.ipc.listenerCount('agent:operational-phase'), 0);
});

test('exact compact manual-stop before the stopping-state UI event is quiet and never continues Run After', async () => {
  const { createAutoCompactCoordinator } = await import('./autoCompactCoordinator.mjs');
  const { normalizeAutoCompactPolicy } = await import('./autoCompactPolicy.mjs');
  const h = await harness(), events = [];
  const policy = normalizeAutoCompactPolicy({ enabled: true, workflowIds: ['main'], armedAt: 1 });
  const coordinator = createAutoCompactCoordinator({
    startedAt: 0, policy: () => policy, target: () => h.target, blocked: () => false,
    readiness: async () => ({ ready: true, status: 'active' }),
    context: async () => ({ exact: true, sessionId: 'S', pct: 70, observedAt: 100 }),
    compact: (_target, id) => h.run(id), activity: (_tab, activity) => events.push({ activity }),
    failure: (_tab, error) => events.push({ error }), release: () => events.push('release'),
  });
  coordinator.intercept('A', { at: 100, turnStartedAt: 10, natural: true, live: true }, () => events.push('continue'));
  await tick(); assert.equal(h.calls.length, 1);
  h.outcome({ handoffId: h.calls[0].handoffId, outcome: 'aborted', reason: 'manual-stop' });
  await tick();
  assert.equal(events.some(event => event.error), false);
  assert.equal(events.at(-1).activity, null);
  assert.equal(events.includes('continue'), false); assert.equal(events.includes('release'), false);
  assert.equal(coordinator.has('A'), false); assert.equal(policy.enabled, true);
  assert.equal(h.ipc.listenerCount('agent:operational-phase'), 0);
});
test('pre-Enter refusal cleans up observer and returns its real cause', async () => {
  const h = await harness({ send: async () => ({ submitted: false, error: 'draft-conflict' }) });
  await assert.rejects(h.run(), /draft-conflict/); assert.equal(h.ipc.listenerCount('agent:operational-phase'), 0);
});
test('main settled ledger recovers an outcome missed by renderer event', async () => {
  const h = await harness({ settled: [{ tabId: 'A', provider: 'codex', sessionId: 'S', handoffId: 'OWN', active: false, outcome: 'completed' }] });
  await h.run(); assert.equal(h.calls.length, 1);
});

test('a compact still running after three minutes keeps its exact observer and accepts late completion', async () => {
  const h = await harness();
  let state = 'pending';
  const result = h.run().then(() => { state = 'completed'; }, () => { state = 'failed'; });
  await tick();
  h.outcome({ active: true, outcome: null });
  h.clock.advance(180_001);
  await tick();
  assert.equal(state, 'pending', 'elapsed time is not a terminal provider outcome');
  assert.equal(h.ipc.listenerCount('agent:operational-phase'), 1);
  h.clock.advance(110_921); // The reported4505 compact completed about4m51s after scheduling.
  h.outcome({ handoffId: 'NEW-OPERATION' });
  h.outcome({ sessionId: 'REPLACED-OWNER' });
  await tick();
  assert.equal(state, 'pending');
  assert.equal(h.calls.length, 1, 'one original compact, never a retry');
  h.outcome();
  await result;
  assert.equal(state, 'completed');
  assert.equal(h.ipc.listenerCount('agent:operational-phase'), 0);
});

test('a slow submission does not spend a provider completion deadline before its acknowledgement', async () => {
  let acknowledge;
  const h = await harness({ send: () => new Promise(resolve => { acknowledge = resolve; }) });
  let state = 'pending';
  const result = h.run().then(() => { state = 'completed'; }, () => { state = 'failed'; });
  await tick();
  h.clock.advance(240_000);
  h.outcome();
  acknowledge({ success: true, submitted: true });
  await result;
  assert.equal(state, 'completed', 'the early exact completion survives a delayed send response');
  assert.equal(h.calls.length, 1);
  assert.equal(h.ipc.listenerCount('agent:operational-phase'), 0);
});

test('registry proof after a long compact releases the same coordinator once, only after input readiness', async () => {
  const { createAutoCompactCoordinator } = await import('./autoCompactCoordinator.mjs');
  const { normalizeAutoCompactPolicy } = await import('./autoCompactPolicy.mjs');
  let h, ready = true;
  const events = [];
  const registry = createCompactOperationRegistry({
    now: () => h.clock.now(),
    publish: operation => h.ipc.emit('agent:operational-phase', null, operation),
  });
  h = await harness({
    snapshot: () => registry.snapshot('A', 'codex'),
    send: args => {
      ready = false;
      registry.begin({ ...args, provider: 'codex', command: '/compact',
        operationId: 'codex:api:' + args.handoffId, generation: 'G', sourceByteOffset: 100 });
      return { success: true, submitted: true };
    },
  });
  const policy = normalizeAutoCompactPolicy({ enabled: true, workflowIds: ['main'], armedAt: 100 });
  const coordinator = createAutoCompactCoordinator({
    startedAt: 50, policy: () => policy, target: () => h.target, blocked: () => false,
    readiness: async () => ({ ready, status: 'active' }),
    context: async () => ({ exact: true, sessionId: 'S', pct: 68, observedAt: 240 }),
    compact: (_target, handoffId) => h.run(handoffId),
    activity: (_tab, activity) => events.push({ activity }),
    failure: (_tab, error) => events.push({ error }), release: () => events.push('release'),
  });
  assert.equal(coordinator.intercept('A', { at: 250, turnStartedAt: 150, live: true, natural: true, compact: false },
    () => events.push('continue')), true);
  await tick();
  h.clock.advance(180_001); await tick();
  assert.equal(coordinator.has('A'), true);
  assert.equal(events.some(event => event.error), false);
  assert.equal(events.at(-1).activity.phase, 'compacting');
  assert.equal(events.includes('continue'), false);
  assert.equal(h.calls.length, 1);
  h.clock.advance(110_921);
  const owner = registry.snapshot('A', 'codex').active;
  registry.observeCodexEvidence({ ...owner, kind: 'compacted', rolloutOffset: 150 });
  registry.observeCodexEvidence({ ...owner, kind: 'task_complete', rolloutOffset: 200 });
  registry.finalizeCodexTaskComplete(owner);
  await tick();
  assert.equal(registry.snapshot('A', 'codex').settled[0].completionProof, 'rollout-compacted-before-task-complete');
  assert.equal(coordinator.has('A'), true, 'completion is not input readiness');
  assert.equal(events.at(-1).activity.phase, 'waiting');
  assert.equal(events.includes('continue'), false);
  ready = true; coordinator.wake('A'); await tick();
  coordinator.wake('A'); await tick();
  assert.equal(coordinator.has('A'), false);
  assert.equal(events.filter(event => event === 'continue').length, 1);
  assert.equal(events.filter(event => event === 'release').length, 1);
  assert.equal(events.some(event => event.error), false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.ipc.listenerCount('agent:operational-phase'), 0);

  assert.equal(coordinator.intercept('A', { at: 450, turnStartedAt: 200, live: true, natural: true, compact: false },
    () => events.push('disposed-continue')), true);
  await tick();
  const disposedOwner = registry.snapshot('A', 'codex').active;
  assert.ok(disposedOwner);
  coordinator.dispose();
  assert.equal(coordinator.has('A'), false);
  h.clock.advance(300_000);
  registry.observeCodexEvidence({ ...disposedOwner, kind: 'compacted', rolloutOffset: 150 });
  registry.observeCodexEvidence({ ...disposedOwner, kind: 'task_complete', rolloutOffset: 200 });
  registry.finalizeCodexTaskComplete(disposedOwner);
  await tick();
  assert.equal(events.includes('disposed-continue'), false, 'late completion cannot resurrect a disposed task');
  assert.equal(events.filter(event => event === 'release').length, 1);
  assert.equal(events.some(event => event.error), false);
  assert.equal(h.calls.length, 2, 'only two distinct explicitly admitted causes, no timer retry');
  assert.equal(h.ipc.listenerCount('agent:operational-phase'), 0);
});

test('exact failed, aborted and unknown outcomes remain failures after a long wait', async () => {
  for (const [outcome, reason] of [['failed', 'compact-provider-error'], ['aborted', 'manual-stop'], ['unknown', 'owner-lost']]) {
    const h = await harness();
    const result = h.run();
    const rejection = assert.rejects(result, new RegExp(reason));
    await tick();
    h.clock.advance(360_000); await tick();
    assert.equal(h.ipc.listenerCount('agent:operational-phase'), 1);
    h.outcome({ outcome, reason });
    await rejection;
    assert.equal(h.calls.length, 1);
    assert.equal(h.ipc.listenerCount('agent:operational-phase'), 0);
  }
});

test('live completion between subscribing and the ledger response survives an empty snapshot', async () => {
  let read;
  const h = await harness({ snapshot: () => new Promise(resolve => { read = resolve; }) });
  let completed = false;
  const result = h.run().then(() => { completed = true; });
  await tick();
  h.outcome();
  assert.equal(completed, false, 'the snapshot request is still in flight');
  read({ settled: [] });
  await result;
  assert.equal(completed, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.ipc.listenerCount('agent:operational-phase'), 0);
});
