'use strict';

// Organization is deliberately independent of execution/history addresses.
// JSON in this contract is lossless: unknown fields survive known-field edits.
const ORGANIZATION_VERSION = 1;
const EXECUTION_SUBJECT_VERSION = 2;
const GLOBAL_EXECUTION_NAMESPACE = '__tab_catalog_v2__';
const INBOX_WORKFLOW_ID = '__noted_workflow_inbox__';
const LAYOUT_FIELDS = Object.freeze(['windowDisplayKey', 'windowDisplayLayouts',
  'splitPanes', 'splitFocusedIndex', 'splitSizes', 'centerStrips',
  'activeProjectId', 'focusedProjectId', 'activeSpaceTab']);
const clone = value => JSON.parse(JSON.stringify(value));
const fail = (code, details = {}) => {
  throw Object.assign(new Error(code), { code, statusCode: 409, ...details });
};
const id = value => typeof value === 'string' && value.length > 0 && value.trim() === value;
function stableJson(value) {
  if (ArrayBuffer.isView(value) && typeof value.toJSON === 'function') return stableJson(value.toJSON());
  if (value === null || typeof value !== 'object') {
    const out = JSON.stringify(value);
    if (out === undefined || (typeof value === 'number' && !Number.isFinite(value))) fail('workflow_json_required');
    return out;
  }
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}
function supported(value, version = ORGANIZATION_VERSION) {
  if (value?.version !== undefined && value.version !== version) fail('workflow_forward_version', { version: value.version });
}
function supportedLayout(layout) {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) fail('workflow_layout_required');
  supported(layout);
  for (const profile of Object.values(layout.windowDisplayLayouts || {})) supportedLayout(profile);
}
function executionScopeForRow(row) {
  if (!row) return null;
  if (row.execution_subject_version === 2) return { version: 2, tabId: row.tab_id,
    subjectId: row.execution_subject_id, executionNamespace: row.execution_namespace, cwd: row.cwd };
  return { version: 1, tabId: row.tab_id, projectId: row.project_id, cwd: row.cwd };
}
function sameExecutionScope(previous, current) {
  if (!previous || !current || previous.version !== current.version || previous.tabId !== current.tabId || previous.cwd !== current.cwd) return false;
  return previous.version === 2 ? id(previous.subjectId) && previous.subjectId === current.subjectId
    : previous.projectId === current.projectId;
}

// Preserve the actual CREATE statement, including future definitions. The
// current project_id declaration is intentionally the only accepted grammar;
// unfamiliar SQL refuses migration instead of guessing at a table rebuild.
function nullableProjectTableSql(sql, temporaryName) {
  const header = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)\s*\(/i;
  if (!header.test(sql)) fail('execution_schema_sql_unsupported');
  const declaration = /(\bproject_id\s+TEXT\s+)NOT\s+NULL\b/i;
  if (!declaration.test(sql)) fail('execution_project_declaration_unsupported');
  return sql.replace(header, 'CREATE TABLE "' + temporaryName + '" (').replace(declaration, '$1');
}

// Omitted extension fields are not permission for an older writer to erase
// them. Arrays still follow the requested order/content; stable identities
// retain extension fields for surviving windows/slots.
function mergeLayout(previous, requested) {
  supportedLayout(requested);
  const merge = (old, next, field = null) => {
    if (Array.isArray(next)) {
      const key = value => value?.windowId || value?.slotId || value?.tabId || null;
      return next.map(value => {
        const match = Array.isArray(old) && key(value) ? old.find(candidate => key(candidate) === key(value)) : null;
        return merge(match, value);
      });
    }
    if (next && typeof next === 'object') {
      const dictionary = field === 'windowDisplayLayouts' || field === 'centerStrips';
      const out = !dictionary && old && typeof old === 'object' && !Array.isArray(old) ? clone(old) : {};
      for (const [field, value] of Object.entries(next)) Object.defineProperty(out, field,
        { value: merge(old?.[field], value, field), enumerable: true, writable: true, configurable: true });
      return out;
    }
    return clone(next);
  };
  return merge(previous, requested);
}

