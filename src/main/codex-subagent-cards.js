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
    // A rejected spawn never produced an agent, so no later event can belong
    // to it — the only exception is an explicit re-spawn, which is a new call
    // and therefore a new card.
    if (card.spawnRejected) return;
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

    /**
     * Spawn output — the moment the attempt either becomes an agent or dies.
     *
     * Success carries an identity, and WHICH identity depends on the protocol
     * (both shapes verified over 190 real spawn outputs):
     *   v1 multi_agent_v1 → {"agent_id":"019f…","nickname":"Faraday"}
     *   v2 collaboration  → {"task_name":"/root/<name>"}   (no agent_id!)
     * A REJECTED spawn carries neither — just a plain error string:
     *   "Full-history forked agents inherit the parent agent type; …"
     *   "collab spawn failed: agent thread limit reached"
     *   "collab spawn failed: thread-store internal error: No space left…"
     *
     * A rejected spawn never created an agent, so nothing will ever complete
     * it: no wait_agent status, no close_agent, no notification. Registering
     * the card as `running` at CALL time and never re-checking the outcome is
     * what produced permanent phantom chips in production 2026-07-26 — two
     * chips whose successful retries (15s later) sat completed right beside
     * them. The card stays (the attempt happened and the user deserves to see
     * why it failed) but is terminal, never live.
     *
     * Identity presence is the structural test; error phrases are only used
     * as the human-readable reason, never as the detector.
     */
    attachSpawnOutput(callId, outputPayload) {
      const card = cardByCallId.get(String(callId || ''));
      if (!card) return;
      const output = parseMaybeJson(outputPayload);
      const agentId = String(output?.agent_id || '').trim();
      const taskName = String(output?.task_name || '').trim();
      const nickname = String(output?.nickname || '').trim();
      if (!agentId && !taskName) {
        // Rejections arrive as PLAIN TEXT, which JSON parsing drops to null —
        // read the reason from the raw payload, falling back to structured
        // error fields when the refusal did come back as an object.
        const raw = typeof outputPayload === 'string' ? outputPayload.trim() : '';
        const structured = String(output?.error || output?.message || '').trim();
        const reason = structured || raw;
        card.spawnRejected = true;
        card.subagentStatus = 'interrupted';
        card.description = card.baseDescription + ' · не запущен';
        card.result = reason || 'Запуск агента отклонён.';
        return;
      }
      if (agentId) {
        card.agentSessionId = agentId;
        cardByAgentKey.set(agentId, card);
      }
      // v2 confirms the agent path; register it so later activity/messages
      // addressed to `/root/<task_name>` find this card.
      if (taskName) cardByAgentKey.set(taskName, card);
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
      if (name === 'resume_agent' || name === 'send_input' || name === 'send_message'
        || name === 'followup_task') {
        // A FINISHED agent can be put back to work: `resume_agent {id}` →
        // {"status":"pending_init"}, then send_input hands it the next task.
        // Without this the card stays "completed" for the whole resumed run
        // and its chip never comes back — the Codex mirror of the Claude
        // SendMessage resume hole (both found 2026-07-26). The next
        // wait_agent/close_agent output completes it again, so this only
        // reopens the live window, never overrides a real terminal event.
        const target = String(call?.args?.id || call?.args?.target
          || call?.args?.agent_id || call?.args?.name || '').trim();
        const card = target ? cardByAgentKey.get(target) : null;
        // A rejected spawn is never resumable — nothing was ever created.
        if (card && !card.spawnRejected) {
          card.subagentStatus = 'running';
          card.description = card.baseDescription + ' · running';
          absorbed = true;
        }
      } else if (name === 'wait_agent') {
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
        // close_agent is TERMINAL by definition: the agent is gone afterwards,
        // whatever it was doing. Its output reports the status the agent had
        // BEFORE closing, in two shapes (verified over 32 real closes):
        //   {"previous_status":{"completed":"<text>"}}  — finished on its own
        //   {"previous_status":"running"}               — closed mid-flight
        // The second shape is a plain string, so reading `.completed` from it
        // yields undefined and the card was left `running` forever — no other
        // event can ever arrive for a closed agent. Real case: two explorer
        // agents whose wait_agent timed out and were then force-closed sat as
        // permanent live chips (4 of 32 closes in the corpus).
        const previous = output?.previous_status;
        const completed = typeof previous?.completed === 'string' ? previous.completed : null;
        const target = String(call?.args?.target || '').trim();
        const card = target ? cardByAgentKey.get(target) : null;
        if (card) {
          if (completed !== null) {
            card.result = completed;
            card.subagentStatus = 'completed';
            card.description = card.baseDescription;
          } else if (card.subagentStatus !== 'completed') {
            // Closed without its own result: terminal, but not a success.
            card.subagentStatus = 'interrupted';
            card.description = card.baseDescription + ' · закрыт';
            if (!card.result) card.result = 'Агент закрыт до завершения задачи.';
          }
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
