// How a pane's strip of tab chips is LAID OUT: grouping and overflow.
//
// Two rules, both pure, both about reading rather than about state:
//
//   1. consecutive chips of the same project share ONE project icon;
//   2. chips that scrolled fully out of sight are counted, not scrolled to.
//
// They live here rather than in the header component because both are the kind
// of arithmetic that silently drifts once it is inlined next to JSX — and both
// have an exact right answer that a test can hold.

/**
 * Split a strip into runs of consecutive chips belonging to the same project.
 *
 * The icon marks the START of a run instead of riding on every chip. With one
 * icon per chip a row of four tabs from one project drew four identical icons,
 * and — worse — an icon sits BETWEEN two chips, so it was unreadable which of
 * the two it belonged to: the one to its right (it is that tab's icon) or the
 * one to its left (it is the end of that tab's card). One icon per run removes
 * the question: it is the label of everything up to the next icon.
 *
 * Runs, not "group all tabs of a project together": the strip's order is the
 * user's, and reordering it to make icons cheaper would be reordering their map.
 *
 * @param {Array<{projectId: string, tabId: string}>} entries
 * @returns {Array<{projectId: string, tabIds: string[]}>}
 */
export function groupStripByProject(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const runs = [];
  list.forEach((entry) => {
    if (!entry || !entry.tabId) return;
    const last = runs[runs.length - 1];
    if (last && last.projectId === entry.projectId) last.tabIds.push(entry.tabId);
    else runs.push({ projectId: entry.projectId, tabIds: [entry.tabId] });
  });
  return runs;
}

/**
 * How many chips are FULLY out of sight on each side of the visible window.
 *
 * A scrollbar is the usual answer and the wrong one here: the header is two
 * short lines, and a horizontal bar under the chips would cost a third — height
 * spent on a control that says less than the counts do. Юзер: *«скролл не
 * показывать, он будет ещё высоту занимать, показывать вместо этого слева либо
 * справа +1, +2»*.
 *
 * FULLY hidden, not "more than half": a chip clipped to a sliver is still
 * visible and still clickable, so counting it as hidden would name it twice —
 * once as a sliver on screen, once as a number. The user asked for exactly this
 * boundary after considering the half rule out loud.
 *
 * Both ends are counted separately because they answer different questions:
 * "there is more behind me" and "there is more ahead".
 *
 * @param {object} args
 * @param {Array<{left: number, width: number}>} args.chips  positions inside the
 *   scrolling content, in strip order
 * @param {number} args.scrollLeft
 * @param {number} args.viewportWidth
 * @param {number} [args.tolerancePx]  sub-pixel slack; a chip flush against the
 *   edge must not flicker into the count on a fractional layout
 */
export function resolveStripOverflow({ chips, scrollLeft, viewportWidth, tolerancePx = 1 }) {
  const list = Array.isArray(chips) ? chips : [];
  const from = Number(scrollLeft) || 0;
  const to = from + (Number(viewportWidth) || 0);
  let hiddenLeft = 0;
  let hiddenRight = 0;
  list.forEach((chip) => {
    if (!chip) return;
    const left = Number(chip.left) || 0;
    const right = left + (Number(chip.width) || 0);
    if (right <= from + tolerancePx) hiddenLeft += 1;
    else if (left >= to - tolerancePx) hiddenRight += 1;
  });
  return { hiddenLeft, hiddenRight };
}

/**
 * Scroll offset that brings one chip fully into view, moving as little as
 * possible — and never moving at all when it already fits.
 *
 * Used when the shown chip changes from somewhere OTHER than a click on it
 * (activation from the sidebar, Ctrl+Tab, a chip closing and its neighbour
 * taking over): the tab whose content fills the window must be the one whose
 * chip is legible, or the header contradicts the window under it.
 *
 * @returns {number} the new scrollLeft
 */
export function scrollOffsetForChip({ chip, scrollLeft, viewportWidth, marginPx = 8 }) {
  const from = Number(scrollLeft) || 0;
  if (!chip) return from;
  const width = Number(viewportWidth) || 0;
  const left = Number(chip.left) || 0;
  const right = left + (Number(chip.width) || 0);
  if (left < from + marginPx) return Math.max(0, left - marginPx);
  if (right > from + width - marginPx) return Math.max(0, right - width + marginPx);
  return from;
}
