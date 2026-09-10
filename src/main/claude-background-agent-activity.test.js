'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createClaudeBackgroundAgentActivityTracker,
} = require('./claude-background-agent-activity');

function spawn(toolUseId = 'toolu_agent') {
  return {
    type: 'assistant',
    timestamp: '2026-08-18T18:51:36.000Z',
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

function toolCall(name, input, id = 'toolu_background', timestamp = '2026-09-10T11:21:49.811Z') {
  return {
    type: 'assistant',
    timestamp,
    sessionId: 'session-a',
    uuid: 'assistant-' + id,
    message: { content: [{ type: 'tool_use', id, name, input }] },
  };
}

function toolResult(id, content, { isError = false, toolUseResult = null } = {}) {
  return {
    type: 'user',
    sessionId: 'session-a',
    ...(toolUseResult ? { toolUseResult } : {}),
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
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
  assert.equal(
    tracker.snapshot('tab-a').agents[0].startedAt,
    Date.parse('2026-08-18T18:51:36.000Z'),
  );
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

test('Monitor appears only after an exact successful task acceptance', () => {
  const tracker = createClaudeBackgroundAgentActivityTracker();
  tracker.bind({ tabId: 'tab-a', sessionId: 'session-a', generation: 'g1' });
  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a',
    record: toolCall('Monitor', {
      command: 'tail -f app.log',
      description: 'release progress',
      timeout_ms: 60000,
    }, 'toolu_monitor'),
  });
  assert.equal(tracker.snapshot('tab-a').taskCount, 0, 'tool_use is only an attempt');

  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a',
    record: toolResult(
      'toolu_monitor',
      'Monitor started (task monitor-1, timeout 60000ms). You will be notified on each event.',
      { toolUseResult: { taskId: 'monitor-1', timeoutMs: 60000, persistent: false } },
    ),
  });
  const snapshot = tracker.snapshot('tab-a');
  assert.equal(snapshot.count, 0, 'a monitor never drives the agent/tab loader');
  assert.equal(snapshot.taskCount, 1);
  assert.deepEqual(snapshot.tasks[0], {
    toolUseId: 'toolu_monitor',
    taskId: 'monitor-1',
    kind: 'monitor',
    label: 'release progress',
    command: 'tail -f app.log',
    acceptance: 'Monitor started (task monitor-1, timeout 60000ms). You will be notified on each event.',
    entryUuid: 'assistant-toolu_monitor',
    startedAt: Date.parse('2026-09-10T11:21:49.811Z'),
  });
});

test('failed Monitor validation never creates background work', () => {
  const tracker = createClaudeBackgroundAgentActivityTracker();
  tracker.bind({ tabId: 'tab-a', sessionId: 'session-a' });
  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a',
    record: toolCall('Monitor', { command: 'tail -f app.log' }, 'toolu_monitor'),
  });
  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a',
    record: toolResult('toolu_monitor', '<tool_use_error>bad timeout</tool_use_error>', { isError: true }),
  });
  assert.equal(tracker.snapshot('tab-a').taskCount, 0);
});

test('background Bash is tracked but foreground Bash is not duplicated', () => {
  const tracker = createClaudeBackgroundAgentActivityTracker();
  tracker.bind({ tabId: 'tab-a', sessionId: 'session-a' });
  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a',
    record: toolCall('Bash', { command: 'sleep 60' }, 'toolu_foreground'),
  });
  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a',
    record: toolResult('toolu_foreground', 'done'),
  });
  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a',
    record: toolCall('Bash', {
      command: 'sleep 60', description: 'minute bash', run_in_background: true,
    }, 'toolu_background'),
  });
  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a',
    record: toolResult(
      'toolu_background',
      'Command did not complete and was moved to the background (ID: bash-1).',
    ),
  });
  const snapshot = tracker.snapshot('tab-a');
  assert.equal(snapshot.taskCount, 1);
  assert.equal(snapshot.tasks[0].kind, 'bash');
  assert.equal(snapshot.tasks[0].taskId, 'bash-1');
});

test('terminal notification closes the exact Monitor and publishes a tombstone', () => {
  const changes = [];
  const tracker = createClaudeBackgroundAgentActivityTracker({ onChange: (value) => changes.push(value) });
  tracker.bind({ tabId: 'tab-a', sessionId: 'session-a' });
  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a',
    record: toolCall('Monitor', { command: 'tail -f app.log' }, 'toolu_monitor'),
  });
  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a',
    record: toolResult('toolu_monitor', 'Monitor started (task monitor-1, timeout 60000ms).'),
  });
  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a', record: { type: 'attachment', sessionId: 'session-a' },
    notifications: [{
      toolUseId: 'toolu_monitor', taskId: 'monitor-1', status: 'completed',
    }],
  });
  const snapshot = tracker.snapshot('tab-a');
  assert.equal(snapshot.taskCount, 0);
  assert.deepEqual(snapshot.terminalBackgroundToolUseIds, ['toolu_monitor']);
  assert.equal(changes.at(-1).taskCount, 0);
});

test('successful TaskStop closes only the background task with its task id', () => {
  const tracker = createClaudeBackgroundAgentActivityTracker();
  tracker.bind({ tabId: 'tab-a', sessionId: 'session-a' });
  for (const [useId, taskId] of [['toolu_one', 'monitor-1'], ['toolu_two', 'monitor-2']]) {
    tracker.observe({
      tabId: 'tab-a', sessionId: 'session-a',
      record: toolCall('Monitor', { command: 'tail -f app.log', description: taskId }, useId),
    });
    tracker.observe({
      tabId: 'tab-a', sessionId: 'session-a',
      record: toolResult(useId, `Monitor started (task ${taskId}, timeout 60000ms).`),
    });
  }
  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a',
    record: toolCall('TaskStop', { task_id: 'monitor-1' }, 'toolu_stop'),
  });
  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a',
    record: toolResult('toolu_stop', '{"message":"Successfully stopped task"}'),
  });
  const snapshot = tracker.snapshot('tab-a');
  assert.deepEqual(snapshot.tasks.map((task) => task.taskId), ['monitor-2']);
  assert.deepEqual(snapshot.terminalBackgroundToolUseIds, ['toolu_one']);
});

test('a terminal notification observed after bind still hides a stale durable task', () => {
  const tracker = createClaudeBackgroundAgentActivityTracker();
  tracker.bind({ tabId: 'tab-a', sessionId: 'session-a' });
  tracker.observe({
    tabId: 'tab-a', sessionId: 'session-a', record: { type: 'attachment', sessionId: 'session-a' },
    notifications: [{
      toolUseId: 'older-monitor', taskId: 'm-old', status: 'killed', backgroundKind: 'monitor',
    }],
  });
  assert.deepEqual(tracker.snapshot('tab-a').terminalBackgroundToolUseIds, ['older-monitor']);
});
