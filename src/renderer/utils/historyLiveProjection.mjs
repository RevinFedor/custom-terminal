import {
  claudeHistoryQueuePresentationIdentity,
  reduceClaudeHistoryPromptCarrier,
} from './historyClaudePromptCarriers.mjs';

const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const stableJson = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
};

const valuesEqual = (left, right) =>
  left === right || stableJson(left) === stableJson(right);

const extractText = (value, { jsonFallback = false } = {}) => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => extractText(part, { jsonFallback }))
      .filter(Boolean)
      .join('\n');
  }
  if (isObject(value)) {
    for (const key of ['text', 'value', 'message', 'content']) {
      if (value[key] != null) {
        const text = extractText(value[key], { jsonFallback });
        if (text) return text;
      }
    }
    if (jsonFallback) {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }
  }
  return '';
};

const normalizeArgs = (value) => {
  if (isObject(value)) return value;
  if (value == null) return {};
  return { value };
};

const unwrapLiveMessage = (envelope) => {
  if (!isObject(envelope)) return null;
  if (
    isObject(envelope.message)
    && typeof envelope.message.uuid === 'string'
    && isObject(envelope.message.message)
  ) {
    return envelope.message;
  }
  if (typeof envelope.uuid === 'string' && isObject(envelope.message)) {
    return envelope;
  }
  return null;
};

const actionToolUseId = (action) => {
  if (!isObject(action)) return '';
  if (typeof action.toolUseId === 'string') return action.toolUseId;
  if (isObject(action.rawTool) && typeof action.rawTool.toolUseId === 'string') {
    return action.rawTool.toolUseId;
  }
  return '';
};

/**
 * Task card for a Claude subagent spawn, built from the live tool_use block.
 *
 * The durable builder produces the same shape from the same fields; this is the
 * live twin of it, not a second source of truth. It deliberately carries only
 * what the spawn itself proves — description and task text. Status is NOT set:
 * a fresh spawn is turn-scoped work, and the background-chip rule reads
 * "no status → alive while the turn is busy". Claiming `running` here would
 * make it process-scoped and resurrect the eternal-chip bug.
 *
 * The CLI renamed the tool Task → Agent; both spawn the same thing, and the
 * renderer contract stays `tool: 'Task'`.
 */
const claudeSubagentSpawnCard = (block, toolUseId) => {
  const name = String(block?.name || block?.tool_name || '');
  if (name !== 'Task' && name !== 'Agent') return null;
  const input = isObject(block.input) ? block.input : (isObject(block.arguments) ? block.arguments : {});
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  return {
    tool: 'Task',
    description: String(input.description || prompt.slice(0, 60) || 'Task agent'),
    toolUseId,
    // A running agent has no id yet — the detail pane locates its transcript by
    // this exact task text, which is also the agent's own first record.
    taskPrompt: prompt.slice(0, 400),
  };
};

const mergeActions = (existing = [], incoming = []) => {
  if (!Array.isArray(existing) || existing.length === 0) return incoming;
  if (!Array.isArray(incoming) || incoming.length === 0) return existing;

  const incomingById = new Map(
    incoming
      .map((action) => [actionToolUseId(action), action])
      .filter(([toolUseId]) => toolUseId),
  );
  const merged = existing.map((action) => {
    const toolUseId = actionToolUseId(action);
    const next = incomingById.get(toolUseId);
    if (!next) return action;
    incomingById.delete(toolUseId);
    return {
      ...action,
      ...next,
      rawTool: {
        ...(isObject(action.rawTool) ? action.rawTool : {}),
        ...(isObject(next.rawTool) ? next.rawTool : {}),
      },
    };
  });

  for (const action of incoming) {
    const toolUseId = actionToolUseId(action);
    if (!toolUseId || incomingById.has(toolUseId)) {
      merged.push(action);
      if (toolUseId) incomingById.delete(toolUseId);
    }
  }
  return valuesEqual(existing, merged) ? existing : merged;
};

