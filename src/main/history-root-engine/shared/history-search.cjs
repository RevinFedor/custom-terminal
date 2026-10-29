'use strict';

const HISTORY_SEARCH_PAGE_SIZE = 100;
const HISTORY_SEARCH_TYPES = ['all', 'user', 'assistant', 'user-images'];
const normalizeHistorySearchType = value => HISTORY_SEARCH_TYPES.includes(value) ? value : 'all';
function historySearchEntryKeys(entry, collector) {
  if (!collector) return [...new Set([entry?.uuid, entry?.sourceIdentity, entry?.entryRef?.sourceIdentity,
    ...(entry?.sourceIdentityAliases || []), ...(entry?.uuidAliases || [])].filter(value => typeof value === 'string' && value))];
  const keys = collector?.keys || [], seen = collector?.seen || new Set();
  const add = value => {
    if (typeof value === 'string' && value && !seen.has(value)) { seen.add(value); keys.push(value); }
  };
  add(entry?.uuid); add(entry?.sourceIdentity); add(entry?.entryRef?.sourceIdentity);
  for (const value of entry?.sourceIdentityAliases || []) add(value);
  for (const value of entry?.uuidAliases || []) add(value);
  return keys;
}
function historyEntryHasImages(entry) {
  return Number(entry?.imageCount) > 0 || (Array.isArray(entry?.imagePaths) && entry.imagePaths.length > 0);
}
function historyImageCountFromProviderRecord(record) {
  const payload = record?.message || record?.payload || {};
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const embedded = blocks.filter(part => part?.type === 'image' || part?.type === 'input_image'
    || part?.type === 'image_url' || part?.source?.type === 'base64').length;
  return Math.max(embedded, Array.isArray(payload.images) ? payload.images.length : 0,
    Array.isArray(payload.local_images) ? payload.local_images.length : 0);
}

// Shared by the full main/worker projection and Claude's complete local view.
// Paging bounds returned snippets/offsets, never the total or Timeline marks.
function createHistorySearchAccumulator({ query = '', type = 'all', offset = 0, limit = HISTORY_SEARCH_PAGE_SIZE } = {}, collector) {
  type = normalizeHistorySearchType(type);
  const needle = String(query).toLocaleLowerCase();
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const take = Math.max(1, Math.min(5000, Math.floor(Number(limit) || HISTORY_SEARCH_PAGE_SIZE)));
  const matches = collector?.matches || [], turnKeys = collector?.turnKeys || new Set(), entryUuids = collector?.entryUuids || [];
  const entryKeys = entry => historySearchEntryKeys(entry, collector?.createEntryKeys?.());
  let total = 0, entryTotal = 0, turn = null;
  const accept = (entry, index) => {
    if (!needle && type === 'all') return;
    if (!entry?.uuid) return;
    if (entry.role === 'user' && !entry.serviceCarrier) turn = entryKeys(entry);
    if (type === 'user' && entry.role !== 'user') return;
    if (type === 'assistant' && entry.role !== 'assistant') return;
    if (type === 'user-images' && (entry.role !== 'user' || !historyEntryHasImages(entry))) return;
    const content = String(entry.content || '');
    const text = content.toLocaleLowerCase();
    let at = needle ? text.indexOf(needle) : 0;
    if (at < 0) return;
    entryTotal += 1;
    entryUuids.push(entry.uuid);
    const keys = entry.role === 'user' ? entryKeys(entry) : turn ? (collector?.copyTurnKeys ? collector.copyTurnKeys(turn) : [...turn]) : [];
    keys.forEach(key => turnKeys.add(key));
    const firstMatch = total;
    let occurrence = 0;
    while (at >= 0) {
      const matchIndex = total++;
      if (matchIndex >= start && matches.length < take) {
        const snippetStart = Math.max(0, at - 45), snippetEnd = Math.min(content.length, Math.max(at + needle.length + 90, snippetStart + 140));
        const match = { entryUuid: entry.uuid, entryIndex: index, entryRef: entry.entryRef || null,
          sourceIdentity: entry.sourceIdentity || entry.entryRef?.sourceIdentity || null,
          physicalSessionId: entry.physicalSessionId || entry.sessionId || null,
          offset: at, matchIndex, occurrence, role: entry.role, turnKeys: keys,
          snippet: content.slice(snippetStart, snippetEnd), snippetStart,
          hasImages: historyEntryHasImages(entry) };
        if (collector?.appendMatch) collector.appendMatch(match, entry); else matches.push(match);
      }
      if (!needle) break;
      occurrence += 1;
      at = text.indexOf(needle, at + 1);
    }
    collector?.entryMatches?.(firstMatch, total, keys);
  };
  return { accept, result: () => ({ matches, total, entryTotal, turnKeys: collector ? turnKeys : [...turnKeys], entryUuids, offset: start,
    truncated: start + matches.length < total }) };
}

function searchHistoryEntries(entries, options = {}) {
  const scan = createHistorySearchAccumulator(options);
  for (let index = 0; index < (entries || []).length; index++) scan.accept(entries[index], index);
  return scan.result();
}

module.exports = { HISTORY_SEARCH_PAGE_SIZE, normalizeHistorySearchType, historySearchEntryKeys, historyEntryHasImages, historyImageCountFromProviderRecord, searchHistoryEntries, createHistorySearchAccumulator };
