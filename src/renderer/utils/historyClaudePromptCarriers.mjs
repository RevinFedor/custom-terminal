const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const extractText = (value) => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!isObject(item)) return '';
        if (item.type === 'text' && typeof item.text === 'string') return item.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (isObject(value) && typeof value.text === 'string') return value.text;
  return '';
};

export const normalizeClaudeHistoryPromptCarrierText = (value) => extractText(value)
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/\[200~/g, '')
  .replace(/~\]/g, '')
  .trim();

const promptIdentityText = (value) => normalizeClaudeHistoryPromptCarrierText(value)
  .replace(/\s+/g, ' ')
  .trim();

const shouldSkipPrompt = (text) => {
  if (!text) return true;
  if (text.startsWith('[Request interrupted') || text === '[User cancelled]') return true;
  if (text.includes('<local-command-stdout>') || text.includes('<local-command-stderr>')) return true;
  if (text.includes('<local-command-caveat>') || text.includes('<command-name>')) return true;
  if (text.includes('<bash-notification>') || text.includes('<shell-id>')) return true;
  if (text.includes('<user-prompt-submit-hook>') || text.includes('<task-notification>')) return true;
  if (text.startsWith('Caveat: The messages below')) return true;
  return false;
};

const hashText = (value) => {
  let hash = 0x811c9dc5;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

const rawRecord = (envelope) => {
  if (isObject(envelope?.message)) return envelope.message;
  return isObject(envelope) ? envelope : null;
};

const recordSessionId = (record, envelope) => String(
  record?.sessionId
  || record?.session_id
  || envelope?.sessionId
  || '',
);

const recordTimestamp = (record, envelope) => String(
  record?.timestamp
  || record?.attachment?.timestamp
  || envelope?.timestamp
  || '1970-01-01T00:00:00.000Z',
);

const recordByteOffsetFrom = (envelope) => {
  const value = Number(envelope?.recordByteOffset);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

const queuedCommandText = (record) => {
  if (record?.type !== 'attachment' || record?.attachment?.type !== 'queued_command') return '';
  return normalizeClaudeHistoryPromptCarrierText(record.attachment.prompt);
};

const ordinaryUserText = (record) => {
  if (record?.type !== 'user') return '';
  if (record.isMeta === true) return '';
  const content = record?.message?.content;
  if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) return '';
  return normalizeClaudeHistoryPromptCarrierText(content);
};

export function extractClaudeHistoryPromptCarrierText(envelope) {
  const record = rawRecord(envelope);
  if (!record) return '';
  if (record.type === 'queue-operation' && record.operation === 'enqueue') {
    return normalizeClaudeHistoryPromptCarrierText(record.content);
  }
  return queuedCommandText(record) || ordinaryUserText(record);
}

/**
 * History may suppress a live Claude prompt only when the transcript carrier
 * proves the exact app-owned handoff. Text equality is deliberately excluded:
 * a user can submit identical text from History and from the native xterm,
 * and both prompts must remain visible as distinct turns.
 */
export function isHistoryPromptLocallyOwned(envelope, handoffs) {
  const source = Array.isArray(handoffs)
    ? handoffs
    : handoffs && typeof handoffs.values === 'function'
      ? Array.from(handoffs.values())
      : [];
  if (source.length === 0) return false;

  const handoffId = typeof envelope?.promptOwner?.handoffId === 'string'
    ? envelope.promptOwner.handoffId
    : '';
  if (handoffId && source.some((handoff) => handoff?.handoffId === handoffId)) {
    return true;
  }

  const record = rawRecord(envelope);
  const entryUuid = typeof record?.uuid === 'string' ? record.uuid : '';
  return !!entryUuid && source.some((handoff) => handoff?.auditEntryUuid === entryUuid);
}

// Compatibility alias for the original Claude-only caller. The ownership
// proof itself is provider-neutral: an exact handoff id or audited record id.
export const isClaudeHistoryPromptLocallyOwned = isHistoryPromptLocallyOwned;

const queueIdentityFrom = ({ sessionId, timestamp, text }) => {
  const normalized = promptIdentityText(text);
  if (!normalized || !timestamp) return '';
  return 'claude-queue:' + sessionId + ':' + timestamp + ':' + hashText(normalized);
};

const queueSourceIdentityFrom = (record, envelope, text) => {
  const entryUuid = typeof record?.uuid === 'string' ? record.uuid.trim() : '';
  if (entryUuid) return 'claude-queue:uuid:' + entryUuid;
  const sessionId = recordSessionId(record, envelope);
  const recordByteOffset = recordByteOffsetFrom(envelope);
  if (sessionId && recordByteOffset !== null) {
    return 'claude-queue:offset:' + sessionId + ':' + recordByteOffset;
  }
  return queueIdentityFrom({
    sessionId,
    timestamp: recordTimestamp(record, envelope),
    text,
  });
};

export function claudeHistoryQueuePresentationIdentity(entry) {
  if (entry?.role !== 'queued') return '';
  if (String(entry?.uuid || '').startsWith('local-prompt-')) return '';
  if (String(entry?.sourceIdentity || '').startsWith('claude-queue:')) {
    return String(entry.sourceIdentity);
  }
  return queueIdentityFrom({
    sessionId: String(entry.sessionId || ''),
    timestamp: String(entry.timestamp || ''),
    text: entry.content,
  });
}

export const hasClaudeHistoryLiveQueuePrompt = (entries) => (
  Array.isArray(entries)
  && entries.some((entry) => (
    entry?.queueStatus === 'queued'
    && String(entry?.sourceIdentity || '').startsWith('claude-queue:')
  ))
);

const removeOneMatchingQueue = (entries, text, timestamp = '', {
  allowConsumedPrefix = false,
  sessionId = '',
} = {}) => {
  const expected = promptIdentityText(text);
  const expectedTimestamp = String(timestamp || '');
  if (!expected) return { entries, removed: null };
  let candidates = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => (
      entry?.role === 'queued'
      && entry.queueStatus !== 'cancelled'
      && promptIdentityText(entry.content) === expected
    ));
  const exact = expectedTimestamp
    ? candidates.find(({ entry }) => String(entry.timestamp || '') === expectedTimestamp)
    : null;
  let index = exact?.index ?? candidates[0]?.index ?? -1;
  if (index < 0 && allowConsumedPrefix) {
    const exactSessionId = String(sessionId || '');
    candidates = entries
      .map((entry, candidateIndex) => ({ entry, index: candidateIndex }))
      .filter(({ entry }) => {
        if (entry?.role !== 'queued' || entry.queueStatus !== 'sent') return false;
        if (exactSessionId && entry.sessionId && entry.sessionId !== exactSessionId) return false;
        const queuedText = promptIdentityText(entry.content);
        if (!queuedText || expected.length <= queuedText.length || !expected.startsWith(queuedText)) {
          return false;
        }
        return /\s/u.test(expected.charAt(queuedText.length));
      });
    if (candidates.length === 1) index = candidates[0].index;
  }
  if (index < 0) return { entries, removed: null };
  return {
    entries: [...entries.slice(0, index), ...entries.slice(index + 1)],
    removed: entries[index],
  };
};

