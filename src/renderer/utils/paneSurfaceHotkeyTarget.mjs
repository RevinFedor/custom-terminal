// WHICH tab does Cmd+] act on?
//
// The shortcut opens "the other surface of THIS pane". In a split, "this pane"
// is the focused pane — and its tab is normally the active tab, so reading the
// active tab was right for as long as the two could not diverge.
//
// They can. A pane can show tab B while the active tab is still A, in another
// pane — an empty placeholder in focus is the everyday case, and any future
// "put a tab here without going to it" path recreates the full one.
//
// Measured on the reported failure (production.log, 21:43 UTC): the user
// dropped tab-2403 into pane 0 without moving focus, then pressed Cmd+] — and
// every press toggled the side terminal of tab-3314, the tab still marked active
// in another pane. The pane in front of them never reacted, which reads exactly
// as "the shortcut does not work"; on the other tab, where active and shown
// happened to agree, it worked. Changing the keyboard layout "fixed" it only
// because the click that came with it re-synced the two. (That particular entry
// point — the pane header's recent-tabs list — was removed 2026-08-17; the rule
// stays, because the divergence it fixes does not depend on it.)
//
// So the target is the FOCUSED PANE's tab, and the active tab is merely the
// fallback for single mode. Same family as the toast and history bugs: one
// signal was answering two different questions.

/**
 * @param {object} args
 * @param {Array<{tabId?: string}>} args.panes  splitPanes ([] = single mode)
 * @param {number} args.focusedIndex            splitFocusedIndex
 * @param {string|null} args.activeTabId        the app-wide active tab
 * @returns {string|null} tab the surface shortcuts must act on
 */
export function resolvePaneSurfaceHotkeyTabId({ panes, focusedIndex, activeTabId }) {
  const list = Array.isArray(panes) ? panes : [];
  if (list.length === 0) return activeTabId || null;
  const index = Number.isInteger(focusedIndex) ? focusedIndex : 0;
  const pane = list[Math.max(0, Math.min(list.length - 1, index))];
  // An empty placeholder pane has no surfaces to toggle; the active tab is the
  // only thing left that can answer, and it is still on screen in some pane.
  if (pane && pane.tabId) return pane.tabId;
  return activeTabId || null;
}
