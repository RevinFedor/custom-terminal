// How a tab card LOOKS — one set of rules for every surface that draws one.
//
// A tab card is drawn in the sidebar list, in the pane header, in the Ctrl+Tab
// switcher and in the Run after picker. Each of those grew its own copy of the
// same three decisions — how big, what colour, and what the hover does — and
// the copies drifted, every time in a way that is invisible in code review and
// obvious on screen:
//
//   • the pane header replaced the tab's OWN colour with a flat white wash on
//     hover, so a green tab flashed grey-green and read as a different widget;
//   • it was 21px tall at 11.5px text while the sidebar card was 27px at 14px,
//     so the same tab looked like two different objects side by side;
//   • it clipped its own content, so the task squares could not reach the
//     bottom seam they are supposed to sit astride.
//
// The rules live here as plain functions so they can be tested without a DOM
// and so a fourth surface cannot invent a fourth answer.

/**
 * Background of a tab card.
 *
 * The important part is the HOVER rule: a coloured tab brightens ITS OWN
 * colour, it does not get painted over. Washing it with white is what made the
 * pane header's hover look like a different colour entirely.
 *
 * @param {object} args
 * @param {string} args.bgColor    the tab's chrome colour (from tabChrome)
 * @param {boolean} args.hasColor  false for the default/uncoloured tab
 * @param {boolean} [args.active]  this tab is the active one on its surface
 * @param {boolean} [args.hovered]
 * @param {boolean} [args.selected]
 * @param {(color: string, delta: number) => string} adjustAlpha
 * @returns {string} a CSS colour
 */
export function resolveTabCardBackground(
  { bgColor, hasColor, active = false, hovered = false, selected = false },
  adjustAlpha,
) {
  if (active) {
    return hasColor ? adjustAlpha(bgColor, 0.25) : 'rgba(255,255,255,0.20)';
  }
  if (selected) {
    return hasColor ? adjustAlpha(bgColor, 0.1) : 'rgba(255,255,255,0.06)';
  }
  if (hovered) {
    // Brighten what is already there. For an uncoloured tab there is nothing
    // to brighten, so a neutral tint is the only option — but a coloured tab
    // must stay itself.
    return hasColor ? adjustAlpha(bgColor, 0.08) : 'rgba(255,255,255,0.12)';
  }
  return hasColor ? bgColor : 'rgba(255,255,255,0.04)';
}

/** Text colour of the name. Dim until the card matters. */
export function resolveTabCardTextColor({ active = false, hovered = false, selected = false }) {
  return (active || hovered || selected) ? '#fff' : '#888';
}

/**
 * Box metrics of a tab card, from the user's Settings → Размеры values.
 *
 * `hasStatusMarker` widens the left inset so the name never sits under the
 * marker; `showTaskLane` shifts the vertical padding so the squares along the
 * bottom seam have room without moving the text off-centre.
 *
 * @param {object} geo   { paddingX, paddingY, paddingLeft, borderRadius, gap }
 * @param {object} args
 * @returns {{padding: string, borderRadius: number, fontSize: number, laneBottomPx: number}}
 */
export function resolveTabCardMetrics(geo, { fontSize, showTaskLane = false, hasStatusMarker = false, nextCardClearancePx = 1 } = {}) {
  const paddingX = num(geo?.paddingX, 6);
  const paddingY = num(geo?.paddingY, 3);
  const paddingLeft = num(geo?.paddingLeft, 16);
  const gap = num(geo?.gap, 4);
  const top = showTaskLane ? Math.max(0, paddingY - 2) : paddingY;
  const bottom = showTaskLane ? paddingY + 2 : paddingY;
  const left = hasStatusMarker ? paddingLeft : paddingX;
  const overhang = Math.max(0, gap - num(nextCardClearancePx, 1));
  return {
    padding: `${top}px ${paddingX}px ${bottom}px ${left}px`,
    borderRadius: num(geo?.borderRadius, 6),
    fontSize: num(fontSize, 14),
    // NEGATIVE, so the squares straddle the bottom edge instead of sitting
    // inside it — they mark the boundary, that is the whole point of the lane.
    // Clamped so they never reach the card below. Written this way rather than
    // as a bare negation because that produces -0 when there is no gap, which
    // reaches CSS as "-0px".
    laneBottomPx: overhang === 0 ? 0 : -overhang,
  };
}

