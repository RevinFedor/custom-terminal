// A cursor-anchored menu must stay inside the window.
//
// Menus that open at the click point (context menus, the split-direction menu)
// take the raw cursor coordinates — and the controls that open them live at the
// window's edges (the split button is the RIGHT-most thing in a pane header),
// so the menu's body routinely lands outside the app. An OS-level context menu
// would be moved by the OS; a DOM-portal menu just clips into nothing.
//
// One rule, used by every such menu: clamp the box into the viewport with a
// small pad. TabBar had its own copy of this — new menus kept being written
// WITHOUT it, which is exactly why the rule now lives in a module.

export const MENU_VIEWPORT_PAD = 8;

/**
 * @param {object} args
 * @param {number} args.x           requested left (cursor)
 * @param {number} args.y           requested top (cursor)
 * @param {number} args.width       menu box width
 * @param {number} args.height      menu box height
 * @param {number} args.viewportWidth
 * @param {number} args.viewportHeight
 * @param {number} [args.pad]
 * @returns {{x: number, y: number}}
 */
export function clampMenuToViewport({
  x,
  y,
  width,
  height,
  viewportWidth,
  viewportHeight,
  pad = MENU_VIEWPORT_PAD,
}) {
  let nx = Number.isFinite(x) ? x : pad;
  let ny = Number.isFinite(y) ? y : pad;
  const w = Number.isFinite(width) ? width : 0;
  const h = Number.isFinite(height) ? height : 0;
  const vw = Number.isFinite(viewportWidth) ? viewportWidth : 0;
  const vh = Number.isFinite(viewportHeight) ? viewportHeight : 0;
  if (nx + w > vw - pad) nx = vw - w - pad;
  if (ny + h > vh - pad) ny = vh - h - pad;
  // Left/top clamps LAST: when the menu is larger than the viewport, being
  // flush with the top-left (content reachable) beats being flush with the
  // bottom-right (title row unreachable).
  if (nx < pad) nx = pad;
  if (ny < pad) ny = pad;
  return { x: nx, y: ny };
}
