// Frozen v1 regression oracle; original source SHA is pinned in SOURCE-BEFORE.
// Only three relative import paths are rebased for this fixture location.
'use strict';

const { orderedWorkflows } = require('../../shared/workflow-order.cjs');
const { selectWorkflowMembers, workflowMemberOutline } = require('../../shared/workflow-tree.cjs');
const { workflowGroupDisplayName } = require('../../shared/workflow-groups-projection.cjs');

const array = value => Array.isArray(value) ? value : [];
const namespaceOf = entry => entry.executionSubject?.version === 2
  ? entry.executionSubject.executionNamespace : entry.executionSubject?.projectId;

/** The fallback mirrors cold catalog hydration: saved namespace insertion order,
 * then each namespace's persisted row order. reserveOrder remains the first key.
 * No name/cwd/MRU ordering, and no window-placement filtering. */
function catalogHydrationOrder(entries, namespaceOrder, legacyNamespaces = []) {
  const rank = new Map(), legacy = new Set(legacyNamespaces);
  for (const namespace of [...array(namespaceOrder), ...entries.map(namespaceOf)])
    if (namespace && !rank.has(namespace)) rank.set(namespace, rank.size);
  const row = entry => entry.nativeRow || entry.legacyRow || {};
  const column = (a,b) => a == null ? b == null ? 0 : -1 : b == null ? 1 : Number(a)-Number(b);
  return [...entries].sort((a,b) => {
    const left = namespaceOf(a), right = namespaceOf(b);
    return (rank.get(left) ?? Infinity) - (rank.get(right) ?? Infinity)
      || (left === right && legacy.has(left) ? column(row(a).is_utility,row(b).is_utility) : 0)
      || column(row(a).position,row(b).position) || column(row(a).id,row(b).id);
  });
}

/** Pure read DTO. Saved descriptors do not assert provider liveness, card-signal
 * freshness, History coverage, or permission to replay a frozen operation. */
