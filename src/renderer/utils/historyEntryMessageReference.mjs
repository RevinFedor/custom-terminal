import historyPrimaryRollout from '../../shared/history-primary-rollout.cjs';
import { heldHistoryPrimaryRootLease } from './historyPrimaryHeldRootRegistry.mjs';
import { heldTimelineView, isExplicitLegacyTimelineOwner } from './timelineViewReadModel.mjs';
import { normalizeTerminalMessageTarget } from '../../shared/terminal-message-reference.mjs';
import { timelineMessageSnapshotCache, makeTimelineSnapshotKey } from './timelineSnapshotCache.mjs';
import { historyEntryHasExactIdentity } from '../../shared/history-entry-identity.mjs';

export function copiedHistoryMessageIteration(rows, entry, owner, eligible) {
  if (!['user', 'assistant'].includes(entry.role)) return null;
  const held = heldTimelineView(owner);
  if (!held && owner.toolType === 'codex' && typeof window !== 'undefined' && typeof window.require === 'function'
    && historyPrimaryRollout.historyPrimaryRootEnabled(window.require('node:process').env)
    && !isExplicitLegacyTimelineOwner(owner)) return null;
  if (held && !held.current) return null;
  if (held?.current) {
    // Both roots must already be held. The reader resolves a preceding user
    // in paged History metadata, then the paged eligible Timeline ordinal.
    return (async () => {
      const client = held.current.client, release = client.retain();
      try {
        const historyRootLease = heldHistoryPrimaryRootLease(owner);
        if (!historyRootLease) return null;
        const result = await client.query('iteration', { historyRootLease,
          historyEntryIdentity: entry.sourceIdentity || entry.uuid });
        return Number.isSafeInteger(result.ordinal) && result.ordinal > 0 ? result.ordinal : null;
      } catch (error) { console.warn('[TimelineRoot] copy-iteration-unavailable code=' + String(error?.code || error?.message)); return null; }
      finally { await release(); }
    })();
  }
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
