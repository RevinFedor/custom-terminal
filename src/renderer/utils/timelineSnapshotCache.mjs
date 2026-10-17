// Remount acceleration is bounded independently from a mounted Timeline's
// current snapshot. A live owner already retains its rows; evicting the shared
// entry must not throw away the matching revision and force a cold main parse.
export function createTimelineSnapshotCache({ maxOwners = 8, maxEntries = 20_000 } = {}) {
  const records = new Map();
  let entries = 0;
  const peek = key => records.get(key) || null;
  const get = key => {
    const record = peek(key);
    if (record) { records.delete(key); records.set(key, record); }
    return record;
  };
  const set = (key, record) => {
    if (!key) return;
    const previous = records.get(key);
    if (previous) { entries -= previous.entries.length; records.delete(key); }
    records.set(key, record); entries += record.entries.length;
    while (records.size > maxOwners || entries > maxEntries) {
      const first = records.keys().next().value;
      if (first === undefined) break;
      entries -= records.get(first).entries.length; records.delete(first);
    }
  };
  return { get, peek, set, size: () => records.size, entryCount: () => entries };
}

export function makeTimelineSnapshotKey({ tabId, toolType, sessionId = '', cwd = '' } = {}) {
  return JSON.stringify({
    tabId: String(tabId || ''),
    toolType: String(toolType || ''),
    sessionId: String(sessionId || ''),
    cwd: String(cwd || ''),
  });
}

// The same accepted bounded cache, also read at an explicit Copy action. No
// second cache, row subscription, reader or retention policy for message chips.
export const timelineMessageSnapshotCache = createTimelineSnapshotCache();

export function createTimelineSnapshotOwner(cache, ownerKey) {
  // One reference to the accepted snapshot, no duplicate array or second
  // revision clock. The React owner recreates this holder on its exact key.
  let retained = null;
  return {
    peek: () => retained || cache.peek(ownerKey),
    read: () => retained || (retained = cache.get(ownerKey)),
    remember: record => { retained = record; cache.set(ownerKey, record); },
    source: () => retained ? 'owner' : cache.peek(ownerKey) ? 'remount' : 'none',
  };
}
