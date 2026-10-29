'use strict';

// Main read projection of the LAST PUBLISHED organization layouts. No renderer
// call, pixel claim, profile selection, execution address inference or writer.
const crypto = require('node:crypto');
const { stableJson } = require('./workflow-organization.cjs');
const { selectWorkflowMembers, workflowMemberOutline } = require('./workflow-tree.cjs');
const array = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const hash = value => crypto.createHash('sha256').update(stableJson(value)).digest('hex');
const key = (...parts) => parts.map(value => { const s = String(value); return Buffer.byteLength(s) + ':' + s; }).join('');

const WINDOW_LAYOUT_CAPABILITY = Object.freeze({ version: 1, field: 'windowLayout',
  source: 'workflow-organization-publication', order: 'columns-ltr-windows-ttb-strip-v1',
  coverage: 'canonical-fragments-v1', fallback: 'canonical-tree-v1',
  dragPresentation: 'canonical-tree-v1', pixels: false });

// Read copies of the two tiny public renderer rules. Parity tests execute the
// actual frozen paneColumns/paneTabs exports. Main must not import a UI store,
// depend on a renderer bundle or invoke a display reconciler (which writes IDs).
function publishedPaneTabs(pane) {
  if (!pane) return [];
  const tabs = array(pane.tabs).filter(entry => entry && entry.tabId);
  return tabs.length ? tabs : pane.tabId ? [{ projectId: pane.projectId, tabId: pane.tabId }] : [];
}
function publishedPaneColumns(panes) {
  const byColumn = new Map();
  array(panes).forEach((pane, index) => {
    if (pane?.displayHidden === true) return;
    const c = Number(pane && pane.column);
    const column = Number.isFinite(c) && c >= 0 ? Math.floor(c) : index;
    if (!byColumn.has(column)) byColumn.set(column, []);
    byColumn.get(column).push({ pane, index });
  });
  return [...byColumn.keys()].sort((a, b) => a - b).map(column => byColumn.get(column));
}

// A hidden pane's `column` can belong to another monitor. Only this published
// display key's positions/lastPositions locate it in the applied layout. Match
// the renderer's overwrite order (positions wins), without reconciling a layout
// or manufacturing window IDs. Unlocated panes keep their publication order.
function publishedHiddenPanes(layout) {
  const panes = array(layout.splitPanes), positions = new Map();
  const ids = new Set(panes.map(pane => pane?.windowId).filter(text));
  const profile = text(layout.windowDisplayKey) ? layout.windowDisplayLayouts?.[layout.windowDisplayKey] : null;
  for (const position of [...array(profile?.lastPositions), ...array(profile?.positions)]) {
    if (position && ids.has(position.windowId) && Number.isInteger(position.column) && position.column >= 0
      && Number.isInteger(position.row) && position.row >= 0) positions.set(position.windowId, position);
  }
  return panes.map((pane, index) => ({ pane, index, position: positions.get(pane?.windowId) || null }))
    .filter(({ pane }) => pane?.displayHidden === true)
    .sort((a, b) => a.position && b.position
      ? a.position.column - b.position.column || a.position.row - b.position.row || a.index - b.index
      : a.position ? -1 : b.position ? 1 : a.index - b.index);
}