function projectWorkflowCatalog({ snapshot, namespaceOrder = [], legacyNamespaces = [], aliases = [] }) {
  if (snapshot?.publication?.version !== 1 || snapshot.publication.migrationVersion !== 1)
    throw Object.assign(new Error('workflow_publication_unavailable'), {code:'workflow_publication_unavailable'});
  if (snapshot.globalGroups?.version !== 1)
    throw Object.assign(new Error('workflow_groups_version_unsupported'), {code:'workflow_groups_version_unsupported'});
  const workflows = orderedWorkflows(snapshot.workflows, snapshot.publication);
  const workflowIds = new Set(workflows.map(workflow => workflow.id));
  const catalog = new Map(), membership = Object.create(null), rows = Object.create(null), executionRefs = Object.create(null), provenance = [];
  const aliasesById = new Map();
  for (const alias of aliases) {
    const id = alias.globalTabId;
    if (!aliasesById.has(id)) aliasesById.set(id, []);
    aliasesById.get(id).push({namespace:alias.namespace,tabId:alias.tabId});
  }
  for (const entry of catalogHydrationOrder(snapshot.tabs || [],namespaceOrder,legacyNamespaces)) {
    const row = entry.nativeRow || entry.legacyRow, namespace = namespaceOf(entry);
    const reason = !entry.executionResolved || !row || !namespace ? 'unresolved'
      : row.execution_archived === 1 ? 'archived'
        : !workflowIds.has(entry.membership?.workflowId) ? 'membership-unavailable' : null;
    const executionRef = {
      subjectVersion:entry.subjectVersion, subject:entry.executionSubject || null,
      namespace:namespace || null, tabId:entry.tabId, cwd:row?.cwd ?? entry.executionSubject?.cwd ?? null,
      storageId:row?.id ?? null, storageRevision:row?.execution_storage_revision ?? null,
      aliases:aliasesById.get(entry.tabId) || [],
      savedSessions:{claude:row?.claude_session_id || null,codex:row?.codex_session_id || null,gemini:row?.gemini_session_id || null},
    };
    membership[entry.tabId] = entry.membership;
    const descriptor = {
      tabId:entry.tabId, name:row?.name || '', tabType:row?.tab_type || 'terminal',
      commandType:row?.command_type || null, color:row?.color || null,
      sessionStatus:row?.session_status || null, isUtility:!!row?.is_utility,
      filePath:row?.file_path || null, parentTabId:row?.parent_tab_id || null,
      visualParentTabId:row?.visual_parent_tab_id || null,
    };
    catalog.set(entry.tabId,{projectId:namespace,tabId:entry.tabId,tab:descriptor,active:!reason,provenance:reason});
    if (reason) provenance.push({tabId:entry.tabId,workflowId:entry.membership?.workflowId || null,reason,executionRef});
    else {
      rows[entry.tabId] = {...descriptor,membership:{workflowId:entry.membership.workflowId,revision:entry.membership.revision}};
      executionRefs[entry.tabId] = executionRef;
    }
  }
  const headers = workflows.map(workflow => {
    const selected = selectWorkflowMembers({catalog,membership,workflowId:workflow.id,
      orderedTabIds:array(workflow.metadata?.reserveOrder),rootOrder:array(workflow.metadata?.reserveRootOrder),
      globalGroups:snapshot.globalGroups});
    const tree = workflowMemberOutline(selected), nodes = [];
    const visit = (items,parentId=null,depth=0) => {
      for (const item of items) {
        const context = item.contextParent, parent = context && catalog.get(context.tabId);
        nodes.push({id:item.id,kind:item.kind,parentId,depth,
          ...(item.tabId ? {tabId:item.tabId} : {groupId:item.groupId}),
          childIds:item.children.map(child=>child.id),expanded:item.expanded,
          contextParent:context ? {tabId:context.tabId,namespace:context.projectId,name:context.name,
            workflowId:membership[context.tabId]?.workflowId || null,availability:parent?.provenance || 'active'} : null});
        visit(item.children,item.id,depth+1);
      }
    };
    visit(tree);
    const groupMembers = new Map();
    for (const owner of selected.items) {
      const id = selected.globalTabGroups?.get(owner.tabId);
      if (id) {if (!groupMembers.has(id)) groupMembers.set(id,[]);groupMembers.get(id).push(owner.tabId);}
    }
    return {id:workflow.id,kind:workflow.kind,revision:workflow.revision,
      name:workflow.metadata?.name || '',icon:workflow.metadata?.icon || null,
      defaultCwd:typeof workflow.metadata?.defaultCwd==='string' ? workflow.metadata.defaultCwd || null : null,
      memberTabIds:selected.items.map(owner=>owner.tabId),rootIds:tree.map(node=>node.id),nodes,
      groups:[...selected.visibleGroups.values()].map(group=>({id:group.id,memberTabIds:groupMembers.get(group.id) || []}))};
  });
  return {version:1,projection:'catalog-v1',inventory:'active-membership',
    workflows:headers,rows,executionRefs,groups:snapshot.globalGroups.groups.map(group=>({
      id:group.id,revision:group.revision,name:group.name || '',displayName:workflowGroupDisplayName(group),
      color:group.color || null,sessionStatus:group.sessionStatus || null,collapsed:!!group.collapsed,
      reserveWorkflowId:group.reserveWorkflowId || null,missingLegacyDefinition:!!group.missingLegacyDefinition,
    })),
    provenance,
    clocks:{organization:{version:snapshot.publication.version,revision:snapshot.publication.revision,generation:snapshot.publication.generation},
      groups:{version:snapshot.globalGroups.version,revision:snapshot.globalGroups.revision}},
    excludedSignals:['runtime','cardSignals','history'],sourceBindings:'tab'};
}

module.exports = {projectWorkflowCatalog,catalogHydrationOrder};
