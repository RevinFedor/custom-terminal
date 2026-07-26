/**
 * Reading anchor for History: which row the user was looking at, not a raw
 * scrollTop. Virtualized row heights are estimates until measured, so a pixel
 * offset stops meaning anything as soon as the list re-measures or rows are
 * prepended. The anchor survives both, and — persisted to localStorage — a
 * full app restart.
 *
 * The module is deliberately NOT a Zustand slice: no component renders from
 * an anchor, all access is imperative (save on scroll idle, read on owner
 * mount), and keeping it out of the store avoids one more churn source.
 */

export interface HistoryReadingAnchor {
  /** Durable uuid of the top-most (partially) visible row. */
  uuid: string;
  /**
   * How many pixels of that row are above the viewport top at save time
   * (>= 0). Restoring aligns the row start to the viewport top and then
   * scrolls down by this amount.
   */
  offsetPx: number;
  /** True when the user was pinned to the tail (follow-bottom mode). */
  followBottom: boolean;
  savedAt: number;
}

const STORAGE_KEY = 'noted-terminal-history-anchors-v1';
const MAX_ANCHORS = 300;
const PERSIST_DEBOUNCE_MS = 400;

let anchors: Map<string, HistoryReadingAnchor> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

const loadAnchors = (): Map<string, HistoryReadingAnchor> => {
  if (anchors) return anchors;
  anchors = new Map();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (
            Array.isArray(item)
            && typeof item[0] === 'string'
            && item[1]
            && typeof item[1].uuid === 'string'
          ) {
            anchors.set(item[0], {
              uuid: item[1].uuid,
              offsetPx: Number.isFinite(item[1].offsetPx) ? Math.max(0, item[1].offsetPx) : 0,
              followBottom: item[1].followBottom === true,
              savedAt: Number.isFinite(item[1].savedAt) ? item[1].savedAt : 0,
            });
          }
        }
      }
    }
  } catch {
    // Corrupt storage falls back to an empty anchor set.
  }
  return anchors;
};

const schedulePersist = () => {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const map = loadAnchors();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(map.entries())));
    } catch {
      // Quota/serialization failures must never break scrolling.
    }
  }, PERSIST_DEBOUNCE_MS);
};

export const getHistoryReadingAnchor = (key: string): HistoryReadingAnchor | undefined =>
  loadAnchors().get(key);

export const setHistoryReadingAnchor = (key: string, anchor: HistoryReadingAnchor): void => {
  const map = loadAnchors();
  // Map insertion order doubles as the LRU list.
  map.delete(key);
  map.set(key, anchor);
  while (map.size > MAX_ANCHORS) {
    const lruKey = map.keys().next().value as string | undefined;
    if (lruKey === undefined) break;
    map.delete(lruKey);
  }
  schedulePersist();
};

export const deleteHistoryReadingAnchor = (key: string): void => {
  if (loadAnchors().delete(key)) schedulePersist();
};

/** Test-only: drop in-memory state so the next call re-reads localStorage. */
export const __resetHistoryReadingAnchorsForTest = (): void => {
  anchors = null;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
};

/** Rows created locally (optimistic prompts, rewind markers) are unstable
 * identities — a durable neighbor makes a better anchor. */
const isLocalRowUuid = (uuid: string): boolean => uuid.startsWith('local-');

export interface CapturedHistoryAnchor {
  uuid: string;
  offsetPx: number;
  followBottom: boolean;
}

/**
 * DOM-derived anchor: the first mounted row whose bottom edge is below the
 * viewport top. Runs on a debounced scroll-idle tick over the mounted
 * (viewport + overscan) rows only, so the cost is a few dozen rect reads.
 */
export const captureHistoryAnchorFromDom = (
  scroller: HTMLElement,
  isTailPinned: boolean,
): CapturedHistoryAnchor | null => {
  const scrollerTop = scroller.getBoundingClientRect().top;
  const rows = scroller.querySelectorAll<HTMLElement>('[data-uuid]');
  let fallback: CapturedHistoryAnchor | null = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= scrollerTop) continue;
    const uuid = row.getAttribute('data-uuid') || '';
    if (!uuid) continue;
    const candidate: CapturedHistoryAnchor = {
      uuid,
      offsetPx: Math.max(0, Math.round(scrollerTop - rect.top)),
      followBottom: isTailPinned,
    };
    if (isLocalRowUuid(uuid)) {
      // Remember the first local row as a fallback but prefer the next
      // durable row (its offset is measured from its own top).
      if (!fallback) fallback = candidate;
      continue;
    }
    return candidate;
  }
  return fallback;
};
