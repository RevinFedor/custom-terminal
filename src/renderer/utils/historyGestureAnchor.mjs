const HEIGHT_EPSILON_PX = 1;

export function shouldArmHistoryGestureAnchor({
  inputAt,
  now,
  direction,
  deltaTop,
  previousScrollHeight,
  scrollHeight,
  machineOwned,
  presented,
}) {
  const ageMs = Number(now) - Number(inputAt);
  const motion = Number(deltaTop);
  const heightDelta = Number(scrollHeight) - Number(previousScrollHeight);
  if (
    !presented
    || machineOwned
    || !Number.isFinite(ageMs)
    || ageMs < 0
    || ageMs > 120
    || !Number.isFinite(motion)
    || Math.abs(motion) < 0.5
    || !Number.isFinite(heightDelta)
    || Math.abs(heightDelta) > HEIGHT_EPSILON_PX
  ) return false;
  return direction === 'up' ? motion < 0 : direction === 'down' ? motion > 0 : false;
}

/** Pick a real semantic row near the viewport centre, not the edge. */
export function pickHistoryGestureAnchorCandidate(rows, viewportTop, viewportBottom) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const top = Number(viewportTop);
  const bottom = Number(viewportBottom);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) return null;
  const target = top + (bottom - top) * 0.45;
  const eligible = rows.filter((row) => (
    row
    && typeof row.identity === 'string'
    && row.identity.length > 0
    && Number.isFinite(Number(row.top))
    && Number.isFinite(Number(row.bottom))
    && Number(row.bottom) > top
    && Number(row.top) < bottom
  ));
  if (eligible.length === 0) return null;
  const containing = eligible.find((row) => Number(row.top) <= target && Number(row.bottom) > target);
  if (containing) return containing;
  return eligible.reduce((best, row) => (
    Math.abs(Number(row.top) - target) < Math.abs(Number(best.top) - target) ? row : best
  ));
}
