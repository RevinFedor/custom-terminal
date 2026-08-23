import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildInterruptedRestoreIncidentReport,
  classifyInterruptedRestoreRuntime,
  resolveInterruptedRestoreTargets,
  restoreInterruptedSessionsSequentially,
} from './interruptedAutoRestore.mjs';

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
