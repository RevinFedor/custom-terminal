// How much of the CENTER surface's right edge is covered by right-docked
// panels, in px.
//
// Three things live at the bottom-right of the center box and must all dodge
// the same obstacles: the Run after strip, the terminal's scroll-to-bottom
// arrow, and the transcript's scroll-to-bottom arrow. They sit in the same box,
// so they must read the SAME number — three private copies of this arithmetic
// would drift apart one detail at a time (the process bar just did exactly
// that, see TabSignals.tsx).
//
// Who is "center" and who is "side" swaps per tab: in transcript-primary the
// terminal docks right, in terminal-primary the transcript docks right. Only
// ONE side panel is ever open — swapping the primary surface closes the other
// (see Workspace::swapPrimarySurface) — so the open one's width is unambiguous.
//
// A surface INSIDE the side panel must pass nothing / use 0: its own bottom
// right corner is already clear, and insetting it would push its controls out
// of the panel it belongs to.
//
// CAREFUL: "which box is this anchored to" is per CONTROL, not per component.
// Terminal.tsx computes TWO insets from the same arguments, because its two
// controls live in different boxes: the scroll arrow is drawn inside the terminal
// (so isSidePanel applies to it), while the Run after strip is portalled out to a
// host spanning the whole centre column (so it must keep dodging, even when the
// terminal itself is the docked panel). Sharing one value there froze the strip
// in place — reported as "I press Cmd+] and Run after does not move".

/** Layout width the collapsed Timeline rail keeps for itself. */
export const TIMELINE_COLLAPSED_SLOT_WIDTH = 32;

/**
 * Expanded Timeline covers the center only while UNPINNED — pinned, it is a
 * column and the center box is already narrower, so insetting would double-count.
 */
export function resolveTimelineInset({ treeMode, pinned, width }) {
  if (!treeMode || pinned) return 0;
  return Math.max(0, (Number(width) || 0) - TIMELINE_COLLAPSED_SLOT_WIDTH);
}

/**
 * Width of whichever side panel is currently docked OVER the center.
 *
 * A PINNED panel contributes nothing: it is a column, so the center box is
 * already narrower and its right edge is clear. Counting it would inset twice
 * and park the controls a panel-width inside empty space.
 */
export function resolveSidePanelInset({
  sideTerminalOpen,
  sideTerminalWidth,
  sideHistoryOpen,
  sideHistoryWidth,
  sidePanelPinned = false,
}) {
  if (sidePanelPinned) return 0;
  if (sideTerminalOpen) return Math.max(0, Number(sideTerminalWidth) || 0);
  if (sideHistoryOpen) return Math.max(0, Number(sideHistoryWidth) || 0);
  return 0;
}

/** Total right-edge inset for anything anchored to the center surface. */
export function resolveCenterRightInset(args = {}) {
  // A surface that IS the side panel has no obstacle at its right edge — it is
  // the obstacle. Insetting it pushes its own controls out of itself by its own
  // width, which is exactly what hid the terminal's scroll-to-bottom arrow when
  // the terminal was the docked panel: the arrow was rendered, just parked in
  // the middle of the transcript next door.
  //
  // The caller says this by passing isSidePanel — it is the one thing the
  // arithmetic cannot work out for itself, because the same terminal component
  // renders in both roles.
  if (args.isSidePanel) return 0;
  return resolveTimelineInset(args) + resolveSidePanelInset(args);
}
