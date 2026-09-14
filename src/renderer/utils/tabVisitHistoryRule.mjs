// WHEN does a tab activation belong in the visit history?
//
// The history answers "where will I want to go back to", and the switcher uses
// it for "bring me the thing that is not on screen". While only one tab was
// visible those were one event: activating a tab WAS making it appear.
//
// With panes they split into TWO questions, and the whole file exists because
// answering both with one flag was wrong in each direction in turn:
//
//   1. HOW FRESH is this tab?           → every activation, no exceptions.
//   2. May it be OFFERED as a return?   → only while it is off screen.
//
// The first version answered only (2) and used it for both: clicking the
// neighbouring pane rewrote the history, and Ctrl+Tab offered the tab already in
// front of the user. The fix at the time — "an activation counts only when the
// tab was not on screen" — cured that and created the mirror defect, reported
// live 2026-08-17: *«перехожу на другую вкладку, нажимаю Ctrl+Tab, ожидая
// увидеть ту вкладку, которая была до этого, но она вообще на десятом месте»*.
//
// Why: a tab sitting in a pane could be worked in for hours without a single
// recorded event, because it never "appeared" — it was already there. Leaving
// the screen is not an event either (nobody activates a tab in order to hide
// it). So its rank stayed frozen at whenever it last came into view, and every
// unrelated activation pushed it one place further down. The user named the
// mechanism exactly: *«вкладка отходит всё назад и назад»*.
//
// Hence the split below. Freshness follows FOCUS, because that is what "I was
// just working here" means; visibility no longer gates recording at all — it
// gates only what the switcher may offer, and it does that in its own list
// (TabSwitcherOverlay::computeRowsFromStores). The two rules meet exactly once:
// the moment a tab leaves the screen it becomes the freshest thing NOT on it,
// so it lands directly under the anchor — with no rule about second place, and
// with the rest of the list ordered by real work rather than by an accident of
// which tab happened to be swapped in last.

import { allPaneTabIds } from './splitPanesModel.mjs';

/**
 * Does this activation update the tab's freshness?
 *
 * Yes, always. Kept as a named function rather than inlined `true` because the
 * question is real and has been answered wrongly twice; a call site reading
 * `isVisitWorthRecording` documents that the decision was made here, and the
 * next person who wants to gate it has one place to argue with.
 *
 * @param {object} args
 * @param {string} args.tabId  tab being activated
 * @returns {boolean} true when this activation should be recorded
 */
export function isVisitWorthRecording({ tabId }) {
  if (!tabId) return false;
  // Focus IS the event. Being on screen is a separate question, asked by the
  // switcher about its own rows — see the note above.
  return true;
}

/**
 * Tabs on screen right now: everything a pane HOLDS, or the single centre tab.
 *
 * Same shape of answer as the toast placement rule — both ask "what is visible",
 * not "what has focus".
 *
 * A pane now holds a strip of chips with one of them shown, and this counts the
 * whole strip. Strictly, an unshown chip's CONTENT is not visible — but the
 * question the switcher asks is "is it already here, in front of me", and a chip
 * is: it is one click away, in a place the user is looking at, and it is what
 * they built the strip for. Offering it in the ctrl list would put the same tab
 * in two places at once and push the genuinely absent tabs further down — the
 * exact failure this file exists to prevent, one level up.
 */
export function onScreenTabIds({ panes, centerTabId }) {
  const list = Array.isArray(panes) ? panes : [];
  const fromPanes = allPaneTabIds(list.filter(pane => !pane?.displayHidden));
  if (fromPanes.length > 0) return fromPanes;
  return centerTabId ? [centerTabId] : [];
}
