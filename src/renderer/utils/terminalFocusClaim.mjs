// May the xterm of a tab take KEYBOARD focus right now?
//
// One rule, because every caller was answering it privately and one of them was
// wrong in a way the user felt as data loss: after Cmd+Tab back into the app,
// paste landed in a terminal that was not even on screen (transcript centred,
// side terminal closed) and mangled the TUI's layout.
//
// The trap is that "presented" is not the same question. A closed side panel is
// still MOUNTED and still ACTIVE — it keeps its PTY, its buffer and its
// scrollback on purpose, so that opening it is instant. What it does not have is
// the right to swallow the user's keystrokes: nothing about it is visible, so a
// keystroke it eats is a keystroke that vanishes.
//
// Deliberately NOT included here: whether xterm's own textarea holds focus
// (focusing it is the point), and whether some other input is focused — that is
// a separate "don't steal from an editable" guard, which callers already apply.

/**
 * @param {object} args
 * @param {boolean} args.active            tab is the app's active tab, in terminal view
 * @param {boolean} args.presented         this terminal's layer is on screen at all
 * @param {boolean} args.terminalIsCentre  the terminal (not the transcript) holds the centre
 * @param {boolean} args.sideTerminalOpen  the side terminal panel is OPEN
 * @param {boolean} [args.hasSurfacePair]  this tab owns the transcript↔terminal pair
 * @returns {boolean}
 */
export function canTerminalClaimFocus({
  active,
  presented,
  terminalIsCentre,
  sideTerminalOpen,
  hasSurfacePair = true,
}) {
  if (!active || !presented) return false;
  // A tab with only ONE surface has no side-panel state to consult: its
  // terminal is the centre by definition. (Plain terminal tabs, no agent.)
  if (!hasSurfacePair) return true;
  // The terminal holds the centre → it is the surface the user is looking at.
  if (terminalIsCentre) return true;
  // Otherwise the terminal is the side panel, and only an OPEN panel may take
  // the keystrokes. This is the line that was missing.
  return !!sideTerminalOpen;
}
