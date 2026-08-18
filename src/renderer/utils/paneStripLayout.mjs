// How a pane's strip of tab chips is LAID OUT: grouping and overflow.
//
// Two rules, both pure, both about reading rather than about state:
//
//   1. consecutive chips of the same project share ONE project icon;
//   2. chips that scrolled fully out of sight are counted BY KIND, not scrolled
//      to.
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
 * WHICH chips are hidden, not merely how many: the badge is painted in the
 * colour of the agent it stands for, so the caller needs their identities. The
 * plain counts stay in the result — that is what the caller renders when every
 * hidden chip is of one kind.
 *
 * @param {object} args
 * @param {Array<{left: number, width: number, tabId?: string}>} args.chips
 *   positions inside the scrolling content, in strip order
 * @param {number} args.scrollLeft
 * @param {number} args.viewportWidth
 * @param {number} [args.tolerancePx]  sub-pixel slack; a chip flush against the
 *   edge must not flicker into the count on a fractional layout
 */
export function resolveStripOverflow({ chips, scrollLeft, viewportWidth, tolerancePx = 1 }) {
  const list = Array.isArray(chips) ? chips : [];
  const from = Number(scrollLeft) || 0;
  const to = from + (Number(viewportWidth) || 0);
  const hiddenLeftIds = [];
  const hiddenRightIds = [];
  list.forEach((chip) => {
    if (!chip) return;
    const left = Number(chip.left) || 0;
    const right = left + (Number(chip.width) || 0);
    if (right <= from + tolerancePx) hiddenLeftIds.push(chip.tabId);
    else if (left >= to - tolerancePx) hiddenRightIds.push(chip.tabId);
  });
  return {
    hiddenLeft: hiddenLeftIds.length,
    hiddenRight: hiddenRightIds.length,
    hiddenLeftIds,
    hiddenRightIds,
  };
}

/**
 * Break one side's hidden chips down BY KIND — one badge per kind, «×N» inside.
 *
 * A single number answers "how many are out of sight" and stops there. What a
 * person actually asks of a strip is *what* is out of sight: two Claude tabs and
 * one Codex tab is a different situation from three Codex tabs. The strip
 * already says that with colour — orange is Claude, green is Codex — so the
 * badge borrows the same colour instead of inventing a second vocabulary, and
 * «×2» in orange reads without a legend. Юзер: *«писать с бэкграундом оранжевым
 * либо зелёным… если там оба, то писать по вертикали друг над другом, два
 * квадратика с цифрой»*.
 *
 * Order is FIRST APPEARANCE in the strip — not by count, not alphabetical: the
 * strip is a map the user arranged, and the badges continue that map past the
 * edge of the window.
 *
 * @param {Array<string>} hiddenIds  tab ids, in strip order
 * @param {(tabId: string) => string} kindOf  colour key of that tab
 * @returns {Array<{kind: string, count: number}>}
 */
export function groupOverflowByKind(hiddenIds, kindOf) {
  const out = [];
  const at = new Map();
  (Array.isArray(hiddenIds) ? hiddenIds : []).forEach((tabId) => {
    const kind = (typeof kindOf === 'function' ? kindOf(tabId) : '') || 'default';
    if (at.has(kind)) out[at.get(kind)].count += 1;
    else { at.set(kind, out.length); out.push({ kind, count: 1 }); }
  });
  return out;
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
