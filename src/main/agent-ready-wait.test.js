'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  READINESS_CHANGED_EVENT,
  READY_EVENT,
  isAgentInputReady,
  waitForAgentReadyTransition,
} = require('./agent-ready-wait');

test('initial ready snapshot resolves without requiring another event', async () => {
  const events = new EventEmitter();
  const status = {
    toolType: 'claude',
    status: 'active',
    inputReady: true,
    startupDefaultsReady: true,
  };
  assert.deepEqual(await waitForAgentReadyTransition({
    tabId: 'tab-already-ready',
    timeoutMs: 2_000,
    eventBus: events,
    readStatus: async () => status,
  }), status);
  assert.equal(events.listenerCount(READY_EVENT), 0);
  assert.equal(events.listenerCount(READINESS_CHANGED_EVENT), 0);
});

test('expected launch rejects Stop or replacement before accepting another ready session', async () => {
  for (const replacement of [
    { sessionId: 'other', launchId: 'L2', lifecycleGeneration: 'G2' },
    { sessionId: 'same', launchId: 'L2', lifecycleGeneration: 'G2' },
    { sessionId: 'same', launchId: null, lifecycleGeneration: null, liveLifecycle: false },
  ]) {
    const eventBus = new EventEmitter();
    let status = { status: 'starting', inputReady: false, launchId: 'L1', lifecycleGeneration: 'G1' };
    const waiting = waitForAgentReadyTransition({ tabId: 'T', eventBus, readStatus: async () => status,
      expectedOwner: { launchId: 'L1', lifecycleGeneration: 'G1' } });
    const rejected = assert.rejects(waiting, error => error.code === 'agent_ready_owner_changed');
    await new Promise(resolve => setImmediate(resolve));
    status = { status: 'active', inputReady: true, ...replacement };
    eventBus.emit(READINESS_CHANGED_EVENT, null, { tabId: 'T' });
    await rejected;
    assert.equal(eventBus.listenerCount(READY_EVENT), 0);
  }
});

