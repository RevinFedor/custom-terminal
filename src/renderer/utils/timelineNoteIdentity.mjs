import identity from '../../shared/history-entry-identity.cjs';

// A saved note read resolves the physical UUID for a currently displayed live
// point. Keep that exact address during subsequent live/canonical convergence.
export function projectTimelineNoteAnchors(entries, anchors) {
  if (!anchors?.length) return entries;
  return entries.map(entry => {
    const matches = anchors.filter(anchor => anchor.sessionId === entry.sessionId && (
      identity.historyEntryHasExactIdentity(anchor, entry.uuid)
      || (entry.sourceIdentity && identity.historyEntryHasExactIdentity(anchor, entry.sourceIdentity))
      || (entry.sourceIdentityAliases || []).some(source => identity.historyEntryHasExactIdentity(anchor, source))
    ));
    if (matches.length !== 1 || matches[0].uuid === entry.uuid) return entry;
    return { ...entry, uuid: matches[0].uuid,
      sourceUuidAliases: [...new Set([...(entry.sourceUuidAliases || []), entry.uuid])] };
  });
}
