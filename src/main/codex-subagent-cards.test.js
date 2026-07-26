'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCodexSubagentTracker,
  extractCollabFinalAnswer,
  isCodexSubagentControlCall,
  isCodexSubagentSpawnCall,
} = require('./codex-subagent-cards');

test('v2 collaboration lifecycle: spawn → activity → FINAL_ANSWER completes the card', () => {
  const tracker = createCodexSubagentTracker();
  const card = tracker.registerSpawn({
    callId: 'call_nCX5RvsCuqfvOKjD4hqaXJxX',
    toolName: 'spawn_agent',
    namespace: 'collaboration',
    args: {
      agent_type: 'luna_e2e',
      fork_turns: 'none',
      message: 'gAAAAABqY7eV-encrypted',
      task_name: 'luna_config_check',
    },
  });
  assert.equal(card.tool, 'Task');
  assert.match(card.description, /luna_config_check \(luna_e2e\) · running/);
  assert.ok(!card.description.includes('gAAAA'), 'encrypted message never leaks into the label');

  tracker.onSubAgentActivity({
    type: 'sub_agent_activity',
    event_id: 'call_nCX5RvsCuqfvOKjD4hqaXJxX',
    agent_thread_id: '019f9585-1fe8-7743-b649-8eafb50835c2',
    agent_path: '/root/luna_config_check',
    kind: 'started',
  });
  assert.equal(card.agentSessionId, '019f9585-1fe8-7743-b649-8eafb50835c2');
  assert.equal(card.subagentStatus, 'running');

  const consumed = tracker.onAgentMessage({
    type: 'agent_message',
    author: '/root/luna_config_check',
    recipient: '/root',
    content: [{
      type: 'input_text',
      text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/luna_config_check\nPayload:\nAll checks passed.',
    }],
  }, (content) => Array.isArray(content) ? content.map((c) => c.text || '').join('') : String(content || ''));
  assert.equal(consumed, true);
  assert.equal(card.subagentStatus, 'completed');
  assert.equal(card.result, 'All checks passed.');
  assert.ok(!card.description.includes('running'), 'completed card drops the running suffix');
});

test('v2 late interacted activity cannot resurrect a completed card', () => {
  const tracker = createCodexSubagentTracker();
  const card = tracker.registerSpawn({
    callId: 'call_1',
    toolName: 'spawn_agent',
    namespace: 'collaboration',
    args: { task_name: 'quick_check' },
  });
  tracker.onAgentMessage({
    author: '/root/quick_check',
    content: 'Message Type: FINAL_ANSWER\nPayload:\ndone',
  }, (c) => String(c || ''));
  assert.equal(card.subagentStatus, 'completed');
  tracker.onSubAgentActivity({
    event_id: 'call_1',
    agent_path: '/root/quick_check',
    kind: 'interacted',
  });
  assert.equal(card.subagentStatus, 'completed', 'catch-up replay must not flip completed → running');
});

test('v1 multi_agent_v1 lifecycle: spawn output binds agent_id; wait_agent output completes', () => {
  const tracker = createCodexSubagentTracker();
  const card = tracker.registerSpawn({
    callId: 'call_v1',
    toolName: 'spawn_agent',
    namespace: 'multi_agent_v1',
    args: { agent_type: 'explorer', fork_context: false, message: 'Ты делаешь свежий read-only обзор архитектуры' },
  });
  tracker.attachSpawnOutput('call_v1', JSON.stringify({
    agent_id: '019f24ea-7296-75b0-953a-fff3163dbb8f',
    nickname: 'Pauli',
  }));
  assert.equal(card.agentSessionId, '019f24ea-7296-75b0-953a-fff3163dbb8f');
  assert.match(card.baseDescription, /Pauli/);

  const absorbed = tracker.absorbControlOutput(
    { toolName: 'wait_agent', namespace: 'multi_agent_v1', args: { targets: ['019f24ea-7296-75b0-953a-fff3163dbb8f'] } },
    JSON.stringify({
      status: { '019f24ea-7296-75b0-953a-fff3163dbb8f': { completed: 'Read-only review done. Findings: …' } },
      timed_out: false,
    }),
  );
  assert.equal(absorbed, true, 'wait output is absorbed into the card, no separate JSON row');
  assert.equal(card.subagentStatus, 'completed');
  assert.match(card.result, /Read-only review done/);
});

