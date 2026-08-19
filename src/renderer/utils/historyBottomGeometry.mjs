/**
 * Canonical History bottom geometry.
 *
 * History has one physical bottom: the scroller's content edge. Group/card
 * collapse no longer manufactures a fake Footer to preserve an unreachable
 * pre-collapse scrollTop, so every consumer can answer the same question from
 * live DOM geometry. Composer growth may pass its measured delta as slack to
 * ask whether the reader was pinned immediately before that resize.
 */

import { HISTORY_TAIL_PIN_THRESHOLD_PX } from './historyBottomScroll.mjs';

export function historyContentDistanceFromBottom(scroller) {
  if (!scroller) return Number.POSITIVE_INFINITY;
  return Number(scroller.scrollHeight || 0)
    - (Number(scroller.scrollTop || 0) + Number(scroller.clientHeight || 0));
}

export function isHistoryAtContentBottom(scroller, {
  thresholdPx = HISTORY_TAIL_PIN_THRESHOLD_PX,
  slackPx = 0,
} = {}) {
  if (!scroller) return false;
  const threshold = Math.max(0, Number(thresholdPx) || 0)
    + Math.max(0, Number(slackPx) || 0);
  return historyContentDistanceFromBottom(scroller) <= threshold;
}
