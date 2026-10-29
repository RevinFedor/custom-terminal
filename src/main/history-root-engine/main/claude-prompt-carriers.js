'use strict';

const crypto = require('node:crypto');

function extractQueuedCommandPromptText(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    return prompt.map((item) => {
      if (!item) return '';
      if (typeof item === 'string') return item;
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string') return item.content;
      if (typeof item.message === 'string') return item.message;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (prompt && typeof prompt === 'object') {
    if (typeof prompt.text === 'string') return prompt.text;
    if (typeof prompt.content === 'string') return prompt.content;
    if (typeof prompt.message === 'string') return prompt.message;
  }
  return '';
}

function claudeInternalAgentContinuationKind(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text.startsWith('<task-notification>') && text.endsWith('</task-notification>')) {
    return 'task-notification';
  }
  if (/^<agent-message(?:\s[^>]*)?>[\s\S]*<\/agent-message>$/.test(text)) {
    return 'agent-message';
  }
  return null;
}

function claudeInternalAgentContinuationKindFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.type === 'attachment' && entry?.attachment?.type === 'queued_command') {
    if (entry.attachment.commandMode === 'task-notification') return 'task-notification';
    return claudeInternalAgentContinuationKind(
      extractQueuedCommandPromptText(entry.attachment.prompt),
    );
  }
  if (entry.type !== 'user') return null;
  const content = entry.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.find((item) => item?.type === 'text' && typeof item.text === 'string')?.text
      : '';
  return claudeInternalAgentContinuationKind(text);
}

function extractClaudeQueueOperationPromptText(entry) {
  if (entry?.type !== 'queue-operation' || entry?.operation !== 'enqueue') return null;
  const text = typeof entry.content === 'string' ? entry.content : '';
  return text.trim() ? text : null;
}

/**
 * Stable identity for the provider-owned queue row. Claude normally gives the
 * enqueue record a UUID; byte position is the exact fallback for older rows.
 * The same identity is attached to the durable History projection so an
 * app-owned optimistic prompt can be consumed after renderer/app restart.
 */
function claudeQueuePromptSourceIdentity(entry, {
  sessionId = null,
  recordByteOffset = null,
} = {}) {
  if (entry?.type !== 'queue-operation' || entry?.operation !== 'enqueue') return null;
  const entryUuid = typeof entry.uuid === 'string' ? entry.uuid.trim() : '';
  if (entryUuid) return 'claude-queue:uuid:' + entryUuid;
  const exactSessionId = String(
    entry.sessionId || entry.session_id || sessionId || '',
  ).trim();
  const offset = Number(recordByteOffset ?? entry.__byteOffset);
  if (!exactSessionId || !Number.isSafeInteger(offset) || offset < 0) return null;
  return 'claude-queue:offset:' + exactSessionId + ':' + offset;
}

function isClaudeTaskNotificationCarrier(entry) {
  if (entry?.type === 'attachment'
    && entry?.attachment?.type === 'queued_command'
    && entry.attachment.commandMode === 'task-notification') return true;
  return claudeInternalAgentContinuationKindFromEntry(entry) === 'task-notification';
}

function isClaudeInternalAgentContinuationCarrier(entry) {
  if (entry?.type === 'attachment'
    && entry?.attachment?.type === 'queued_command'
    && entry.attachment.commandMode === 'task-notification') return true;
  return claudeInternalAgentContinuationKindFromEntry(entry) !== null;
}

