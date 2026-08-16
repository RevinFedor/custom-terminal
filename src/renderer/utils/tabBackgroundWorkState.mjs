/**
 * Accept one main-owned background-work record without letting a delayed
 * startup snapshot roll back a newer event for the same tab.
 *
 * Revisions are intentionally scoped per tab. Activity on another project is
 * unrelated and must never make this tab's snapshot look stale.
 */
export function acceptTabBackgroundWorkRecord(revisions, record) {
  const tabId = String(record?.tabId || '');
  if (!tabId) return null;
  const revision = Number(record?.revision);
  const previousRevision = revisions.get(tabId) ?? -1;
  if (Number.isFinite(revision)) {
    if (revision < previousRevision) return null;
    revisions.set(tabId, revision);
  } else if (previousRevision >= 0) {
    return null;
  }
  return {
    tabId,
    active: (Number(record?.count) || 0) > 0,
  };
}
