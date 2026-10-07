import { UNPLACED_WORKFLOW_ID } from './workflowVisuals.mjs';
import { workflowForTab, legacyAutomationScope } from './workflowMembership.mjs';

// The picker and live Restart after subscriptions must describe the same tabs.
export function aiKindForTab(tab) {
  // Typed but unstarted AI tabs are valid choices before a session exists.
  if (tab?.tabType === 'claude-sdk') return 'claude-sdk';
  if (tab?.commandType === 'claude') return 'claude-pty';
  if (tab?.commandType === 'codex') return 'codex';
  if (tab?.commandType === 'gemini') return 'gemini';
  return null;
}

export function runAfterWorkflowByProject(spaces = []) {
  const byProject = new Map();
  for (const space of spaces) {
    for (const projectId of Array.isArray(space.projectIds) ? space.projectIds : []) {
      if (!byProject.has(projectId)) byProject.set(projectId, space.id);
    }
  }
  return byProject;
}

export function runAfterWorkflowTabIds(state, workflowIds, ownerTabId) {
  const selected = new Set(workflowIds);
  const ids = [];
  for (const [projectId, workspace] of state?.openProjects || []) {
    for (const tab of workspace.tabs.values()) {
      const legacy = state?.organizationReady && state?.runAfterWorkflowScopeVersions?.[ownerTabId] !== 2;
      const workflowId = legacy ? legacyAutomationScope(state,tab.id) : workflowForTab(state,tab.id,projectId);
      if (selected.has(workflowId) && tab.id !== ownerTabId && !tab.parentTabId && aiKindForTab(tab)) ids.push(tab.id);
    }
  }
  return ids;
}
