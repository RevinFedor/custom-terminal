const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computePromptQueueInstallBlockers,
  describeQueuePromise,
  promptQueueReadFailureBlocker,
} = require('./prompt-queue-install-blockers');

const armed = (extra = {}) => ({
  autoRun: true,
  items: [{ id: 'a', text: 'go' }],
  ...extra,
});

test('an armed queue with a runnable card blocks the rebuild', () => {
  const blockers = computePromptQueueInstallBlockers({
    persistedQueues: { 'tab-1': armed() },
  });
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].tabId, 'tab-1');
  assert.equal(blockers[0].kind, 'prompt-queue');
  // Not 'busy' — the tab is owed, not running.
  assert.equal(blockers[0].status, 'queued');
  assert.equal(blockers[0].reason, 'queue');
  assert.equal(blockers[0].pending, 1);
});

test('THE BUG: the gap between two links of a chain is still blocked', () => {
  // Trigger tab finished, owner tab has not started yet. Nothing is running,
  // and the rebuild used to fire exactly here (measured 1.7s wide). The owner
  // still owes its prompt, so it must keep blocking through the whole hole.
  const blockers = computePromptQueueInstallBlockers({
    persistedQueues: {
      'trigger-tab': { autoRun: false, items: [] },
      'owner-tab': armed({ runAfterTabId: 'trigger-tab' }),
    },
  });
  assert.deepEqual(blockers.map((b) => b.tabId), ['owner-tab']);
});

test('cards without Run after are staging, not a promise', () => {
  const blockers = computePromptQueueInstallBlockers({
    persistedQueues: { 'tab-1': { autoRun: false, items: [{ id: 'a', text: 'later' }] } },
  });
  assert.deepEqual(blockers, []);
});

test('armed but every card disabled — nothing left to send', () => {
  const blockers = computePromptQueueInstallBlockers({
    persistedQueues: {
      'tab-1': { autoRun: true, items: [{ id: 'a', enabled: false }, { id: 'b', enabled: false }] },
    },
  });
  assert.deepEqual(blockers, []);
});

test('a disabled card does not hide a runnable one behind it', () => {
  const blockers = computePromptQueueInstallBlockers({
    persistedQueues: {
      'tab-1': { autoRun: true, items: [{ id: 'a', enabled: false }, { id: 'b' }] },
    },
  });
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].pending, 1);
});

test('a card saved before `enabled` existed counts as runnable', () => {
  // Legacy rows have no flag. Reading absent as disabled would silently let the
  // rebuild through on exactly the queues that predate the field.
  const blockers = computePromptQueueInstallBlockers({
    persistedQueues: { 'tab-1': { autoRun: true, items: [{ id: 'legacy', text: 'x' }] } },
  });
  assert.equal(blockers.length, 1);
});

test('an armed Loop blocks even with an empty card list', () => {
  const blockers = computePromptQueueInstallBlockers({
    persistedQueues: { 'tab-1': { autoRun: false, items: [], loopPromptEnabled: true } },
    sharedLoopText: 'continue if unfinished',
  });
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].reason, 'loop');
});

test('Loop switched on with empty text sends nothing and does not block', () => {
  const blockers = computePromptQueueInstallBlockers({
    persistedQueues: { 'tab-1': { loopPromptEnabled: true, loopPromptText: '   ' } },
    sharedLoopText: '   ',
  });
  assert.deepEqual(blockers, []);
});

test('a per-tab Loop body wins over the shared one', () => {
  const blockers = computePromptQueueInstallBlockers({
    persistedQueues: { 'tab-1': { loopPromptEnabled: true, loopPromptText: 'own text' } },
    sharedLoopText: '',
  });
  assert.equal(blockers.length, 1);
});

test('a closed tab cannot wedge the rebuild forever', () => {
  // Leftover rows outlive their tabs. Without the liveness test one stale row
  // would make every future rebuild wait on a tab that no longer exists.
  const blockers = computePromptQueueInstallBlockers({
    persistedQueues: { 'gone-tab': armed(), 'live-tab': armed() },
    tabExists: (tabId) => tabId === 'live-tab',
  });
  assert.deepEqual(blockers.map((b) => b.tabId), ['live-tab']);
});

test('a tab already reported as running is not double-counted', () => {
  const blockers = computePromptQueueInstallBlockers({
    persistedQueues: { 'tab-1': armed() },
    seen: new Set(['tab-1']),
  });
  assert.deepEqual(blockers, []);
});

test('labels are attached so the log names the holding tab', () => {
  const blockers = computePromptQueueInstallBlockers({
    persistedQueues: { 'tab-1': armed() },
    labelFor: () => ({ project: 'uav', name: 'обфускация' }),
  });
  assert.equal(blockers[0].project, 'uav');
  assert.equal(blockers[0].name, 'обфускация');
});

test('missing or malformed persisted state never blocks', () => {
  // A rebuild must not become unrunnable because the row is absent or corrupt.
  for (const value of [null, undefined, 'not-json', 42, []]) {
    assert.deepEqual(computePromptQueueInstallBlockers({ persistedQueues: value }), []);
  }
  assert.deepEqual(computePromptQueueInstallBlockers({}), []);
});

test('queue and loop armed together report both', () => {
  assert.equal(
    describeQueuePromise(
      { autoRun: true, items: [{ id: 'a' }], loopPromptEnabled: true },
      'text',
    ).reason,
    'queue+loop',
  );
});

test('a persisted queue read failure blocks install instead of reporting false idle', () => {
  assert.deepEqual(promptQueueReadFailureBlocker(new Error('sqlite unavailable')), {
    tabId: '__prompt_queue_state__',
    kind: 'prompt-queue-state',
    status: 'unknown',
    reason: 'persisted-queue-read-failed',
    error: 'sqlite unavailable',
  });
});

test('a garbage entry describes no promise', () => {
  for (const value of [null, undefined, 'x', 7]) {
    assert.equal(describeQueuePromise(value, 'text'), null);
  }
});