test('spawn/control classification requires the subagent namespace', () => {
  assert.equal(isCodexSubagentSpawnCall({ toolName: 'spawn_agent', namespace: 'collaboration' }), true);
  assert.equal(isCodexSubagentSpawnCall({ toolName: 'spawn_agent', namespace: '' }), false,
    'a user-defined MCP tool named spawn_agent is not a subagent');
  assert.equal(isCodexSubagentControlCall({ toolName: 'wait_agent', namespace: 'multi_agent_v1' }), true);
  assert.equal(isCodexSubagentControlCall({ toolName: 'wait', namespace: '' }), false,
    'orchestrated exec wait cells keep their own path');
});

test('FINAL_ANSWER extraction tolerates missing payload separator', () => {
  assert.equal(extractCollabFinalAnswer('Message Type: MESSAGE\nPayload:\ngAAAA-encrypted'), null);
  assert.equal(
    extractCollabFinalAnswer('Message Type: FINAL_ANSWER\nTask name: /root\nPayload:\nline one\nline two'),
    'line one\nline two',
  );
});

test('subagent_notification completes a fire-and-forget card (E2E zombie 2026-07-25)', () => {
  const tracker = createCodexSubagentTracker();
  const card = tracker.registerSpawn({
    callId: 'call_notify1',
    toolName: 'spawn_agent',
    namespace: 'collaboration',
    args: { task_name: 'sleeper', message: 'gAAAA-enc' },
  });
  // Child thread binds through activity, as in the real rollout.
  tracker.onSubAgentActivity({
    event_id: 'call_notify1',
    agent_path: '/root/sleeper',
    agent_thread_id: '019f9af1-aaaa-7000-8000-000000000001',
    kind: 'started',
  });
  assert.equal(card.subagentStatus, 'running');

  // Real shape from the E2E rollout: user message wrapping a JSON body.
  const handled = tracker.onSubagentNotification(
    'note <subagent_notification>{"agent_path":"/root/sleeper","status":{"completed":"готово"}}</subagent_notification>',
  );
  assert.equal(handled, true);
  assert.equal(card.subagentStatus, 'completed');
  assert.equal(card.result, 'готово');
});

test('subagent_notification with interrupted status marks the card amber', () => {
  const tracker = createCodexSubagentTracker();
  const card = tracker.registerSpawn({
    callId: 'call_notify2',
    toolName: 'spawn_agent',
    namespace: 'collaboration',
    args: { task_name: 'doomed' },
  });
  const handled = tracker.onSubagentNotification(
    '<subagent_notification>{"agent_path":"/root/doomed","status":{"interrupted":true}}</subagent_notification>',
  );
  assert.equal(handled, true);
  assert.equal(card.subagentStatus, 'interrupted');
});

test('subagent_notification non-JSON body degrades to mention-scan, never a zombie', () => {
  const tracker = createCodexSubagentTracker();
  const card = tracker.registerSpawn({
    callId: 'call_notify3',
    toolName: 'spawn_agent',
    namespace: 'collaboration',
    args: { task_name: 'freeform' },
  });
  const handled = tracker.onSubagentNotification(
    '<subagent_notification>Agent /root/freeform finished, "completed": "done here"</subagent_notification>',
  );
  assert.equal(handled, true);
  assert.equal(card.subagentStatus, 'completed');
  assert.equal(card.result, 'done here');
});

test('subagent_notification for an unknown agent is a no-op', () => {
  const tracker = createCodexSubagentTracker();
  tracker.registerSpawn({
    callId: 'call_notify4',
    toolName: 'spawn_agent',
    namespace: 'collaboration',
    args: { task_name: 'known' },
  });
  const handled = tracker.onSubagentNotification(
    '<subagent_notification>{"agent_path":"/root/other","status":{"completed":"x"}}</subagent_notification>',
  );
  assert.equal(handled, false);
});