function extractClaudePromptCarrier(entry) {
  // Claude's own async Agent/Task completion is persisted in the same
  // queued_command envelope as a real user message, but it is not a new user
  // intent.  The assistant records that follow it continue the turn which
  // launched that exact tool.  Treating this service carrier as a prompt
  // splits one orchestration result into several fake turns and leaves the
  // originating run permanently "incomplete" even after end_turn.
  if (isClaudeInternalAgentContinuationCarrier(entry)) return null;
  if (entry?.type === 'attachment' && entry?.attachment?.type === 'queued_command') {
    const text = extractQueuedCommandPromptText(entry.attachment.prompt);
    if (!text.trim()) return null;
    return {
      kind: 'queued_command',
      text,
      uuid: entry.uuid || null,
      timestamp: entry.timestamp || null,
    };
  }
  if (entry?.type !== 'user') return null;
  // Claude persists tool-produced UI payloads (for example screenshot
  // references) as `user` records with isMeta=true.  They are part of the
  // current model turn, not a new prompt.  Treating one as a carrier splits
  // the turn and can leave the exact originating prompt looking incomplete
  // even though a later assistant record has stop_reason=end_turn.
  if (entry.isMeta === true) return null;
  const content = entry.message?.content;
  if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) return null;
  let text = null;
  if (typeof content === 'string') text = content;
  if (Array.isArray(content)) {
    const block = content.find((item) => item?.type === 'text' && typeof item.text === 'string');
    text = block?.text || null;
  }
  if (text == null) return null;
  return {
    kind: entry.isCompactSummary === true ? 'compact_summary' : 'user',
    text,
    uuid: entry.uuid || null,
    timestamp: entry.timestamp || null,
  };
}

// Observability only: do not change which text the production carrier reads.
// This shape needs real provider evidence before changing delivery semantics.
function isClaudeMultitextPromptCarrier(entry) {
  const content = entry?.message?.content;
  if (entry?.type !== 'user' || entry.isMeta === true || !Array.isArray(content)) return false;
  let nonEmptyTextParts = 0;
  for (const block of content) {
    if (block?.type === 'tool_result') return false;
    if (block?.type === 'text' && typeof block.text === 'string' && /\S/u.test(block.text)) {
      nonEmptyTextParts += 1;
    }
  }
  return nonEmptyTextParts >= 2;
}

function describeClaudeMultitextPromptCarrier(entry, { hashText } = {}) {
  if (!isClaudeMultitextPromptCarrier(entry)) return null;
  const hash = hashText || ((text) => crypto.createHash('sha256').update(text).digest('hex'));
  const content = entry.message.content;
  const maxParts = 64;
  const imageSampleChars = 32 * 1024;
  let textParts = 0;
  let nonEmptyTextParts = 0;
  let imageParts = 0;
  const parts = [];
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    if (block?.type === 'text') {
      textParts += 1;
      if (typeof block.text === 'string' && /\S/u.test(block.text)) nonEmptyTextParts += 1;
    }
    if (block?.type === 'image') imageParts += 1;
    if (index >= maxParts) continue;
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push({ index, type: 'text', length: block.text.length,
        utf8Bytes: Buffer.byteLength(block.text, 'utf8'), hash: hash(block.text),
        roleHint: /^\s*\[Image(?: source:|:)/u.test(block.text) ? 'image-metadata'
          : /^\s*<(?:system-reminder|ide_selection)(?:>|\s)/u.test(block.text) ? 'context-tag'
            : 'unclassified' });
    } else if (block?.type === 'image') {
      const source = block.source || {};
      const data = typeof source.data === 'string' ? source.data : null;
      // Never decode/copy an entire base64 image just to diagnose a text
      // boundary. The bounded sample is explicitly NOT an attachment proof.
      const sampled = data !== null && data.length > imageSampleChars * 2;
      const imageHash = data === null ? null : sampled
        ? hash(data.slice(0, imageSampleChars) + '\0' + data.slice(-imageSampleChars))
        : hash(data);
      parts.push({ index, type: 'image',
        sourceType: source.type === 'base64' || source.type === 'url' ? source.type : 'other',
        mediaType: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(source.media_type)
          ? source.media_type : null,
        encodedLength: data?.length ?? null, hash: imageHash,
        hashScope: data === null ? 'unavailable' : sampled ? 'encoded-head-tail-32KiB' : 'encoded-full',
      });
    } else {
      parts.push({ index, type: block?.type === 'document' ? 'document' : 'other' });
    }
  }
  return { partCount: content.length, textParts, nonEmptyTextParts, imageParts,
    partsTruncated: content.length > maxParts, parts };
}

