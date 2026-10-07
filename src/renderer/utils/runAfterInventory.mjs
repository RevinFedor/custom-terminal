import { aiKindForTab } from './runAfterTabScope.mjs';
import { resolvePtyAgentOwner } from './ptyAgentOwner.mjs';
import { automationWorkflowForProject, UNPLACED_AUTOMATION_WORKFLOW } from './autoCompactPolicy.mjs';
import { resolveWorkflowIcon, UNPLACED_WORKFLOW_ID } from './workflowVisuals.mjs';
import { collectQueueRelations } from './runAfterDependencyLayout.mjs';
import { workflowForTab } from './workflowMembership.mjs';

export function runAfterTargetInventory(workspace, projects, ownerTabId) {
  const ownerProjectId = [...workspace.openProjects].find(([, value]) => value.tabs.has(ownerTabId))?.[0];
  return [...workspace.openProjects].flatMap(([projectId, value]) => [...value.tabs.values()].flatMap(tab => {
    const kind = aiKindForTab(tab);
    if (!kind || tab.parentTabId || tab.id === ownerTabId) return [];
    return [{ id: tab.id, name: tab.name || tab.id.slice(-6), kind, projectId,
      projectName: projects[projectId]?.name || value.projectPath?.split(/[\\/]/).filter(Boolean).pop() || projectId,
      isOwnerProject: projectId === ownerProjectId,
      workflowId: workflowForTab(workspace,tab.id,projectId),
      groupId: tab.groupId || null, visualParentTabId: tab.visualParentTabId || null }];
  }));
}

export function automationInventory(workspace, metadata) {
  const projects = [...workspace.openProjects].map(([id, value]) => ({ id,
    name: metadata[id]?.name || value.projectPath?.split('/').filter(Boolean).pop() || id,
    icon: metadata[id]?.icon || null, tabs: [...value.tabs.values()]
      .filter(tab => tab.tabType !== 'claude-sdk' && resolvePtyAgentOwner(tab)) }));
  const tabs = projects.flatMap(project => project.tabs.map(tab => {
    const provider = resolvePtyAgentOwner(tab);
    return { id: tab.id, name: tab.name, provider,
      sessionId: (provider === 'codex' ? tab.codexSessionId : tab.claudeSessionId) || null,
      color: tab.color, tabType: tab.tabType, projectId: project.id,
      projectName: project.name, projectIcon: project.icon, cwd: tab.cwd || '',
      workflowId: workflowForTab(workspace,tab.id,project.id),
      membershipRevision: workspace.tabWorkflowMembership?.[tab.id]?.revision };
  }));
  const groups = [...workspace.spaces, ...(!workspace.organizationReady
    ? [{ id: UNPLACED_AUTOMATION_WORKFLOW, name: 'Без workflow', projectIds: [] }] : [])]
    .map(space => ({ ...space, icon: space.id === UNPLACED_AUTOMATION_WORKFLOW ? null
      : resolveWorkflowIcon(space, id => metadata[id]?.icon || null),
      projectNames: workspace.organizationReady
        ? [...new Set(tabs.filter(tab => tab.workflowId === space.id).map(tab => tab.cwd?.split('/').filter(Boolean).pop()).filter(Boolean))]
        : space.id === UNPLACED_AUTOMATION_WORKFLOW
        ? projects.filter(project => automationWorkflowForProject(workspace.spaces, project.id) === space.id).map(project => project.name)
        : (space.projectIds || []).map(id => metadata[id]?.name || metadata[id]?.path?.split('/').filter(Boolean).pop() || id),
      tabs: tabs.filter(tab => tab.workflowId === space.id) }));
  return { tabs, groups };
}

export function queueIsConfigured(queue) {
  return !!queue && (queue.items.length > 0 || queue.postPromptEnabled || queue.loopPromptEnabled
    || queue.firstDelaySeconds > 0 || !!queue.runAfterTabId);
}

// Same topology as the desktop overview. Its shelf memory is UI-owned; native
// can request the fresh staged/active topology without changing that memory.
export function selectRunAfterOverview(inventory, queues, { hasPending, shelves = new Map(), showDisabled = true }) {
  const known = new Set(inventory.tabs.map(tab => tab.id));
  const edges = inventory.tabs.flatMap(tab => collectQueueRelations(tab.id, queues.get(tab.id)));
  const primary = new Set(inventory.tabs.filter(tab => shelves.get(tab.id) === false
    || (queues.has(tab.id) && hasPending(queues.get(tab.id)))).map(tab => tab.id));
  const expand = ids => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges) if (ids.has(edge.source) && known.has(edge.target) && !ids.has(edge.target)) {
        ids.add(edge.target); changed = true;
      }
    }
  };
  expand(primary); for (const id of primary) shelves.set(id, false);
  const disabled = new Set(inventory.tabs.filter(tab => !primary.has(tab.id)
    && (queueIsConfigured(queues.get(tab.id)) || shelves.get(tab.id) === true)).map(tab => tab.id));
  for (const id of disabled) if (!shelves.has(id)) shelves.set(id, true);
  const secondary = new Set(showDisabled ? disabled : []); expand(secondary);
  for (const id of primary) secondary.delete(id);
  const visible = inventory.tabs.filter(tab => primary.has(tab.id) || secondary.has(tab.id));
  const graphTargets = new Set(visible.map(tab => tab.id));
  const visibleEdges = edges.filter(edge => graphTargets.has(edge.source) && graphTargets.has(edge.target));
  const awaitedTargets = new Set(visibleEdges.filter(edge => edge.enabled).map(edge => edge.target));
  return { primary, disabled, secondary, visible, graphTargets, visibleEdges, awaitedTargets };
}
