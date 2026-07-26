'use strict';

// Codex in-process subagents leave two rollout generations on disk:
//
//   v1 `multi_agent_v1` (cli ≤0.144): spawn_agent output carries {agent_id,
//   nickname}; results return through wait_agent output.status[agent_id]
//   .completed / close_agent output.previous_status.completed, and the
//   parent may also receive a `<subagent_notification>` user record.
//
//   v2 `collaboration` (cli 0.145): spawn_agent args carry task_name +
//   agent_type (message is Fernet-encrypted); the ONLY parent-side link to
//   the child rollout is `event_msg sub_agent_activity` whose event_id equals
//   the spawn call_id and whose agent_thread_id is the child session id.
//   Results arrive as `response_item agent_message` records addressed from
//   the child agent_path with a plaintext FINAL_ANSWER payload; wait_agent
//   output is content-free ("Wait completed.").
//
// This tracker turns those event streams into TaskAction-shaped cards
// (`tool:'Task'`) so the existing SubAgentBlock renderer shows Codex
// subagents exactly like Claude Task agents: label, live status, result.
// Cards are mutated in place after being pushed into the entries array —
// the history builder shares action objects by reference.

const CODEX_SUBAGENT_SPAWN_NAMES = new Set(['spawn_agent']);
const CODEX_SUBAGENT_CONTROL_NAMES = new Set([
  'wait_agent', 'send_input', 'resume_agent', 'close_agent',
  'send_message', 'followup_task', 'interrupt_agent', 'list_agents',
]);
const CODEX_SUBAGENT_NAMESPACES = new Set(['multi_agent_v1', 'collaboration']);

function isCodexSubagentNamespace(namespace) {
  return CODEX_SUBAGENT_NAMESPACES.has(String(namespace || ''));
}

function isCodexSubagentSpawnCall(call) {
  return isCodexSubagentNamespace(call?.namespace)
    && CODEX_SUBAGENT_SPAWN_NAMES.has(String(call?.toolName || ''));
}

function isCodexSubagentControlCall(call) {
  return isCodexSubagentNamespace(call?.namespace)
    && CODEX_SUBAGENT_CONTROL_NAMES.has(String(call?.toolName || ''));
}

function describeSubagentSpawn(args = {}) {
  const taskName = typeof args.task_name === 'string' && args.task_name.trim()
    ? args.task_name.trim()
    : '';
  const agentType = typeof args.agent_type === 'string' && args.agent_type.trim()
    ? args.agent_type.trim()
    : '';
  const message = typeof args.message === 'string' ? args.message.trim() : '';
  // v2 messages are encrypted (Fernet, gAAAA… prefix) — never show them.
  const messagePreview = message && !message.startsWith('gAAAA')
    ? message.slice(0, 80)
    : '';
  const label = taskName || messagePreview || 'Subagent';
  return agentType ? label + ' (' + agentType + ')' : label;
}

function extractCollabFinalAnswer(text) {
  const value = String(text || '');
  if (!/Message Type:\s*FINAL_ANSWER/i.test(value)) return null;
  const payloadIndex = value.search(/Payload:\s*\n/);
  if (payloadIndex < 0) return value.trim();
  return value.slice(value.indexOf('\n', payloadIndex) + 1).trim();
}

