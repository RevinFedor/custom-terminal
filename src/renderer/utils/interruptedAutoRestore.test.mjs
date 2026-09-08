import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildInterruptedRestoreIncidentReport,
  classifyInterruptedRestoreRuntime,
  reconcileRestoredInterruptedTab,
  normalizeInterruptedRestoreParallelism,
  prioritizeInterruptedRestoreTargets,
  retryInterruptedRestoreAdmission,
  resolveInterruptedRestoreTargets,
  restoreInterruptedSessionsWithConcurrency,
  restoreInterruptedSessionsSequentially,
} from './interruptedAutoRestore.mjs';

test('late ready consumes a shutdown marker only for the exact confirmed ready writer', () => {
  const tab = { wasInterrupted: true, codexSessionId: 'S' };
  let clears = 0;
  const store = { openProjects: new Map([['P', { tabs: new Map([['T', tab]]) }]]),
    clearInterruptedState: () => { clears++; tab.wasInterrupted = false; } };
  const ready = { success: true, inputReady: true, writerConfirmed: true,
    provenWriterSessionId: 'S', liveLifecycle: true, sessionStatus: 'active' };
  for (const delta of [{ inputReady: false }, { writerConfirmed: false },
    { provenWriterSessionId: 'other' }, { liveLifecycle: false }, { sessionStatus: 'starting' }]) {
    assert.equal(reconcileRestoredInterruptedTab(store, 'T', { ...ready, ...delta }), false);
    assert.equal(tab.wasInterrupted, true);
  }
  assert.equal(reconcileRestoredInterruptedTab(store, 'T', ready), true);
  assert.equal(reconcileRestoredInterruptedTab(store, 'T', ready), false);
  assert.equal(clears, 1);
});

test('temporary process lookup failure is retried without admitting another launch', async () => {
  const attempts = [];
  const waits = [];
  const retries = [];
  const result = await retryInterruptedRestoreAdmission(
    async (attempt) => {
      attempts.push(attempt);
      if (attempt < 3) {
        return {
          success: false,
          accepted: false,
          error: 'process_lookup_failed',
          reason: 'process_lookup_unknown',
        };
      }
      return { success: true, accepted: true };
    },
    {
      retryDelaysMs: [100, 250, 500],
      wait: async (delayMs) => { waits.push(delayMs); },
      onRetry: ({ attempt, nextAttempt, delayMs }) => {
        retries.push([attempt, nextAttempt, delayMs]);
      },
    },
  );

  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(waits, [100, 250]);
  assert.deepEqual(retries, [[1, 2, 100], [2, 3, 250]]);
  assert.equal(result.accepted, true);
  assert.equal(result.admissionAttempts, 3);
});

test('real busy-shell refusal is final and is never retried', async () => {
  let attempts = 0;
  const result = await retryInterruptedRestoreAdmission(async () => {
    attempts += 1;
    return { success: false, accepted: false, error: 'shell_not_idle' };
  }, {
    retryDelaysMs: [0, 0],
    wait: async () => { throw new Error('must not wait'); },
  });
  assert.equal(attempts, 1);
  assert.equal(result.error, 'shell_not_idle');
  assert.equal(result.admissionAttempts, 1);
});

test('persistent unknown lookup is reported only after the bounded retry budget', async () => {
  let attempts = 0;
  const result = await retryInterruptedRestoreAdmission(async () => {
    attempts += 1;
    return {
      success: false,
      accepted: false,
      error: 'process_lookup_failed',
      lookupStatus: 'unknown',
    };
  }, {
    retryDelaysMs: [0, 0],
    wait: async () => {},
  });
  assert.equal(attempts, 3);
  assert.equal(result.retryExhausted, true);
  assert.equal(result.admissionAttempts, 3);
});

test('renderer consumes the frozen exact target instead of re-inferring provider ownership', () => {
  const resolved = resolveInterruptedRestoreTargets({
    source: 'exact-shutdown-snapshot',
    targets: [{ tabId: 'tab-1', provider: 'codex', sessionId: 'writer-child' }],
  }, [{
    projectId: 'project-1',
    tabs: [{
      tabId: 'tab-1',
      wasInterrupted: true,
      claudeSessionId: 'stale-claude',
      codexSessionId: 'writer-child',
      commandType: 'claude',
    }],
  }]);
  assert.deepEqual(resolved.targets, [{
    tabId: 'tab-1',
    projectId: 'project-1',
    sessionId: 'writer-child',
    engine: 'codex',
  }]);
});

