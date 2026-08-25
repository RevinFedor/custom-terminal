import {
  addEmptyPane,
  addEmptyPaneVertical,
  arrangePanes,
  collapseLonePane,
  dropTabFromAllPaneStrips,
  isEmptyPane,
  moveTabsToPane,
  paneTabs,
  splitAvailability,
} from './splitPanesModel.mjs';
import { moveEntriesToIndex } from './horizontalReorder.mjs';
import { emptySpaceLayout } from './workspaceSpacesModel.mjs';

const normalizeEntries = (raw) => {
  const seen = new Set();
  return (Array.isArray(raw) ? raw : []).flatMap((entry) => {
    if (!entry?.projectId || !entry?.tabId || seen.has(entry.tabId)) return [];
    seen.add(entry.tabId);
    return [{ projectId: entry.projectId, tabId: entry.tabId }];
  });
};

export function dropTabsFromWorkspaceLayout(rawLayout, tabIds) {
  const layout = { ...emptySpaceLayout(), ...(rawLayout || {}) };
  const ids = new Set((Array.isArray(tabIds) ? tabIds : []).filter(Boolean));
  if (ids.size === 0) return layout;

  let splitPanes = Array.isArray(layout.splitPanes) ? layout.splitPanes : [];
  for (const tabId of ids) {
    const dropped = dropTabFromAllPaneStrips(splitPanes, tabId);
    if (dropped) splitPanes = dropped.panes;
  }

  const centerStrips = {};
  const centerSurvivors = [];
  for (const [key, rawStrip] of Object.entries(layout.centerStrips || {})) {
    const strip = (Array.isArray(rawStrip) ? rawStrip : []).filter((entry) => !ids.has(entry?.tabId));
    centerSurvivors.push(...strip);
    if (strip.length > 1) centerStrips[key] = strip;
  }
  let activeSpaceTab = layout.activeSpaceTab || null;
  if (ids.has(activeSpaceTab?.tabId)) {
    const focus = Number.isInteger(layout.splitFocusedIndex) ? layout.splitFocusedIndex : 0;
    const replacementPane = splitPanes[focus]?.tabId
      ? splitPanes[focus]
      : splitPanes.find((pane) => pane?.tabId);
    activeSpaceTab = replacementPane?.tabId
      ? { projectId: replacementPane.projectId, tabId: replacementPane.tabId }
      : (centerSurvivors[0] || null);
  }

  return {
    ...layout,
    splitPanes,
    centerStrips,
    activeSpaceTab,
    activeProjectId: activeSpaceTab?.projectId || layout.activeProjectId,
    focusedProjectId: activeSpaceTab?.projectId || layout.focusedProjectId,
  };
}

const mutationFailure = (reason, details = {}) => ({ ok: false, reason, ...details });