test('same launch source-to-child readiness is valid; unproven owner never grants ready', async () => {
  const eventBus = new EventEmitter();
  let status = { status: 'active', inputReady: true, sessionId: 'source' };
  let resolved = false;
  const waiting = waitForAgentReadyTransition({ tabId: 'T', eventBus, readStatus: async () => status,
    expectedOwner: { launchId: 'L1', lifecycleGeneration: 'G1' } }).then(value => { resolved = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  status = { status: 'busy', inputReady: true, sessionId: 'child', launchId: 'L1', lifecycleGeneration: 'G1' };
  eventBus.emit(READINESS_CHANGED_EVENT, null, { tabId: 'T' });
  assert.equal((await waiting).sessionId, 'child');
});

test('Codex provisional composer remains ready for one guarded first submit', () => {
  assert.equal(isAgentInputReady({
    toolType: 'codex',
    status: 'starting',
    inputReady: true,
    writerConfirmed: false,
  }), true);
  assert.equal(isAgentInputReady({
    toolType: 'claude',
    status: 'starting',
    inputReady: true,
  }), false);
});

test('busy runtime with available input is ready for queued submission', () => {
  assert.equal(isAgentInputReady({
    toolType: 'codex',
    status: 'busy',
    inputReady: true,
  }), true);
  assert.equal(isAgentInputReady({
    toolType: 'claude',
    status: 'busy',
    inputReady: true,
  }), true);
});

test('task_started resolves startup wait without an idle composer edge', async () => {
  const events = new EventEmitter();
  let status = {
    toolType: 'codex',
    status: 'starting',
    inputReady: false,
  };
  const waiting = waitForAgentReadyTransition({
    tabId: 'resume-goal-tab',
    timeoutMs: 2_000,
    eventBus: events,
    readStatus: async () => status,
  });

  status = {
    toolType: 'codex',
    status: 'busy',
    inputReady: true,
  };
  events.emit(READINESS_CHANGED_EVENT, null, {
    tabId: 'resume-goal-tab',
    toolType: 'codex',
    source: 'turn-lifecycle',
    status: 'ready',
  });

  assert.deepEqual(await waiting, status);
  assert.equal(events.listenerCount(READY_EVENT), 0);
  assert.equal(events.listenerCount(READINESS_CHANGED_EVENT), 0);
});

test('verified Codex composer wakes the exact Project API readiness wait', async () => {
  const events = new EventEmitter();
  let status = {
    toolType: 'codex',
    status: 'starting',
    inputReady: false,
    writerConfirmed: false,
  };
  const waiting = waitForAgentReadyTransition({
    tabId: 'nested-codex-tab',
    timeoutMs: 2_000,
    eventBus: events,
    readStatus: async () => status,
  });

  status = {
    toolType: 'codex',
    status: 'starting',
    inputReady: true,
    writerConfirmed: false,
  };
  events.emit(READY_EVENT, null, {
    tabId: 'nested-codex-tab',
    toolType: 'codex',
  });

  assert.deepEqual(await waiting, status);
  assert.equal(events.listenerCount(READY_EVENT), 0);
  assert.equal(events.listenerCount(READINESS_CHANGED_EVENT), 0);
});

test('known manual-action readiness failure is a conflict, not a timeout', async () => {
  const events = new EventEmitter();
  await assert.rejects(waitForAgentReadyTransition({
    tabId: 'tab-auth',
    timeoutMs: 2_000,
    eventBus: events,
    readStatus: async () => ({
      toolType: 'codex',
      status: 'starting',
      inputReady: false,
      manualActionRequired: true,
      lastNotReady: { blockers: ['auth-required'] },
    }),
  }), (error) => {
    assert.equal(error.code, 'codex_auth_required');
    assert.equal(error.statusCode, 409);
    return true;
  });
});

test('post-TUI startup-settings readiness wakes the same Project API wait', async () => {
  const events = new EventEmitter();
  const logs = [];
  let status = {
    toolType: 'claude',
    status: 'starting',
    inputReady: false,
    startupDefaultsPending: true,
  };
  const waiting = waitForAgentReadyTransition({
    tabId: 'tab-ready',
    timeoutMs: 2_000,
    eventBus: events,
    readStatus: async () => status,
    log: (message) => logs.push(message),
  });

  // The raw TUI edge is intentionally too early: startup settings still own
  // the input gate, so this wake must not resolve the wait.
  events.emit(READY_EVENT, null, { tabId: 'tab-ready', toolType: 'claude' });
  await Promise.resolve();

  status = {
    toolType: 'claude',
    status: 'active',
    inputReady: true,
    startupDefaultsReady: true,
  };
  events.emit(READINESS_CHANGED_EVENT, null, {
    tabId: 'tab-ready',
    source: 'startup-defaults',
    status: 'ready',
  });

  assert.deepEqual(await waiting, status);
  assert.equal(logs.some((line) => line.includes('defaults=pending')), true);
  assert.equal(logs.some((line) => line.includes('defaults=ready')), true);
  assert.equal(logs.some((line) => line.includes('source=startup-defaults')), true);
  assert.equal(events.listenerCount(READY_EVENT), 0);
  assert.equal(events.listenerCount(READINESS_CHANGED_EVENT), 0);
});

test('startup-settings failure rejects immediately instead of timing out', async () => {
  const events = new EventEmitter();
  let status = {
    toolType: 'claude',
    status: 'starting',
    inputReady: false,
    startupDefaultsPending: true,
  };
  const waiting = waitForAgentReadyTransition({
    tabId: 'tab-failed',
    timeoutMs: 2_000,
    eventBus: events,
    readStatus: async () => status,
  });

  status = {
    toolType: 'claude',
    status: 'starting',
    inputReady: false,
    startupDefaultsError: '/effort max was not confirmed',
  };
  events.emit(READINESS_CHANGED_EVENT, null, {
    tabId: 'tab-failed',
    source: 'startup-defaults',
    status: 'failed',
  });

  await assert.rejects(waiting, (error) => {
    assert.equal(error.code, 'agent_startup_defaults_failed');
    assert.equal(error.statusCode, 409);
    assert.equal(error.status, status);
    return true;
  });
});

test('an unrelated tab wake cannot advance this tab readiness', async () => {
  const events = new EventEmitter();
  let reads = 0;
  let status = {
    toolType: 'claude',
    status: 'starting',
    inputReady: false,
    startupDefaultsPending: true,
  };
  const waiting = waitForAgentReadyTransition({
    tabId: 'owned-tab',
    timeoutMs: 2_000,
    eventBus: events,
    readStatus: async () => {
      reads += 1;
      return status;
    },
  });
  await Promise.resolve();
  const readsAfterInitial = reads;

  events.emit(READINESS_CHANGED_EVENT, null, {
    tabId: 'other-tab',
    status: 'ready',
  });
  await Promise.resolve();
  assert.equal(reads, readsAfterInitial);

  status = { toolType: 'claude', status: 'active', inputReady: true };
  events.emit(READINESS_CHANGED_EVENT, null, {
    tabId: 'owned-tab',
    status: 'ready',
  });
  assert.equal((await waiting).inputReady, true);
});
