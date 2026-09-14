import {
  addEmptyPane,
  addEmptyPaneVertical,
  arrangePanes,
  collapseLonePane,
  dropTabFromAllPaneStrips,
  isEmptyPane,
  moveTabsToPane,
  paneChooserSlots,
  paneTabs,
  splitAvailability,
  vacantPaneWithTabs,
} from './splitPanesModel.mjs';
import { moveEntriesToIndex } from './horizontalReorder.mjs';
import { emptySpaceLayout } from './workspaceSpacesModel.mjs';
import { applyWindowDisplay, reconcileWindowDisplay } from './windowDisplayLayouts.mjs';

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
  let vacatedCenterKey = null;
  let vacatedCenterEntries = [];
  for (const [key, rawStrip] of Object.entries(layout.centerStrips || {})) {
    const before = Array.isArray(rawStrip) ? rawStrip : [];
    const strip = before.filter((entry) => !ids.has(entry?.tabId));
    if (ids.has(layout.activeSpaceTab?.tabId) && before.some((entry) => entry?.tabId === layout.activeSpaceTab.tabId)) {
      vacatedCenterKey = key;
      vacatedCenterEntries = strip;
      continue;
    }
    if (strip.length > 1) centerStrips[key] = strip;
  }
  let activeSpaceTab = layout.activeSpaceTab || null;
  if (ids.has(activeSpaceTab?.tabId)) {
    if (splitPanes.length === 0) {
      splitPanes = [vacantPaneWithTabs({}, vacatedCenterEntries)];
      if (vacatedCenterKey) delete centerStrips[vacatedCenterKey];
    }
    activeSpaceTab = null;
  }

  return {
    ...layout,
    splitPanes,
    centerStrips,
    activeSpaceTab,
    activeProjectId: layout.activeProjectId,
    focusedProjectId: layout.focusedProjectId,
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

  // A background source still has a real window when its monitor hides it.
  // Resolve "below/right of source" in a profile where that window is placed,
  // then restore the current projection. No intermediate layout reaches UI.
  if (panes[targetPaneIndex]?.displayHidden && layout.windowDisplayKey
      && (target.mode === 'new-window' || createEmptyWindow)) {
    const sourceId = panes[targetPaneIndex].windowId;
    const saved = Object.entries(layout.windowDisplayLayouts || {})
      .sort(([a], [b]) => Number(a === '__initial__') - Number(b === '__initial__'))
      .find(([key, profile]) => (
      key !== layout.windowDisplayKey && profile?.positions?.some(p => p.windowId === sourceId)
    ));
    if (saved) {
      const alternate = { key: saved[0], internal: false };
      const expanded = applyWindowDisplay(layout, alternate);
      const anchor = expanded.splitPanes.findIndex(p => p.windowId === sourceId);
      const changed = applyWorkspaceWindowMutation({ layout: expanded,
        target: { ...target, paneIndex: anchor }, entries, windows, show, focus, createEmptyWindow });
      if (!changed.ok) return changed;
      const updated = reconcileWindowDisplay(changed.layout, alternate);
      const addedIds = (changed.placedIndices || [changed.paneIndex]).map(index => updated.splitPanes[index]?.windowId);
      const restored = applyWindowDisplay(updated, { key: layout.windowDisplayKey, internal: false });
      const placedIndices = addedIds.map(id => restored.splitPanes.findIndex(p => p.windowId === id));
      return { ...changed, layout: restored, paneIndex: placedIndices[0],
        ...(changed.placedIndices ? { placedIndices } : {}) };
    }
  }

  if (target.mode === 'new-window' || createEmptyWindow) {
    const anchorIndex = targetPaneIndex === null ? 0 : targetPaneIndex;
    // «Пустое окно уже есть — заполните его» относится к окну, которое ЖДЁТ
    // вкладку. Окно с открытой страницей выбора её не ждёт: человек прямо
    // сейчас выбирает в нём, и для внешнего клиента это не свободное место.
    //
    // Без этой оговорки открытая страница выбора молча запрещала бы Terminal
    // MCP создать окно — то есть внутренний жест приложения сужал бы внешний
    // API, у которого о нём нет никаких сведений.
    if (createEmptyWindow
        && panes.some((pane) => isEmptyPane(pane) && paneChooserSlots(pane).length === 0)) {
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
