/**
 * Per-owner cache of Virtuoso's MEASURED row geometry.
 *
 * Why this exists
 * ---------------
 * The panel is a single instance that swaps owners, and the list is keyed by
 * owner — so every tab return threw away the measured sizes and re-derived the
 * position from ESTIMATED heights. The convergence loop then hunted for the
 * anchor one frame at a time: measured in prod (26.07) at 6 attempts / ~90ms
 * on an even-height session versus 12-29 attempts / 470-1100ms on a session
 * with wildly uneven rows. The delay tracked *height variance*, not row count
 * — all three fixtures painted the same 12 rows.
 *
 * Handing Virtuoso back its own measurements removes the hunt: it can place
 * the anchor from real geometry instead of guessing and correcting.
 *
 * What is stored is a pure display accelerator: row sizes and a scroll offset.
 * It is never a source of truth about content, so a miss or a stale entry can
 * only cost the old convergence path, never a wrong transcript.
 *
 * Persisted to localStorage (debounced) for the same reason the reading anchor
 * is: the dev cycle restarts the app constantly, and without the geometry the
 * first return to every heavy tab pays the full anchor hunt — measured live
 * (04.08, 20:21 МСК) at 13 jumps / 1481ms of chopped long tasks versus an
 * instant drift=0 restore when geometry existed. Ranges are per size RANGE,
 * not per row (a 2618-row session stored 26 ranges), so the payload is tiny.
 */

/** Mirrors Virtuoso's StateSnapshot without importing its types here. */
export interface HistoryMeasuredSnapshot {
  ranges: unknown[];
  scrollTop: number;
}

interface StoredLayout {
  snapshot: HistoryMeasuredSnapshot;
  /** Row count when measured — a large delta invalidates the geometry. */
  itemCount: number;
  savedAt: number;
}

/**
 * Owners are tabs; a handful covers realistic back-and-forth. Each entry holds
 * one number per measured size RANGE (not per row), so this stays small even
 * for thousand-message sessions.
 */
const MAX_OWNERS = 12;

/**
 * Rows arriving while you were away are normal and must not drop the cache —
 * Virtuoso re-measures the tail itself. A big jump means a different shape
 * (rewind, edit, branch switch) and the old geometry no longer describes it.
 */
const MAX_ITEM_DELTA = 200;

const STORAGE_KEY = 'noted-terminal-history-measured-layout-v1';
const PERSIST_DEBOUNCE_MS = 400;
/** Row geometry drifts with content edits and font changes; a week-old
 * snapshot of a heavy session is still a better starting guess than estimated
 * heights, but a month-old one likely describes different rows. */
const MAX_STORED_AGE_MS = 14 * 24 * 60 * 60 * 1000;

let store: Map<string, StoredLayout> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

const isValidRange = (range: unknown): boolean => {
  const r = range as { startIndex?: unknown; endIndex?: unknown; size?: unknown };
  return !!r
    && Number.isFinite(r.startIndex)
    && Number.isFinite(r.endIndex)
    && Number.isFinite(r.size);
};

const loadStore = (): Map<string, StoredLayout> => {
  if (store) return store;
  store = new Map();
  try {
    const raw = typeof localStorage !== 'undefined'
      ? localStorage.getItem(STORAGE_KEY)
      : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const now = Date.now();
        for (const item of parsed) {
          if (
            !Array.isArray(item)
            || typeof item[0] !== 'string'
            || !item[1]
            || !Array.isArray(item[1].snapshot?.ranges)
            || item[1].snapshot.ranges.length === 0
            || !item[1].snapshot.ranges.every(isValidRange)
          ) continue;
          const savedAt = Number.isFinite(item[1].savedAt) ? item[1].savedAt : 0;
          if (now - savedAt > MAX_STORED_AGE_MS) continue;
          store.set(item[0], {
            snapshot: {
              ranges: item[1].snapshot.ranges,
              scrollTop: Number(item[1].snapshot.scrollTop) || 0,
            },
            itemCount: Number(item[1].itemCount) || 0,
            savedAt,
          });
        }
      }
    }
  } catch {
    // Corrupt storage falls back to an empty geometry set.
  }
  return store;
};

const schedulePersist = () => {
  if (typeof localStorage === 'undefined') return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const map = loadStore();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(map.entries())));
    } catch {
      // Quota/serialization failures must never break scrolling.
    }
  }, PERSIST_DEBOUNCE_MS);
};

