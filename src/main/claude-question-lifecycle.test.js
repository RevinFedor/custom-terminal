const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clearClaudeQuestionStateOnProcessExit,
} = require('./claude-question-lifecycle');

test('process exit atomically clears awaiting and pending question state', () => {
  const awaitingByTab = new Map([
    ['tab-a', true],
    ['tab-b', true],
  ]);
  const pendingQuestionByTab = new Map([
    ['tab-a', { questions: [{ question: 'A?' }] }],
    ['tab-b', { questions: [{ question: 'B?' }] }],
  ]);

  assert.deepEqual(clearClaudeQuestionStateOnProcessExit({
    tabId: 'tab-a',
    awaitingByTab,
    pendingQuestionByTab,
  }), {
    changed: true,
    wasAwaiting: true,
    hadAwaitingState: true,
    hadPendingQuestion: true,
  });
  assert.equal(awaitingByTab.has('tab-a'), false);
  assert.equal(pendingQuestionByTab.has('tab-a'), false);
  assert.equal(awaitingByTab.get('tab-b'), true);
  assert.equal(pendingQuestionByTab.has('tab-b'), true);
});

test('process exit clears a stale pending question even if awaiting was already false', () => {
  const awaitingByTab = new Map([['tab-a', false]]);
  const pendingQuestionByTab = new Map([['tab-a', { questions: [] }]]);

  assert.deepEqual(clearClaudeQuestionStateOnProcessExit({
    tabId: 'tab-a',
    awaitingByTab,
    pendingQuestionByTab,
  }), {
    changed: true,
    wasAwaiting: false,
    hadAwaitingState: true,
    hadPendingQuestion: true,
  });
  assert.equal(awaitingByTab.has('tab-a'), false);
  assert.equal(pendingQuestionByTab.has('tab-a'), false);
});

test('process exit cleanup is idempotent', () => {
  const awaitingByTab = new Map();
  const pendingQuestionByTab = new Map();
  const input = { tabId: 'tab-a', awaitingByTab, pendingQuestionByTab };

  assert.deepEqual(clearClaudeQuestionStateOnProcessExit(input), {
    changed: false,
    wasAwaiting: false,
    hadAwaitingState: false,
    hadPendingQuestion: false,
  });
  assert.deepEqual(clearClaudeQuestionStateOnProcessExit(input), {
    changed: false,
    wasAwaiting: false,
    hadAwaitingState: false,
    hadPendingQuestion: false,
  });
});
