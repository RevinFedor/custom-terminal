/**
 * Transient tail spacer — the "fake scroll reserve" that keeps the screen
 * still when content below the reading point shrinks near the BOTTOM of the
 * feed (a collapsed block or a shorter/disappearing terminal preview).
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
    /** Arm the reserve after a tail shrink. Replaces, never adds up: two quick
     * direct arms keep the larger single reserve. Callers that observe
     * separate shrink deficits may explicitly pass `get() + deficit`. */
    arm(nextPx, reason = 'collapse') {
      const value = Math.max(0, Math.round(Number(nextPx) || 0));
      if (value <= 0) return;
      px = Math.max(px, value);
      if (typeof diag === 'function') diag('TAIL_SPACER add px=' + px + ' reason=' + reason);
      publish(reason);
    },
    /** Burn part of the reserve as the user scrolls AWAY from the bottom —
     * at most `deltaPx` (the upward distance just travelled).
     *
     * `source` is mandatory in spirit: prod 17.08 showed an avalanche of
     * ~40 burns down to zero within 800ms of a collapse with NO user gesture
     * in between (browser clamp + Virtuoso's late measurement pass both emit
     * scroll events). Without the source in the log the two burn callers —
     * the user's upward travel and the per-commit deficit reconciliation —
     * are indistinguishable in a production trace. */
    burn(deltaPx, source = 'unknown') {
      if (px <= 0) return 0;
      const burnPx = Math.max(0, Math.round(Number(deltaPx) || 0));
      if (burnPx <= 0) return 0;
      const burned = Math.min(px, burnPx);
      px -= burned;
      if (typeof diag === 'function') {
        diag('TAIL_SPACER burn px=' + burned + ' left=' + px + ' src=' + source);
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

/** Window after a discrete gesture event (wheel/touchmove/scroll key) during
 * which the scroll events it produces are still that gesture's. A wheel tick
 * lands its scroll event in the same or next frame; momentum/smooth scrolling
 * keeps firing gesture events of its own, so this stays short on purpose. */
export const HISTORY_GESTURE_SCROLL_WINDOW_MS = 250;

/**
 * May this negative scroll delta consume the reserve?
 *
 * Only the USER moving up may. The reserve exists precisely because the
 * browser and Virtuoso move scrollTop by themselves after a shrink: the
 * clamp fires immediately, Virtuoso's measurement pass lands up to ~250ms
 * later, and the hold loop re-asserts the position each frame — every one of
 * those emits scroll events with a negative delta. Burning on those made the
 * reserve evaporate on its own (prod 17.08 11:52:42.8–43.0: ~40 burns to
 * zero, no gesture in the whole window) and the frame jumped.
 *
 * Proof of user ownership is a gesture that a programmatic writer cannot
 * fake: an in-progress scrollbar drag (pointer down on the scrollbar) or a
 * discrete gesture event within the window above. A live hold vetoes
 * everything — that frame belongs to the shrink compensation.
 */
export function isUserOwnedScrollBurn({
  holdActive = false,
  pointerScrollActive = false,
  msSinceGesture = Number.POSITIVE_INFINITY,
} = {}) {
  if (holdActive) return false;
  if (pointerScrollActive) return true;
  return msSinceGesture <= HISTORY_GESTURE_SCROLL_WINDOW_MS;
}

/** Bottom distance corrected for the reserve: the CONTENT bottom, not the
 * padded scroller bottom. All tail-pin math must use this. */
export function historyContentDistanceFromBottom(scroller, spacerPx) {
  if (!scroller) return Number.POSITIVE_INFINITY;
  const raw = Number(scroller.scrollHeight || 0)
    - (Number(scroller.scrollTop || 0) + Number(scroller.clientHeight || 0));
  return raw - Math.max(0, Number(spacerPx) || 0);
}

/**
 * Pixels the browser can no longer represent after content below the reading
 * point shrank. Supplying the PRE-change scrollTop is essential: the live
 * scrollTop may already have been clamped by the time React/Virtuoso reports
 * the new height.
 */
export function historyTailReserveDeficitAfterShrink(scroller, scrollTopBefore) {
  if (!scroller) return 0;
  const oldTop = Math.max(0, Number(scrollTopBefore) || 0);
  const viewport = Math.max(0, Number(scroller.clientHeight) || 0);
  const nextHeight = Math.max(0, Number(scroller.scrollHeight) || 0);
  return Math.max(0, Math.round(oldTop + viewport - nextHeight));
}