test('changed or ambiguous renderer identity never auto-resumes', () => {
  const snapshot = {
    targets: [
      { tabId: 'changed', provider: 'claude', sessionId: 'old' },
      { tabId: 'duplicate', provider: 'codex', sessionId: 'writer' },
    ],
  };
  const resolved = resolveInterruptedRestoreTargets(snapshot, [
    { projectId: 'p1', tabs: [{ tabId: 'changed', wasInterrupted: true, claudeSessionId: 'new' }] },
    { projectId: 'p1', tabs: [{ tabId: 'duplicate', wasInterrupted: true, codexSessionId: 'writer' }] },
    { projectId: 'p2', tabs: [{ tabId: 'duplicate', wasInterrupted: true, codexSessionId: 'writer' }] },
  ]);
  assert.deepEqual(resolved.targets, []);
  assert.equal(resolved.unresolved.length, 2);
});

test('restore priority is focused tab, visible panes, active workflow, then background', () => {
  const source = ['background-a', 'active-hidden', 'visible-b', 'focused', 'visible-a', 'background-b']
    .map((tabId) => ({ tabId }));
  assert.deepEqual(
    prioritizeInterruptedRestoreTargets(source, {
      focusedTabId: 'focused',
      visibleTabIds: ['visible-a', 'focused', 'visible-b'],
      activeWorkflowTabIds: ['active-hidden', 'visible-a', 'focused', 'visible-b'],
    }).map((item) => item.tabId),
    ['focused', 'visible-b', 'visible-a', 'active-hidden', 'background-a', 'background-b'],
  );
});

test('parallel restore setting defaults to two and is bounded to one through three', () => {
  assert.equal(normalizeInterruptedRestoreParallelism(undefined), 2);
  assert.equal(normalizeInterruptedRestoreParallelism(null), 2);
  assert.equal(normalizeInterruptedRestoreParallelism(''), 2);
  assert.equal(normalizeInterruptedRestoreParallelism('2'), 2);
  assert.equal(normalizeInterruptedRestoreParallelism(0), 1);
  assert.equal(normalizeInterruptedRestoreParallelism(99), 3);
});

test('bounded restore serializes admission while overlapping at most two warmups', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let admissions = 0;
  let maxAdmissions = 0;
  const events = [];
  const results = await restoreInterruptedSessionsWithConcurrency(
    [{ tabId: 'a' }, { tabId: 'b' }, { tabId: 'c' }],
    async (item, _index, { releaseAdmission }) => {
      inFlight += 1;
      admissions += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      maxAdmissions = Math.max(maxAdmissions, admissions);
      events.push('admission:' + item.tabId);
      await new Promise((resolve) => setImmediate(resolve));
      admissions -= 1;
      releaseAdmission();
      events.push('warming:' + item.tabId);
      await new Promise((resolve) => setTimeout(resolve, item.tabId === 'a' ? 8 : 2));
      events.push('ready:' + item.tabId);
      inFlight -= 1;
      return { success: true, accepted: true, ready: true, settled: true };
    },
    { parallelism: 2 },
  );

  assert.equal(maxAdmissions, 1);
  assert.equal(maxInFlight, 2);
  assert.equal(results.length, 3);
  assert.ok(events.indexOf('admission:b') < events.indexOf('ready:a'));
  assert.ok(events.indexOf('admission:c') > events.indexOf('ready:b'));
});

test('interrupted restore starts the next tab only after the previous lifecycle settles', async () => {
  let active = 0;
  let maxActive = 0;
  const order = [];
  const results = await restoreInterruptedSessionsSequentially(
    [{ tabId: 'a' }, { tabId: 'b' }, { tabId: 'c' }],
    async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push('start:' + item.tabId);
      await new Promise((resolve) => setImmediate(resolve));
      order.push('ready:' + item.tabId);
      active -= 1;
      return { success: true, accepted: true, ready: true, settled: true };
    },
  );

  assert.equal(maxActive, 1);
  assert.deepEqual(order, [
    'start:a', 'ready:a',
    'start:b', 'ready:b',
    'start:c', 'ready:c',
  ]);
  assert.equal(results.length, 3);
});

