// What "the saved session" IS — one definition, used by BOTH ways it is written.
//
// The session is written on two paths:
//   • the debounced save during normal work (300ms after any change);
//   • the immediate save while the app is closing (beforeunload).
//
// They used to build the object separately, and the closing one listed fewer
// fields — it saved the projects, the active project and the view, and nothing
// else. Since it always runs LAST, it OVERWROTE the good record with the short
// one every single time the app was closed. Everything the short version did
// not mention was gone on the next launch: the split layout, which pane was
// focused, the tab-visit order, the project order, the sidebar's project.
//
// The user saw it as "I had two panes, I reinstalled, now there is one" — and
// the layout really was saved correctly, right up to the moment of closing.
//
// So the shape is built HERE, once, and both callers use it. Adding a field to
// the session now means adding it in one place; the closing path cannot fall
// behind again, because there is no second list to keep in sync.

/**
 * Build the persisted session record.
 *
 * @param {object} state — the workspace store state (openProjects Map, …).
 * @returns {object} the value stored under the session key.
 */
export function buildSessionSnapshot(state) {
  const openProjects = state && state.openProjects ? state.openProjects : new Map();
  return {
    openProjects: Array.from(openProjects.values()).map((workspace) => {
      const tabIds = Array.from(workspace.tabs.keys());
      const activeTabIndex = workspace.activeTabId ? tabIds.indexOf(workspace.activeTabId) : 0;
      return {
        projectId: workspace.projectId,
        projectPath: workspace.projectPath,
        activeTabIndex: Math.max(0, activeTabIndex),
      };
    }),
    activeProjectId: state.activeProjectId ?? null,
    focusedProjectId: state.focusedProjectId ?? null,
    view: state.view,
    projectHistory: state.projectHistory || [],
    globalTabMru: state.globalTabMru || [],
    splitPanes: state.splitPanes || [],
    splitFocusedIndex: state.splitFocusedIndex ?? 0,
    // Divider positions; null = equal split (the stored default is absent,
    // same as a pane's `column`).
    splitSizes: state.splitSizes ?? null,
  };
}

/**
 * Every field the session record carries. A save that omits any of these
 * silently erases it, because the store writes the whole value at once.
 *
 * Exported for the test that guards the two writers against drifting apart —
 * that is the failure this whole module exists to prevent.
 */
export const SESSION_SNAPSHOT_FIELDS = Object.freeze([
  'openProjects',
  'activeProjectId',
  'focusedProjectId',
  'view',
  'projectHistory',
  'globalTabMru',
  'splitPanes',
  'splitFocusedIndex',
  'splitSizes',
]);