const projectAssistantEntry = (canonical, envelope, blocks) => {
  const text = blocks
    .filter((block) => isObject(block) && block.type === 'text')
    .map((block) => extractText(block.text))
    .filter(Boolean)
    .join('\n');
  const thinking = blocks
    .filter((block) => isObject(block) && block.type === 'thinking')
    .map((block) => extractText(block.thinking ?? block.text))
    .filter(Boolean)
    .join('\n');
  const actions = blocks
    .filter((block) =>
      isObject(block)
      && block.type === 'tool_use'
      && (typeof block.id === 'string' || typeof block.tool_use_id === 'string'))
    .map((block) => {
      const toolUseId = String(block.id || block.tool_use_id);
      // A subagent spawn arrives with its ready-made card: rebuild the Task
      // row instead of a generic tool row, otherwise the background-chip strip
      // (which matches on `tool: 'Task'`) never sees the running agent.
      if (isObject(block.subagentCard) && block.subagentCard.tool === 'Task') {
        return { ...block.subagentCard, toolUseId };
      }
      // Claude has no such prepared card: its live record is the raw tool_use,
      // so the card must be rebuilt here from the spawn itself. Without this,
      // a Claude subagent was invisible for its whole life whenever the durable
      // history could not be re-read — and it never can be while the parent
      // turn is busy, which is exactly a SYNCHRONOUS agent's entire lifetime.
      // Scar 2026-07-29: a 42-second synchronous agent produced zero chips
      // because every durable re-read was deferred with reason=turn-busy.
      const claudeSpawn = claudeSubagentSpawnCard(block, toolUseId);
      if (claudeSpawn) return claudeSpawn;
      return {
        tool: '__raw__',
        rawTool: {
          toolUseId,
          toolName: String(block.name || block.tool_name || 'Tool'),
          args: normalizeArgs(block.input ?? block.arguments),
        },
      };
    });

  if (!text && !thinking && actions.length === 0) return null;
  return {
    uuid: canonical.uuid,
    ...(typeof canonical.sourceIdentity === 'string'
      ? { sourceIdentity: canonical.sourceIdentity }
      : {}),
    ...(canonical.livePendingThinking === true
      ? { livePendingThinking: true }
      : {}),
    role: 'assistant',
    timestamp: String(
      canonical.timestamp
      || canonical.message?.timestamp
      || envelope.timestamp
      || FALLBACK_TIMESTAMP,
    ),
    content: text,
    ...(thinking ? { thinking } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    sessionId: String(canonical.sessionId || envelope.sessionId || ''),
  };
};

const projectUserEntry = (canonical, envelope, blocks) => {
  const text = blocks
    .filter((block) => isObject(block) && block.type === 'text')
    .map((block) => extractText(block.text))
    .filter(Boolean)
    .join('\n');
  if (!text) return null;
  return {
    uuid: canonical.uuid,
    role: 'user',
    timestamp: String(
      canonical.timestamp
      || canonical.message?.timestamp
      || envelope.timestamp
      || FALLBACK_TIMESTAMP,
    ),
    content: text,
    sessionId: String(canonical.sessionId || envelope.sessionId || ''),
  };
};

const upsertEntry = (entries, incoming, { beforeFirstQueued = false } = {}) => {
  const index = entries.findIndex((entry) =>
    entry?.uuid === incoming.uuid
    || (
      incoming.sourceIdentity
      && entry?.sourceIdentity === incoming.sourceIdentity
    )
  );
  if (index < 0) {
    if (beforeFirstQueued) {
      const queuedIndex = entries.findIndex((entry) => (
        entry?.role === 'queued' && entry?.queueStatus === 'queued'
      ));
      if (queuedIndex >= 0) {
        return [
          ...entries.slice(0, queuedIndex),
          incoming,
          ...entries.slice(queuedIndex),
        ];
      }
    }
    return [...entries, incoming];
  }

  const existing = entries[index];
  const merged = {
    ...existing,
    ...incoming,
    uuid: existing.uuid,
    content: incoming.content || existing.content || '',
    ...(incoming.thinking
      ? { thinking: incoming.thinking }
      : existing.thinking
        ? { thinking: existing.thinking }
        : {}),
    ...(
      incoming.actions || existing.actions
        ? { actions: mergeActions(existing.actions, incoming.actions) }
        : {}
    ),
  };
  if (valuesEqual(existing, merged)) return entries;
  const next = entries.slice();
  next[index] = merged;
  return next;
};

const extractToolResults = (blocks) => blocks
    .filter((block) =>
      isObject(block)
      && block.type === 'tool_result'
      && (typeof block.tool_use_id === 'string' || typeof block.toolUseId === 'string'))
    .map((block) => ({
      toolUseId: String(block.tool_use_id || block.toolUseId),
      result: extractText(block.content ?? block.result, { jsonFallback: true }),
      isError: Boolean(block.is_error ?? block.isError),
    }));

const applyToolResultValues = (entries, results) => {
  if (results.length === 0) return entries;

  const resultById = new Map(results.map((result) => [result.toolUseId, result]));
  let changed = false;
  const next = entries.map((entry) => {
    if (!Array.isArray(entry?.actions)) return entry;
    let actionChanged = false;
    const actions = entry.actions.map((action) => {
      const result = resultById.get(actionToolUseId(action));
      if (!result || !isObject(action.rawTool)) return action;
      if (
        action.rawTool.result === result.result
        && action.rawTool.isError === result.isError
      ) {
        return action;
      }
      actionChanged = true;
      return {
        ...action,
        rawTool: {
          ...action.rawTool,
          result: result.result,
          isError: result.isError,
        },
      };
    });
    if (!actionChanged) return entry;
    changed = true;
    return { ...entry, actions };
  });
  return changed ? next : entries;
};

const applyToolResults = (entries, blocks) =>
  applyToolResultValues(entries, extractToolResults(blocks));

export function extractHistoryLiveToolResults(envelope) {
  const canonical = unwrapLiveMessage(envelope);
  if (!canonical) return [];
  const blocks = Array.isArray(canonical.message?.content)
    ? canonical.message.content
    : [];
  return extractToolResults(blocks);
}

export function applyHistoryLiveToolResultsToEntry(entry, results) {
  if (!isObject(entry) || !Array.isArray(results) || results.length === 0) {
    return entry;
  }
  return applyToolResultValues([entry], results)[0];
}

/**
 * Retires transient live tool results once the exact durable action exists.
 *
 * A Task/spawn output is only the child identity/acceptance carrier. The same
 * durable Task action is later enriched with the child's terminal result, so
 * comparing both result strings can never settle: they intentionally describe
 * different lifecycle phases. Exact toolUseId ownership is sufficient for a
 * Task because its live result is not rendered as the Task outcome. Raw tools
 * still require exact result/error coverage (or an exact dehydrated ref).
 */
export function reconcileHistoryLiveToolResults(durableEntries, liveResults) {
  const source = liveResults instanceof Map ? liveResults : new Map();
  if (source.size === 0) return source;
  const remaining = new Map(source);
  for (const entry of Array.isArray(durableEntries) ? durableEntries : []) {
    for (const action of Array.isArray(entry?.actions) ? entry.actions : []) {
      const toolUseId = actionToolUseId(action);
      if (!toolUseId) continue;
      if (action?.tool === 'Task') {
        // Live Task blocks stamp the one decoded card as
        // `${callId}:canonical:0`; the durable card keeps the provider's
        // original callId. Both are the same exact spawn action, not fuzzy
        // text matching. Delete either carrier only for this one-card Task
        // shape.
        remaining.delete(toolUseId);
        remaining.delete(toolUseId + ':canonical:0');
        continue;
      }
      if (!remaining.has(toolUseId)) continue;
      if (action?.tool !== '__raw__' || !isObject(action.rawTool)) continue;
      const expected = remaining.get(toolUseId);
      const durableCoversLive = action.rawTool.resultRef
        ? typeof action.rawTool.result === 'string'
        : action.rawTool.result === expected?.result;
      if (durableCoversLive && Boolean(action.rawTool.isError) === Boolean(expected?.isError)) {
        remaining.delete(toolUseId);
      }
    }
  }
  return remaining.size === source.size ? source : remaining;
}

/**
 * Removes live rows only after their durable counterparts belong to the
 * committed History presentation. The caller owns the commit boundary (React
 * uses a layout effect) so a fetched-but-not-yet-rendered snapshot cannot
 * create a frame with neither copy.
 */
export function reconcileCommittedHistoryLiveProjection(liveEntries, durableEntries) {
  const durableIdentities = new Set(
    (durableEntries || [])
      .map((entry) => historyLivePresentationIdentity(entry))
      .filter(Boolean),
  );
  const source = Array.isArray(liveEntries) ? liveEntries : [];
  if (source.length === 0) {
    return { entries: source, durableIdentities };
  }
  const remaining = source.filter((entry) =>
    !historyLivePresentationIdentity(entry)
    || !durableIdentities.has(historyLivePresentationIdentity(entry))
  );
  return {
    entries: remaining.length === source.length ? source : remaining,
    durableIdentities,
  };
}

/**
 * Builds the single list presented by History while a durable refresh catches
 * up with live rollout events. A durable row wins as soon as it exists; only
 * unmatched live rows are appended. With `historyLivePresentationKey` this
 * turns live → durable into an in-place React update instead of two competing
 * DOM surfaces.
 */
export function buildHistoryLivePresentation(durableEntries, liveEntries) {
  const durable = Array.isArray(durableEntries) ? durableEntries : [];
  const live = Array.isArray(liveEntries) ? liveEntries : [];
  if (live.length === 0) return durable;

  const durableIdentities = new Set(
    durable
      .map((entry) => historyLivePresentationIdentity(entry))
      .filter(Boolean),
  );
  const unmatchedLive = live.filter((entry) =>
    !historyLivePresentationIdentity(entry)
    || !durableIdentities.has(historyLivePresentationIdentity(entry))
  );
  if (unmatchedLive.length === 0) return durable;

  // A local prompt submitted while the current turn is busy represents the
  // next turn. It belongs after the current live answer. Once the queue
  // promotes it to `sent`, it becomes the current prompt and belongs before
  // its own live answer.
  const deferredPromptIndex = durable.findIndex((entry) =>
    entry?.role === 'queued'
    && (
      entry?.queueStatus === 'queued'
      || (
        entry?.statusAtSend === 'busy'
        && entry?.queueStatus !== 'sent'
      )
    )
  );
  if (deferredPromptIndex < 0) return [...durable, ...unmatchedLive];
  return [
    ...durable.slice(0, deferredPromptIndex),
    ...unmatchedLive,
    ...durable.slice(deferredPromptIndex),
  ];
}

export function historyLivePresentationKey(entry) {
  const sourceIdentity = String(entry?.sourceIdentity || '');
  // Only assistant rows have a live → durable replacement in this projection.
  // Local user prompts gain their audit identity after they are already on
  // screen; keying those by source would remount the row merely because its
  // delivery proof arrived.
  if (
    sourceIdentity
    && (
      entry?.role === 'assistant'
      || sourceIdentity.startsWith('claude-queue:')
    )
  ) {
    return 'source:' + sourceIdentity;
  }
  const queueIdentity = claudeHistoryQueuePresentationIdentity(entry);
  if (queueIdentity) return 'source:' + queueIdentity;
  return 'uuid:' + String(entry?.uuid || '');
}

export function historyLivePresentationIdentity(entry) {
  const sourceIdentity = String(entry?.sourceIdentity || '');
  if (sourceIdentity) return sourceIdentity;
  const queueIdentity = claudeHistoryQueuePresentationIdentity(entry);
  if (queueIdentity) return queueIdentity;
  // Claude's durable projection preserves the JSONL assistant UUID directly.
  // That UUID is the exact live→durable identity even though Claude does not
  // add Codex's separate sourceIdentity field.
  if (entry?.role === 'assistant' && entry?.uuid) {
    return 'assistant-uuid:' + String(entry.uuid);
  }
  if (entry?.role === 'user' && entry?.uuid) {
    return 'user-uuid:' + String(entry.uuid);
  }
  return '';
}

const TURN_BOUNDARIES_THAT_CLEAR_PENDING_THINKING = new Set([
  'task_started',
  'task_complete',
  'turn_aborted',
  // Provider-neutral presentation boundary emitted by History when its
  // authoritative turn lifecycle settles. Claude has no Codex-style rollout
  // boundary, so this releases a thinking-only live record that the durable
  // Claude projection deliberately does not materialize.
  'turn_settled',
]);

const clearPendingThinking = (entries, sessionId) => {
  const next = entries.filter((entry) =>
    entry?.livePendingThinking !== true
    || (sessionId && entry?.sessionId !== sessionId)
  );
  return next.length === entries.length ? entries : next;
};

/**
 * Projects one canonical live-message envelope into the visible History shape.
 * The reducer is intentionally stateless: replaying an envelope is an upsert by
 * message UUID, while tool results enrich the action identified by toolUseId.
 */
export function reduceHistoryLiveProjection(
  currentEntries,
  envelope,
  { includeUserText = false } = {},
) {
  const entries = Array.isArray(currentEntries) ? currentEntries : [];
  if (
    envelope?.type === 'turn_boundary'
    && TURN_BOUNDARIES_THAT_CLEAR_PENDING_THINKING.has(envelope.boundary)
  ) {
    return clearPendingThinking(entries, String(envelope.sessionId || ''));
  }
  const promptCarrier = reduceClaudeHistoryPromptCarrier(entries, envelope, {
    includeUserText,
  });
  if (promptCarrier.handled) {
    return promptCarrier.promptBoundary
      ? clearPendingThinking(
          promptCarrier.entries,
          String(envelope?.sessionId || envelope?.message?.sessionId || ''),
        )
      : promptCarrier.entries;
  }
  const canonical = unwrapLiveMessage(envelope);
  if (!canonical) return entries;

  const role = canonical.message?.role || canonical.type;
  const blocks = Array.isArray(canonical.message?.content)
    ? canonical.message.content
    : [];
  let next = applyToolResults(entries, blocks);

  if (role === 'assistant') {
    let entry = projectAssistantEntry(canonical, envelope, blocks);
    if (!entry) return next;
    const materializesPendingThinking =
      entry.livePendingThinking !== true
      && (
        Boolean(entry.content)
        || (Array.isArray(entry.actions) && entry.actions.length > 0)
      );
    if (materializesPendingThinking) {
      const pending = next.filter((candidate) =>
        candidate?.livePendingThinking === true
        && candidate?.sessionId === entry.sessionId
      );
      if (pending.length > 0) {
        const pendingThinking = pending
          .map((candidate) => candidate.thinking || '')
          .filter(Boolean)
          .join('\n');
        entry = {
          ...entry,
          ...(pendingThinking
            ? {
                thinking: [pendingThinking, entry.thinking || '']
                  .filter(Boolean)
                  .join('\n'),
              }
            : {}),
        };
        const pendingUuids = new Set(pending.map((candidate) => candidate.uuid));
        next = next.filter((candidate) => !pendingUuids.has(candidate?.uuid));
      }
    }
    return upsertEntry(next, entry, { beforeFirstQueued: true });
  }
  if (role === 'user') {
    const entry = projectUserEntry(canonical, envelope, blocks);
    if (entry) {
      next = clearPendingThinking(
        next,
        String(canonical.sessionId || envelope.sessionId || ''),
      );
    }
    return includeUserText && entry ? upsertEntry(next, entry) : next;
  }
  return next;
}
