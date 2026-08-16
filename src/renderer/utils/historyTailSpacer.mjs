/**
 * Transient tail spacer — the "fake scroll reserve" that keeps the screen
 * still when a block collapses near the BOTTOM of the feed.
 *
 * Collapsing the last expanded block removes hundreds of pixels below the
 * viewport; without compensation the scroller clamps and the content the user
 * is looking at jumps down. The reserve temporarily replaces the removed
 * height inside the Footer, then burns away as the user scrolls up, and
 * zeroes on every event that makes it meaningless.
 *
 * Owner guards (approved, docs/tmp/визуал-history.md::Вердикт п.2):
 *  1. ONE value source — every bottom-math consumer must subtract
 *     `get()` from its distance-to-bottom; helpers below do it.
 *  2. Zero before any restore/convergence — callers assert via `mustBeZero`.
 *  3. Monotonic decrease while alive: `burn()` only shrinks, never below 0.
 *  4. Never persisted; `reset('owner-change')` on owner switches.
 *  5. Our scrollTop signal stays authoritative over Virtuoso's atBottom.
 */

export function createHistoryTailSpacer({ onChange, diag } = {}) {
  let px = 0;

  const publish = (reason) => {
    if (typeof onChange === 'function') onChange(px, reason);
  };

  return {
    get: () => px,
    /** Arm the reserve (collapse near the bottom). Replaces, never adds up:
     * two quick collapses keep the larger single reserve. */
    arm(nextPx, reason = 'collapse') {
      const value = Math.max(0, Math.round(Number(nextPx) || 0));
      if (value <= 0) return;
      px = Math.max(px, value);
      if (typeof diag === 'function') diag('TAIL_SPACER add px=' + px + ' reason=' + reason);
      publish(reason);
    },
    /** Burn part of the reserve as the user scrolls AWAY from the bottom —
     * at most `deltaPx` (the upward distance just travelled). */
    burn(deltaPx) {
      if (px <= 0) return 0;
      const burnPx = Math.max(0, Math.round(Number(deltaPx) || 0));
      if (burnPx <= 0) return 0;
      const burned = Math.min(px, burnPx);
      px -= burned;
      if (typeof diag === 'function') {
        diag('TAIL_SPACER burn px=' + burned + ' left=' + px);
      }
      publish('burn');
      return burned;
    },
    /** Hard zero: restore start, owner change, new rows at the tail, real
     * bottom reached. */
    reset(reason = 'reset') {
      if (px === 0) return false;
      px = 0;
      if (typeof diag === 'function') diag('TAIL_SPACER zero reason=' + reason);
      publish(reason);
      return true;
    },
    /** Restore/convergence entry assertion (guard 2). */
    mustBeZero(context) {
      if (px === 0) return true;
      if (typeof diag === 'function') {
        diag('TAIL_SPACER violation context=' + context + ' px=' + px);
      }
      px = 0;
      publish('violation:' + context);
      return false;
    },
  };
}

/** Bottom distance corrected for the reserve: the CONTENT bottom, not the
 * padded scroller bottom. All tail-pin math must use this. */
export function historyContentDistanceFromBottom(scroller, spacerPx) {
  if (!scroller) return Number.POSITIVE_INFINITY;
  const raw = Number(scroller.scrollHeight || 0)
    - (Number(scroller.scrollTop || 0) + Number(scroller.clientHeight || 0));
  return raw - Math.max(0, Number(spacerPx) || 0);
}
