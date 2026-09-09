const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TaskCompletionIntentRegistry,
  findTaskCompletionBlockers,
  loopTaskCompletionEligibility,
} = require('./task-completion-intent');
const { LOOP_TASK_COMPLETION_PROTOCOL } = require('../shared/task-completion-protocol.cjs');

const loopPrompt = 'continue\n' + LOOP_TASK_COMPLETION_PROTOCOL;

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
  intents.beginTurn({
    tabId: 'tab-a', provider: 'claude', sessionId: 'session-a',
    completionEligible: true, completionSource: 'prompt-loop',
  });
  assert.deepEqual(intents.requestCompletion({ tabId: 'tab-a', sourceTabId: 'tab-a' }), {
    ok: true,
    idempotent: false,
    turn: {
      tabId: 'tab-a', provider: 'claude', sessionId: 'session-a', turnId: null,
      generation: 1, active: true, startedAt: 101,
      completionEligible: true, completionSource: 'prompt-loop',
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
  intents.beginTurn({ tabId: 'tab-a', provider: 'claude', completionEligible: true });
  const first = intents.requestCompletion({ tabId: 'tab-a' });
  const duplicate = intents.requestCompletion({ tabId: 'tab-a' });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.turn.intentId, first.turn.intentId);
  assert.equal(intents.finishTurn({ tabId: 'tab-a', success: false }).explicitTaskComplete, false);
});

test('a newer turn invalidates the old intent', () => {
  const intents = registry();
  intents.beginTurn({
    tabId: 'tab-a', provider: 'claude', sessionId: 'session-a', completionEligible: true,
  });
  intents.requestCompletion({ tabId: 'tab-a' });
  const second = intents.beginTurn({ tabId: 'tab-a', provider: 'claude', sessionId: 'session-a' });
  assert.equal(second.generation, 2);
  assert.equal(second.intentId, null);
  assert.equal(intents.finishTurn({ tabId: 'tab-a', success: true }).explicitTaskComplete, false);
});

test('stale Codex completion cannot consume a newer exact turn', () => {
  const intents = registry();
  intents.beginTurn({
    tabId: 'tab-a', provider: 'codex', sessionId: 'session-a', turnId: 'turn-1',
    completionEligible: true,
  });
  intents.requestCompletion({ tabId: 'tab-a' });
  intents.beginTurn({ tabId: 'tab-a', provider: 'codex', sessionId: 'session-a', turnId: 'turn-2' });
  const stale = intents.finishTurn({
    tabId: 'tab-a', provider: 'codex', sessionId: 'session-a', turnId: 'turn-1', success: true,
  });
  assert.equal(stale.matched, false);
  assert.equal(intents.getTurn('tab-a').turnId, 'turn-2');
});

test('F1: a stale Claude process completion cannot consume a newer process turn', () => {
  const intents = registry();
  intents.beginTurn({
    tabId: 'tab-a', provider: 'claude', sessionId: 'session-a', processId: 'pid-old',
    completionEligible: true,
  });
  intents.requestCompletion({ tabId: 'tab-a' });
  intents.beginTurn({
    tabId: 'tab-a', provider: 'claude', sessionId: 'session-a', processId: 'pid-new',
  });

  const stale = intents.finishTurn({
    tabId: 'tab-a',
    provider: 'claude',
    sessionId: 'session-a',
    processId: 'pid-old',
    success: true,
  });

  assert.equal(stale.matched, false);
  assert.equal(intents.getTurn('tab-a').processId, 'pid-new');
  assert.equal(intents.getTurn('tab-a').intentId, null);
});

test('request rejects idle and cross-tab registration', () => {
  const intents = registry();
  assert.equal(intents.requestCompletion({ tabId: 'tab-a' }).code, 'no_active_turn');
  intents.beginTurn({ tabId: 'tab-a', provider: 'claude' });
  assert.equal(
    intents.requestCompletion({ tabId: 'tab-a', sourceTabId: 'tab-b' }).code,
    'source_tab_mismatch',
  );
  assert.equal(
    intents.requestCompletion({ tabId: 'tab-a', sourceTabId: 'tab-a' }).code,
    'completion_protocol_not_active',
  );
});

test('only an audited prompt-loop carrier makes a turn eligible', () => {
  assert.equal(loopTaskCompletionEligibility({ source: 'prompt-loop', prompt: loopPrompt }).eligible, true);
  assert.equal(loopTaskCompletionEligibility({ source: 'codex-prompt-loop', prompt: loopPrompt }).eligible, true);
  assert.equal(loopTaskCompletionEligibility({ source: 'history-panel', prompt: loopPrompt }).eligible, false);
  assert.equal(loopTaskCompletionEligibility({ source: 'prompt-loop', prompt: 'ordinary request' }).eligible, false);
});

test('late exact Codex prompt proof can authorize only its current turn', () => {
  const intents = registry();
  intents.beginTurn({
    tabId: 'tab-a', provider: 'codex', sessionId: 'session-a', turnId: 'turn-1',
  });
  assert.equal(intents.requestCompletion({ tabId: 'tab-a' }).code, 'completion_protocol_not_active');
  assert.equal(intents.authorizeCompletion({
    tabId: 'tab-a', provider: 'codex', sessionId: 'session-a', turnId: 'turn-old',
  }).code, 'turn_identity_mismatch');
  assert.equal(intents.authorizeCompletion({
    tabId: 'tab-a', provider: 'codex', sessionId: 'session-a', turnId: 'turn-1',
  }).ok, true);
  assert.equal(intents.requestCompletion({ tabId: 'tab-a' }).ok, true);
});

test('a repeated exact Codex busy edge may upgrade but never downgrade Loop eligibility', () => {
  const intents = registry();
  intents.beginTurn({
    tabId: 'tab-a', provider: 'codex', sessionId: 'session-a', turnId: 'turn-1',
  });
  const upgraded = intents.beginTurn({
    tabId: 'tab-a', provider: 'codex', sessionId: 'session-a', turnId: 'turn-1',
    reuseExactTurn: true, completionEligible: true, completionSource: 'prompt-loop',
  });
  assert.equal(upgraded.generation, 1);
  assert.equal(upgraded.completionEligible, true);
  const repeated = intents.beginTurn({
    tabId: 'tab-a', provider: 'codex', sessionId: 'session-a', turnId: 'turn-1',
    reuseExactTurn: true,
  });
  assert.equal(repeated.completionEligible, true);
  assert.equal(intents.requestCompletion({ tabId: 'tab-a' }).ok, true);
});

test('an audited idle-only Loop send may authorize by active Codex session when user_message omits turn id', () => {
  const intents = registry();
  intents.beginTurn({
    tabId: 'tab-a', provider: 'codex', sessionId: 'session-a', turnId: 'turn-1',
  });
  assert.equal(intents.authorizeCompletion({
    tabId: 'tab-a', provider: 'codex', sessionId: 'session-a', source: 'prompt-loop',
  }).ok, true);
  assert.equal(intents.requestCompletion({ tabId: 'tab-a' }).ok, true);
});

test('active outgoing orchestrations block completion independently of target runs', () => {
  const blockers = findTaskCompletionBlockers([
    { runId: 'parent', sourceTabId: 'root', targetTabId: 'worker', status: 'running' },
    { runId: 'child', sourceTabId: 'worker', targetTabId: 'tester', status: 'running' },
    { runId: 'followup', sourceTabId: 'worker', targetTabId: 'tester-2', status: 'completed', notificationStatus: 'waiting-for-input' },
  ], 'worker');
  assert.deepEqual(blockers.map((item) => item.runId), ['child', 'followup']);
});
