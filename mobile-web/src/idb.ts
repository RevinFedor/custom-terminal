// IndexedDB record-level cache for chat history.
//
// Why per-record instead of one blob:
//   1. iOS Safari localStorage silently wipes at ~2.5 MB (Apple Forum #715380).
//      IndexedDB on iOS 17+ gets ~60% of disk — gigabytes.
//   2. Reading 5000 records from IDB returns 5000 live objects via structured
//      clone — no JSON.parse on the hot path. A 20 MB JSON blob would take
//      ~30 ms to parse on phone CPU every cold open.
//   3. Delta sync becomes trivial: read `meta.lastUuid`, fetch
//      `/history?after=<lastUuid>`, IDB-put the new messages. No full rewrite.
//
// Stores:
//   meta: { sessionId (key), lastUuid, etag, total, updatedAt }
//   messages: { [sessionId, ord] (key), uuid (index), payload }
//
// We key messages by (sessionId, ordinal) so iteration via getAll() returns
// them in insertion order without needing a separate timestamp index. `uuid`
// is a secondary index for GoTo lookup.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

const DB_NAME = 'noted-mobile';
// v2 adds the `kv` store (generic JSON blobs keyed by string) — used for the
// projects-list and per-project tabs-list snapshots that drive instant
// (stale-while-revalidate) navigation. Additive upgrade: existing chat-history
// stores (meta/messages) are untouched, so bumping the version does NOT wipe
// the user's cached conversations.
const DB_VERSION = 2;

interface NotedDB extends DBSchema {
  meta: {
    key: string; // sessionId
    value: {
      sessionId: string;
      lastUuid: string | null;
      etag: string;
      total: number;
      updatedAt: number;
    };
  };
  messages: {
    key: [string, number]; // [sessionId, ord]
    value: {
      sessionId: string;
      ord: number;
      uuid: string | null;
      payload: any; // SDK message object
    };
    indexes: {
      'by-uuid': string;
    };
  };
  kv: {
    key: string; // e.g. 'projects', 'tabs:<projectId>'
    value: {
      key: string;
      payload: any; // arbitrary JSON snapshot
      updatedAt: number;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<NotedDB>> | null = null;
function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<NotedDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'sessionId' });
        }
        if (!db.objectStoreNames.contains('messages')) {
          const store = db.createObjectStore('messages', { keyPath: ['sessionId', 'ord'] });
          store.createIndex('by-uuid', 'uuid');
        }
        // v2: generic kv store for projects/tabs snapshots (SWR).
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv', { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

export async function readCachedHistory(sessionId: string): Promise<{
  meta: NotedDB['meta']['value'] | null;
  messages: any[];
}> {
  const db = await getDb();
  const meta = (await db.get('meta', sessionId)) ?? null;
  if (!meta) return { meta: null, messages: [] };
  // getAll with bound range returns insertion order because the key is
  // [sessionId, ord] and IDB iterates compound keys lexicographically.
  const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
  const rows = await db.getAll('messages', range);
  return { meta, messages: rows.map((r) => r.payload) };
}

// Write/replace ALL messages for a session. Use after initial NDJSON stream
// completes — the tx wipes existing rows for this session then re-inserts.
// Single transaction, so partial-write crash leaves the previous snapshot
// intact (rollback semantics).
export async function writeFullHistory(
  sessionId: string,
  messages: any[],
  etag: string,
  total: number,
  lastUuid: string | null,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['meta', 'messages'], 'readwrite');

  // Clear old messages for this session. IDB has no per-key-prefix clear so
  // we iterate via cursor on the bounded range.
  const msgStore = tx.objectStore('messages');
  const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
  let cur = await msgStore.openCursor(range);
  while (cur) {
    await cur.delete();
    cur = await cur.continue();
  }

  // Insert new messages with monotonic ord.
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    await msgStore.put({
      sessionId,
      ord: i,
      uuid: typeof m?.uuid === 'string' ? m.uuid : null,
      payload: m,
    });
  }
  await tx.objectStore('meta').put({
    sessionId,
    lastUuid,
    etag,
    total,
    updatedAt: Date.now(),
  });
  await tx.done;
}

// Append delta — messages strictly after the current lastUuid. Used after
// `?after=<lastUuid>` returns new messages.
export async function appendDelta(
  sessionId: string,
  newMessages: any[],
  etag: string,
  total: number,
  newLastUuid: string | null,
): Promise<void> {
  if (newMessages.length === 0) {
    // Even if no new messages, update etag/updatedAt so next revalidate sees
    // a fresh timestamp (don't kick off another delta-fetch immediately).
    const db = await getDb();
    const existing = await db.get('meta', sessionId);
    if (existing) {
      existing.etag = etag;
      existing.updatedAt = Date.now();
      await db.put('meta', existing);
    }
    return;
  }
  const db = await getDb();
  const tx = db.transaction(['meta', 'messages'], 'readwrite');
  const msgStore = tx.objectStore('messages');

  // Find current max ord for this session via reverse cursor.
  let nextOrd = 0;
  const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
  const cur = await msgStore.openCursor(range, 'prev');
  if (cur) nextOrd = cur.key[1] + 1;

  for (const m of newMessages) {
    await msgStore.put({
      sessionId,
      ord: nextOrd++,
      uuid: typeof m?.uuid === 'string' ? m.uuid : null,
      payload: m,
    });
  }
  await tx.objectStore('meta').put({
    sessionId,
    lastUuid: newLastUuid,
    etag,
    total,
    updatedAt: Date.now(),
  });
  await tx.done;
}

// Wipe a session's cache. Called on 404 or explicit clear.
export async function dropSession(sessionId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['meta', 'messages'], 'readwrite');
  await tx.objectStore('meta').delete(sessionId);
  const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
  let cur = await tx.objectStore('messages').openCursor(range);
  while (cur) {
    await cur.delete();
    cur = await cur.continue();
  }
  await tx.done;
}

// ─────────── Generic kv snapshots (SWR for projects/tabs) ───────────
// Stale-while-revalidate: read the last snapshot synchronously-ish (one IDB
// get) to paint instantly, then the caller revalidates in the background and
// overwrites. Keys: 'projects', 'tabs:<projectId>'.

export async function readKv<T = any>(key: string): Promise<{ payload: T; updatedAt: number } | null> {
  try {
    const db = await getDb();
    const row = await db.get('kv', key);
    return row ? { payload: row.payload as T, updatedAt: row.updatedAt } : null;
  } catch {
    return null; // IDB unavailable (private mode etc.) — caller falls back to network
  }
}

export async function writeKv(key: string, payload: any): Promise<void> {
  try {
    const db = await getDb();
    await db.put('kv', { key, payload, updatedAt: Date.now() });
  } catch {
    // best-effort; cache miss next time is acceptable
  }
}

// Best-effort storage estimate. Returns null on browsers without the API.
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const est = await navigator.storage.estimate();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch {
    return null;
  }
}
