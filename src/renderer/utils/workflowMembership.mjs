import { UNPLACED_AUTOMATION_WORKFLOW } from './autoCompactPolicy.mjs';

export const INBOX_WORKFLOW_ID = '__noted_workflow_inbox__';
export const GLOBAL_EXECUTION_NAMESPACE = '__tab_catalog_v2__';

export function workflowForTab(state, tabId, legacyNamespace) {
  const member = state?.tabWorkflowMembership?.[tabId];
  if (member) return member.workflowId;
  if (state?.organizationReady) return UNPLACED_AUTOMATION_WORKFLOW;
  // Compatibility for a pre-migration fixture/client. Never runtime authority
  // once Main has published canonical membership.
  return state?.spaces?.find(space => space.projectIds?.includes(legacyNamespace))?.id
    || UNPLACED_AUTOMATION_WORKFLOW;
}

export function legacyAutomationScope(state, tabId) {
  const member = state?.tabWorkflowMembership?.[tabId];
  const saved = state?.organizationMigrationScopes?.[tabId];
  return saved && member?.revision === saved.membershipRevision
    && member.workflowId === saved.workflowId ? saved.legacyWorkflowId : member?.workflowId;
}