// Explicit, because the row-height math below has to PREDICT the chip's
// rendered height. With the browser default ('normal') the text box height is
// font-dependent and the prediction drifts; the chip sets this value on itself
// so the two cannot disagree.
export const TAB_CARD_LINE_HEIGHT = 1.2;

// The pane header was a hard 26px while the chip inside it obeys the user's
// Settings → Размеры. Any setting that makes the chip taller than 26 made it
// overflow the row symmetrically — poking past the PANE'S TOP EDGE, i.e. over
// the separator line of the stacked pane above. Which of the two painted on
// top then depended on sibling DOM order, so the symptom flipped with focus:
// chip over the line, or line through the chip. The row must be sized FROM the
// chip, not the chip squeezed into the row.
export const SPLIT_ATTACH_ROW_MIN_H = 26;

/**
 * Height of the pane header's SECOND line: the tab's working directory.
 *
 * Its own constant rather than a literal at the two places that need it (the
 * row and everything positioned below the row), for exactly the reason the row
 * height is computed rather than hard-coded — see the note above.
 */
export const SPLIT_ATTACH_PATH_LINE_H = 13;

/**
 * Height of a pane's attach row: the chip's own height plus 1px of air, never
 * below the classic 26 (at default settings the math lands exactly on 26, so
 * nothing moves for anyone who has not touched Размеры).
 *
 * Only fontSize and paddingY matter: the task-lane variant shifts padding
 * between top and bottom but keeps the sum, and the status marker only widens
 * the left inset.
 *
 * `withPath` adds the directory line under the chip. It is a PARAMETER rather
 * than a second function because every surface that positions content below the
 * header must get the same answer as the header itself — the whole reason this
 * lives in one resolver.
 */
export function resolveSplitAttachRowHeight(geo, { fontSize, withPath = false } = {}) {
  const paddingY = num(geo?.paddingY, 3);
  const fs = num(fontSize, 14);
  const chipH = Math.ceil(fs * TAB_CARD_LINE_HEIGHT) + paddingY * 2 + 2; // +2 — chip borders
  const base = Math.max(SPLIT_ATTACH_ROW_MIN_H, chipH + 1);
  return withPath
    ? base + resolveTabCardBottomOverhang(geo) + SPLIT_ATTACH_PATH_LINE_H
    : base;
}

/**
 * How far a card's marks hang BELOW its box.
 *
 * Two of them do it on purpose: the context-usage number and the task-square
 * lane straddle the bottom edge, because a lane that stops inside the card says
 * nothing about a boundary. In the sidebar they hang into the gap before the
 * next card, so the gap is what limits them — and that limit is where this
 * number comes from.
 *
 * The pane header has no next card: under the chip sits the path line. Without
 * reserving the same room, the marks land ON the path — measured live, the
 * green context number sat across the tail of «…/custom-terminal». So the header
 * asks for the overhang and puts it between its two lines.
 */
export function resolveTabCardBottomOverhang(geo) {
  const gap = Math.max(0, Math.floor(num(geo?.gap, 4)));
  // The badge is clamped by the gap (TabSignals::tabFastBadgeOutsidePx); the
  // lane by the gap minus the 1px clearance it leaves the next card.
  const badge = Math.min(TAB_CARD_BADGE_OUTSIDE_PX, gap);
  const lane = Math.max(0, gap - 1);
  return Math.max(badge, lane);
}

// round(TAB_CONTEXT_BADGE_FONT_PX × TAB_FAST_BADGE_OUTSIDE_RATIO) — the share of
// itself a badge shows outside the card. Lives here, with the rest of the card's
// geometry, so the header can reserve for it without importing a component.
export const TAB_CARD_BADGE_OUTSIDE_PX = 3;

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
