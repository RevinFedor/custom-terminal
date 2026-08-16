// WHERE do keystrokes go — the workspace, or the surrounding interface?
//
// One question, one answer, decided by what the user last pressed on. This is
// not focus and not selection: the active tab never changes here. It exists so
// Ctrl+Tab can tell "bring back what I had in THIS pane" from "bring back what
// I had anywhere" without asking the user to remember a mode.
//
// Rules, in the order they are asked:
//
//   1. A press inside a pane / the centre surface → the workspace owns the
//      keyboard. This includes the terminal, the transcript, the composer, the
//      pane header — everything that is "the work".
//   2. A press on the interface AROUND the work — the tab list, the top bars,
//      the dashboard, a project card → the interface owns it. The tab stays
//      active; only the destination of the next keystroke changes.
//   3. A press on a floating overlay (menu, popover, the switcher itself)
//      changes NOTHING. An overlay is a tool for acting on what is underneath;
//      opening a menu about a pane must not hand the keyboard to whatever is
//      behind the menu, and dismissing one must not move it either. Without
//      this rule, picking a row in a list that belongs to a pane would flip
//      ownership as a side effect of the click that chose the row.
//
// Everything else (a press on the window background, an element with no
// marker) is left ALONE rather than guessed: "unknown" must not silently mean
// "the interface", or a stray click on padding would change what Ctrl+Tab does.

/**
 * Surfaces that ARE the work. One marker on the centre column
 * (data-workspace-center in Workspace.tsx) covers the terminal, the panes,
 * History, the composer and the control bar at once — chasing each inner
 * surface separately is how a list like this rots. The pane wrapper is listed
 * too for panes portalled outside the column (none today; cheap insurance).
 */
export const WORKSPACE_SURFACE_SELECTORS = Object.freeze([
  '[data-workspace-center]',
  '[data-terminal-pane-wrapper]',
]);

/** Surfaces AROUND the work. A press here moves the keyboard out of the pane. */
export const INTERFACE_SURFACE_SELECTORS = Object.freeze([
  '[data-tabbar-vertical]',
  '[data-project-toolbar]',
  '.title-bar',
  '[data-dashboard-root]',
]);

/**
 * Overlays: a press here is about the overlay, never about ownership.
 *
 * The switcher panel is included deliberately — it is opened FROM one scope and
 * clicking a row inside it must not change that scope before the pick lands.
 */
export const OWNERSHIP_NEUTRAL_SELECTORS = Object.freeze([
  '[data-tab-switcher-root]',
  '[data-pane-recent-menu]',
  '[data-pane-recent-button]',
  '[data-tab-context-menu]',
  '[data-split-direction-menu]',
  '[data-run-after-picker-menu]',
  '[data-command-history-popover]',
  // Not an overlay, but the same logic: dragging a divider is about GEOMETRY,
  // not "I want to type here" — same reasoning that excludes the right and
  // middle buttons. Without this, grabbing a divider while the keyboard was in
  // the sidebar would flip ownership and flash the pane frame mid-drag.
  '[data-split-divider]',
]);

const matches = (el, selectors) => (
  !!el && typeof el.closest === 'function' && selectors.some((s) => !!el.closest(s))
);

/**
 * @param {Element|null} target  the pressed element
 * @returns {'workspace'|'interface'|null} null = leave ownership unchanged
 */
export function keyboardOwnerFromPress(target) {
  if (!target) return null;
  // Neutral first: an overlay can be rendered INSIDE a pane wrapper (portals
  // aside, the pane's own menus are), so asking about the pane first would read
  // a menu click as work.
  if (matches(target, OWNERSHIP_NEUTRAL_SELECTORS)) return null;
  if (matches(target, WORKSPACE_SURFACE_SELECTORS)) return 'workspace';
  if (matches(target, INTERFACE_SURFACE_SELECTORS)) return 'interface';
  return null;
}

/**
 * Should this press be considered at all?
 *
 * Only the LEFT button. A right click opens a menu about something and a middle
 * click removes something — neither is "I want to type here", exactly as with
 * pane focus and the header chip.
 */
export function pressCanMoveKeyboardOwner(button) {
  return button === 0;
}
