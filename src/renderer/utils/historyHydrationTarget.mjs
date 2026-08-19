/**
 * Hydration identity is an ENTRY property. Display-unit indices cannot answer
 * it because grouping compresses many raw entries into one visual row.
 */
export function isHistoryHydrationTargetStub(entries, targetUuid) {
  if (!targetUuid || !Array.isArray(entries)) return false;
  return entries.some((entry) => entry?.uuid === targetUuid && entry?.rowStub === true);
}
