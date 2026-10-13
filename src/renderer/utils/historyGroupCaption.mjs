import { historyEntryHasExactIdentity } from '../../shared/history-entry-identity.mjs';

/** Selection is exact row identity, never body text or display position. */
export const historyGroupCaptionIdentity = entry => [entry?.sourceIdentity, entry?.uuid]
  .find(value => typeof value === 'string' && value.trim()) || null;

export function resolveHistoryGroupCaption(entries, identity = null) {
  const captions = Array.isArray(entries) ? entries : [];
  const found = identity ? captions.findIndex(entry => historyEntryHasExactIdentity(entry, identity)) : -1;
  const index = found >= 0 ? found : captions.length - 1;
  return { entry: captions[index] || null, index, count: captions.length };
}

export function previousHistoryGroupCaption(entries, identity = null) {
  const current = resolveHistoryGroupCaption(entries, identity);
  if (!current.count) return current;
  const index = (current.index - 1 + current.count) % current.count;
  return { entry: entries[index], index, count: current.count };
}

/** Small view-only hint for the existing hydration owner. No bodies retained. */
export function rememberHistoryGroupCaption(selections, groupKey, identity) {
  if (typeof groupKey !== 'string' || !groupKey || typeof identity !== 'string' || !identity) return;
  selections.delete(groupKey);
  selections.set(groupKey, identity);
  while (selections.size > 256) selections.delete(selections.keys().next().value);
}
