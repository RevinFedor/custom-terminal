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
  /** Exact positional identity used when every measured size was captured. */
  itemKeys: string[];
  savedAt: number;
}

/**
 * Owners are tabs; a handful covers realistic back-and-forth. Each entry holds
 * one number per measured size RANGE (not per row), so this stays small even
 * for thousand-message sessions.
 */
const MAX_OWNERS = 12;

const STORAGE_KEY = 'noted-terminal-history-measured-layout-v2';
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

const normalizeItemKeys = (value: readonly string[] | null | undefined): string[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const keys = value.map((key) => String(key || ''));
  if (keys.some((key) => key.length === 0)) return null;
  if (new Set(keys).size !== keys.length) return null;
  return keys;
};

const sameItemKeys = (left: readonly string[], right: readonly string[]): boolean => (
  left.length === right.length && left.every((key, index) => key === right[index])
);

const itemKeysArePrefix = (prefix: readonly string[], full: readonly string[]): boolean => (
  prefix.length <= full.length && prefix.every((key, index) => key === full[index])
);

const snapshotFitsItemKeys = (
  snapshot: HistoryMeasuredSnapshot,
  itemKeys: readonly string[],
): boolean => snapshot.ranges.every((range) => {
  if (!isValidRange(range)) return false;
  const current = range as { startIndex: number; endIndex: number; size: number };
  return current.startIndex >= 0
    && current.endIndex >= current.startIndex
    && current.endIndex < itemKeys.length
    && current.size > 0;
});

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
          ) continue;
          const itemKeys = normalizeItemKeys(item[1].itemKeys);
          if (!itemKeys || !snapshotFitsItemKeys(item[1].snapshot, itemKeys)) continue;
          const savedAt = Number.isFinite(item[1].savedAt) ? item[1].savedAt : 0;
          if (now - savedAt > MAX_STORED_AGE_MS) continue;
          store.set(item[0], {
            snapshot: {
              ranges: item[1].snapshot.ranges,
              scrollTop: Number(item[1].snapshot.scrollTop) || 0,
            },
            itemKeys,
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

/** Rows a snapshot has real measurements for (ranges are inclusive). */
const measuredRowCoverage = (snapshot: HistoryMeasuredSnapshot): number => {
  let covered = 0;
  for (const range of snapshot.ranges) {
    const r = range as { startIndex?: number; endIndex?: number; size?: number };
    if (!isValidRange(r)) continue;
    covered += (r.endIndex as number) - (r.startIndex as number) + 1;
  }
  return covered;
};

export function saveHistoryMeasuredLayout(
  ownerKey: string,
  snapshot: HistoryMeasuredSnapshot | null | undefined,
  currentItemKeys: readonly string[],
): boolean {
  if (!ownerKey || !snapshot || !Array.isArray(snapshot.ranges)) return false;
  const itemKeys = normalizeItemKeys(currentItemKeys);
  if (!itemKeys) return false;
  const map = loadStore();
  // An empty measurement set is not knowledge — storing it would answer
  // "restore?" with a snapshot that teaches Virtuoso nothing.
  if (snapshot.ranges.length === 0 || !snapshotFitsItemKeys(snapshot, itemKeys)) return false;
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
  // Coverage guard. A visit whose list mounted WITHOUT restored geometry
  // (Timeline jump owns the position; first visit after a store loss) only
  // measures the rows it actually rendered — a getState there describes a
  // few dozen rows of a multi-thousand-row session. Storing that over a
  // rich snapshot trades a full accelerator for a sliver (observed live
  // 05.08: a 2618-row owner went from full coverage to 7 ranges, and every
  // later return re-estimated everything outside them). Keep the richer
  // knowledge and refresh only the offset; the poor save is not lost
  // knowledge — the rows it measured are a subset of what is kept.
  if (previous && (
    sameItemKeys(previous.itemKeys, itemKeys)
    || itemKeysArePrefix(previous.itemKeys, itemKeys)
  )) {
    const nextCoverage = measuredRowCoverage(snapshot);
    const previousCoverage = measuredRowCoverage(previous.snapshot);
    if (nextCoverage < previousCoverage * 0.5) {
      if (nextScrollTop > 0 || previous.snapshot.scrollTop === 0) {
        previous.snapshot.scrollTop = nextScrollTop;
        previous.savedAt = Date.now();
        schedulePersist();
      }
      return false;
    }
  }
  map.delete(ownerKey);
  map.set(ownerKey, {
    snapshot: { ranges: snapshot.ranges, scrollTop: Number(snapshot.scrollTop) || 0 },
    itemKeys,
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
  currentItemKeys: readonly string[],
): HistoryMeasuredSnapshot | null {
  if (!ownerKey) return null;
  const itemKeys = normalizeItemKeys(currentItemKeys);
  if (!itemKeys) return null;
  const map = loadStore();
  const stored = map.get(ownerKey);
  if (!stored) return null;
  const exactShape = sameItemKeys(stored.itemKeys, itemKeys);
  const provenAppend = !exactShape && itemKeysArePrefix(stored.itemKeys, itemKeys);
  // Positional measurements are valid only for the physical rows that owned
  // those indices. Equal/nearby counts prove nothing: a regroup, rewind or
  // live→durable substitution can put another row at the same index. A miss
  // does not destroy the cache because an owner-switch transition may still
  // ask with another owner's units before the handoff commit completes.
  if (!exactShape && !provenAppend) return null;
  // Refresh recency so an actively used tab is not evicted by a drive-by visit.
  map.delete(ownerKey);
  map.set(ownerKey, stored);
  if (exactShape) return stored.snapshot;

  // Virtuoso extrapolates the size of its final measured range into unknown
  // appended indices. If that final row was a 4,800px response, three new
  // tail units become a phantom 14,400px black region until mounted. Seed the
  // exact append suffix with the weighted owner average instead; the real
  // rows replace these estimates as they mount.
  const appendedSize = estimateHistoryAverageRowHeight(stored.snapshot) ?? 96;
  return {
    ranges: [
      ...stored.snapshot.ranges,
      {
        startIndex: stored.itemKeys.length,
        endIndex: itemKeys.length - 1,
        size: appendedSize,
      },
    ],
    scrollTop: stored.snapshot.scrollTop,
  };
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
 * Per-index row height resolver from a measured snapshot, for the mount-wave
 * shells. A shell must occupy EXACTLY the pixels its real card measured at —
 * that is what makes the shell→card upgrade invisible to Virtuoso (same size
 * reported, no re-measure cascade, no scroll correction). Rows the snapshot
 * never measured fall back to the per-owner average.
 */
export function createHistoryRowHeightLookup(
  snapshot: HistoryMeasuredSnapshot | null | undefined,
  fallbackPx: number,
): (index: number) => number {
  const ranges = ((snapshot?.ranges || []) as Array<{
    startIndex: number; endIndex: number; size: number;
  }>).filter(isValidRange);
  if (ranges.length === 0) return () => fallbackPx;
  return (index: number) => {
    for (const range of ranges) {
      if (index >= range.startIndex && index <= range.endIndex && range.size > 0) {
        return range.size;
      }
    }
    return fallbackPx;
  };
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
 * Picks the next shell row the mount wave should upgrade. Only rows that are
 * actually MOUNTED cost anything to hydrate, and among those the ones the user
 * can see must come first — a shell in the viewport is visible placeholder
 * content, a shell in the overscan is not. Candidates are DOM-measured rects
 * of mounted shell rows; the viewport is the scroller's own rect. Returns the
 * uuid of the topmost shell intersecting the (margin-expanded) viewport, then
 * the topmost mounted shell, then null (no mounted shells left — the caller
 * flips the remaining unmounted ones in one trivial commit).
 */
export function pickHistoryMountWaveTarget(
  candidates: Array<{ uuid: string; top: number; bottom: number }>,
  viewport: { top: number; bottom: number } | null,
  marginPx = 200,
): string | null {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => a.top - b.top);
  if (viewport) {
    const vTop = viewport.top - marginPx;
    const vBottom = viewport.bottom + marginPx;
    for (const row of sorted) {
      if (row.bottom >= vTop && row.top <= vBottom) return row.uuid;
    }
  }
  return sorted[0]?.uuid ?? null;
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
