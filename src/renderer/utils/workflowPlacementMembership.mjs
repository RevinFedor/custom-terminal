import { layoutReferences } from '../../shared/workflow-organization.cjs';
import { captureSpaceLayout } from './workspaceSpacesModel.mjs';
import { INBOX_WORKFLOW_ID } from './workflowMembership.mjs';

function placements(state) {
  return new Map((state.spaces || []).map(space => [space.id,new Set(layoutReferences(
    space.id === state.activeSpaceId ? captureSpaceLayout(state) : space.layout || {},
  ).map(reference => reference.tabId))]));
}

/** Local placement intent; automation continues reading Main's committed membership. */
export function organizationPlacementIntent(previous, next) {
  if (!previous.organizationReady || previous.isRestoring || next.isRestoring) return null;
  const before = placements(previous), after = placements(next);
  const pending = {...previous.pendingTabWorkflowMembership};
  const workflows = new Set((next.spaces || []).map(space => space.id));
  for (const [tabId,member] of Object.entries(previous.tabWorkflowMembership || {})) {
    const current = pending[tabId]?.workflowId || member.workflowId;
    if (!workflows.has(current)) pending[tabId] = {...member,workflowId:INBOX_WORKFLOW_ID};
  }
  for (const [workflowId,tabs] of after) for (const tabId of tabs) {
    if (before.get(workflowId)?.has(tabId) || !previous.tabWorkflowMembership[tabId]) continue;
    // Merely revealing a profile-only placement or switching workflow does
    // not move membership. A newly added placement does.
    if ([...before].some(([id,tabs]) => id !== workflowId && tabs.has(tabId))
      && [...after].some(([id,tabs]) => id !== workflowId && tabs.has(tabId))) continue;
    pending[tabId] = {...previous.tabWorkflowMembership[tabId],workflowId};
    // Direct files and physical subagents keep their exact owner. Visual AI
    // descendants have their own membership and are not transitively included.
    const family = new Set([tabId]);
    let added = true;
    while (added) {
      added = false;
      for (const workspace of previous.openProjects.values()) for (const tab of workspace.tabs.values()) {
        if (family.has(tab.id) || !(family.has(tab.parentTabId)
          || tab.tabType === 'file' && family.has(tab.visualParentTabId))) continue;
        family.add(tab.id);added = true;
        const member = previous.tabWorkflowMembership[tab.id];
        if (member) pending[tab.id] = {...member,workflowId};
      }
    }
  }
  return {pendingTabWorkflowMembership:pending};
}
