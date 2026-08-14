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

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
