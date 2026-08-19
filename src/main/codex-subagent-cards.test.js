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

// ── rejected spawn (production 2026-07-26: two permanent phantom chips) ────

const spawnCall = (callId, extra = {}) => ({
  callId,
  toolName: 'spawn_agent',
  namespace: 'multi_agent_v1',
  args: { agent_type: 'default', fork_context: true, message: 'E2E-прогон', ...extra },
});

test('rejected spawn is terminal, never a live card', () => {
  // Real output of a spawn Codex refused (fork_context + agent_type together).
  // Nothing will ever complete it: no wait_agent status, no close_agent, no
  // notification — so a card left `running` here spins forever.
  const tracker = createCodexSubagentTracker();
  const card = tracker.registerSpawn(spawnCall('call_rejected'));
  assert.equal(card.subagentStatus, 'running', 'live until the outcome is known');

  tracker.attachSpawnOutput(
    'call_rejected',
    'Full-history forked agents inherit the parent agent type; omit agent_type, or spawn without a full-history fork.',
  );
  assert.equal(card.subagentStatus, 'interrupted');
  assert.match(card.description, /не запущен/);
  assert.match(card.result, /Full-history forked agents inherit/, 'the reason is visible to the user');
});

test('other real rejection texts are terminal too (detector is structural)', () => {
  for (const reason of [
    'collab spawn failed: agent thread limit reached',
    'collab spawn failed: thread-store internal error: No space left on device',
  ]) {
    const tracker = createCodexSubagentTracker();
    const card = tracker.registerSpawn(spawnCall('call_x'));
    tracker.attachSpawnOutput('call_x', reason);
    assert.equal(card.subagentStatus, 'interrupted', reason);
    assert.equal(card.result, reason);
  }
});

test('a rejected spawn cannot be revived by later events', () => {
  // Stale activity or a resume aimed at a never-born agent must not relight it.
  const tracker = createCodexSubagentTracker();
  const card = tracker.registerSpawn(spawnCall('call_dead', { task_name: 'ghost' }));
  tracker.attachSpawnOutput('call_dead', 'collab spawn failed: agent thread limit reached');

  tracker.onSubAgentActivity({ event_id: 'call_dead', agent_path: '/root/ghost', kind: 'started' });
  assert.equal(card.subagentStatus, 'interrupted', 'activity cannot resurrect it');

  tracker.absorbControlOutput(
    { toolName: 'resume_agent', namespace: 'multi_agent_v1', args: { id: '/root/ghost' } },
    JSON.stringify({ status: 'pending_init' }),
  );
  assert.equal(card.subagentStatus, 'interrupted', 'resume cannot resurrect it');
});

test('v2 spawn output identifies by task_name, not agent_id', () => {
  // 190 real spawn outputs: v1 returns {agent_id, nickname}, v2 returns
  // {task_name}. Treating "no agent_id" as rejection would kill every v2 card.
  const tracker = createCodexSubagentTracker();
  const card = tracker.registerSpawn({
    callId: 'call_v2',
    toolName: 'spawn_agent',
    namespace: 'collaboration',
    args: { task_name: 'docs_audit', agent_type: 'luna_e2e', message: 'gAAAAencrypted' },
  });
  tracker.attachSpawnOutput('call_v2', JSON.stringify({ task_name: '/root/docs_audit' }));
  assert.equal(card.subagentStatus, 'running', 'v2 success stays live');
  assert.ok(!card.spawnRejected);

  // The registered agent path routes later messages to this card.
  const consumed = tracker.onAgentMessage(
    { author: '/root/docs_audit', content: 'Message Type: FINAL_ANSWER\nPayload:\nOK' },
    (c) => String(c || ''),
  );
  assert.equal(consumed, true);
  assert.equal(card.subagentStatus, 'completed');
});

// ── resume: a finished agent can be put back to work ───────────────────────

test('resume_agent puts a completed card back to running', () => {
  // Real production sequence (04:31:54 → 04:38:11): resume_agent {id} →
  // {"status":"pending_init"} → send_input → wait_agent completes it again.
  // Without handling resume the chip stays dark for the whole resumed run.
  const tracker = createCodexSubagentTracker();
  const agentId = '019f9cab-3ce1-72a2-95f0-066b3c8a1018';
  const card = tracker.registerSpawn(spawnCall('call_r'));
  tracker.attachSpawnOutput('call_r', JSON.stringify({ agent_id: agentId, nickname: 'Helmholtz' }));
  tracker.absorbControlOutput(
    { toolName: 'wait_agent', namespace: 'multi_agent_v1', args: {} },
    JSON.stringify({ status: { [agentId]: { completed: 'Первый прогон готов' } } }),
  );
  assert.equal(card.subagentStatus, 'completed');

  const absorbed = tracker.absorbControlOutput(
    { toolName: 'resume_agent', namespace: 'multi_agent_v1', args: { id: agentId } },
    JSON.stringify({ status: 'pending_init' }),
  );
  assert.equal(absorbed, true);
  assert.equal(card.subagentStatus, 'running', 'resumed agent is live again');
  assert.match(card.description, /running/);

  // …and the next terminal event closes it again.
  tracker.absorbControlOutput(
    { toolName: 'wait_agent', namespace: 'multi_agent_v1', args: {} },
    JSON.stringify({ status: { [agentId]: { completed: 'Второй прогон готов' } } }),
  );
  assert.equal(card.subagentStatus, 'completed');
  assert.equal(card.result, 'Второй прогон готов');
});

