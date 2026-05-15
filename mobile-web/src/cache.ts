// localStorage chat cache. Survives forever (until LRU eviction or version bump).
//
// Goals:
//   1. Open old chat → show last seen state INSTANTLY (no 20s wait).
//   2. Always parallel-fetch fresh in the background, swap when arrives.
//   3. Don't write on every WS message — batch on unmount + beforeunload.
//   4. Bound storage: max 10 chats, LRU eviction, truncate huge tool outputs.
//
// What about iOS private mode? localStorage throws on write — wrap in try/catch
// and silently degrade (no cache, but app still works).

import type { UiEntry } from './messages';
import type { TimelineEntry } from './api';

const CACHE_KEY = 'noted-chat-cache:v1';
const MAX_CHATS = 10;
// Hard limit per individual tool result before save — gigabyte greps would
// otherwise fill the 5MB quota with one entry.
const TOOL_RESULT_TRUNCATE = 1024;

export type ChatCacheEntry = {
  entries: UiEntry[];
  timelineEntries: TimelineEntry[] | null;
  sessionId: string | undefined;
  savedAt: number;
};

type CacheMap = Record<string, ChatCacheEntry>;

function readAll(): CacheMap {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function writeAll(map: CacheMap) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(map));
  } catch (e) {
    // QuotaExceededError or private-mode throw — try to evict more aggressively.
    const tabIds = Object.keys(map).sort((a, b) => map[a].savedAt - map[b].savedAt);
    while (tabIds.length > 3) {
      delete map[tabIds.shift()!];
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(map));
        return;
      } catch {}
    }
    // Still failing → give up silently. Cache is best-effort.
  }
}

export function loadChat(tabId: string): ChatCacheEntry | null {
  const all = readAll();
  return all[tabId] || null;
}

export function saveChat(tabId: string, data: Omit<ChatCacheEntry, 'savedAt'>) {
  const all = readAll();

  // Truncate tool entries — they can dominate size on grep/large file reads.
  const trimmedEntries = data.entries.map((e) => {
    if (e.kind === 'tool' && typeof e.result === 'string' && e.result.length > TOOL_RESULT_TRUNCATE) {
      return { ...e, result: e.result.slice(0, TOOL_RESULT_TRUNCATE) + '\n…' };
    }
    return e;
  });
  const trimmedTimeline = (data.timelineEntries || []).map((t) => ({
    ...t,
    // Timeline `tools` arrays carry results too — truncate same way.
    tools: t.tools.map((tl) => ({
      ...tl,
      result: tl.result && tl.result.length > TOOL_RESULT_TRUNCATE
        ? tl.result.slice(0, TOOL_RESULT_TRUNCATE) + '\n…'
        : tl.result,
    })),
    // Full text is fine — capped at 220 in preview anyway, and `full` is what
    // gives expand value. Don't truncate.
  }));

  all[tabId] = {
    entries: trimmedEntries,
    timelineEntries: trimmedTimeline,
    sessionId: data.sessionId,
    savedAt: Date.now(),
  };

  // LRU eviction: keep N most-recently-saved.
  const ids = Object.keys(all);
  if (ids.length > MAX_CHATS) {
    ids.sort((a, b) => all[b].savedAt - all[a].savedAt);
    for (const id of ids.slice(MAX_CHATS)) delete all[id];
  }

  writeAll(all);
}

export function dropChat(tabId: string) {
  const all = readAll();
  if (!all[tabId]) return;
  delete all[tabId];
  writeAll(all);
}
