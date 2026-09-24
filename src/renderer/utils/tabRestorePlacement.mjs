import { paneSlots, restoreTabAtPanePosition } from './splitPanesModel.mjs';
import { captureTabOrder, restoredTabOrderIndex, tabSlotKey } from './tabOrderPosition.mjs';

// Layout identity survives undo; a new PTY still receives a NEW runtime tab id.
export const tabPlacementId = tab => tab.restorePlacementId || tab.id;
export function tabPlacementSlotKey(state) {
  const keys = new Map([...state.openProjects?.values() || []].flatMap(w => [...w.tabs.values()].map(t => [t.id, tabPlacementId(t)])));
  return slot => slot.tabId ? 'tab:' + (keys.get(slot.tabId) || slot.tabId) : tabSlotKey(slot);
}

export function readTabRestorePlacement(value) {
  try {
    const data = typeof value === 'string' ? JSON.parse(value) : value;
    const position = p => p && Number.isInteger(p.index) && p.index >= 0
      && Array.isArray(p.before) && p.before.every(id => typeof id === 'string')
      && Array.isArray(p.after) && p.after.every(id => typeof id === 'string');
    if (data?.version !== 1 || typeof data.id !== 'string' || !data.id || !position(data.sidebar)
      || (data.sidebar.parentId != null && typeof data.sidebar.parentId !== 'string')) return null;
    if (data.window && (!['pane', 'center'].includes(data.window.kind)
      || typeof data.window.spaceId !== 'string' || !position(data.window.position))) return null;
    return data;
  } catch { return null; }
}

export function captureTabRestorePlacement(state, workspace, tabId) {
  const tab = workspace.tabs.get(tabId);
  if (!tab || tab.parentTabId) return null;
  const id = tabPlacementId(tab);
  const sidebar = captureTabOrder([...workspace.tabs.values()].filter(t => !t.parentTabId).map(tabPlacementId), id);
  const parent = workspace.tabs.get(tab.visualParentTabId);
  sidebar.parentId = parent ? tabPlacementId(parent) : tab?.closedVisualParentTabId || null;
  sidebar.isCollapsed = tab.isCollapsed === true;
  const layouts = [
    { id: state.activeSpaceId, layout: state },
    ...(state.spaces || []).filter(s => s.id !== state.activeSpaceId),
  ];
  let window = null;
  const slotKey = tabPlacementSlotKey({ ...state, openProjects: state.openProjects || new Map([[workspace.projectId, workspace]]) });
  for (const { id: spaceId, layout } of layouts) {
    if (!layout) continue;
    const paneIndex = (layout.splitPanes || []).findIndex(p => paneSlots(p).some(s => s.tabId === tabId));
    if (paneIndex >= 0) {
      const pane = layout.splitPanes[paneIndex];
      window = { kind: 'pane', spaceId, windowId: pane.windowId || null, paneIndex,
        position: captureTabOrder(paneSlots(pane).map(slotKey), 'tab:' + id) };
      break;
    }
    for (const [projectId, strip] of Object.entries(layout.centerStrips || {})) {
      if (!strip.some(s => s.tabId === tabId)) continue;
      window = { kind: 'center', spaceId, projectId,
        position: captureTabOrder(strip.map(slotKey), 'tab:' + id) };
      break;
    }
    if (window) break;
  }
  return { version: 1, id, sidebar, window };
}

// Closing a parent promotes only its direct children. Keep a separate undo
// relation, so they stay usable while it is closed, even across restart.
export function tabsAfterClose(tabs, tabId, rememberParent = true) {
  const parentId = tabs.has(tabId) ? tabPlacementId(tabs.get(tabId)) : tabId;
  const next = new Map(tabs);
  next.delete(tabId);
  for (const [id, tab] of next) {
    if (tab.visualParentTabId === tabId) next.set(id, { ...tab, visualParentTabId: undefined,
      closedVisualParentTabId: rememberParent ? parentId : undefined });
  }
  return next;
}