// All-profile placement is used by the real sidebar, so its retained content
// must remain represented here too. Modern profiles contain only positions;
// old profiles/other centre strips may still own tab references. They never
// become visible by being found here. Deduplication against visible/current
// retained windows happens once, at assignment below.
function publishedRetainedSegments(layout, workflowId) {
  const result = [], seen = new Set();
  const refId = ref => typeof ref === 'string' ? ref : ref?.tabId;
  const add = (parts, refs, placement = {}) => result.push({
    id: key('retained', workflowId, ...parts), kind: 'retained', windowId: null,
    paneIndex: null, column: null, row: null, ...placement,
    stripTabIds: refs.map(refId).filter(text),
  });
  const visit = (value, path, top = false) => {
    if (!object(value) || seen.has(value)) return;
    seen.add(value);
    if (!top) publishedPaneColumns(value.splitPanes).forEach((column, columnIndex) => {
      column.forEach(({ pane, index }, row) => add([...path, 'pane', index], publishedPaneTabs(pane), {
        windowId: text(pane?.windowId) ? pane.windowId : null, paneIndex: index, column: columnIndex, row,
      }));
    });
    for (const { pane, index, position } of publishedHiddenPanes(value)) add([...path, 'pane', index], publishedPaneTabs(pane), {
      windowId: text(pane?.windowId) ? pane.windowId : null, paneIndex: index,
      column: position?.column ?? null, row: position?.row ?? null,
    });
    for (const [stripKey, strip] of Object.entries(value.centerStrips || {})) add([...path, 'center', stripKey], array(strip));
    // Normally the shown tab is already in its strip. Preserve any legacy
    // single-tab reference too, without pretending that it is a second window.
    for (const [index, pane] of array(value.splitPanes).entries()) if (pane?.tabId) add([...path, 'pane-active', index], [pane]);
    if (value.activeSpaceTab) add([...path, 'active'], [value.activeSpaceTab]);
    for (const [profileKey, profile] of Object.entries(value.windowDisplayLayouts || {}))
      visit(profile, [...path, 'profile', profileKey]);
  };
  visit(layout, ['published'], true);
  return result;
}

// Same placement fields as workflowPlacedTabIds, including dormant centre
// strips and old content-bearing profiles. History/detached/chooser are not tabs.
function publishedPlacedTabs(layouts) {
  const placed = new Set(), visited = new Set();
  const add = ref => { const id = typeof ref === 'string' ? ref : ref?.tabId; if (text(id)) placed.add(id); };
  const pending = [...layouts];
  while (pending.length) {
    const layout = pending.pop();
    if (!object(layout) || visited.has(layout)) continue;
    visited.add(layout);
    for (const pane of array(layout.splitPanes)) { add(pane); for (const tab of array(pane?.tabs)) add(tab); }
    for (const strip of Object.values(layout.centerStrips || {})) for (const ref of array(strip)) add(ref);
    add(layout.activeSpaceTab);
    pending.push(...Object.values(layout.windowDisplayLayouts || {}));
  }
  return placed;
}

// Unknown placement containers cannot establish an empty sidebar. They still
// permit the independent complete canonical Core inventory to be displayed.
function knownPlacementShapes(layouts) {
  const pending = [...layouts], seen = new Set();
  while (pending.length) {
    const layout = pending.pop();
    if (!object(layout)) return false;
    if (seen.has(layout)) continue;
    seen.add(layout);
    if (layout.version != null && layout.version !== 1
      || layout.splitPanes != null && !Array.isArray(layout.splitPanes)
      || layout.centerStrips != null && !object(layout.centerStrips)
      || layout.windowDisplayLayouts != null && !object(layout.windowDisplayLayouts)
      || layout.windowDisplayKey != null && typeof layout.windowDisplayKey !== 'string'
      || layout.activeSpaceTab != null && !object(layout.activeSpaceTab) && !text(layout.activeSpaceTab)) return false;
    if (Object.values(layout.centerStrips || {}).some(strip => !Array.isArray(strip))) return false;
    if (array(layout.splitPanes).some(pane => !object(pane)
      || pane.tabs != null && !Array.isArray(pane.tabs)
      || pane.windowId != null && typeof pane.windowId !== 'string')) return false;
    pending.push(...Object.values(layout.windowDisplayLayouts || {}));
  }
  return true;
}

