'use strict';

const UNPLACED = '__unplaced__';

/** Preserve the accepted eligibility of existing tabs at the organization cutover. */
function migrationAutomationScopes(plan) {
  const spaces = plan.artifacts?.workspace?.spaces || [];
  const members = new Map(plan.memberships.map(member => [member.tabId,member]));
  const result = {};
  for (const tab of plan.catalog) {
    const active = tab.records.find(record => !record.archived);
    if (!active) continue;
    const member = members.get(tab.tabId);
    const workflowId = spaces.find(space => space.projectIds?.includes(active.namespace))?.id || UNPLACED;
    result[tab.tabId] = { workflowId: member.workflowId, membershipRevision: member.revision, legacyWorkflowId: workflowId };
  }
  return result;
}

function migrateAutoCompactPolicy(raw, scopes) {
  const policy = typeof raw === 'string' ? JSON.parse(raw) : raw || {};
  if (policy.organizationVersion != null && policy.organizationVersion !== 1) throw new Error('automation_forward_version');
  const excluded = new Set(policy.excludedTabIds || []), selected = new Set(policy.workflowIds || []);
  const migrationEligibility = {};
  for (const [tabId,scope] of Object.entries(scopes)) {
    const included = !excluded.has(tabId) && (scope.legacyWorkflowId === UNPLACED
      ? policy.includeUnplaced === true : policy.allWorkflows === true || selected.has(scope.legacyWorkflowId));
    migrationEligibility[tabId] = {workflowId:scope.workflowId,membershipRevision:scope.membershipRevision,included};
  }
  return {...policy,organizationVersion:1,migrationEligibility};
}

function activateOrganizationPolicy(database, plan, generation) {
  const scopes = migrationAutomationScopes(plan);
  const raw = database.getAppState('globalAutoCompact');
  const policy = migrateAutoCompactPolicy(raw,scopes);
  database.setAppState('globalAutoCompact',JSON.stringify(policy));
  database.setAppState('workflow-organization-migration-scopes.v1',{version:1,generation,scopes});
  // Frozen operations, Prompt Queue items, claims, receipts and leases are untouched.
  return {policy,scopes};
}

module.exports = {migrationAutomationScopes,migrateAutoCompactPolicy,activateOrganizationPolicy};
