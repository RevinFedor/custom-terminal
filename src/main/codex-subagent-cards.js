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
const CODEX_SUBAGENT_WORK_START_NAMES = new Set(['resume_agent', 'send_input', 'followup_task']);
const CODEX_SUBAGENT_NAMESPACES = new Set(['multi_agent_v1', 'collaboration']);
const CODEX_SUBAGENT_CALL_NAMES = new Set([...CODEX_SUBAGENT_SPAWN_NAMES, ...CODEX_SUBAGENT_CONTROL_NAMES]);
const { codexStartedLaunchSettings } = require('./subagent-launch-settings');

// Programmatic exec exposes namespace tools as flat callable identifiers.
// Keep a closed identity dictionary: an MCP suffix, quoted example or prose
// mentioning spawn_agent is not a native subagent call.
function normalizeCodexSubagentCall(call = {}) {
  const name = String(call.toolName || call.name || '');
  const namespace = String(call.namespace || '');
  const names = CODEX_SUBAGENT_CALL_NAMES;
  if (CODEX_SUBAGENT_NAMESPACES.has(namespace) && names.has(name)) return call;
  if (namespace && !CODEX_SUBAGENT_NAMESPACES.has(namespace)) return call;
  for (const candidate of CODEX_SUBAGENT_NAMESPACES) {
    for (const separator of ['__', '_', '.']) {
      const prefix = candidate + separator;
      if (name.startsWith(prefix) && names.has(name.slice(prefix.length))) {
        return { ...call, toolName: name.slice(prefix.length), namespace: candidate };
      }
    }
  }
  return call;
}

// The outer exec can print several real spawn receipts from one loop. Accept
// complete JSON values/JSON lines only, never substring matches in tool prose.
function extractCodexSpawnIdentities(value, namespace = 'multi_agent_v1') {
  const found = new Map();
  const visit = (candidate) => {
    if (Array.isArray(candidate)) { candidate.forEach(visit); return; }
    if (!candidate || typeof candidate !== 'object') return;
    const agentId = typeof candidate.agent_id === 'string' ? candidate.agent_id.trim() : '';
    const taskName = typeof candidate.task_name === 'string' ? candidate.task_name.trim() : '';
    const nickname = typeof candidate.nickname === 'string' ? candidate.nickname.trim() : '';
    if (namespace === 'multi_agent_v1'
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)) return;
    if (namespace === 'collaboration' && !agentId && !taskName.startsWith('/root/')) return;
    if (!agentId && !taskName) return;
    const key = agentId || taskName;
    if (!found.has(key)) found.set(key, { agent_id: agentId, task_name: taskName, nickname });
  };
  if (typeof value === 'string') {
    try { visit(JSON.parse(value)); }
    catch { for (const line of value.split('\n')) { try { visit(JSON.parse(line.trim())); } catch {} } }
  } else visit(value);
  return [...found.values()];
}

function isCodexSubagentNamespace(namespace) {
  return CODEX_SUBAGENT_NAMESPACES.has(String(namespace || ''));
}

function isCodexSubagentSpawnCall(call) {
  const normalized = normalizeCodexSubagentCall(call);
  return isCodexSubagentNamespace(normalized?.namespace)
    && CODEX_SUBAGENT_SPAWN_NAMES.has(String(normalized?.toolName || ''));
}

function isCodexSubagentControlCall(call) {
  const normalized = normalizeCodexSubagentCall(call);
  return isCodexSubagentNamespace(normalized?.namespace)
    && CODEX_SUBAGENT_CONTROL_NAMES.has(String(normalized?.toolName || ''));
}

function isCodexSubagentWorkStartingCall(call) {
  const normalized = normalizeCodexSubagentCall(call);
  // collaboration.send_message is QueueOnly in both 0.159.2 and 0.162:
  // successful mailbox delivery does NOT wake an idle child. Only explicit
  // work-start controls may reopen its completed lease/clock.
  return isCodexSubagentControlCall(normalized)
    && CODEX_SUBAGENT_WORK_START_NAMES.has(normalized.toolName);
}