export function restoreSidebarTab(tabs, tabId, placement, groups = []) {
  const next = new Map(tabs);
  const tab = next.get(tabId);
  if (!tab || !placement) return next;
  const parentId = placement.sidebar.parentId;
  const parent = [...next.values()].find(t => tabPlacementId(t) === parentId);
  let validParent = !!parent && parent.id !== tabId && !parent.parentTabId;
  const seen = new Set([tabId]);
  for (let ancestor = parent; validParent && ancestor; ancestor = next.get(ancestor.visualParentTabId)) {
    if (seen.has(ancestor.id)) { validParent = false; break; }
    seen.add(ancestor.id);
  }
  const groupId = validParent ? parent.groupId : groups.some(g => g.id === tab.groupId) ? tab.groupId : undefined;
  next.set(tabId, { ...tab, restorePlacementId: placement.id, groupId, visualParentTabId: validParent ? parent.id : undefined,
    isCollapsed: placement.sidebar.isCollapsed === true,
    closedVisualParentTabId: parentId && !parent ? parentId : undefined });
  for (const [id, child] of next) {
    if (!seen.has(id) && child.closedVisualParentTabId === placement.id && !child.visualParentTabId
      && !child.parentTabId && (child.groupId || null) === (groupId || null)) {
      next.set(id, { ...child, visualParentTabId: tabId, closedVisualParentTabId: undefined });
    }
  }
  const entries = [...next].filter(([id]) => id !== tabId);
  const mainIds = entries.filter(([, t]) => !t.parentTabId).map(([, t]) => tabPlacementId(t));
  const at = restoredTabOrderIndex(mainIds, placement.sidebar);
  const index = at < mainIds.length ? entries.findIndex(([, t]) => tabPlacementId(t) === mainIds[at])
    : (mainIds.length ? entries.findIndex(([, t]) => tabPlacementId(t) === mainIds.at(-1)) + 1 : 0);
  entries.splice(index, 0, [tabId, next.get(tabId)]);
  return new Map(entries);
}

// Reuse an existing window by stable identity. A deleted window/workflow is
// not resurrected by undo; the caller retains its normal focused-pane fallback.
export function restoreArchivedTabWindow(state, placement, projectId, tabId) {
  const target = placement?.window;
  if (!target) return null;
  const active = target.spaceId === state.activeSpaceId;
  const space = (state.spaces || []).find(s => s.id === target.spaceId);
  const layout = active ? state : space?.layout;
  if (!layout) return null;
  const slotKey = tabPlacementSlotKey(state);
  let patch;
  if (target.kind === 'pane') {
    const panes = layout.splitPanes || [];
    const index = target.windowId ? panes.findIndex(p => p.windowId === target.windowId) : -1;
    if (index < 0) return null;
    const restored = restoreTabAtPanePosition(panes, index, { projectId, tabId }, target.position, false, slotKey);
    if (!restored) return null;
    patch = { splitPanes: restored.panes };
  } else if (target.kind === 'center') {
    const panes = layout.splitPanes || [];
    if (panes.length) {
      // Closing the shown chip of a single centre materializes a vacant pane.
      // Recognize the surviving strip, never an unrelated newly created pane.
      const neighbours = new Set([...(target.position?.before || []), ...(target.position?.after || [])]);
      if (panes.length !== 1 || panes[0].tabId
        || !paneSlots(panes[0]).some(s => neighbours.has(slotKey(s)))) return null;
      patch = { splitPanes: restoreTabAtPanePosition(panes, 0, { projectId, tabId }, target.position, false, slotKey).panes };
    } else {
      const strip = layout.centerStrips?.[target.projectId];
      const shown = layout.activeSpaceTab;
      const current = strip || (shown?.tabId ? [shown] : []);
      if (!current.length) return null;
      const next = current.filter(s => s.tabId !== tabId);
      next.splice(restoredTabOrderIndex(next.map(slotKey), target.position), 0, { projectId, tabId });
      patch = { centerStrips: { ...layout.centerStrips, [target.projectId]: next } };
    }
  } else return null;
  return { spaceId: target.spaceId, patch: active ? patch : {
    spaces: state.spaces.map(s => s.id === target.spaceId ? { ...s, layout: { ...s.layout, ...patch } } : s),
  } };
}
