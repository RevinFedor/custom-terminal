// Three states of a project card in the titlebar, not two.
//
// The card used to answer one question — "is this the project the sidebar is
// showing" — and painted a white plate for yes, nothing for no. With panes that
// leaves a real case unnamed: a pane can show a tab of ANOTHER project, so that
// project is on screen and being worked in, while its card looks exactly as
// idle as a project you have not opened in a week.
//
//   'focused'  — the sidebar/toolbar project. White plate, black text. Unchanged.
//   'on-screen' — not focused, but at least one of its tabs is visible in a pane
//                 (or is the centre tab in single mode). A faint white wash:
//                 clearly "in use", clearly not the selected one.
//   'idle'     — neither. Nothing, as before.
//
// Deliberately a WASH, not a border or a dot: the card's edges already carry the
// drop outline and the focus ring, its inside carries the completion flash, the
// awaiting-input pulse and the process counter. A background is the one channel
// still free — and it reads at a glance without asking the eye to decode a mark.

/** Alpha of the on-screen wash. Faint enough to never compete with the white
 *  plate of the focused card, strong enough to survive video compression on a
 *  dark titlebar (the AI-detectability rule in CLAUDE.md). */
export const PROJECT_CARD_ON_SCREEN_BG = 'rgba(255,255,255,0.14)';

/**
 * @param {object} args
 * @param {string} args.projectId
 * @param {string|null} args.focusedProjectId  project the sidebar shows
 * @param {Array<{projectId?: string, tabId?: string}>} args.panes
 * @param {string|null} [args.centerProjectId] single mode: project of the centre tab
 * @returns {'focused'|'on-screen'|'idle'}
 */
export function projectCardPresence({ projectId, focusedProjectId, panes, centerProjectId }) {
  if (!projectId) return 'idle';
  if (projectId === focusedProjectId) return 'focused';
  const list = Array.isArray(panes) ? panes : [];
  if (list.length > 0) {
    // Empty placeholder panes hold no tab and therefore show no project.
    const shown = list.some((pane) => pane && pane.tabId && pane.projectId === projectId);
    return shown ? 'on-screen' : 'idle';
  }
  // Single mode: the centre is the only visible surface. It can still belong to
  // another project — activating a tab moves the centre, not the sidebar.
  return centerProjectId && centerProjectId === projectId ? 'on-screen' : 'idle';
}
