'use strict';

function acceptanceObjects(value, depth = 0) {
  if (!value || depth > 4) return [];
  if (typeof value === 'string') {
    try { return acceptanceObjects(JSON.parse(value), depth + 1); } catch { return []; }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return [];
  if (value.messageId && (value.accepted === true || value.message)) return [value];
  const result = [];
  if (value.structuredContent) result.push(...acceptanceObjects(value.structuredContent, depth + 1));
  for (const block of Array.isArray(value.content) ? value.content : []) {
    if (block?.type === 'text') result.push(...acceptanceObjects(block.text, depth + 1));
  }
  return result;
}

/** A source is a tool carrier, never a user quote or a body-text search hit. */
function findTabMessageSourceLocation(message, history) {
  if (!message?.messageId || !message.sourceTabId || !message.sourceSessionId
    || !['claude', 'codex'].includes(message.sourceProvider)) {
    return { success: false, error: 'tab_message_source_identity_unavailable' };
  }
  if (!history?.success) return { success: false, error: history?.error || 'tab_message_source_history_unavailable' };
  if (history.toolType && history.toolType !== message.sourceProvider) {
    return { success: false, error: 'tab_message_source_provider_changed' };
  }
  const wantedMethod = message.kind === 'reply' ? 'reply_to_message' : 'send_message';
  const exact = [], requestOnly = [];
  for (const entry of history.entries || []) {
    if (entry.role !== 'assistant') continue;
    for (const action of entry.actions || []) {
      const raw = action?.rawTool;
      if (raw?.family !== 'mcp' || raw.mcpServer !== 'terminal'
        || raw.mcpMethod !== wantedMethod || !raw.toolUseId) continue;
      const args = raw.args || {};
      if (wantedMethod === 'send_message' && args.tabId !== undefined && args.tabId !== message.targetTabId) continue;
      if (wantedMethod === 'reply_to_message' && args.messageId !== undefined && args.messageId !== message.replyTo) continue;
      if (typeof args.requestId === 'string' && args.requestId !== message.requestId) continue;
      const candidates = acceptanceObjects(raw.result);
      const accepted = candidates.find(body => body.messageId === message.messageId
        && body.ok !== false && body.accepted === true
        && (!body.requestId || body.requestId === message.requestId)
        && (!body.message?.sourceTabId || body.message.sourceTabId === message.sourceTabId)
        && (!body.message?.sourceSessionId || body.message.sourceSessionId === message.sourceSessionId)
        && (!body.message?.targetTabId || body.message.targetTabId === message.targetTabId)
        && (!body.message?.kind || body.message.kind === message.kind)
        && (body.message?.replyTo === undefined || (body.message.replyTo || null) === (message.replyTo || null)));
      const physicalSid = entry.sessionId || history.sessionId;
      if (physicalSid !== message.sourceSessionId && accepted?.message?.sourceSessionId !== message.sourceSessionId) continue;
      const location = { messageId: message.messageId, tabId: message.sourceTabId,
        projectId: message.sourceProjectId || null, toolType: message.sourceProvider,
        sourceSessionId: message.sourceSessionId, readSessionId: history.sessionId,
        entryUuid: entry.uuid, sourceIdentity: entry.sourceIdentity || null,
        toolUseId: raw.toolUseId, method: wantedMethod };
      if (accepted) exact.push({ ...location, proof: 'accepted-message-id', deduplicated: accepted.deduplicated === true });
      else if (!candidates.length && args.requestId && args.requestId === message.requestId) {
        requestOnly.push({ ...location, proof: 'exact-request-id' });
      }
    }
  }
  const initial = exact.filter(row => !row.deduplicated);
  const matches = initial.length ? initial : exact.length ? exact : requestOnly;
  if (matches.length !== 1) return { success: false,
    error: matches.length ? 'tab_message_source_ambiguous' : 'tab_message_source_call_not_found' };
  return { success: true, location: matches[0] };
}

async function resolveTabMessageSourceLocation(messageId, { getMessage, readOwner, readLocation }) {
  const pair = await getMessage(messageId), message = pair?.message;
  if (!message) return { success: false, error: 'tab_message_not_found' };
  const before = await readOwner(message.sourceTabId);
  if (!before?.sessionId || before.toolType !== message.sourceProvider) {
    return { success: false, error: 'tab_message_source_history_unavailable' };
  }
  const identity = { messageId: message.messageId, kind: message.kind, replyTo: message.replyTo,
    sourceTabId: message.sourceTabId, sourceProjectId: message.sourceProjectId,
    sourceProvider: message.sourceProvider, sourceSessionId: message.sourceSessionId,
    targetTabId: message.targetTabId, requestId: message.requestId };
  const result = await readLocation({ message: identity, tabId: message.sourceTabId,
    toolType: before.toolType, sessionId: before.sessionId, cwd: before.cwd || null });
  const after = await readOwner(message.sourceTabId);
  if (after?.sessionId !== before.sessionId || after?.toolType !== before.toolType
    || (after?.cwd || null) !== (before.cwd || null)) {
    return { success: false, error: 'tab_message_source_read_identity_changed' };
  }
  return result;
}

module.exports = { findTabMessageSourceLocation, resolveTabMessageSourceLocation };