function projectWorkflowWindowLayout({ snapshot, core }) {
  const published = new Map(snapshot.workflows.map(workflow => [workflow.id, workflow]));
  const catalog = new Map(Object.entries(core.rows).map(([tabId, row]) => [tabId,
    { tabId, projectId: core.executionInputs[tabId].executionSubject.executionNamespace
      || core.executionInputs[tabId].executionSubject.projectId, tab: row, active: true }]));
  const membership = Object.fromEntries([...catalog].map(([id, owner]) => [id, owner.tab.membership]));
  const layouts = snapshot.workflows.map(workflow => workflow.layout);
  const placementInventoryKnown = knownPlacementShapes(layouts);
  const placed = publishedPlacedTabs(layouts), represented = new Set(placed), familyChildren = new Map();
  for (const [id, owner] of catalog) {
    const parent = owner.tab.parentTabId || (owner.tab.tabType === 'file' && owner.tab.visualParentTabId);
    if (parent) { if (!familyChildren.has(parent)) familyChildren.set(parent, []); familyChildren.get(parent).push(id); }
  }
  const queue = [...represented];
  for (let at = 0; at < queue.length; at++) for (const id of familyChildren.get(queue[at]) || []) {
    if (!represented.has(id)) { represented.add(id); queue.push(id); }
  }
  const sidebarCatalog = new Map([...catalog].map(([id, owner]) => [id,
    represented.has(id) && !placed.has(id) ? { ...owner, active: false } : owner]));
  const source = { kind: 'workflow-organization-publication', version: snapshot.publication.version,
    generation: snapshot.publication.generation, revision: snapshot.publication.revision,
    hash: hash(snapshot.workflows.map(workflow => ({ workflowId: workflow.id,
      revision: workflow.revision, layout: workflow.layout ?? null }))) };
  const workflows = core.workflows.map(workflow => {
    const publication = published.get(workflow.id), layout = object(publication.layout) ? publication.layout : {};
    const reasons = placementInventoryKnown ? [] : ['placement-inventory-unavailable'];
    const members = new Set(workflow.memberTabIds);
    const nodes = new Map(workflow.nodes.map(node => [node.id, node]));
    const byTab = new Map(workflow.nodes.filter(node => node.tabId).map(node => [node.tabId, node]));
    const groupOf = new Map();
    for (const node of workflow.nodes) {
      if (node.groupId) groupOf.set(node.id, node.id);
      else if (node.parentId) groupOf.set(node.id, groupOf.get(node.parentId) || null);
    }
    const sidebar = selectWorkflowMembers({ catalog: sidebarCatalog, membership, workflowId: workflow.id,
      orderedTabIds: array(publication.metadata?.reserveOrder), rootOrder: array(publication.metadata?.reserveRootOrder),
      excludedTabIds: placed, globalGroups: snapshot.globalGroups });
    const sidebarTree = workflowMemberOutline(sidebar);
    const sidebarTabIds = sidebar.items.map(owner => owner.tabId);
    const windows = [];
    const panes = array(layout.splitPanes);
    if (!object(publication.layout) || layout.version != null && layout.version !== 1
      || layout.splitPanes != null && !Array.isArray(layout.splitPanes)
      || layout.windowDisplayLayouts != null && !object(layout.windowDisplayLayouts)) reasons.push('layout-shape-unsupported');
    // The applied top-level projection is already published. A key identifies
    // it; profiles are not alternate content to pick by index or geometry.
    const profileKey = text(layout.windowDisplayKey) ? layout.windowDisplayKey : null;
    if (layout.windowDisplayKey != null && !profileKey) reasons.push('profile-key-invalid');
    for (const profile of Object.values(layout.windowDisplayLayouts || {})) {
      if (!object(profile) || profile.version != null && profile.version !== 1) reasons.push('profile-shape-unsupported');
    }
    if (panes.length) {
      const windowIds = panes.map(pane => pane?.windowId).filter(text);
      if (new Set(windowIds).size !== windowIds.length || panes.some(pane => !object(pane))) reasons.push('window-identity-ambiguous');
      publishedPaneColumns(panes).forEach((column, columnIndex) => {
        column.forEach(({ pane, index }, row) => windows.push({
          id: key('window', workflow.id, pane?.windowId || 'published-pane-index:' + index), kind: 'window',
          windowId: text(pane?.windowId) ? pane.windowId : null, paneIndex: index,
          column: columnIndex, row,
          stripTabIds: publishedPaneTabs(pane).map(ref => ref.tabId).filter(id => members.has(id)) }));
      });
    } else {
      // Single-mode centre uses the persisted activeProjectId key (the actual
      // centerStripKey contract), not every dormant centre strip concatenated.
      const strip = array(layout.centerStrips?.[layout.activeProjectId]).filter(ref => ref?.tabId);
      const refs = strip.length ? strip : layout.activeSpaceTab?.tabId ? [layout.activeSpaceTab] : [];
      if (refs.length) windows.push({ id: key('center', workflow.id), kind: 'window', windowId: null,
        paneIndex: null, column: 0, row: 0, stripTabIds: refs.map(ref => ref.tabId).filter(id => members.has(id)) });
    }
    const explicit = windows.flatMap(window => window.stripTabIds);
    if (new Set(explicit).size !== explicit.length) reasons.push('duplicate-visible-placement');
    const ownerSegment = new Map();
    for (const window of windows) for (const id of window.stripTabIds) ownerSegment.set(id, window.id);
    // A visible occurrence wins over hidden/legacy copies. Within retained
    // content the first published occurrence owns the tab; duplicate chips
    // never become non-owning tab rows or a second execution identity.
    const retained = publishedRetainedSegments(layout, workflow.id).map(segment => ({ ...segment,
      stripTabIds: segment.stripTabIds.filter(id => {
        if (!members.has(id) || ownerSegment.has(id)) return false;
        ownerSegment.set(id, segment.id); return true;
      }) })).filter(segment => segment.stripTabIds.length);
    // Match the physical/file descendant exclusion of the actual sidebar.
    // An explicit strip placement wins over inherited presentation, exactly
    // once; it does not advance an attached-file materialized prefix.
    const inheritedQueue = [...ownerSegment.keys()];
    for (let at = 0; at < inheritedQueue.length; at++) for (const id of familyChildren.get(inheritedQueue[at]) || []) {
      if (members.has(id) && !ownerSegment.has(id) && !placed.has(id)) {
        ownerSegment.set(id, ownerSegment.get(inheritedQueue[at])); inheritedQueue.push(id);
      }
    }
    const sidebarSet = new Set(sidebarTabIds);
    // All-profile placements can lack a current local geometry (for example a
    // legacy profile or an unplaced physical child of a retained foreign root).
    // Keep that full canonical inventory in one final retained fragment, using
    // its published canonical order, before the actual sidebar.
    const residual = workflow.nodes.filter(node => node.tabId && !ownerSegment.has(node.tabId)
      && !sidebarSet.has(node.tabId)).map(node => node.tabId);
    const retainedRoots = new Map();
    if (residual.length) {
      const segment = { id: key('retained', workflow.id, 'unlocated'), kind: 'retained',
        windowId: null, paneIndex: null, column: null, row: null,
        stripTabIds: residual.filter(id => placed.has(id)) };
      // Physical/file descendants without their own placement are traversal
      // seeds, never invented strip members. Keep this private to projection.
      retainedRoots.set(segment.id, residual);
      retained.push(segment); for (const id of residual) ownerSegment.set(id, segment.id);
    }
    const retainedSegments = new Set(retained.map(segment => segment.id));
    const retainedTabIds = workflow.memberTabIds.filter(id => retainedSegments.has(ownerSegment.get(id)));
    const usedCanonical = new Set(), builtTabs = new Set();
    const segments = [];
    const appendForest = (segment, forest) => {
      const out = { ...segment, rootIds: [], nodes: [] };
      const counts = new Map();
      const visit = (items, parentId = null, depth = 0) => items.map(item => {
        const canonical = nodes.get(item.id);
        if (!canonical) { reasons.push('fragment-canonical-node-missing'); return null; }
        const ordinal = counts.get(canonical.id) || 0; counts.set(canonical.id, ordinal + 1);
        const displayId = key('fragment', segment.id, canonical.id, ordinal);
        const ownsCanonicalNode = !usedCanonical.has(canonical.id); usedCanonical.add(canonical.id);
        const record = { id: displayId, canonicalNodeId: canonical.id, parentId, depth, childIds: [], ownsCanonicalNode,
          contextParent: item.contextParent || null };
        out.nodes.push(record);
        record.childIds = visit(item.children || [], displayId, depth + 1).filter(Boolean);
        return displayId;
      });
      out.rootIds = visit(forest).filter(Boolean); segments.push(out);
    };
    const contextFor = (node, parentCanonical) => {
      if (node.parentId === parentCanonical) return node.contextParent;
      const parent = nodes.get(node.parentId);
      if (!parent?.tabId) return node.contextParent;
      const owner = catalog.get(parent.tabId);
      return { tabId: parent.tabId, namespace: owner?.projectId || null, name: owner?.tab.name || '',
        workflowId: workflow.id, availability: 'active' };
    };
    for (const window of [...windows, ...retained]) {
      const roots = [], explicitSet = new Set(window.stripTabIds);
      const make = (node, parentCanonical = null) => {
        builtTabs.add(node.tabId);
        return { id: node.id, contextParent: contextFor(node, parentCanonical), children: node.childIds
          .map(id => nodes.get(id)).filter(child => child?.tabId && ownerSegment.get(child.tabId) === window.id
            && !explicitSet.has(child.tabId) && !builtTabs.has(child.tabId)).map(child => make(child, node.id)) };
      };
      const addRoot = node => {
        const item = make(node), groupId = groupOf.get(node.id);
        if (!groupId) { roots.push(item); return; }
        let group = roots.at(-1);
        if (group?.id !== groupId) { group = { id: groupId, children: [] }; roots.push(group); }
        group.children.push(item);
      };
      for (const id of retainedRoots.get(window.id) || window.stripTabIds) if (!builtTabs.has(id)) addRoot(byTab.get(id));
      // Cross-group physical descendants still have their own group/context.
      for (const node of workflow.nodes) if (node.tabId && ownerSegment.get(node.tabId) === window.id && !builtTabs.has(node.tabId)) addRoot(node);
      appendForest(window, roots);
    }
    // Shared sidebar rules supply BOTH its actual inventory and its own order.
    // A filtered full-canonical preorder is not a substitute for this forest.
    const convertSidebar = items => items.map(item => ({ id: item.id,
      contextParent: item.contextParent ? { tabId: item.contextParent.tabId, namespace: item.contextParent.projectId || null,
        name: item.contextParent.name || '', workflowId: core.rows[item.contextParent.tabId]?.membership.workflowId || null,
        availability: core.rows[item.contextParent.tabId] ? 'active' : 'unresolved' } : nodes.get(item.id)?.contextParent || null,
      children: convertSidebar(item.children || []) }));
    appendForest({ id: key('sidebar', workflow.id), kind: 'sidebar', windowId: null,
      paneIndex: null, column: null, row: null, stripTabIds: [] }, convertSidebar(sidebarTree));
    // Fully placed empty group identities must never disappear from coverage.
    if (usedCanonical.size !== workflow.nodes.length || workflow.nodes.some(node => !usedCanonical.has(node.id)))
      reasons.push('canonical-node-coverage-incomplete');
    const uniqueReasons = [...new Set(reasons)];
    return { workflowId: workflow.id, workflowRevision: workflow.revision,
      layoutHash: hash(publication.layout ?? null), profileKey, profileKind: profileKey ? 'published-key' : 'published-unkeyed',
      state: uniqueReasons.length ? 'canonical' : 'ready', reasons: uniqueReasons,
      placementInventoryKnown,
      placedTabIds: placementInventoryKnown ? workflow.memberTabIds.filter(id => placed.has(id)) : null,
      sidebarTabIds: placementInventoryKnown ? sidebarTabIds : null,
      retainedTabIds: placementInventoryKnown ? retainedTabIds : null,
      segments: uniqueReasons.length ? [] : segments.filter(segment => segment.nodes.length) };
  });
  return { version: 1, source, order: WINDOW_LAYOUT_CAPABILITY.order,
    coverage: WINDOW_LAYOUT_CAPABILITY.coverage, fallback: WINDOW_LAYOUT_CAPABILITY.fallback,
    dragPresentation: WINDOW_LAYOUT_CAPABILITY.dragPresentation, pixels: false, workflows };
}

module.exports = { WINDOW_LAYOUT_CAPABILITY, projectWorkflowWindowLayout,
  publishedPaneTabs, publishedPaneColumns, publishedPlacedTabs, publishedHiddenPanes };