function codexSubagentTerminalOutcomes(call, outputPayload) {
  call = normalizeCodexSubagentCall(call);
  if (!isCodexSubagentControlCall(call)) return [];
  const output = parseMaybeJson(outputPayload);
  if (!output || typeof output !== 'object') return [];
  const outcomes = [];
  const add = (key, status) => {
    if (!key || !status || typeof status !== 'object') return;
    if (typeof status.completed === 'string') outcomes.push({ key, status: 'completed', result: status.completed });
    else if (status.interrupted !== undefined || status.errored !== undefined
      || status.shutdown !== undefined) outcomes.push({ key, status: 'interrupted' });
  };
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 4) return;
    if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return; }
    // Exact Promise.allSettled transport, not an arbitrary recursive search.
    if (value.status === 'fulfilled' && Object.hasOwn(value, 'value')) {
      visit(value.value, depth + 1); return;
    }
    if (value.status === 'rejected') return;
    if (call.toolName === 'wait_agent' && value.status && typeof value.status === 'object') {
      for (const [key, status] of Object.entries(value.status)) add(key, status);
    } else if (call.toolName === 'list_agents' && Array.isArray(value.agents)) {
      for (const agent of value.agents) add(agent.agent_id || agent.agent_name, agent.agent_status || agent.status);
    } else if (call.toolName === 'close_agent' && Object.hasOwn(value, 'previous_status')) {
      const key = String(call.args?.target || call.args?.id || call.args?.agent_id || '');
      const before = outcomes.length;
      add(key, value.previous_status);
      if (key && outcomes.length === before) outcomes.push({ key, status: 'interrupted' });
    }
  };
  visit(output);
  return outcomes;
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

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function createCodexSubagentTracker(seed = {}) {
  const cardByCallId = seed.cardByCallId || new Map();
  const cardByAgentKey = seed.cardByAgentKey || new Map();

  const stampTerminalTiming = (card, observedAt) => {
    if (card.completionTimingSource === 'child') return;
    const completedAt = timestampMs(observedAt);
    if (!completedAt) return;
    card.completedAt = completedAt;
    card.completionTimingSource = 'parent';
    if (Number(card.startedAt) > 0) {
      card.durationMs = Math.max(0, completedAt - Number(card.startedAt));
    }
  };
  const setStatus = (card, status, observedAt = null) => {
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
    if (status === 'completed' || status === 'interrupted') {
      stampTerminalTiming(card, observedAt);
    }
  };
  const statusSuffix = (status) => {
    if (status === 'running') return ' · running';
    if (status === 'interrupted') return ' · interrupted';
    if (status === 'completed') return '';
    return '';
  };

  return {
    exportState: () => ({ cardByCallId, cardByAgentKey }),
    getCard: (callId) => cardByCallId.get(String(callId || '')) || null,
    /** Register a spawn_agent function_call → returns the TaskAction card. */
    registerSpawn(call) {
      const baseDescription = describeSubagentSpawn(call?.args || {});
      const card = {
        tool: 'Task',
        toolUseId: String(call?.callId || ''),
        baseDescription,
        description: baseDescription + ' · running',
        subagentStatus: 'running',
        startedAt: timestampMs(call?.timestamp),
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
    attachSpawnOutput(callId, outputPayload, observedAt = null) {
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
        stampTerminalTiming(card, observedAt);
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
    onSubAgentActivity(payload = {}, observedAt = null) {
      const eventId = String(payload.event_id || '').trim();
      const agentPath = String(payload.agent_path || '').trim();
      const threadId = String(payload.agent_thread_id || '').trim();
      const kind = String(payload.kind || '').trim();
      let card = eventId ? cardByCallId.get(eventId) : null;
      if (!card && agentPath) card = cardByAgentKey.get(agentPath) || null;
      if (!card) return;
      if (!card.launchSettings && eventId === card.toolUseId
        && (!card.agentSessionId || card.agentSessionId === threadId)) {
        const settings = codexStartedLaunchSettings(payload, card.toolUseId, threadId, observedAt);
        if (settings) card.launchSettings = settings;
      }
      if (agentPath) cardByAgentKey.set(agentPath, card);
      if (threadId && !card.agentSessionId) {
        card.agentSessionId = threadId;
        cardByAgentKey.set(threadId, card);
      }
      // Interacted is shared by QueueOnly mail and real followup. The latter
      // is handled by its control output; interaction alone proves no turn.
      if (kind === 'started') setStatus(card, 'running');
      else if (kind === 'interrupted') setStatus(card, 'interrupted', observedAt);
    },

    /** v2 agent_message response_item: FINAL_ANSWER carries the result. */
    onAgentMessage(payload = {}, extractTextContent, observedAt = null) {
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
        stampTerminalTiming(card, observedAt);
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
    onSubagentNotification(text, observedAt = null) {
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
          stampTerminalTiming(card, observedAt);
          handled = true;
        } else if (status.interrupted !== undefined || status.errored !== undefined) {
          setStatus(card, 'interrupted', observedAt);
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
          stampTerminalTiming(card, observedAt);
          handled = true;
        } else if (/interrupted|errored/i.test(body)) {
          setStatus(card, 'interrupted', observedAt);
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
    absorbControlOutput(call, outputPayload, observedAt = null) {
      call = normalizeCodexSubagentCall(call);
      if (!isCodexSubagentControlCall(call)) return false;
      const name = String(call?.toolName || '');
      const output = parseMaybeJson(outputPayload);
      let absorbed = false;
      if (name === 'send_message') {
        const target = String(call?.args?.target || call?.args?.id || call?.args?.agent_id || '').trim();
        // Absorb mailbox control noise without changing terminal state,
        // completedAt, duration or launch metadata (3607/4196, 09.10).
        absorbed = !!(target && cardByAgentKey.get(target));
      } else if (isCodexSubagentWorkStartingCall(call)) {
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
          card.startedAt = timestampMs(call?.timestamp) || timestampMs(observedAt) || card.startedAt;
          delete card.completedAt;
          delete card.durationMs;
          delete card.completionTimingSource;
          absorbed = true;
        }
      } else if (name === 'wait_agent') {
        for (const outcome of codexSubagentTerminalOutcomes(call, outputPayload)) {
            const card = cardByAgentKey.get(outcome.key);
            if (card && outcome.status === 'completed') {
              card.result = outcome.result;
              card.subagentStatus = 'completed';
              card.description = card.baseDescription;
              stampTerminalTiming(card, observedAt);
            } else if (card) {
              setStatus(card, 'interrupted', observedAt);
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
        const target = String(call?.args?.target || call?.args?.id || call?.args?.agent_id || '').trim();
        const card = target ? cardByAgentKey.get(target) : null;
        if (card) {
          if (completed !== null) {
            card.result = completed;
            card.subagentStatus = 'completed';
            card.description = card.baseDescription;
            stampTerminalTiming(card, observedAt);
          } else if (card.subagentStatus !== 'completed') {
            // Closed without its own result: terminal, but not a success.
            card.subagentStatus = 'interrupted';
            card.description = card.baseDescription + ' · закрыт';
            if (!card.result) card.result = 'Агент закрыт до завершения задачи.';
            stampTerminalTiming(card, observedAt);
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

    allCards() {
      return [...cardByCallId.values()];
    },

    /**
     * Cards still marked running after the whole rollout was replayed.
     *
     * The parent is not a reliable witness of completion: `wait_agent` is
     * routinely called with no target, and its `Wait completed` output names
     * nobody — so a finished agent can leave zero terminal trace here. In a
     * live production tab 12 of 36 spawns ended that way and animated the tab
     * forever. The caller resolves these against each agent's OWN transcript.
     */
    runningCards() {
      const running = [];
      for (const card of cardByCallId.values()) {
        if (card.subagentStatus === 'running' && !card.spawnRejected) running.push(card);
      }
      return running;
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
  codexSubagentTerminalOutcomes,
  describeSubagentSpawn,
  extractCollabFinalAnswer,
  extractCodexSpawnIdentities,
  normalizeCodexSubagentCall,
  isCodexSubagentControlCall,
  isCodexSubagentWorkStartingCall,
  isCodexSubagentNamespace,
  isCodexSubagentSpawnCall,
};