// Read content inventories (including hidden windows), NOT profile geometry,
// history, detachedTabs or an arbitrary tabId inside future metadata.
function layoutReferences(layout, path = []) {
  const out = [];
  const add = (entry, entryPath, kind) => {
    if (id(entry?.tabId)) out.push({ tabId: entry.tabId, namespace: entry.projectId ?? null,
      path: entryPath, kind, entry: clone(entry) });
  };
  for (const [index, pane] of (Array.isArray(layout?.splitPanes) ? layout.splitPanes : []).entries()) {
    const base = [...path, 'splitPanes', index];
    for (const [slot, entry] of (Array.isArray(pane?.tabs) ? pane.tabs : []).entries()) add(entry, [...base, 'tabs', slot], 'strip');
    add(pane, base, pane?.displayHidden ? 'hidden-window' : 'window');
  }
  for (const [key, strip] of Object.entries(layout?.centerStrips || {})) {
    for (const [index, entry] of (Array.isArray(strip) ? strip : []).entries()) add(entry, [...path, 'centerStrips', key, index], 'center-strip');
  }
  if (!layout?.splitPanes?.length) add(layout?.activeSpaceTab, [...path, 'activeSpaceTab'], 'center');
  for (const [key, profile] of Object.entries(layout?.windowDisplayLayouts || {})) {
    out.push(...layoutReferences(profile, [...path, 'windowDisplayLayouts', key]));
  }
  return out;
}

// Remove only matching placements. Keep chooser slots, empty window identity,
// geometry, history, group metadata and future fields. The caller journals the
// predecessor, including changed selection fields, before committing this edit.
function removeLayoutTabs(layout, tabIds) {
  const removed = new Set(tabIds);
  const next = clone(layout || {});
  if (Array.isArray(next.splitPanes)) next.splitPanes = next.splitPanes.map(pane => {
    if (!pane || typeof pane !== 'object') return pane;
    if (Array.isArray(pane.tabs)) pane.tabs = pane.tabs.filter(entry => !removed.has(entry?.tabId));
    if (removed.has(pane.tabId)) {
      const replacement = pane.tabs?.find(entry => id(entry?.tabId));
      pane.tabId = replacement?.tabId || '';
      pane.projectId = replacement?.projectId || '';
      if ('selectedSlotId' in pane) pane.selectedSlotId = replacement?.slotId || null;
    }
    return pane;
  });
  if (next.centerStrips) for (const [key, strip] of Object.entries(next.centerStrips)) {
    if (Array.isArray(strip)) next.centerStrips[key] = strip.filter(entry => !removed.has(entry?.tabId));
  }
  if (removed.has(next.activeSpaceTab?.tabId)) next.activeSpaceTab = null;
  if (next.windowDisplayLayouts) for (const [key, profile] of Object.entries(next.windowDisplayLayouts)) {
    next.windowDisplayLayouts[key] = removeLayoutTabs(profile, tabIds);
  }
  return next;
}

function effectiveSpaces(workspace = {}) {
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) fail('workflow_workspace_required');
  const spaces = clone(workspace.spaces || []);
  if (!Array.isArray(spaces)) fail('workflow_spaces_required');
  // Existing restoreSpaces contract: a session from before spaces keeps its
  // single layout as space-1. This is layout provenance, not a new Project.
  if (!spaces.length && !workspace.activeSpaceId && LAYOUT_FIELDS.some(field => Object.hasOwn(workspace, field))) {
    const layout = {};
    for (const field of LAYOUT_FIELDS) if (Object.hasOwn(workspace, field)) layout[field] = clone(workspace[field]);
    spaces.push({ id: 'space-1', name: 'main',
      projectIds: [...new Set(layoutReferences(layout).map(ref => ref.namespace).filter(id))], layout });
  }
  const seen = new Set();
  for (const space of spaces) {
    if (!id(space?.id) || seen.has(space.id) || space.id === INBOX_WORKFLOW_ID) fail('workflow_space_identity_conflict');
    seen.add(space.id);
    space.layout = space.layout || {};
    if (space.id === workspace.activeSpaceId) {
      // Only present top-level fields override the saved mirror. In particular,
      // an explicitly empty live inventory overrides a stale nonempty one.
      for (const field of LAYOUT_FIELDS) if (Object.hasOwn(workspace, field)) space.layout[field] = clone(workspace[field]);
    }
  }
  if (id(workspace.activeSpaceId) && !seen.has(workspace.activeSpaceId)) fail('workflow_active_space_missing');
  return spaces;
}

