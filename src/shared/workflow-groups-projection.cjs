'use strict';

// A projection of Main's group publication, never a second writable authority.
// No namespace, cwd, owner or visual relation is inferred from group membership.
const entries = value => value instanceof Map ? [...value] : Object.entries(value || {});
const active = owner => {
  const tab = owner.tab || owner;
  return tab.archived !== true && tab.isArchived !== true && !tab.archivedAt && tab.deleted !== true;
};

// Missing legacy definitions preserve archive provenance. They are not named
// containers the user can choose for a new assignment. An explicit later
// rename supplies a display name without destroying the original alias.
function workflowGroupIsPlaceholder(group) {
  return group?.missingLegacyDefinition === true && (!group.name || group.name === group.legacyGroupId);
}
function workflowGroupDisplayName(group) {
  return workflowGroupIsPlaceholder(group) ? 'Группа без названия' : group?.name || 'Группа';
}
function workflowGroupChoices(publication) {
  return (publication?.groups || []).filter(group => !workflowGroupIsPlaceholder(group));
}

function workflowGlobalGroupMembers(publication, groupId, catalog, { includeArchived = false } = {}) {
  const byId = new Map(entries(catalog));
  return Object.entries(publication?.tabGroups || {}).filter(([, id]) => id === groupId)
    .map(([tabId]) => {
      const owner = byId.get(tabId);
      return owner ? { ...owner, tabId } : null;
    }).filter(owner => owner && (includeArchived || active(owner)));
}

/** Sidebar projection: a partially placed/spanning group keeps its global ID.
 * Pass reserveTabIds from the canonical ALL-profile placement resolver.
 * Return definitions separately so fully placed groups are never discarded.
 */
function selectWorkflowGlobalGroups({ publication, catalog, membership, workflowId, reserveTabIds, orderedTabIds = [] }) {
  const groups = new Map((publication?.groups || []).map(group => [group.id, group]));
  const reserve = new Set(reserveTabIds || []), rank = new Map(orderedTabIds.map((id, i) => [id, i]));
  const byId = new Map(entries(catalog));
  const tabGroups = new Map(), visibleGroups = new Map();
  const membersByGroup = new Map();
  for (const [tabId, groupId] of Object.entries(publication?.tabGroups || {})) {
    if (!groups.has(groupId)) continue; // tombstone/future stale reference is not a new group
    tabGroups.set(tabId, groupId);
    const member = membership instanceof Map ? membership.get(tabId) : membership?.[tabId];
    const owner = byId.get(tabId);
    if (!owner || !active(owner) || !reserve.has(tabId) || member?.workflowId !== workflowId) continue;
    const members = membersByGroup.get(groupId) || [];
    members.push({ ...owner, tabId }); membersByGroup.set(groupId, members);
  }
  for (const group of publication?.groups || []) {
    const members = membersByGroup.get(group.id);
    if (!members?.length) continue;
    members.sort((a, b) => (rank.get(a.tabId) ?? Infinity) - (rank.get(b.tabId) ?? Infinity));
    visibleGroups.set(group.id, { ...group, members });
  }
  return { groups, visibleGroups, tabGroups, membersByGroup };
}

// Migration/compatibility lookup only. Runtime uses tabGroups, not this alias.
function workflowLegacyGlobalGroup(publication, namespace, legacyGroupId) {
  return (publication?.groups || []).find(group => group.legacyNamespace === namespace && group.legacyGroupId === legacyGroupId) || null;
}

module.exports = { workflowGroupIsPlaceholder, workflowGroupDisplayName, workflowGroupChoices, workflowGlobalGroupMembers, selectWorkflowGlobalGroups, workflowLegacyGlobalGroup };
