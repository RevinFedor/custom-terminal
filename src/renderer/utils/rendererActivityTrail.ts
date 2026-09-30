/**
 * Freeze attribution trail.
 *
 * The platform's own long-task attribution is useless for our code: every one
 * of the 898 long tasks recorded across two days of production logs reported
 * `attribution=unknown`, including a 14.2s freeze. Same-origin script work
 * collapses to "self" and names nothing. So the app keeps its own short trail
 * of what it was doing, and the freeze probe stamps each long task with the
 * activities that overlapped it.
 *
 * This is a diagnostic breadcrumb, NOT a control signal: nothing branches on
 * it. It only turns "something froze" into "this froze while X was running".
 *
 * Deliberately dependency-free. The freeze probe itself is imported lazily
 * (see main.tsx) so Zustand stores are not created before DEV settings are
 * restored; hot paths that want to leave a mark must be able to import the
 * trail WITHOUT dragging the probe — and the stores — in with it.
 */

import { uiPerformancePhase } from './uiPerformanceDiagnostics.mjs';

export type ActivityMark = {
  label: string;
  startAbs: number;
  endAbs: number | null;
};

const trail: ActivityMark[] = [];
const TRAIL_MAX = 80;

function absNow(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * Marks a span of renderer work so a freeze overlapping it can be named.
 * Returns the closer; calling it more than once is harmless.
 */
export function markRendererActivity(label: string): () => void {
  const mark: ActivityMark = { label, startAbs: absNow(), endAbs: null };
  uiPerformancePhase('activity-start:' + label);
  trail.push(mark);
  if (trail.length > TRAIL_MAX) trail.shift();
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    mark.endAbs = absNow();
    uiPerformancePhase('activity-end:' + label, { ms: mark.endAbs - mark.startAbs });
  };
}

/**
 * Every activity whose span overlaps [startAbs, endAbs] — i.e. was in flight
 * while the main thread was blocked. Marks that never closed are reported as
 * open. This is temporal overlap, not CPU attribution: an awaited request can
 * stay open for minutes while queued and consume no CPU during another task.
 */
export function attributeFreeze(startAbs: number, endAbs: number): string {
  const overlapping: string[] = [];
  for (const mark of trail) {
    const markEnd = mark.endAbs ?? Number.POSITIVE_INFINITY;
    if (markEnd < startAbs || mark.startAbs > endAbs) continue;
    overlapping.push(mark.label + (mark.endAbs === null ? '(open)' : ''));
  }
  if (overlapping.length === 0) return 'none-marked';
  // Latest first for readability, not a ranking of CPU cost or causality.
  return overlapping.slice(-4).reverse().join(',').slice(0, 160);
}

/**
 * A LongTask with no overlapping mark can still be the deferred React/browser
 * continuation of work that ended just before the task boundary. Return the
 * nearest completed marks as breadcrumbs; this is deliberately not presented
 * as causal proof.
 */
export function recentRendererActivities(
  startAbs: number,
  lookbackMs = 1500,
): string {
  const recent = trail
    .filter((mark) => (
      mark.endAbs !== null
      && mark.endAbs < startAbs
      && mark.endAbs >= startAbs - lookbackMs
    ))
    .sort((left, right) => Number(right.endAbs) - Number(left.endAbs))
    .slice(0, 4)
    .map((mark) => `${mark.label}:${Math.max(0, startAbs - Number(mark.endAbs)).toFixed(0)}ms`);
  return recent.length > 0 ? recent.join(',').slice(0, 200) : 'none';
}
