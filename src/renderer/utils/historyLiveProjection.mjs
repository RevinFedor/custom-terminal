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

const upsertEntry = (entries, incoming) => {
  const index = entries.findIndex((entry) =>
    entry?.uuid === incoming.uuid
    || (
      incoming.sourceIdentity
      && entry?.sourceIdentity === incoming.sourceIdentity
    )
  );
  if (index < 0) return [...entries, incoming];

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
 * Removes live rows only after their durable counterparts belong to the
 * committed History presentation. The caller owns the commit boundary (React
 * uses a layout effect) so a fetched-but-not-yet-rendered snapshot cannot
 * create a frame with neither copy.
 */
export function reconcileCommittedHistoryLiveProjection(liveEntries, durableEntries) {
  const durableIdentities = new Set(
    (durableEntries || [])
      .map((entry) => entry?.sourceIdentity)
      .filter(Boolean),
  );
  const source = Array.isArray(liveEntries) ? liveEntries : [];
  if (source.length === 0) {
    return { entries: source, durableIdentities };
  }
  const remaining = source.filter((entry) =>
    !entry?.sourceIdentity || !durableIdentities.has(entry.sourceIdentity)
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
      .map((entry) => entry?.sourceIdentity)
      .filter(Boolean),
  );
  const unmatchedLive = live.filter((entry) =>
    !entry?.sourceIdentity || !durableIdentities.has(entry.sourceIdentity)
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
  if (sourceIdentity && entry?.role === 'assistant') {
    return 'source:' + sourceIdentity;
  }
  return 'uuid:' + String(entry?.uuid || '');
}

const CODEX_TURN_BOUNDARIES = new Set([
  'task_started',
  'task_complete',
  'turn_aborted',
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
    && CODEX_TURN_BOUNDARIES.has(envelope.boundary)
  ) {
    return clearPendingThinking(entries, String(envelope.sessionId || ''));
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
    return upsertEntry(next, entry);
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
