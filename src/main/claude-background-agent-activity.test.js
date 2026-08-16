'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createClaudeBackgroundAgentActivityTracker,
} = require('./claude-background-agent-activity');

function spawn(toolUseId = 'toolu_agent') {
  return {
    type: 'assistant',
    sessionId: 'session-a',
    message: {
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: 'Agent',
        input: { prompt: 'inspect', run_in_background: true },
      }],
    },
  };
}

function accept(toolUseId = 'toolu_agent', agentId = 'agent-a') {
  return {
    type: 'user',
    sessionId: 'session-a',
    toolUseResult: { isAsync: true, agentId },
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'launched' }],
    },
  };
}

test('an async agent is counted only after structural acceptance', () => {
  const changes = [];
  const tracker = createClaudeBackgroundAgentActivityTracker({
    onChange: (value) => changes.push(value),
  });
  tracker.bind({ tabId: 'tab-a', sessionId: 'session-a', generation: 'g1' });
  tracker.observe({ tabId: 'tab-a', sessionId: 'session-a', record: spawn() });
  assert.equal(tracker.snapshot('tab-a').count, 0);
  tracker.observe({ tabId: 'tab-a', sessionId: 'session-a', record: accept() });
  assert.equal(tracker.snapshot('tab-a').count, 1);
  assert.equal(changes.at(-1).count, 1);
});

test('an exact notification ends the agent even when carried by an attachment', () => {
  const tracker = createClaudeBackgroundAgentActivityTracker();
  tracker.bind({ tabId: 'tab-a', sessionId: 'session-a' });
  tracker.observe({ tabId: 'tab-a', sessionId: 'session-a', record: spawn() });
  tracker.observe({ tabId: 'tab-a', sessionId: 'session-a', record: accept() });
  tracker.observe({
    tabId: 'tab-a',
    sessionId: 'session-a',
    record: { type: 'attachment', sessionId: 'session-a' },
    notifications: [{ toolUseId: 'toolu_agent', agentId: 'agent-a', status: 'completed' }],
  });
  assert.equal(tracker.snapshot('tab-a').count, 0);
});

test('SendMessage reopens the exact completed agent until its next notification', () => {
  const tracker = createClaudeBackgroundAgentActivityTracker();
  tracker.bind({ tabId: 'tab-a', sessionId: 'session-a' });
  tracker.observe({ tabId: 'tab-a', sessionId: 'session-a', record: spawn() });
  tracker.observe({ tabId: 'tab-a', sessionId: 'session-a', record: accept() });
  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a', record: {},
    notifications: [{ toolUseId: 'toolu_agent', agentId: 'agent-a', status: 'completed' }],
  });
  tracker.observe({
    tabId: 'tab-a',
    sessionId: 'session-a',
    record: {
      type: 'assistant',
      sessionId: 'session-a',
      message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'agent-a' } }] },
    },
  });
  assert.equal(tracker.snapshot('tab-a').count, 1);
});

test('foreign session records cannot mutate a bound tab', () => {
  const tracker = createClaudeBackgroundAgentActivityTracker();
  tracker.bind({ tabId: 'tab-a', sessionId: 'session-a' });
  tracker.observe({ tabId: 'tab-a', sessionId: 'session-b', record: spawn() });
  tracker.observe({ tabId: 'tab-a', sessionId: 'session-b', record: accept() });
  assert.equal(tracker.snapshot('tab-a').count, 0);
});

test('the same transcript byte record is idempotent across catch-up and live observers', () => {
  const tracker = createClaudeBackgroundAgentActivityTracker();
  tracker.bind({ tabId: 'tab-a', sessionId: 'session-a' });
  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a', record: spawn(), recordByteOffset: 10,
  });
  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a', record: accept(), recordByteOffset: 20,
  });
  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a', record: accept(), recordByteOffset: 20,
  });
  assert.equal(tracker.snapshot('tab-a').count, 1);
});

test('sidecar stop and process boundary are authoritative terminal proofs', () => {
  const changes = [];
  const tracker = createClaudeBackgroundAgentActivityTracker({ onChange: (value) => changes.push(value) });
  tracker.bind({ tabId: 'tab-a', sessionId: 'session-a' });
  tracker.observe({ tabId: 'tab-a', sessionId: 'session-a', record: spawn() });
  tracker.observe({ tabId: 'tab-a', sessionId: 'session-a', record: accept() });
  assert.equal(tracker.markStopped({
    tabId: 'tab-a', sessionId: 'session-a', toolUseId: 'toolu_agent',
  }).applied, true);
  assert.equal(tracker.snapshot('tab-a').count, 0);

  tracker.observe({ tabId: 'tab-a', sessionId: 'session-a', record: accept() });
  assert.equal(tracker.snapshot('tab-a').count, 0, 'replayed acceptance cannot resurrect stopped work');
  tracker.clear('tab-a', 'process-ended');
  assert.equal(tracker.snapshot('tab-a').count, 0);
  assert.equal(changes.at(-1).reason, 'process-ended');
});