function promptFingerprint(value) {
  const normalized = String(value || '').replace(/\r\n/g, '\n').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Finds the one synthetic queue row replaced by a durable Claude prompt.
 * Exact timestamp/session wins; otherwise the oldest same-text row wins.
 * Walking from the end is incorrect when two identical prompts are queued.
 */
function selectClaudeQueuedPromptIndex(
  pendingEntries,
  { text, timestamp = '', sessionId = '', normalizeText = (value) => String(value || '').trim() },
) {
  const normalized = normalizeText(text);
  if (!normalized) return -1;
  const expectedTimestamp = String(timestamp || '');
  const expectedSessionId = String(sessionId || '');
  const candidates = (Array.isArray(pendingEntries) ? pendingEntries : [])
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      if (entry?.queueStatus === 'cancelled') return false;
      if (normalizeText(entry?.content) !== normalized) return false;
      const candidateSessionId = String(entry?.sessionId || '');
      return !expectedSessionId || !candidateSessionId || candidateSessionId === expectedSessionId;
    });
  if (expectedTimestamp) {
    const exact = candidates.find(({ entry }) => (
      String(entry?.timestamp || '') === expectedTimestamp
    ));
    if (exact) return exact.index;
  }
  return candidates[0]?.index ?? -1;
}

function findMatchingClaudePromptTurn({
  turns,
  recordMap,
  promptHash,
  promptUserUuid,
  requestedAt,
  resultAfterAt,
  resultBeforeAt,
}) {
  const latestAfter = Number(resultAfterAt) > 0 ? Number(resultAfterAt) : 0;
  const upperBound = Number(resultBeforeAt) > 0 ? Number(resultBeforeAt) : 0;
  const lowerBound = latestAfter
    || (Number(requestedAt) > 0 ? Number(requestedAt) - 5 * 60 * 1000 : 0);
  const rows = Array.isArray(turns) ? turns : [];

  // A prompt audit UUID is the durable identity of the exact external turn.
  // Never fall back to same-text matching when that proof exists: a missing UUID
  // means the exact turn has not materialized in this snapshot yet.
  if (promptUserUuid) {
    const turnIndex = rows.findIndex((turn) => (
      (turn?.kind === 'user' || turn?.kind === 'queued_command')
      && turn.userUuid === promptUserUuid
    ));
    return turnIndex >= 0 ? { turn: rows[turnIndex], turnIndex } : null;
  }

  const hashMatches = [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const turn = rows[index];
    if ((turn?.kind !== 'user' && turn?.kind !== 'queued_command') || !turn.userUuid) continue;
    const timestampMs = Date.parse(turn.userTimestamp || '');
    if ((lowerBound || upperBound) && !Number.isFinite(timestampMs)) continue;
    if (lowerBound && Number.isFinite(timestampMs) && timestampMs < lowerBound) continue;
    if (upperBound && Number.isFinite(timestampMs) && timestampMs > upperBound) continue;
    if (latestAfter) {
      if (!Array.isArray(turn.assistantUuids) || turn.assistantUuids.length === 0) continue;
    } else {
      const record = recordMap?.get?.(turn.userUuid);
      const carrier = extractClaudePromptCarrier(record);
      if (!carrier?.text || promptFingerprint(carrier.text) !== promptHash) continue;
      hashMatches.push({ turn, turnIndex: index });
      continue;
    }
    return { turn, turnIndex: index };
  }
  return hashMatches.length === 1 ? hashMatches[0] : null;
}

module.exports = {
  describeClaudeMultitextPromptCarrier,
  isClaudeMultitextPromptCarrier,
  claudeQueuePromptSourceIdentity,
  claudeInternalAgentContinuationKind,
  claudeInternalAgentContinuationKindFromEntry,
  extractClaudeQueueOperationPromptText,
  extractClaudePromptCarrier,
  extractQueuedCommandPromptText,
  findMatchingClaudePromptTurn,
  isClaudeInternalAgentContinuationCarrier,
  isClaudeTaskNotificationCarrier,
  promptFingerprint,
  selectClaudeQueuedPromptIndex,
};
