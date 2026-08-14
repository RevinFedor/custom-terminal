// WHICH history does Ctrl+Tab walk — this pane's, or the global one?
//
// The gesture is one gesture, but there are now two questions behind it:
//
//   • "bring back what I had HERE" — the pane I am working in has its own past,
//     and in a split that past is the only one that describes this slot;
//   • "bring back what I had ANYWHERE" — the pre-split meaning, and still the
//     right answer when no pane owns the keyboard or the pane has no past yet.
//
// ── Two words that are NOT the same ───────────────────────────────────────
//
// ACTIVE TAB always exists. Every tab-owned surface follows it: the control
// bar, History, Timeline, the task plan, Run after, the composer. Nothing here
// ever clears it — that was the objection to "drop focus when you click outside
// the panes", and it stands: half the screen would need an empty state.
//
// KEYBOARD OWNER is a separate, single answer to "where do keystrokes go":
// either one pane, or the rest of the interface (sidebar, top bars, dashboard).
// Clicking the sidebar does not deactivate the tab, it just moves the keyboard
// out of the pane. That is the whole model — not two focuses of different
// strength, but one selection plus one keyboard location.
//
// So: Ctrl+Tab reads the keyboard owner. A pane owns it → the pane's list, at
// the pane. Nobody owns it → the global list. Cmd+P is always global, because
// "find a tab by name" is not a question about where I have been.

/**
 * @param {object} args
 * @param {number} args.keyboardPaneIndex  pane that owns the keyboard, or -1
 * @param {Array} args.panes               splitPanes
 * @param {number} args.paneHistoryCount   restorable entries in that pane's history
 * @returns {{scope: 'pane'|'global', paneIndex: number, reason: string}}
 */
export function resolveSwitcherScope({ keyboardPaneIndex, panes, paneHistoryCount }) {
  const list = Array.isArray(panes) ? panes : [];
  const idx = Number.isInteger(keyboardPaneIndex) ? keyboardPaneIndex : -1;
  // Single mode has no pane list to scope to — this is the pre-split meaning.
  if (list.length === 0) return { scope: 'global', paneIndex: -1, reason: 'single-mode' };
  // The keyboard is in the interface, not in a pane: the user is not "in" any
  // slot, so scoping to one would pick a pane they are not looking at.
  if (idx < 0 || idx >= list.length) return { scope: 'global', paneIndex: -1, reason: 'no-pane-owner' };
  // A pane the user has not navigated in yet has nothing to offer. Falling
  // through to the global list is what keeps the gesture alive there instead of
  // opening an empty box — the approved answer to "what about a fresh pane".
  if (!(paneHistoryCount > 0)) return { scope: 'global', paneIndex: idx, reason: 'pane-history-empty' };
  return { scope: 'pane', paneIndex: idx, reason: 'pane-owns-keyboard' };
}

/**
 * Filter a project list down to ONE pane's restorable history, keeping the
 * history's own order. The result feeds buildSwitcherRows with the history as
 * the ranking — so the pane list is drawn by the exact same row builder as the
 * global one and the two windows cannot drift apart visually.
 *
 * Only ranked tabs survive: the global builder appends every unranked tab
 * after the ranked ones (its list is "everything, recency-ordered"), while the
 * pane list is "this pane's past" — a tab the pane never showed does not
 * belong in it, however recent it is globally.
 *
 * @param {Array} projects  [{ projectId, projectName, tabs: [...] }]
 * @param {Array} history   restorablePaneHistory() entries, most recent first
 */
export function filterProjectsToPaneHistory(projects, history) {
  const wanted = new Set((history || []).map((e) => e && e.tabId).filter(Boolean));
  return (projects || [])
    .map((project) => ({
      ...project,
      tabs: (project.tabs || []).filter((tab) => wanted.has(tab.id)),
    }))
    .filter((project) => project.tabs.length > 0);
}

/**
 * The focus frame's meaning, in one place.
 *
 * The frame answers "which pane is active" AND, after this change, "whose
 * history will Ctrl+Tab walk" — so its two states are the two answers:
 *
 *   'owns-keyboard' — full contour, bright: keystrokes and Ctrl+Tab land here;
 *   'active-only'   — same 1px contour, dimmed: the tab is still active (every
 *                     surface still follows it) but the keyboard is elsewhere,
 *                     so Ctrl+Tab is global;
 *   'idle'          — the other panes: side separators only.
 *
 * Deliberately brightness, not colour: tabs carry their own colours (a coloured
 * frame would fight them), and violet is already spoken for by the resize
 * handles. And deliberately the DIM state is the exception — owning the keyboard
 * is the normal case, so it must not be the loud one.
 */
export function paneFrameState({ isFocusedPane, keyboardInPane }) {
  if (!isFocusedPane) return 'idle';
  return keyboardInPane ? 'owns-keyboard' : 'active-only';
}