function planMigration(source) {
  supported(source);
  supported(source.workspace);
  const spaces = effectiveSpaces(source.workspace);
  for (const space of spaces) supportedLayout(space.layout);
  const records = new Map();
  const put = (tabId, namespace, record, archived = false) => {
    if (!id(tabId)) return;
    let target = records.get(tabId);
    if (!target) {
      target = { tabId, records: [], aliases: [], references: [] };
      records.set(tabId, target);
    }
    target.records.push({ namespace, archived, record: clone(record) });
    if (id(namespace) && !target.aliases.some(alias => alias.namespace === namespace)) target.aliases.push({ namespace, tabId });
  };
  const namespace = row => row.execution_subject_version === 2 ? row.execution_namespace : row.project_id;
  for (const row of source.legacy?.tables?.tabs || []) put(row.tab_id, namespace(row), row, row.execution_archived === 1);
  for (const row of source.legacy?.tables?.tab_history || []) put(row.tab_id, namespace(row), row, true);
  const evidence = new Map();
  for (const space of spaces) for (const reference of layoutReferences(space.layout)) {
    if (!records.has(reference.tabId)) records.set(reference.tabId, { tabId: reference.tabId, records: [], aliases: [], references: [] });
    const target = records.get(reference.tabId);
    target.references.push({ workflowId: space.id, ...reference });
    if (!evidence.has(reference.tabId)) evidence.set(reference.tabId, new Set());
    evidence.get(reference.tabId).add(space.id);
  }
  const journal = [];
  const memberships = [];
  for (const target of records.values()) {
    const candidates = [...(evidence.get(target.tabId) || [])].sort();
    let workflowId = INBOX_WORKFLOW_ID;
    let reason = 'unassociated';
    if (candidates.length === 1) { workflowId = candidates[0]; reason = 'placement'; }
    else if (candidates.length > 1) {
      // Active-first is NOT a proof. Preserve every conflicting placement and
      // make the record accessible in Inbox until an explicit resolution.
      reason = 'cross-workflow-conflict';
      journal.push({ tabId: target.tabId, reason, candidates, winner: workflowId, evidence: target.references });
    } else {
      const namespaces = [...new Set(target.records.map(row => row.namespace).filter(id))];
      const associations = spaces.filter(space => namespaces.some(namespace => space.projectIds?.includes(namespace))).map(space => space.id);
      if (namespaces.length === 1 && associations.length === 1) { workflowId = associations[0]; reason = 'unique-legacy-association'; }
      else if (associations.length > 1 || namespaces.length > 1) reason = 'ambiguous-legacy-association';
    }
    memberships.push({ tabId: target.tabId, workflowId, revision: 1, reason });
    if (!target.records.length) journal.push({ tabId: target.tabId, reason: 'reference-without-execution-record', evidence: target.references });
  }
  const workflows = spaces.map(space => {
    const remove = memberships.filter(member => member.workflowId !== space.id).map(member => member.tabId);
    const layout = removeLayoutTabs(space.layout, remove);
    if (stableJson(layout) !== stableJson(space.layout)) journal.push({ workflowId: space.id,
      reason: 'conflicting-placements-removed', before: space.layout, after: layout });
    const metadata = clone(space);
    delete metadata.layout; // the original complete space remains in artifacts
    return { id: space.id, kind: 'user', revision: 1, metadata, layout };
  });
  workflows.push({ id: INBOX_WORKFLOW_ID, kind: 'inbox', revision: 1,
    metadata: { id: INBOX_WORKFLOW_ID, name: 'Inbox', system: true }, layout: {} });
  return { version: ORGANIZATION_VERSION, workflows, memberships, catalog: [...records.values()], journal,
    // Exact, address-scoped artifacts; deliberately no prompt-root scope union,
    // group flattening or __unplaced__ policy substitution.
    artifacts: { legacy: clone(source.legacy || {}), extra: clone(source.artifacts || {}),
      workspace: clone(source.workspace || {}), integrationRequired: [
        'groups/sidebar ordering by canonical members (retain partially placed groups)',
        'archive/favorites/exports read/restore through immutable legacy addresses',
        'prompt roots/effective bindings per namespace; resolve scopes field by field',
        'automation eligibility and frozen queue targets; __unplaced__ is not Inbox',
        'execution-subject v2 runtime adapters; retain v1 owner guards',
      ] } };
}

module.exports = { ORGANIZATION_VERSION, EXECUTION_SUBJECT_VERSION, INBOX_WORKFLOW_ID,
  GLOBAL_EXECUTION_NAMESPACE, executionScopeForRow, sameExecutionScope, nullableProjectTableSql,
  LAYOUT_FIELDS, clone, fail, id, stableJson, supported, supportedLayout, mergeLayout,
  layoutReferences, removeLayoutTabs, effectiveSpaces, planMigration };