export function applyWorkspaceWindowMutation({
  layout: rawLayout,
  target,
  entries: rawEntries,
  windows: rawWindows,
  show = false,
  focus = false,
  createEmptyWindow = false,
} = {}) {
  if (!target?.ok) return mutationFailure(target?.reason || 'target_unresolved');
  const layout = { ...emptySpaceLayout(), ...(rawLayout || {}) };
  const entries = normalizeEntries(rawEntries);
  const windows = (Array.isArray(rawWindows) ? rawWindows : [])
    .map((strip) => normalizeEntries(strip))
    .filter((strip) => strip.length > 0);
  const panes = Array.isArray(layout.splitPanes) ? layout.splitPanes : [];
  const current = layout.activeSpaceTab?.tabId ? layout.activeSpaceTab : null;
  const sourceStripKey = current?.projectId || layout.activeProjectId || null;
  const sourceCenterStrip = sourceStripKey && Array.isArray(layout.centerStrips?.[sourceStripKey])
    ? layout.centerStrips[sourceStripKey]
    : [];
  const currentWindow = current && sourceCenterStrip.length > 1
    ? { ...current, tabs: sourceCenterStrip }
    : current;
  const promotedCenterStrips = { ...(layout.centerStrips || {}) };
  if (panes.length === 0 && sourceStripKey && sourceCenterStrip.length > 1) {
    delete promotedCenterStrips[sourceStripKey];
  }
  const targetPaneIndex = target.paneIndex;

  if (target.mode === 'new-window' || createEmptyWindow) {
    const anchorIndex = targetPaneIndex === null ? 0 : targetPaneIndex;
    if (createEmptyWindow && panes.some(isEmptyPane)) {
      return mutationFailure('empty_window_exists');
    }
    const availability = splitAvailability(panes, anchorIndex);
    const vertical = target.side === 'above' || target.side === 'below';
    if (vertical ? !availability.vertical : !availability.horizontal) {
      return mutationFailure('window_capacity_reached', {
        direction: target.side,
        availability,
      });
    }

    if (entries.length === 0 && windows.length === 0) {
      const added = vertical
        ? addEmptyPaneVertical(panes, layout.splitFocusedIndex || 0, currentWindow, targetPaneIndex, target.side)
        : addEmptyPane(panes, layout.splitFocusedIndex || 0, currentWindow, targetPaneIndex, target.side);
      if (!added) return mutationFailure('empty_window_rejected');
      return {
        ok: true,
        layout: {
          ...layout,
          splitPanes: added.panes,
          splitFocusedIndex: focus ? added.focusedIndex : (layout.splitFocusedIndex || 0),
          splitSizes: panes.length === 0 ? null : layout.splitSizes,
          centerStrips: promotedCenterStrips,
        },
        paneIndex: added.focusedIndex,
        shownTabId: null,
      };
    }

    const arrangedWindows = windows.length > 0 ? windows : [entries];
    const arranged = arrangePanes(
      panes,
      layout.splitFocusedIndex || 0,
      {
        anchorIndex,
        side: target.side,
        divide: 'columns',
        windows: arrangedWindows,
      },
      currentWindow,
    );
    if (!arranged) return mutationFailure('window_arrangement_rejected');
    const paneIndex = arranged.placedIndices[0];
    const shownEntry = arrangedWindows[0][0];
    const shownTabId = shownEntry.tabId;
    return {
      ok: true,
      layout: {
        ...layout,
        splitPanes: arranged.panes,
        splitFocusedIndex: focus ? paneIndex : (layout.splitFocusedIndex || 0),
        activeSpaceTab: show ? shownEntry : layout.activeSpaceTab,
        activeProjectId: show ? shownEntry.projectId : layout.activeProjectId,
        focusedProjectId: show ? shownEntry.projectId : layout.focusedProjectId,
        centerStrips: promotedCenterStrips,
      },
      paneIndex,
      placedIndices: arranged.placedIndices,
      shownTabId,
    };
  }

  if (entries.length === 0) return mutationFailure('tabs_required');

  if (panes.length > 0) {
    if (!Number.isInteger(targetPaneIndex) || !panes[targetPaneIndex]) {
      return mutationFailure('target_pane_missing');
    }
    const previousShown = panes[targetPaneIndex].tabId || null;
    const moved = moveTabsToPane(
      panes,
      targetPaneIndex,
      entries,
      target.insertIndex,
      show ? entries[0].tabId : previousShown,
    );
    if (!moved) return mutationFailure('window_strip_unchanged');
    if (collapseLonePane(moved.panes)) {
      const strip = paneTabs(moved.panes[0]);
      const shown = strip.find((entry) => entry.tabId === moved.shownTabId) || entries[0];
      const centerStrips = { ...(layout.centerStrips || {}) };
      if (strip.length > 1) centerStrips[shown.projectId] = strip;
      return {
        ok: true,
        layout: {
          ...layout,
          splitPanes: [],
          splitFocusedIndex: 0,
          splitSizes: null,
          centerStrips,
          activeSpaceTab: shown,
          activeProjectId: show ? shown.projectId : layout.activeProjectId,
          focusedProjectId: show ? shown.projectId : layout.focusedProjectId,
        },
        paneIndex: null,
        insertedAt: moved.insertedAt,
        shownTabId: shown.tabId,
      };
    }
    const shownTabId = moved.panes[targetPaneIndex].tabId;
    const shown = paneTabs(moved.panes[targetPaneIndex]).find((entry) => entry.tabId === shownTabId);
    return {
      ok: true,
      layout: {
        ...layout,
        splitPanes: moved.panes,
        splitFocusedIndex: focus ? targetPaneIndex : (layout.splitFocusedIndex || 0),
        activeSpaceTab: show && shown ? shown : layout.activeSpaceTab,
        activeProjectId: show && shown ? shown.projectId : layout.activeProjectId,
        focusedProjectId: show && shown ? shown.projectId : layout.focusedProjectId,
      },
      paneIndex: targetPaneIndex,
      insertedAt: moved.insertedAt,
      shownTabId,
    };
  }

  const shown = layout.activeSpaceTab;
  const key = shown?.projectId || layout.activeProjectId || entries[0].projectId;
  const currentStrip = Array.isArray(layout.centerStrips?.[key])
    ? layout.centerStrips[key]
    : (shown?.tabId ? [shown] : []);
  const next = moveEntriesToIndex(currentStrip, entries, target.insertIndex);
  const finalShown = show ? entries[0] : (shown || next[0]);
  const centerStrips = { ...(layout.centerStrips || {}) };
  if (next.length > 1) centerStrips[key] = next;
  else delete centerStrips[key];
  return {
    ok: true,
    layout: {
      ...layout,
      centerStrips,
      activeSpaceTab: finalShown || null,
      activeProjectId: show && finalShown ? finalShown.projectId : layout.activeProjectId,
      focusedProjectId: show && finalShown ? finalShown.projectId : layout.focusedProjectId,
    },
    paneIndex: null,
    insertedAt: next.findIndex((entry) => entry.tabId === entries[0].tabId),
    shownTabId: finalShown?.tabId || null,
  };
}
