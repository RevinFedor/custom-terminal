import { normalizeTerminalMessageTarget } from '../../shared/terminal-message-reference.mjs';
import { timelineMessageSnapshotCache, makeTimelineSnapshotKey } from './timelineSnapshotCache.mjs';
import { historyEntryHasExactIdentity } from '../../shared/history-entry-identity.mjs';

export function copiedHistoryMessageIteration(rows, entry, owner, eligible) {
  if (!['user', 'assistant'].includes(entry.role)) return null;
  const index = rows.findIndex(row => row.uuid === entry.uuid);
  if (index < 0) return null;
  let user = null;
  for (let at = index; at >= 0; at--) if (rows[at].role === 'user') { user = rows[at]; break; }
  if (!user) return null;
  const snapshot = timelineMessageSnapshotCache.peek(makeTimelineSnapshotKey(owner));
  if (!snapshot) return null; // never fetch Timeline to produce a label
  let ordinal = 0;
  for (const candidate of snapshot.entries) {
    if (!candidate.uuid || candidate.isSentHandoffProjection
      || candidate.semanticTags?.some(tag => tag.kind === 'orchestration') || !eligible(candidate)) continue;
    ordinal++;
    if (historyEntryHasExactIdentity(user, candidate.uuid)) return ordinal;
  }
  return null;
}

export function historyEntryMessageReference(entry, { tabId, tabName, provider, iteration = null,
  readSessionId, referenceId, timeLabel } = {}) {
  const ref = entry?.entryRef || {};
  const source = normalizeTerminalMessageTarget({
    tabId, tabName, provider, iteration, timeLabel,
    messageId: entry?.uuid, sessionId: entry?.sessionId,
    physicalSessionId: ref.physicalSessionId || entry?.physicalSessionId,
    rawUuid: ref.rawUuid || entry?.rawUuid,
    viewOwnerSessionId: readSessionId || ref.viewOwnerSessionId || entry?.viewOwnerSessionId,
    transcriptSegmentId: ref.segmentId || entry?.transcriptSegmentId,
    sourceIdentity: ref.sourceIdentity || entry?.sourceIdentity,
    handoffId: entry?.handoffId,
    messageTimestamp: entry?.timestamp, role: entry?.role,
  });
  return source && referenceId ? { source, referenceId } : null;
}
