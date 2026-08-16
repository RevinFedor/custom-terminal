// Four states of a project card in the titlebar, not two.
//
// The card used to answer one question — "is this the project the sidebar is
// showing" — and painted a white plate for yes, nothing for no. With panes that
// leaves real cases unnamed: a pane can show a tab of ANOTHER project, and the
// tab being WORKED IN can belong to a project whose card looks exactly as idle
// as one not opened in a week.
//
//   'focused'  — the sidebar/toolbar project. White plate, black text. Unchanged,
//                and deliberately still the loudest: the white plate means an
//                EXPLICIT project choice («смена вкладки ≠ смена проекта»), so a
//                working project must never outshine it — that would read as
//                "switching the tab switched the project", the exact confusion
//                the two pointers exist to prevent.
//   'working'  — not focused, but the ACTIVE tab (the focused pane's tab, or
//                the centre tab in single mode) belongs to it. Wash + a 1px
//                white contour: the same visual language as the pane frame —
//                contour = "work happens here", wash = "this is shown". The
//                contour follows the ACTIVE TAB, not the keyboard owner: a
//                click into the sidebar must not flicker the titlebar.
//   'on-screen' — not focused, not active, but at least one of its tabs is
//                visible in a pane. The faint wash alone.
//   'idle'     — none of the above. Nothing, as before.
//
// Wash + contour rather than two wash intensities: two alphas a few percent
// apart on a small card cannot be told apart without a side-by-side reference,
// while "has an edge / has no edge" reads instantly — and matches what the
// contour already means on the panes.

/** Alpha of the on-screen wash. Faint enough to never compete with the white
 *  plate of the focused card, strong enough to survive video compression on a
 *  dark titlebar (the AI-detectability rule in CLAUDE.md). */
export const PROJECT_CARD_ON_SCREEN_BG = 'rgba(255,255,255,0.14)';

/** Contour of the working card. 0.60, not the 0.50 of the projects-area
 *  navigation ring on the white card — the two coexist rarely (that ring lives
 *  only on the focused card) but must not read as the same mark when they do. */
export const PROJECT_CARD_WORKING_RING = 'inset 0 0 0 1px rgba(255,255,255,0.60)';

/**
 * @param {object} args
 * @param {string} args.projectId
 * @param {string|null} args.focusedProjectId  project the sidebar shows
 * @param {string|null} [args.activeProjectId] project of the ACTIVE tab
 * @param {Array<{projectId?: string, tabId?: string}>} args.panes
 * @param {string|null} [args.centerProjectId] single mode: project of the centre tab
 * @returns {'focused'|'working'|'on-screen'|'idle'}
 */
export function projectCardPresence({ projectId, focusedProjectId, activeProjectId, panes, centerProjectId }) {
  if (!projectId) return 'idle';
  if (projectId === focusedProjectId) return 'focused';
  // The active tab's project. The active tab is on screen by definition (the
  // focused pane's tab, or the centre in single mode), so no visibility check
  // is needed on top.
  if (activeProjectId && projectId === activeProjectId) return 'working';
  const list = Array.isArray(panes) ? panes : [];
  if (list.length > 0) {
    // Empty placeholder panes hold no tab and therefore show no project.
    const shown = list.some((pane) => pane && pane.tabId && pane.projectId === projectId);
    return shown ? 'on-screen' : 'idle';
  }
  // Single mode without an activeProjectId from the caller: the centre is the
  // only visible surface, and it can still belong to another project.
  return centerProjectId && centerProjectId === projectId ? 'on-screen' : 'idle';
}
