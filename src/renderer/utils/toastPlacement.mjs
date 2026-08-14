// WHERE does a toast belong, and WHEN is it visible?
//
// Two questions that used to have one answer each, both wrong once the workspace
// could show several tabs at the same time:
//
//  • Place. The container is `position: fixed` at the window's top-right, so a
//    message about the LEFT pane appeared over the RIGHT one. With one visible
//    tab that was invisible as a bug; with panes it points at the wrong work.
//
//  • Visibility. A tab-scoped toast rendered only while its tab was THE effective
//    active tab — i.e. the focused pane's tab. Click another pane and the toast
//    vanished, although its tab is still on screen right there. The user's own
//    words: «если я делаю фокус под рукой вкладки, то они почему-то пропадают».
//
// The rule below answers both from one fact: which tabs are VISIBLE (all panes,
// or the single centre tab), not which one holds focus.

/**
 * Tabs that currently occupy a surface on screen.
 *
 * @param {object} args
 * @param {Array<{tabId?: string}>} args.panes  split panes (empty in single mode)
 * @param {string|null} args.effectiveTabId     the centre/focused tab
 * @returns {string[]} tab ids, in pane order; single mode → the one centre tab
 */
export function visibleToastTabIds({ panes, effectiveTabId }) {
  const list = Array.isArray(panes) ? panes : [];
  const fromPanes = list
    .map((pane) => (pane && typeof pane.tabId === 'string' ? pane.tabId : ''))
    .filter(Boolean);
  if (fromPanes.length > 0) return fromPanes;
  return effectiveTabId ? [effectiveTabId] : [];
}

/**
 * Which surface should show this toast?
 *
 * Returns the tab id whose pane hosts it, or null for "the window" (global
 * toasts, and tab-scoped ones whose tab is not on screen — those keep the old
 * window-corner placement rather than disappearing, so a message about
 * background work is never silently dropped).
 */
export function resolveToastHostTabId(toast, visibleTabIds) {
  const tabId = toast && typeof toast.tabId === 'string' ? toast.tabId : '';
  if (!tabId) return null;
  const visible = Array.isArray(visibleTabIds) ? visibleTabIds : [];
  return visible.includes(tabId) ? tabId : null;
}

/**
 * Should this toast be rendered at all?
 *
 * Everything is rendered. This exists as a named rule because the previous
 * answer — "only while its tab is the FOCUSED one" — is what made toasts vanish
 * on a click into a neighbouring pane, and a future change should have to argue
 * with this comment rather than re-introduce the filter by accident.
 */
export function isToastVisible() {
  return true;
}
