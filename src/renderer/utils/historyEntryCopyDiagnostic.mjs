// Ordinary prompt copying keeps its structured attachments. Only the existing
// Copy ID and details gesture requests diagnostics for an unconfirmed send.
export function historyEntryCopyDiagnostic(entry, tabId, toolType, requestedAt = Date.now()) {
  if (entry?.queueStatus !== 'delivery-unknown'
    || !tabId
    || (toolType !== 'claude' && toolType !== 'codex')) return null;
  return {
    tabId,
    toolType,
    messageId: entry.uuid || null,
    sessionId: entry.sessionId || null,
    handoffId: entry.handoffId || null,
    queueStatus: entry.queueStatus,
    statusReason: entry.statusReason || null,
    statusChangedAt: entry.statusChangedAt ?? null,
    messageTimestamp: entry.timestamp || null,
    requestedAt,
    promptText: typeof entry.content === 'string' ? entry.content : '',
    imagePaths: Array.isArray(entry.imagePaths) ? entry.imagePaths : [],
    chipCount: Array.isArray(entry.promptChips) ? entry.promptChips.length : 0,
  };
}
