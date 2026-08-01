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

function isClaudeTaskNotificationCarrier(entry) {
  if (!entry || typeof entry !== 'object') return false;

  if (entry.type === 'attachment' && entry?.attachment?.type === 'queued_command') {
    const text = extractQueuedCommandPromptText(entry.attachment.prompt).trimStart();
    return entry.attachment.commandMode === 'task-notification'
      || text.startsWith('<task-notification>');
  }

  if (entry.type !== 'user') return false;
  const content = entry.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.find((item) => item?.type === 'text' && typeof item.text === 'string')?.text
      : '';
  return String(text || '').trimStart().startsWith('<task-notification>');
}

function extractClaudePromptCarrier(entry) {
  // Claude's own async Agent/Task completion is persisted in the same
  // queued_command envelope as a real user message, but it is not a new user
  // intent.  The assistant records that follow it continue the turn which
  // launched that exact tool.  Treating this service carrier as a prompt
  // splits one orchestration result into several fake turns and leaves the
  // originating run permanently "incomplete" even after end_turn.
  if (isClaudeTaskNotificationCarrier(entry)) return null;
  if (entry?.type === 'attachment' && entry?.attachment?.type === 'queued_command') {
    const text = extractQueuedCommandPromptText(entry.attachment.prompt).trim();
    if (!text) return null;
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
  extractClaudePromptCarrier,
  extractQueuedCommandPromptText,
  findMatchingClaudePromptTurn,
  isClaudeTaskNotificationCarrier,
  promptFingerprint,
  selectClaudeQueuedPromptIndex,
};
