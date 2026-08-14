// Does the control bar under the composer still fit on ONE line?
//
// The bar has two clusters — session controls on the left, model/effort
// dropdowns on the right — and every child of both sets flexShrink: 0, because
// each is a fixed-size pill whose label must stay readable. So at a narrow width
// nothing shrinks: the clusters simply run into each other and their contents
// overlap into an unreadable stack (worst in a split, where two bars live at
// half the window's width each).
//
// The fix is a wrap, not a shrink — and the ORDER is the point. The right
// cluster (model / effort / think) goes on the FIRST line and the left cluster
// (session, ^C, context %) drops to the second, so the controls the user reaches
// for most keep their position relative to the composer above them.
//
// Measured, never guessed: pill widths depend on the live label text ("GPT-5.6-Sol"
// vs "opus"), on the user's font-size setting, and on which optional chips are
// present. Any px threshold computed from a formula would be wrong for some
// combination — see the project's rule about measuring the DOM instead.

/** Gap the two clusters must keep between them before wrapping (px). */
export const CONTROL_BAR_CLUSTER_MIN_GAP_PX = 8;

/**
 * How much width a cluster's CONTENT actually needs, in px.
 *
 * Not scrollWidth. The left cluster ends with a flex spacer that pushes the
 * context % to its right edge, so scrollWidth is always "however wide the
 * cluster was given" — measured live: 600 of 600, while its real children summed
 * to 521. Feeding that back in makes the comparison self-referential: the number
 * grows with the space you give it, so the bar can never decide it fits again.
 *
 * Summing the children skips the spacer (it has no content of its own) and gives
 * a figure that does not move when the layout changes.
 *
 * @param {Element|null} cluster
 * @param {number} gapPx gap between the cluster's own children
 */
export function measureClusterContentWidth(cluster, gapPx = 0) {
  if (!cluster || !cluster.children) return 0;
  const kids = Array.from(cluster.children);
  let total = 0;
  let counted = 0;
  for (const kid of kids) {
    // A spacer is a child with no content: it exists only to take up slack.
    const style = kid.ownerDocument?.defaultView?.getComputedStyle?.(kid);
    const grows = style ? parseFloat(style.flexGrow) > 0 : false;
    const width = kid.getBoundingClientRect
      ? kid.getBoundingClientRect().width
      : 0;
    if (grows && !kid.textContent?.trim() && !kid.children.length) continue;
    if (width <= 0) continue;
    total += width;
    counted += 1;
  }
  const gap = Number.isFinite(Number(gapPx)) ? Number(gapPx) : 0;
  return total + Math.max(0, counted - 1) * gap;
}

/**
 * @param {object} args
 * @param {number} args.availableWidth inner width of the bar, padding excluded
 * @param {number} args.leftWidth      natural (unwrapped) width of the left cluster
 * @param {number} args.rightWidth     natural width of the right cluster
 * @param {number} [args.minGap]       required breathing room between clusters
 * @returns {boolean} true when the two clusters must be stacked on two lines
 */
export function shouldWrapControlBar({ availableWidth, leftWidth, rightWidth, minGap }) {
  const available = Number(availableWidth);
  const left = Number(leftWidth);
  const right = Number(rightWidth);
  // Before the first measurement everything is 0 — that is "unknown", not
  // "everything fits in nothing". Staying on one line keeps the bar looking the
  // way it always did until a real measurement arrives.
  if (!Number.isFinite(available) || available <= 0) return false;
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (left <= 0 || right <= 0) return false;
  const gap = Number.isFinite(Number(minGap)) ? Number(minGap) : CONTROL_BAR_CLUSTER_MIN_GAP_PX;
  return left + right + gap > available;
}
