'use strict';

const { historyEntryHasExactIdentity } = require('../shared/history-entry-identity.cjs');

async function resolveTimelineNoteAnchor(request, readTimeline) {
  const { entryUuid, sessionId, sourceIdentity } = request;
  if (!String(entryUuid || '').startsWith('codex-live-')) return { success: true, entryUuid };
  // Live UUIDs contain a watcher-local sequence, not a persisted address.
  // Resolve ONLY the physical source identity published with that point.
  const exactSource = ['user', 'compact'].some(kind => {
    const prefix = 'codex-' + kind + '-source-' + sessionId + '-';
    return String(sourceIdentity || '').startsWith(prefix)
      && /^[0-9]+$/.test(sourceIdentity.slice(prefix.length));
  });
  if (!sessionId || !entryUuid.startsWith('codex-live-' + sessionId + '-') || !exactSource) {
    return { success: false, error: 'timeline_note_source_identity_required' };
  }
  const result = await readTimeline({ sessionId, cwd: request.cwd, tabId: request.tabId, toolType: 'codex' });
  if (result?.success !== true) return { success: false, error: result?.error || 'timeline_note_source_unavailable' };
  const matches = (result.entries || []).filter(entry => (
    (entry.type === 'user' || entry.type === 'compact' || entry.role === 'user' || entry.role === 'compact')
    && historyEntryHasExactIdentity(entry, sourceIdentity)
    && !String(entry.uuid || '').startsWith('codex-live-')
  ));
  if (matches.length !== 1) return { success: false, error: 'timeline_note_source_unresolved' };
  const entry = matches[0];
  return { success: true, entryUuid: entry.uuid, anchor: {
    uuid: entry.uuid, sessionId, sourceIdentity: entry.sourceIdentity,
    sourceIdentityAliases: entry.sourceIdentityAliases || [], sourceUuidAliases: [entryUuid],
  } };
}

module.exports = { resolveTimelineNoteAnchor };
