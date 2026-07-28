const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TaskCompletionIntentRegistry,
  findTaskCompletionBlockers,
} = require('./task-completion-intent');

function registry() {
  let now = 100;
  let id = 0;
  return new TaskCompletionIntentRegistry({
    now: () => ++now,
    createId: () => `intent-${++id}`,
  });
}

test('completion belongs only to the successful current turn', () => {
  const intents = registry();
  intents.beginTurn({ tabId: 'tab-a', provider: 'claude', sessionId: 'session-a' });
  assert.deepEqual(intents.requestCompletion({ tabId: 'tab-a', sourceTabId: 'tab-a' }), {
    ok: true,
    idempotent: false,
    turn: {
      tabId: 'tab-a', provider: 'claude', sessionId: 'session-a', turnId: null,
      generation: 1, active: true, startedAt: 101,
      intentId: 'intent-1', intentRequestedAt: 102,
    },
  });
  const finished = intents.finishTurn({
    tabId: 'tab-a', provider: 'claude', sessionId: 'session-a', success: true,
  });
  assert.equal(finished.matched, true);
  assert.equal(finished.explicitTaskComplete, true);
  assert.equal(finished.taskCompletionIntentId, 'intent-1');
  assert.equal(intents.getTurn('tab-a'), null);
});

test('duplicate request is idempotent and an error never becomes success', () => {
  const intents = registry();
  intents.beginTurn({ tabId: 'tab-a', provider: 'claude' });
  const first = intents.requestCompletion({ tabId: 'tab-a' });
  const duplicate = intents.requestCompletion({ tabId: 'tab-a' });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.turn.intentId, first.turn.intentId);
  assert.equal(intents.finishTurn({ tabId: 'tab-a', success: false }).explicitTaskComplete, false);
});

test('a newer turn invalidates the old intent', () => {
  const intents = registry();
  intents.beginTurn({ tabId: 'tab-a', provider: 'claude', sessionId: 'session-a' });
  intents.requestCompletion({ tabId: 'tab-a' });
  const second = intents.beginTurn({ tabId: 'tab-a', provider: 'claude', sessionId: 'session-a' });
  assert.equal(second.generation, 2);
  assert.equal(second.intentId, null);
  assert.equal(intents.finishTurn({ tabId: 'tab-a', success: true }).explicitTaskComplete, false);
});

test('stale Codex completion cannot consume a newer exact turn', () => {
  const intents = registry();
  intents.beginTurn({ tabId: 'tab-a', provider: 'codex', sessionId: 'session-a', turnId: 'turn-1' });
  intents.requestCompletion({ tabId: 'tab-a' });
  intents.beginTurn({ tabId: 'tab-a', provider: 'codex', sessionId: 'session-a', turnId: 'turn-2' });
  const stale = intents.finishTurn({
    tabId: 'tab-a', provider: 'codex', sessionId: 'session-a', turnId: 'turn-1', success: true,
  });
  assert.equal(stale.matched, false);
  assert.equal(intents.getTurn('tab-a').turnId, 'turn-2');
});

test('request rejects idle and cross-tab registration', () => {
  const intents = registry();
  assert.equal(intents.requestCompletion({ tabId: 'tab-a' }).code, 'no_active_turn');
  intents.beginTurn({ tabId: 'tab-a', provider: 'claude' });
  assert.equal(
    intents.requestCompletion({ tabId: 'tab-a', sourceTabId: 'tab-b' }).code,
    'source_tab_mismatch',
  );
});

test('active outgoing orchestrations block completion independently of target runs', () => {
  const blockers = findTaskCompletionBlockers([
    { runId: 'parent', sourceTabId: 'root', targetTabId: 'worker', status: 'running' },
    { runId: 'child', sourceTabId: 'worker', targetTabId: 'tester', status: 'running' },
    { runId: 'followup', sourceTabId: 'worker', targetTabId: 'tester-2', status: 'completed', notificationStatus: 'waiting-for-input' },
  ], 'worker');
  assert.deepEqual(blockers.map((item) => item.runId), ['child', 'followup']);
});
