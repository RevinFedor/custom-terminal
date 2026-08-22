import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
