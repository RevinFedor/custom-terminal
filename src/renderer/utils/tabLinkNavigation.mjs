import { findTabPlacement, placementWorldFromState } from './tabPlacementResolver.mjs';
import { paneDetachedTabs } from './splitPanesModel.mjs';

export function findOpenTabOwner(state, tabId) {
  const namespace = state.tabCatalog?.[tabId]?.namespace;
  if (namespace) {
    const workspace = state.openProjects?.get(namespace),tab = workspace?.tabs?.get(tabId);
    return tab ? {projectId:namespace,workspace,tab} : null;
  }
  for (const [projectId, workspace] of state.openProjects || []) {
    const tab = workspace.tabs?.get(tabId);
    if (tab) return { projectId, workspace, tab };
  }
  return null;
}

// This is navigation memory, not execution ownership or automation membership.
export function normalizeTabWorkflowMemory(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([id, space]) =>
    id && typeof space === 'string' && space));
}

export function seedTabWorkflowMemory(state, raw) {
  const memory = normalizeTabWorkflowMemory(raw);
  const spaces = new Set((state.spaces || []).map(space => space.id));
  const world = placementWorldFromState(state);
  for (const [projectId, workspace] of state.openProjects || []) {
    for (const tab of workspace.tabs?.values() || []) {
      if (spaces.has(memory[tab.id])) continue;
      const placed = findTabPlacement({ ...world, tabId: tab.id });
      const detached = lastTabWorkflow(state, tab.id);
      // Legacy project association is imported ONCE. Runtime link navigation
      // never derives organizational membership from an execution namespace.
      const legacy = (state.spaces || []).filter(space => space.projectIds?.includes(projectId));
      const id = placed?.spaceId || detached || (legacy.length === 1 ? legacy[0].id : null);
      if (id) memory[tab.id] = id;
    }
  }
  return memory;
}

export function lastTabWorkflow(state, tabId) {
  const spaces = new Set((state.spaces || []).map(space => space.id));
  const membership = (state.pendingTabWorkflowMembership?.[tabId] || state.tabWorkflowMembership?.[tabId])?.workflowId;
  if (membership && spaces.has(membership)) return membership;
  const remembered = state.tabLastWorkflowIds?.[tabId];
  if (remembered && spaces.has(remembered)) return remembered;
  const layouts = [{ id: state.activeSpaceId, layout: state },
    ...(state.spaces || []).filter(space => space.id !== state.activeSpaceId)];
  const removals = layouts.flatMap(space => (space.layout?.splitPanes || []).flatMap(pane =>
    paneDetachedTabs(pane).filter(entry => entry.tabId === tabId)
      .map(entry => ({ spaceId: space.id, order: Number(entry.closedOrder) || 0 }))));
  removals.sort((a, b) => b.order - a.order);
  return removals[0]?.spaceId || null;
}

export function resolveTabLinkNavigation(state, tabId) {
  const world = placementWorldFromState(state);
  const placement = findTabPlacement({ ...world, tabId });
  if (placement) return { kind: 'reveal', spaceId: placement.spaceId,
    paneIndex: placement.paneIndex };
  // Older display snapshots may still hold content. Geometry-only profiles
  // contribute nothing here. Keep the exact saved window and chip sequence.
  const spaces = [{id:state.activeSpaceId,layout:state},
    ...(state.spaces || []).filter(space => space.id !== state.activeSpaceId)];
  for (const space of spaces) {
    const seen = new Set();
    const visit = layout => {
      if (!layout || seen.has(layout)) return null;
      seen.add(layout);
      for (const [profileKey,profile] of Object.entries(layout.windowDisplayLayouts || {})) {
        const paneIndex = (profile.splitPanes || []).findIndex(pane =>
          (pane.tabs?.length ? pane.tabs : [pane]).some(ref => ref?.tabId === tabId));
        if (paneIndex >= 0) return {kind:'reveal-profile',spaceId:space.id,profileKey,
          paneIndex,pane:profile.splitPanes[paneIndex]};
        const center = Object.values(profile.centerStrips || {}).find(strip =>
          Array.isArray(strip) && strip.some(ref => ref?.tabId === tabId));
        if (center || profile.activeSpaceTab?.tabId === tabId) return {kind:'reveal-profile',spaceId:space.id,
          profileKey,paneIndex:null,entries:center || [profile.activeSpaceTab]};
        const nested = visit(profile); if (nested) return nested;
      }
      return null;
    };
    const profile = visit(space.layout); if (profile) return profile;
  }
  const spaceId = lastTabWorkflow(state, tabId) || state.activeSpaceId;
  const layout = spaceId === state.activeSpaceId ? state
    : state.spaces.find(space => space.id === spaceId)?.layout;
  if (!layout) return null;
  const panes = layout.splitPanes || [];
  const focused = Math.max(0, Math.min(layout.splitFocusedIndex || 0, panes.length - 1));
  return { kind: 'append', spaceId, paneIndex: panes.length
    ? !panes[focused]?.displayHidden ? focused : Math.max(0,panes.findIndex(pane => !pane.displayHidden)) : null };
}