// ── close_agent is terminal in both output shapes ──────────────────────────

test('close_agent with a plain previous_status still closes the card', () => {
  // Real corpus: 28 closes return {"previous_status":{"completed":"…"}}, but
  // 4 return {"previous_status":"running"} — the agent was force-closed while
  // still working. Reading `.completed` off that string gives undefined, and
  // the card used to stay `running` forever: nothing else can ever arrive for
  // a closed agent. Caught on two explorer agents whose wait_agent timed out.
  const tracker = createCodexSubagentTracker();
  const agentId = '019ecc79-dc2d-7f71-8143-f447e7c099d6';
  const card = tracker.registerSpawn({
    callId: 'call_exp',
    toolName: 'spawn_agent',
    namespace: 'multi_agent_v1',
    args: { agent_type: 'explorer', message: 'Изучи репозиторий' },
  });
  tracker.attachSpawnOutput('call_exp', JSON.stringify({ agent_id: agentId, nickname: 'Pauli' }));
  assert.equal(card.subagentStatus, 'running');

  const absorbed = tracker.absorbControlOutput(
    { toolName: 'close_agent', namespace: 'multi_agent_v1', args: { target: agentId } },
    JSON.stringify({ previous_status: 'running' }),
  );
  assert.equal(absorbed, true);
  assert.equal(card.subagentStatus, 'interrupted', 'closed mid-flight is terminal, not live');
  assert.match(card.description, /закрыт/);
  assert.ok(card.result, 'the user sees why the card ended');
});

test('close_agent keeps a real result when the agent had finished', () => {
  const tracker = createCodexSubagentTracker();
  const agentId = '019ecc7a-edc5-7991-a55f-d761fd02fc66';
  const card = tracker.registerSpawn({
    callId: 'call_done',
    toolName: 'spawn_agent',
    namespace: 'multi_agent_v1',
    args: { agent_type: 'explorer', message: 'Изучи репозиторий' },
  });
  tracker.attachSpawnOutput('call_done', JSON.stringify({ agent_id: agentId, nickname: 'Ampere' }));
  tracker.absorbControlOutput(
    { toolName: 'close_agent', namespace: 'multi_agent_v1', args: { target: agentId } },
    JSON.stringify({ previous_status: { completed: 'Проверил только terminal path.' } }),
  );
  assert.equal(card.subagentStatus, 'completed');
  assert.equal(card.result, 'Проверил только terminal path.');
  assert.ok(!card.description.includes('закрыт'));
});

test('closing an already completed agent does not downgrade it', () => {
  const tracker = createCodexSubagentTracker();
  const agentId = 'agent-final';
  const card = tracker.registerSpawn({
    callId: 'call_seq',
    toolName: 'spawn_agent',
    namespace: 'multi_agent_v1',
    args: { agent_type: 'explorer', message: 'x' },
  });
  tracker.attachSpawnOutput('call_seq', JSON.stringify({ agent_id: agentId }));
  tracker.absorbControlOutput(
    { toolName: 'wait_agent', namespace: 'multi_agent_v1', args: {} },
    JSON.stringify({ status: { [agentId]: { completed: 'Готово' } } }),
  );
  // Cleanup close arrives after the real completion — must not overwrite it.
  tracker.absorbControlOutput(
    { toolName: 'close_agent', namespace: 'multi_agent_v1', args: { target: agentId } },
    JSON.stringify({ previous_status: 'running' }),
  );
  assert.equal(card.subagentStatus, 'completed');
  assert.equal(card.result, 'Готово');
});

test('resume for an unknown agent is a no-op', () => {
  const tracker = createCodexSubagentTracker();
  const absorbed = tracker.absorbControlOutput(
    { toolName: 'resume_agent', namespace: 'multi_agent_v1', args: { id: 'nobody' } },
    JSON.stringify({ status: 'pending_init' }),
  );
  assert.equal(absorbed, false, 'no card to reopen → the control call renders normally');
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

test('terminal child evidence freezes the exact elapsed duration', () => {
  const tracker = createCodexSubagentTracker();
  const card = tracker.registerSpawn({
    callId: 'call_timed',
    toolName: 'spawn_agent',
    namespace: 'collaboration',
    timestamp: '2026-08-18T20:07:32.000Z',
    args: { task_name: 'timed' },
  });
  tracker.onAgentMessage({
    author: '/root/timed',
    content: 'Message Type: FINAL_ANSWER\nPayload:\ndone',
  }, (value) => String(value), '2026-08-18T20:12:42.000Z');
  assert.equal(card.subagentStatus, 'completed');
  assert.equal(card.durationMs, 310_000);
  assert.equal(card.completedAt, Date.parse('2026-08-18T20:12:42.000Z'));
});
