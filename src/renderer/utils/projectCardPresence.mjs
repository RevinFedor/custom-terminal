// Three states of a project card in the titlebar.
//
// The card used to answer one question — "is this the project the sidebar is
// showing" — and painted a white plate for yes, nothing for no. With panes that
// left a real case unnamed: a pane can show a tab of ANOTHER project, and that
// project's card looked exactly as idle as one not opened in a week.
//
//   'focused'  — the sidebar/toolbar project. White plate, black text.
//                Deliberately the loudest: the white plate is where the map
//                (the sidebar) points.
//   'on-screen' — not focused, but at least one of its tabs is visible in a
//                pane (or is the centre tab). A faint wash.
//   'idle'     — none of the above. Nothing.
//
// There WAS a fourth tier — 'working', a 1px contour for "the ACTIVE tab's
// project" — needed while the sidebar could point away from the active tab.
// The one-pointer model (2026-08-17) made it unreachable in practice: the
// sidebar follows every activation, so focused and working are the same card
// except during an explicit project parking, and a mark that appears only in
// that transient window taught nothing. Removed with it: PROJECT_CARD_WORKING_RING.

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
  // Single mode: the centre is the only visible surface, and while the sidebar
  // is parked on another project the centre tab can still belong to this one.
  return centerProjectId && centerProjectId === projectId ? 'on-screen' : 'idle';
}