const queueSettlementIdentityFrom = (record, envelope) => {
  const recordUuid = typeof record?.uuid === 'string' ? record.uuid : '';
  if (recordUuid) return 'claude-queue-settlement:uuid:' + recordUuid;
  const sessionId = recordSessionId(record, envelope);
  const byteOffset = Number(envelope?.recordByteOffset);
  const timestamp = String(record?.timestamp || envelope?.timestamp || '');
  const boundary = Number.isFinite(byteOffset)
    ? 'offset:' + byteOffset
    : 'timestamp:' + timestamp;
  return 'claude-queue-settlement:'
    + sessionId + ':' + boundary + ':'
    + String(record?.operation || '') + ':'
    + hashText(promptIdentityText(record?.content));
};

const hasQueueSettlement = (entries, settlementIdentity) => !!settlementIdentity
  && entries.some((entry) => (
    Array.isArray(entry?.queueSettlementIdentities)
    && entry.queueSettlementIdentities.includes(settlementIdentity)
  ));

const withQueueSettlement = (entry, settlementIdentity) => {
  if (!settlementIdentity) return entry;
  const current = Array.isArray(entry?.queueSettlementIdentities)
    ? entry.queueSettlementIdentities
    : [];
  if (current.includes(settlementIdentity)) return entry;
  return {
    ...entry,
    queueSettlementIdentities: [...current, settlementIdentity],
  };
};

