import { buildSwitcherRows, initialCtrlIndex, resolveCtrlTabAnchor } from './tabSwitcherModel.mjs';
import { onScreenTabIds } from './tabVisitHistoryRule.mjs';
import { allPaneTabIds } from './splitPanesModel.mjs';
import { spacesWithLiveLayout } from './workspaceSpaceRecovery.mjs';
import { tabSpaceIndexMap } from './workspaceSpacesModel.mjs';
import { UNPLACED_WORKFLOW_ID, UNPLACED_WORKFLOW_NAME, resolveWorkflowIcon } from './workflowVisuals.mjs';

// One selector for the actual desktop panel and the read-only bridge. The
// caller supplies snapshots, not navigation methods or a mounted component.
export function buildSwitcherWorkflowLookup(ws, projects) {
  const spaces = spacesWithLiveLayout(ws.spaces, ws.activeSpaceId, ws);
  const indexes = tabSpaceIndexMap(spaces, allPaneTabIds, ws.activeSpaceId);
  return tabId => {
    const index = indexes.get(tabId), space = index === undefined ? null : spaces[index];
    return space ? { id: space.id, name: space.name || 'Workflow',
      icon: resolveWorkflowIcon(space, projectId => projects[projectId]?.icon || null), unplaced: false }
      : { id: UNPLACED_WORKFLOW_ID, name: UNPLACED_WORKFLOW_NAME, icon: null, unplaced: true };
  };
}

export function captureSwitcherInputs(ws, projectsMeta, {
  isFileMissing = () => false, inboxName = 'Inbox', projectTab,
} = {}) {
  const workflowForTab = buildSwitcherWorkflowLookup(ws, projectsMeta);
  const recentFirst = [...ws.projectHistory].reverse();
  const orderedIds = [...recentFirst.filter(id => ws.openProjects.has(id)),
    ...Array.from(ws.openProjects.keys()).filter(id => !recentFirst.includes(id))];
  const centerTabId = ws.activeProjectId ? ws.openProjects.get(ws.activeProjectId)?.activeTabId || null : null;
  const anchorTabId = resolveCtrlTabAnchor({ panes: ws.splitPanes, focusedIndex: ws.splitFocusedIndex, centerTabId });
  const visibleTabIds = onScreenTabIds({ panes: ws.splitPanes, centerTabId: anchorTabId });
  const projects = orderedIds.map(projectId => {
    const workspace = ws.openProjects.get(projectId);
    const projectName = projectsMeta[projectId]?.name || (projectId === '__noted_inbox__' ? inboxName
      : workspace.projectPath?.split('/').filter(Boolean).pop() || 'Project');
    const tabs = Array.from(workspace.tabs.values()).filter(tab => !tab.parentTabId).map(tab => {
      const workflow = workflowForTab(tab.id);
      return { ...(projectTab ? projectTab(tab) : tab), ...(tab.tabType === 'file' && isFileMissing(tab.filePath) ? { missing: true } : {}),
        workflowId: workflow.id, workflowName: workflow.name, workflowIcon: workflow.icon, workflowUnplaced: workflow.unplaced };
    });
    return { projectId, projectName, projectIcon: projectsMeta[projectId]?.icon || null, tabs };
  }).filter(project => project.tabs.length > 0);
  return { projects, globalMru: ws.globalTabMru, desktop: { anchorTabId, visibleTabIds, activeSpaceId: ws.activeSpaceId || null } };
}

export function selectSwitcherRows(input, { query = '', hideOnScreen = false, context = input.desktop } = {}) {
  const anchorTabId = hideOnScreen ? context.anchorTabId : null;
  const hidden = hideOnScreen ? new Set(context.visibleTabIds) : null;
  const projects = input.projects.map(project => ({ ...project,
    tabs: project.tabs.filter(tab => tab.id === anchorTabId || !hidden || !hidden.has(tab.id)),
  })).filter(project => project.tabs.length > 0);
  const rows = buildSwitcherRows({ projects, globalMru: input.globalMru, query, pinnedFirstTabId: anchorTabId });
  return { rows, anchorTabId, visibleTabIds: [...context.visibleTabIds],
    initialIndex: hideOnScreen ? initialCtrlIndex(rows, input.globalMru, anchorTabId) : -1 };
}
