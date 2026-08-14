// Default state of the Run after panel, in ONE place.
//
// A fresh tab opens COLLAPSED: the rail (counter + grab + panel toggles) is
// enough to see there is nothing queued, and an expanded panel on every new tab
// ate width the user had not asked to spend.
//
// The trap this module exists to prevent: the default and the "is this worth
// saving?" check must agree. Storage skips a tab whose state equals the
// default, so if only one of the two flips, the user's manual "expand this
// empty tab" is written as if it were the default and comes back collapsed
// after a restart. Both answers now come from the same constant.
//
// Persistence stays a plain boolean — `undefined` (a row written before the
// field existed, or no row at all) reads as the default, and only an explicit
// `false` counts as "the user expanded this one".

export const DEFAULT_RUN_AFTER_PANEL_COLLAPSED = true;

export function resolvePersistedPanelCollapsed(value) {
  if (value === true) return true;
  if (value === false) return false;
  return DEFAULT_RUN_AFTER_PANEL_COLLAPSED;
}

// True when the tab's panel state is a deliberate choice that must survive a
// restart even though the queue itself is empty.
export function panelCollapsedIsWorthPersisting(value) {
  return resolvePersistedPanelCollapsed(value) !== DEFAULT_RUN_AFTER_PANEL_COLLAPSED;
}
