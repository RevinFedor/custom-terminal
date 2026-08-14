// WHEN does a tab activation belong in the visit history?
//
// The history answers "where will I want to go back to", and the switcher uses
// it for "bring me the thing that is not on screen". While only one tab was
// visible those were the same event: activating a tab WAS making it appear.
//
// With panes they diverge. Clicking the neighbouring pane changes which pane has
// focus, but nothing new appears — both tabs were already on screen. Recording
// that rewrites the history with information it does not carry, and Ctrl+Tab then
// offers the tab you are already looking at, which is the opposite of what the
// gesture is for.
//
// So the rule is about VISIBILITY, not about clicks: an activation is a visit
// when it puts on screen something that was not there.

/**
 * @param {object} args
 * @param {string} args.tabId              tab being activated
 * @param {string[]} args.visibleTabIds    tabs on screen BEFORE this activation
 *                                         (all pane tabs; single mode → the centre tab)
 * @returns {boolean} true when this activation should be recorded
 */
export function isVisitWorthRecording({ tabId, visibleTabIds }) {
  if (!tabId) return false;
  const visible = Array.isArray(visibleTabIds) ? visibleTabIds : [];
  // Not on screen → it is about to appear. That is a visit.
  if (!visible.includes(tabId)) return true;
  // Already on screen. The only reason to record would be "it became the focused
  // one", and focus is not what the history is asked about — see above.
  return false;
}

/**
 * Tabs on screen right now: every pane's tab, or the single centre tab.
 *
 * Same shape of answer as the toast placement rule — both ask "what is visible",
 * not "what has focus".
 */
export function onScreenTabIds({ panes, centerTabId }) {
  const list = Array.isArray(panes) ? panes : [];
  const fromPanes = list
    .map((pane) => (pane && typeof pane.tabId === 'string' ? pane.tabId : ''))
    .filter(Boolean);
  if (fromPanes.length > 0) return fromPanes;
  return centerTabId ? [centerTabId] : [];
}
