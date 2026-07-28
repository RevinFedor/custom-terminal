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

const store = new Map<string, StoredLayout>();

export function saveHistoryMeasuredLayout(
  ownerKey: string,
  snapshot: HistoryMeasuredSnapshot | null | undefined,
  itemCount: number,
): boolean {
  if (!ownerKey || !snapshot || !Array.isArray(snapshot.ranges)) return false;
  // An empty measurement set is not knowledge — storing it would answer
  // "restore?" with a snapshot that teaches Virtuoso nothing.
  if (snapshot.ranges.length === 0) return false;
  store.delete(ownerKey);
  store.set(ownerKey, {
    snapshot: { ranges: snapshot.ranges, scrollTop: Number(snapshot.scrollTop) || 0 },
    itemCount: Number(itemCount) || 0,
    savedAt: Date.now(),
  });
  while (store.size > MAX_OWNERS) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  return true;
}

export function getHistoryMeasuredLayout(
  ownerKey: string,
  itemCount: number,
): HistoryMeasuredSnapshot | null {
  if (!ownerKey) return null;
  const stored = store.get(ownerKey);
  if (!stored) return null;
  if (Math.abs((Number(itemCount) || 0) - stored.itemCount) > MAX_ITEM_DELTA) {
    store.delete(ownerKey);
    return null;
  }
  // Refresh recency so an actively used tab is not evicted by a drive-by visit.
  store.delete(ownerKey);
  store.set(ownerKey, stored);
  return stored.snapshot;
}

/**
 * Drop geometry that can no longer describe the content: rewind, edit, or any
 * branch change rewrites row heights wholesale.
 */
export function dropHistoryMeasuredLayout(ownerKey: string): void {
  if (ownerKey) store.delete(ownerKey);
}

export function __resetHistoryMeasuredLayoutForTest(): void {
  store.clear();
}

export function __historyMeasuredLayoutSizeForTest(): number {
  return store.size;
}