function createCodexSubagentTracker() {
  const cardByCallId = new Map();
  const cardByAgentKey = new Map();

  const setStatus = (card, status) => {
    if (!card) return;
    // Terminal states are monotonic: a late "interacted" activity replayed
    // from catch-up must not resurrect a completed card as running.
    if (card.subagentStatus === 'completed') return;
    card.subagentStatus = status;
    card.description = card.baseDescription + statusSuffix(status);
  };
  const statusSuffix = (status) => {
    if (status === 'running') return ' · running';
    if (status === 'interrupted') return ' · interrupted';
    if (status === 'completed') return '';
    return '';
  };

  return {
    /** Register a spawn_agent function_call → returns the TaskAction card. */
    registerSpawn(call) {
      const baseDescription = describeSubagentSpawn(call?.args || {});
      const card = {
        tool: 'Task',
        toolUseId: String(call?.callId || ''),
        baseDescription,
        description: baseDescription + ' · running',
        subagentStatus: 'running',
      };
      if (card.toolUseId) cardByCallId.set(card.toolUseId, card);
      // v2 task_name maps to agent_path `/root/<task_name>`; register both.
      const taskName = String(call?.args?.task_name || '').trim();
      if (taskName) cardByAgentKey.set('/root/' + taskName, card);
      return card;
    },

    /** v1 spawn output: {agent_id, nickname}. */
    attachSpawnOutput(callId, outputPayload) {
      const card = cardByCallId.get(String(callId || ''));
      if (!card) return;
      const output = parseMaybeJson(outputPayload);
      const agentId = String(output?.agent_id || '').trim();
      const nickname = String(output?.nickname || '').trim();
      if (agentId) {
        card.agentSessionId = agentId;
        cardByAgentKey.set(agentId, card);
      }
      if (nickname) {
        card.baseDescription = card.baseDescription + ' — ' + nickname;
        card.description = card.baseDescription + (card.subagentStatus === 'running' ? ' · running' : '');
      }
    },

    /** v2 sub_agent_activity event: exact link spawn call → child rollout. */
    onSubAgentActivity(payload = {}) {
      const eventId = String(payload.event_id || '').trim();
      const agentPath = String(payload.agent_path || '').trim();
      const threadId = String(payload.agent_thread_id || '').trim();
      const kind = String(payload.kind || '').trim();
      let card = eventId ? cardByCallId.get(eventId) : null;
      if (!card && agentPath) card = cardByAgentKey.get(agentPath) || null;
      if (!card) return;
      if (agentPath) cardByAgentKey.set(agentPath, card);
      if (threadId && !card.agentSessionId) {
        card.agentSessionId = threadId;
        cardByAgentKey.set(threadId, card);
      }
      if (kind === 'started' || kind === 'interacted') setStatus(card, 'running');
      else if (kind === 'interrupted') setStatus(card, 'interrupted');
    },

    /** v2 agent_message response_item: FINAL_ANSWER carries the result. */
    onAgentMessage(payload = {}, extractTextContent) {
      const author = String(payload.author || '').trim();
      if (!author) return false;
      const card = cardByAgentKey.get(author);
      const text = typeof extractTextContent === 'function'
        ? extractTextContent(payload.content)
        : String(payload.content || '');
      const finalAnswer = extractCollabFinalAnswer(text);
      if (!card) return finalAnswer !== null;
      if (finalAnswer !== null) {
        card.result = finalAnswer;
        card.subagentStatus = 'completed';
        card.description = card.baseDescription;
        return true;
      }
      // Interim MESSAGE payloads are encrypted — count them as activity only.
      setStatus(card, 'running');
      return true;
    },

    /**
     * `<subagent_notification>` user record: a THIRD completion path — the
     * parent is notified about a child it never wait_agent'ed (fire-and-
     * forget spawn). E2E-proven zombie 2026-07-25: an agent finished with
     * `{"agent_path":"/root/…","status":{"completed":"готово"}}` inside a
     * plain user message, no sub_agent_activity/agent_message/wait output
     * ever arrived, and the chip climbed to 4m+ as running. Returns true
     * when a card consumed the notification.
     */
    onSubagentNotification(text) {
      const value = String(text || '');
      if (!value.includes('<subagent_notification>')) return false;
      const body = (value.match(/<subagent_notification>([\s\S]*?)<\/subagent_notification>/) || [])[1]
        || value;
      const parsed = parseMaybeJson(body.trim());
      let handled = false;
      const applyOutcome = (agentKey, status) => {
        const card = agentKey ? cardByAgentKey.get(String(agentKey)) : null;
        if (!card || !status || typeof status !== 'object') return;
        if (typeof status.completed === 'string') {
          card.result = status.completed;
          card.subagentStatus = 'completed';
          card.description = card.baseDescription;
          handled = true;
        } else if (status.interrupted !== undefined || status.errored !== undefined) {
          setStatus(card, 'interrupted');
          handled = true;
        }
      };
      if (parsed && typeof parsed === 'object') {
        applyOutcome(parsed.agent_path || parsed.agent_id || parsed.agent_name, parsed.status);
        if (!handled && parsed.status && typeof parsed.status === 'object' && !parsed.agent_path) {
          // Alternate shape: {status: {"<agentKey>": {...}}} map.
          for (const [agentKey, agentStatus] of Object.entries(parsed.status)) {
            applyOutcome(agentKey, agentStatus);
          }
        }
        return handled;
      }
      // Non-JSON notification body: fall back to a per-known-agent scan so a
      // format drift degrades to "matched by mention", never to a zombie.
      for (const [agentKey, card] of cardByAgentKey) {
        if (!body.includes(agentKey)) continue;
        if (/"completed"\s*:/.test(body) || /status[^а-яa-z]*completed/i.test(body)) {
          const completedText = (body.match(/"completed"\s*:\s*"((?:[^"\\]|\\.)*)"/) || [])[1];
          if (completedText !== undefined) {
            try { card.result = JSON.parse('"' + completedText + '"'); } catch { card.result = completedText; }
          }
          card.subagentStatus = 'completed';
          card.description = card.baseDescription;
          handled = true;
        } else if (/interrupted|errored/i.test(body)) {
          setStatus(card, 'interrupted');
          handled = true;
        }
      }
      return handled;
    },

    /**
     * v1 wait_agent/close_agent output: attach completed results to their
     * cards. Returns true when the output was absorbed (no separate card
     * needed for the control call).
     */
    absorbControlOutput(call, outputPayload) {
      if (!isCodexSubagentControlCall(call)) return false;
      const name = String(call?.toolName || '');
      const output = parseMaybeJson(outputPayload);
      let absorbed = false;
      if (name === 'wait_agent') {
        const status = output?.status;
        if (status && typeof status === 'object') {
          for (const [agentKey, agentStatus] of Object.entries(status)) {
            const card = cardByAgentKey.get(String(agentKey));
            const completed = typeof agentStatus?.completed === 'string'
              ? agentStatus.completed
              : null;
            if (card && completed !== null) {
              card.result = completed;
              card.subagentStatus = 'completed';
              card.description = card.baseDescription;
            }
          }
        }
        // v2 wait output is content-free; v1 carries results — both are
        // control-plane noise once cards exist.
        absorbed = cardByCallId.size > 0;
      } else if (name === 'close_agent') {
        const completed = output?.previous_status?.completed;
        const target = String(call?.args?.target || '').trim();
        const card = target ? cardByAgentKey.get(target) : null;
        if (card && typeof completed === 'string') {
          card.result = completed;
          card.subagentStatus = 'completed';
          card.description = card.baseDescription;
        }
        absorbed = !!card;
      } else if (name === 'list_agents') {
        const agents = Array.isArray(output?.agents) ? output.agents : [];
        for (const agent of agents) {
          const card = cardByAgentKey.get(String(agent?.agent_name || ''));
          const completed = typeof agent?.agent_status?.completed === 'string'
            ? agent.agent_status.completed
            : null;
          if (card && completed !== null) {
            card.result = completed;
            card.subagentStatus = 'completed';
            card.description = card.baseDescription;
          }
        }
        absorbed = false; // list_agents output stays visible — it is a query.
      }
      return absorbed;
    },

    hasCards() {
      return cardByCallId.size > 0;
    },
  };
}

function parseMaybeJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

module.exports = {
  CODEX_SUBAGENT_CONTROL_NAMES,
  CODEX_SUBAGENT_SPAWN_NAMES,
  createCodexSubagentTracker,
  describeSubagentSpawn,
  extractCollabFinalAnswer,
  isCodexSubagentControlCall,
  isCodexSubagentNamespace,
  isCodexSubagentSpawnCall,
};
