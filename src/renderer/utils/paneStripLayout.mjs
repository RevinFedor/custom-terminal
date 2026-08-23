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
 * Identity of the complete overflow state, not only of the badge text.
 * Two hidden tabs of the same kind both render as `claude:1`, but toast/error
 * ownership still has to move from the old tab id to the new one.
 */
export function paneStripOverflowStateKey({
  hiddenLeftIds = [],
  hiddenRightIds = [],
  leftGroups = [],
  rightGroups = [],
} = {}) {
  const groups = (items) => (Array.isArray(items) ? items : [])
    .map((group) => `${group?.kind || 'default'}:${Number(group?.count) || 0}`)
    .join(',');
  return 'LI:' + (Array.isArray(hiddenLeftIds) ? hiddenLeftIds : []).join(',')
    + '|RI:' + (Array.isArray(hiddenRightIds) ? hiddenRightIds : []).join(',')
    + '|LG:' + groups(leftGroups)
    + '|RG:' + groups(rightGroups);
}

/**
 * Scroll offset that brings one chip fully into view, moving as little as
 * possible — and never moving at all when it already fits.
 *
 * Used whenever the shown chip changes, from wherever: activation from the
 * sidebar, Ctrl+Tab, a neighbour closing — and from a click on a chip that is
 * only half on screen. That last case is the reason this is not conditioned on
 * "the change came from elsewhere": a chip clipped by the edge is still
 * clickable, so clicking it selected a tab whose own name stayed cut in half.
 * Юзер: *«если я на эту вкладку кликаю, пусть она доскроллится ровно
 * настолько, насколько нужно, чтобы показаться целиком»*.
 *
 * Moving as little as possible is what makes it safe to run on EVERY change:
 * a chip already fully visible returns the offset unchanged, so the strip
 * never jumps under a click that did not need it.
 *
 * `viewport` is the preferred form for DOM callers: both rectangles then come
 * from the SAME layout and already include whatever real neighbours (for
 * example an overflow badge stack) took from the scroller. `viewportWidth` is
 * kept for callers whose chip coordinates already live in scroll-content
 * space.
 *
 * There is deliberately no visual margin here. A chip flush with either edge
 * is fully visible, so moving it would turn activation into gratuitous strip
 * motion. If a chip is clipped, the clipped edge itself supplies the exact
 * delta to the nearest viewport edge.
 *
 * @param {object} args
 * @param {{left: number, right?: number, width?: number}} args.chip
 * @param {number} args.scrollLeft
 * @param {{left: number, right: number}} [args.viewport]
 * @param {number} [args.viewportWidth]
 * @returns {number} the new scrollLeft
 */
export function scrollOffsetForChip({ chip, scrollLeft, viewport, viewportWidth }) {
  const from = Number(scrollLeft) || 0;
  if (!chip) return from;

  const hasViewport = viewport
    && Number.isFinite(Number(viewport.left))
    && Number.isFinite(Number(viewport.right));
  const viewportLeft = hasViewport ? Number(viewport.left) : from;
  const viewportRight = hasViewport
    ? Number(viewport.right)
    : viewportLeft + (Number(viewportWidth) || 0);
  const left = Number(chip.left) || 0;
  const right = Number.isFinite(Number(chip.right))
    ? Number(chip.right)
    : left + (Number(chip.width) || 0);

  if (viewportRight <= viewportLeft) return from;
  // Fully visible means exactly that; touching an edge is not clipping.
  if (left >= viewportLeft && right <= viewportRight) return from;
  // A chip wider than the viewport cannot be made whole. If it already covers
  // the complete viewport, moving to either edge would only hide more of the
  // opposite side and would oscillate on the next reveal.
  if (left <= viewportLeft && right >= viewportRight) return from;

  if (left < viewportLeft) return Math.max(0, from + left - viewportLeft);
  if (right > viewportRight) return Math.max(0, from + right - viewportRight);
  return from;
}