const updateQueuedStatus = (
  entries,
  operation,
  text,
  settlementIdentity,
  { recordByteOffset = null, timestamp = '' } = {},
) => {
  if (hasQueueSettlement(entries, settlementIdentity)) return entries;
  if (operation === 'popAll') {
    const exactSettlementOffset = Number.isSafeInteger(recordByteOffset)
      ? recordByteOffset
      : null;
    const settlementAt = Date.parse(String(timestamp || ''));
    return entries.filter((entry) => {
      if (entry?.role !== 'queued' || entry.queueStatus !== 'queued') return true;
      const entryOffset = Number(entry.recordByteOffset);
      if (exactSettlementOffset !== null && Number.isSafeInteger(entryOffset)) {
        return entryOffset > exactSettlementOffset;
      }
      const entryAt = Date.parse(String(entry.timestamp || ''));
      if (Number.isFinite(settlementAt) && Number.isFinite(entryAt)) {
        return entryAt > settlementAt;
      }
      // Live delivery is ordered. With no persisted position at all, every
      // currently queued row necessarily precedes this popAll envelope.
      return false;
    });
  }
  const expected = promptIdentityText(text);
  let changed = false;
  let consumed = false;
  const next = entries.map((entry) => {
    if (entry?.role !== 'queued' || entry.queueStatus !== 'queued') return entry;
    const exactContentMatch = expected && promptIdentityText(entry.content) === expected;
    const applies = !consumed && (exactContentMatch || !expected);
    if (!applies) return entry;
    consumed = true;
    changed = true;
    return withQueueSettlement({
      ...entry,
      queueStatus: 'sent',
    }, settlementIdentity);
  });
  return changed ? next : entries;
};

const upsertByUuidOrSource = (entries, incoming) => {
  const index = entries.findIndex((entry) => (
    entry?.uuid === incoming.uuid
    || (
      incoming.sourceIdentity
      && entry?.sourceIdentity === incoming.sourceIdentity
    )
  ));
  if (index < 0) return [...entries, incoming];
  const next = entries.slice();
  next[index] = { ...next[index], ...incoming };
  return next;
};

/**
 * Projects only Claude prompt carriers. `handled:false` delegates assistant and
 * tool-result records back to the provider-neutral live reducer.
 */