test('one rejected restore is recorded and does not block later interrupted tabs', async () => {
  const seen = [];
  const results = await restoreInterruptedSessionsSequentially(
    [{ tabId: 'a' }, { tabId: 'b' }],
    async (item) => {
      seen.push(item.tabId);
      if (item.tabId === 'a') {
        return { success: false, accepted: false, ready: false, settled: true, error: 'shell_not_idle' };
      }
      return { success: true, accepted: true, ready: true, settled: true };
    },
  );
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(results[0].result.error, 'shell_not_idle');
  assert.equal(results[1].result.ready, true);
});

test('unknown accepted startup halts the queue instead of creating a launch storm', async () => {
  const seen = [];
  const results = await restoreInterruptedSessionsSequentially(
    [{ tabId: 'a' }, { tabId: 'b' }],
    async (item) => {
      seen.push(item.tabId);
      return {
        success: false,
        accepted: true,
        ready: false,
        settled: false,
        error: 'agent_ready_timeout',
      };
    },
  );
  assert.deepEqual(seen, ['a']);
  assert.equal(results.length, 1);
});

test('an exact live Codex writer is already restored, not a second launch target', () => {
  assert.deepEqual(classifyInterruptedRestoreRuntime({
    engine: 'codex',
    sessionId: 'session-exact',
    runtime: {
      success: true,
      liveLifecycle: true,
      sessionStatus: 'busy',
      writerConfirmed: true,
      provenWriterSessionId: 'session-exact',
      savedSessionId: 'session-exact',
    },
  }), {
    state: 'ready',
    reason: 'exact-live-writer',
    observedSessionId: 'session-exact',
    status: 'busy',
  });
});

test('an exact provisional Resume is joined while it is still starting', () => {
  assert.deepEqual(classifyInterruptedRestoreRuntime({
    engine: 'codex',
    sessionId: 'session-exact',
    runtime: {
      success: true,
      liveLifecycle: true,
      sessionStatus: 'starting',
      writerConfirmed: false,
      provenWriterSessionId: null,
      readIdentitySource: 'resume-source',
      readSessionId: 'session-exact',
      savedSessionId: 'session-exact',
    },
  }), {
    state: 'joining',
    reason: 'exact-resume-in-flight',
    observedSessionId: 'session-exact',
    status: 'starting',
  });
});

test('a saved id never disguises a different live Codex writer as restored', () => {
  assert.deepEqual(classifyInterruptedRestoreRuntime({
    engine: 'codex',
    sessionId: 'saved-session',
    runtime: {
      success: true,
      liveLifecycle: true,
      sessionStatus: 'active',
      writerConfirmed: true,
      provenWriterSessionId: 'foreign-writer',
      savedSessionId: 'saved-session',
    },
  }), {
    state: 'conflict',
    reason: 'live-codex-session-mismatch',
    observedSessionId: 'foreign-writer',
    status: 'active',
  });
});

test('Claude also requires the exact live session; an inactive target still launches', () => {
  assert.equal(classifyInterruptedRestoreRuntime({
    engine: 'claude',
    sessionId: 'claude-exact',
    runtime: { status: 'active', sessionId: 'claude-exact' },
  }).state, 'ready');
  assert.equal(classifyInterruptedRestoreRuntime({
    engine: 'claude',
    sessionId: 'claude-exact',
    runtime: { status: 'active', sessionId: 'claude-other' },
  }).state, 'conflict');
  assert.equal(classifyInterruptedRestoreRuntime({
    engine: 'claude',
    sessionId: 'claude-exact',
    runtime: { status: 'inactive', sessionId: 'claude-exact' },
  }).state, 'launch');
});

test('automatic restore incident report contains exact copy diagnostics', () => {
  const report = buildInterruptedRestoreIncidentReport({
    tabId: 'project-tab-714',
    sessionId: '2fc5d6dd-ae50-46d4-8399-8670a2284c2e',
    engine: 'codex',
    error: 'shell_not_idle',
    detail: 'foreground_command_running',
    runtimeReason: 'foreground_command_running',
    occurredAt: Date.UTC(2026, 7, 23, 18, 13, 52, 407),
  });
  assert.match(report, /^Noted Terminal automatic restore incident/m);
  assert.match(report, /Tab ID: project-tab-714/);
  assert.match(report, /Session ID: 2fc5d6dd-ae50-46d4-8399-8670a2284c2e/);
  assert.match(report, /Time \(Moscow\): 2026-08-23 21:13:52\.407 MSK/);
  assert.match(report, /Error code: shell_not_idle/);
  assert.match(report, /Runtime reason: foreground_command_running/);
});