export function saveHistoryMeasuredLayout(
  ownerKey: string,
  snapshot: HistoryMeasuredSnapshot | null | undefined,
  itemCount: number,
): boolean {
  if (!ownerKey || !snapshot || !Array.isArray(snapshot.ranges)) return false;
  const map = loadStore();
  // An empty measurement set is not knowledge — storing it would answer
  // "restore?" with a snapshot that teaches Virtuoso nothing.
  if (snapshot.ranges.length === 0) return false;
  // A zero offset from a list that had a real one is almost always the
  // baseline sample firing before the restore has been applied — the list is
  // momentarily at the top, and storing that overwrites the position the user
  // actually left. Observed live (e2e22): three good saves at 43140, then one
  // at 0, and from that point every return landed at the very top. A genuine
  // "user scrolled to the top" is re-recorded by the next scroll-idle sample
  // anyway, so refusing this one costs nothing and prevents silent loss.
  const previous = map.get(ownerKey);
  const nextScrollTop = Number(snapshot.scrollTop) || 0;
  if (nextScrollTop === 0 && previous && previous.snapshot.scrollTop > 0) {
    return false;
  }
  map.delete(ownerKey);
  map.set(ownerKey, {
    snapshot: { ranges: snapshot.ranges, scrollTop: Number(snapshot.scrollTop) || 0 },
    itemCount: Number(itemCount) || 0,
    savedAt: Date.now(),
  });
  while (map.size > MAX_OWNERS) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  schedulePersist();
  return true;
}

export function getHistoryMeasuredLayout(
  ownerKey: string,
  itemCount: number,
): HistoryMeasuredSnapshot | null {
  if (!ownerKey) return null;
  const map = loadStore();
  const stored = map.get(ownerKey);
  if (!stored) return null;
  // A mismatched count means "do not restore from this", NOT "destroy it".
  // Reads can legitimately arrive with a foreign row count — during an owner
  // switch the panel renders one frame with the PREVIOUS tab's rows — and a
  // read-time delete let that transient frame erase a perfectly valid stored
  // geometry (now persisted, so the loss would survive restarts too). The
  // entry stays; the next save simply overwrites it.
  if (Math.abs((Number(itemCount) || 0) - stored.itemCount) > MAX_ITEM_DELTA) {
    return null;
  }
  // Refresh recency so an actively used tab is not evicted by a drive-by visit.
  map.delete(ownerKey);
  map.set(ownerKey, stored);
  return stored.snapshot;
}

/**
 * Weighted average row height from a measured snapshot, for the list's
 * default-height estimate. Rows never scrolled past have no measurement, and
 * Virtuoso's fallback (height of the first measured row) is a terrible
 * estimator for History — a 40px user prompt next to a 500px diff card. A bad
 * estimate is what makes the scrollbar thumb lurch while scrubbing across
 * unmeasured regions: every newly measured row re-scales the total height.
 */
export function estimateHistoryAverageRowHeight(
  snapshot: HistoryMeasuredSnapshot | null | undefined,
): number | null {
  if (!snapshot || !Array.isArray(snapshot.ranges) || snapshot.ranges.length === 0) {
    return null;
  }
  let px = 0;
  let rows = 0;
  for (const range of snapshot.ranges) {
    const r = range as { startIndex?: number; endIndex?: number; size?: number };
    if (
      !Number.isFinite(r.startIndex)
      || !Number.isFinite(r.endIndex)
      || !Number.isFinite(r.size)
    ) continue;
    const count = (r.endIndex as number) - (r.startIndex as number) + 1;
    if (count <= 0 || (r.size as number) <= 0) continue;
    px += (r.size as number) * count;
    rows += count;
  }
  if (rows === 0 || px <= 0) return null;
  return Math.round(px / rows);
}

/**
 * O(1) live patch of the stored scroll offset, without re-asking Virtuoso for
 * a full state snapshot. The full save runs on scroll-idle (150ms debounce),
 * so a switch-away right after a scroll stored the PREVIOUS idle tick and the
 * return landed where the user was one gesture ago. Ranges stay from the last
 * full save — row sizes do not change from scrolling — only the offset needs
 * to be exact.
 *
 * Keeps the same zero-guard as the full save: a transient 0 while a restore
 * is being applied must not erase a real position (e2e22).
 */
export function updateHistoryMeasuredLayoutScrollTop(
  ownerKey: string,
  scrollTop: number,
): void {
  if (!ownerKey || !Number.isFinite(scrollTop)) return;
  const stored = loadStore().get(ownerKey);
  if (!stored) return;
  const next = Math.max(0, Math.round(scrollTop));
  if (next === 0 && stored.snapshot.scrollTop > 0) return;
  if (Math.abs(next - stored.snapshot.scrollTop) < 1) return;
  stored.snapshot.scrollTop = next;
  stored.savedAt = Date.now();
  schedulePersist();
}

/**
 * Drop geometry that can no longer describe the content: rewind, edit, or any
 * branch change rewrites row heights wholesale.
 */
export function dropHistoryMeasuredLayout(ownerKey: string): void {
  if (!ownerKey) return;
  if (loadStore().delete(ownerKey)) schedulePersist();
}

export function __resetHistoryMeasuredLayoutForTest(): void {
  store = null;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

export function __historyMeasuredLayoutSizeForTest(): number {
  return loadStore().size;
}
