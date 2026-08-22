import { captureSpaceLayout } from './workspaceSpacesModel.mjs';

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
//
// A shared shape does NOT make a partially restored store complete. Shutdown
// therefore skips this writer while `isRestoring`, and main rejects a smaller
// workflow-id set unless the explicit remove-workflow action authorises it.

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
    // The single-mode centre's strip, PER PROJECT: without a split there is no
    // pane object to hang it on, and the centre shows a different project's tabs
    // as you move between projects — one shared list would follow you across and
    // read as somebody else's tabs.
    centerStrips: state.centerStrips || {},
    // Рабочие пространства. Раскладка текущего лежит ВЫШЕ, на верхнем уровне —
    // здесь она записывается ещё и в его собственный снимок, иначе перезапуск
    // вернул бы окна на месте, но у пространства они бы «пропали» при первом же
    // переключении. Один и тот же вопрос, два читателя: верхний уровень отвечает
    // «что показать сразу», список — «что показать, когда сюда вернутся».
    spaces: (state.spaces || []).map((space) => (
      space.id === state.activeSpaceId
        ? { ...space, layout: captureSpaceLayout(state) }
        : space
    )),
    activeSpaceId: state.activeSpaceId ?? null,
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
  'centerStrips',
  'spaces',
  'activeSpaceId',
]);