export function reduceClaudeHistoryPromptCarrier(
  currentEntries,
  envelope,
  { includeUserText = false } = {},
) {
  const entries = Array.isArray(currentEntries) ? currentEntries : [];
  const record = rawRecord(envelope);
  if (!record) return {
    handled: false, entries, projectedUser: false, promptBoundary: false,
  };

  if (record.type === 'queue-operation') {
    if (!includeUserText) return {
      handled: true, entries, projectedUser: false, promptBoundary: false,
    };
    if (record.operation === 'enqueue') {
      const text = normalizeClaudeHistoryPromptCarrierText(record.content);
      if (shouldSkipPrompt(text)) return {
        handled: true, entries, projectedUser: false, promptBoundary: false,
      };
      const sessionId = recordSessionId(record, envelope);
      const timestamp = recordTimestamp(record, envelope);
      const sourceIdentity = queueSourceIdentityFrom(record, envelope, text);
      const entry = {
        uuid: sourceIdentity || ('claude-queue:' + hashText(text)),
        sourceIdentity,
        role: 'queued',
        timestamp,
        content: text,
        queueStatus: 'queued',
        sessionId,
        ...(recordByteOffsetFrom(envelope) !== null
          ? { recordByteOffset: recordByteOffsetFrom(envelope) }
          : {}),
      };
      return {
        handled: true,
        entries: upsertByUuidOrSource(entries, entry),
        projectedUser: true,
        promptBoundary: false,
      };
    }
    if (record.operation === 'dequeue' || record.operation === 'remove' || record.operation === 'popAll') {
      return {
        handled: true,
        entries: updateQueuedStatus(
          entries,
          record.operation,
          record.content,
          queueSettlementIdentityFrom(record, envelope),
          {
            recordByteOffset: recordByteOffsetFrom(envelope),
            timestamp: recordTimestamp(record, envelope),
          },
        ),
        projectedUser: false,
        promptBoundary: false,
      };
    }
    return {
      handled: true, entries, projectedUser: false, promptBoundary: false,
    };
  }

  const attachmentText = queuedCommandText(record);
  if (record.type === 'attachment' && record?.attachment?.type === 'queued_command') {
    if (!includeUserText || shouldSkipPrompt(attachmentText) || !record.uuid) {
      return {
        handled: true,
        entries,
        projectedUser: false,
        promptBoundary: !shouldSkipPrompt(attachmentText),
      };
    }
    const existingCanonical = entries.some((entry) => entry?.uuid === String(record.uuid));
    const queueMatch = existingCanonical
      ? { entries, removed: null }
      : removeOneMatchingQueue(
          entries,
          attachmentText,
          recordTimestamp(record, envelope),
          {
            allowConsumedPrefix: true,
            sessionId: recordSessionId(record, envelope),
          },
        );
    const inheritedSettlements = Array.isArray(queueMatch.removed?.queueSettlementIdentities)
      ? { queueSettlementIdentities: queueMatch.removed.queueSettlementIdentities }
      : {};
    const inheritedQueueIdentity = queueMatch.removed?.sourceIdentity
      ? { sourceIdentity: queueMatch.removed.sourceIdentity }
      : {};
    return {
      handled: true,
      entries: upsertByUuidOrSource(queueMatch.entries, {
        uuid: String(record.uuid),
        ...(typeof record.sourceIdentity === 'string'
          ? { sourceIdentity: record.sourceIdentity }
          : {}),
        role: 'user',
        timestamp: recordTimestamp(record, envelope),
        content: attachmentText,
        queueStatus: 'sent',
        sessionId: recordSessionId(record, envelope),
        ...(recordByteOffsetFrom(envelope) !== null
          ? { recordByteOffset: recordByteOffsetFrom(envelope) }
          : {}),
        ...inheritedQueueIdentity,
        ...inheritedSettlements,
      }),
      projectedUser: true,
      promptBoundary: true,
    };
  }

  if (record.type === 'user') {
    const content = record?.message?.content;
    const hasToolResult = Array.isArray(content)
      && content.some((block) => block?.type === 'tool_result');
    if (hasToolResult) return {
      handled: false, entries, projectedUser: false, promptBoundary: false,
    };
    const text = ordinaryUserText(record);
    if (!includeUserText || shouldSkipPrompt(text) || !record.uuid) {
      return {
        handled: true,
        entries,
        projectedUser: false,
        promptBoundary: !shouldSkipPrompt(text),
      };
    }
    const existingCanonical = entries.some((entry) => entry?.uuid === String(record.uuid));
    const queueMatch = existingCanonical
      ? { entries, removed: null }
      : removeOneMatchingQueue(entries, text, '', {
          allowConsumedPrefix: true,
          sessionId: recordSessionId(record, envelope),
        });
    const inheritedSettlements = Array.isArray(queueMatch.removed?.queueSettlementIdentities)
      ? { queueSettlementIdentities: queueMatch.removed.queueSettlementIdentities }
      : {};
    const inheritedQueueIdentity = queueMatch.removed?.sourceIdentity
      ? { sourceIdentity: queueMatch.removed.sourceIdentity }
      : {};
    return {
      handled: true,
      entries: upsertByUuidOrSource(queueMatch.entries, {
        uuid: String(record.uuid),
        ...(typeof record.sourceIdentity === 'string'
          ? { sourceIdentity: record.sourceIdentity }
          : {}),
        role: 'user',
        timestamp: recordTimestamp(record, envelope),
        content: text,
        sessionId: recordSessionId(record, envelope),
        ...(recordByteOffsetFrom(envelope) !== null
          ? { recordByteOffset: recordByteOffsetFrom(envelope) }
          : {}),
        ...inheritedQueueIdentity,
        ...inheritedSettlements,
      }),
      projectedUser: true,
      promptBoundary: true,
    };
  }

  return {
    handled: false, entries, projectedUser: false, promptBoundary: false,
  };
}
