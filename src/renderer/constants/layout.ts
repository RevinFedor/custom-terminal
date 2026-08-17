// Heights of the fixed strip at the top of the window, in ONE place.
//
// Two surfaces are positioned against that strip with `position: fixed` and
// therefore cannot learn its height from the flex layout: the file-explorer
// sidebar portal and the tab switcher panel. Both used to carry the literal
// 70 (titlebar 40 + toolbar 30), so adding a row to the strip left them
// overlapping it until someone remembered to update both numbers.

/** App titlebar with the project cards. */
export const TITLE_BAR_H = 40;

/** ProjectToolbar row (History / Compress / ⌘P / usage / Git). */
export const PROJECT_TOOLBAR_H = 30;

/**
 * The location row under the toolbar: the working directory of the ACTIVE tab.
 * Thin on purpose — it is a label, not a control strip.
 */
export const TAB_LOCATION_BAR_H = 20;

/** Everything above the workspace body. */
export const TOP_STRIP_H = TITLE_BAR_H + PROJECT_TOOLBAR_H + TAB_LOCATION_BAR_H;
