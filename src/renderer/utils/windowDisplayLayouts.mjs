import { paneColumns, paneGridRects, packSplitSizes, paneTabs, paneChooserSlots,
  paneSlots, paneHistory, isBareEmptyPane, addEmptyPane, addEmptyPaneVertical,
  splitAvailability, replacePaneShownTab, selectChooserSlot } from './splitPanesModel.mjs';

// The pane array owns window CONTENT once. Display profiles contain addresses
// and geometry only; they can never restore deleted tabs or fork a live owner.
const INITIAL = '__initial__';
const newId = () => globalThis.crypto?.randomUUID?.()
  || `window-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export const isWindowVisible = (pane) => !!pane && pane.displayHidden !== true;
export const visibleWindowCount = (panes) => (panes || []).filter(isWindowVisible).length;

// A freshly created split slot has no content or return history of its own.
// An intentional vacancy after Remove/Full may still own Ctrl+[ / Cmd+Shift+T
// history; never discard that window merely because its body is empty.
const isNewEmptyWindow = pane => isBareEmptyPane(pane)
  && paneHistory(pane).length === 0 && !(pane?.detachedTabs?.length);
const hiddenWindowForSplit = panes => panes.find(p => !isWindowVisible(p) && paneSlots(p).length > 0)
  || panes.find(p => !isWindowVisible(p));

/** UI split adds a visible place, reusing existing offscreen content first. */
export function windowSplitAvailability(panes, paneIndex) {
  const list = Array.isArray(panes) ? panes : [];
  const visible = list.filter(isWindowVisible);
  if (hiddenWindowForSplit(list) && visible.some(isNewEmptyWindow)) {
    return { horizontal: true, vertical: true, reason: null };
  }
  return splitAvailability(visible, visible.indexOf(list[paneIndex ?? 0]));
}

export function splitWindowPane(panes, focusedIndex, current, anchorIndex = null, side = 'right', hiddenWindowId = null) {
  if (!Array.isArray(panes) || !['right', 'left', 'above', 'below'].includes(side)) return null;
  const list = ensureWindowIds(panes);
  const visible = list.filter(isWindowVisible);
  const anchor = list[anchorIndex ?? focusedIndex];
  if (list.length && !isWindowVisible(anchor)) return null;
  const incoming = hiddenWindowId ? list.find(pane=>pane.windowId===hiddenWindowId && !isWindowVisible(pane)) : hiddenWindowForSplit(list);
  if(hiddenWindowId && !incoming)return null;
  const placeholderIndex = list.findIndex(p => isWindowVisible(p) && isNewEmptyWindow(p));
  if (incoming && placeholderIndex >= 0) {
    // Recovery for a split made by older builds: fill its existing vacancy,
    // don't create yet another column or exchange it into the hidden picker.
    const revealed = revealHiddenWindow({ splitPanes: list, splitFocusedIndex: focusedIndex },
      placeholderIndex, incoming.windowId);
    return revealed && { panes: revealed.splitPanes, focusedIndex: revealed.splitFocusedIndex,
      revealedWindowId: incoming.windowId };
  }
  const visibleFocus = Math.max(0, visible.indexOf(list[focusedIndex]));
  const visibleAnchor = list.length ? visible.indexOf(anchor) : null;
  // Hidden window columns belong to their saved monitor projection. The
  // ordinary geometry primitives must see only the currently visible grid.
  const opened = side === 'above' || side === 'below'
    ? addEmptyPaneVertical(visible, visibleFocus, current, visibleAnchor, side)
    : addEmptyPane(visible, visibleFocus, current, visibleAnchor, side);
  if (!opened) return null;
  const next = opened.panes.slice();
  if (incoming) {
    const { displayHidden, displayRect, column, ...content } = incoming;
    const slot = next[opened.focusedIndex];
    next[opened.focusedIndex] = { ...content,
      ...(slot.column !== undefined ? { column: slot.column } : {}) };
  }
  return { panes: [...next, ...list.filter(p => !isWindowVisible(p) && p !== incoming)],
    focusedIndex: opened.focusedIndex, revealedWindowId: incoming?.windowId };
}

export function ensureWindowIds(panes, _namespace = 'workspace') {
  const used = new Set();
  let changed = false;
  const next = (panes || []).map((pane) => {
    let id = pane.windowId;
    if (!id || used.has(id)) {
      // A closed window's identity must never be reused by a later window in
      // the same slot (an open picker/async operation may still name it).
      id = newId();
      changed = true;
    }
    used.add(id);
    return id === pane.windowId ? pane : { ...pane, windowId: id };
  });
  return changed ? next : panes;
}

export function captureWindowDisplayLayout(layout) {
  const panes = layout.splitPanes || [];
  const positions = [];
  paneColumns(panes).forEach((rows, column) => rows.forEach(({ pane }, row) => {
    positions.push({ windowId: pane.windowId, column, row });
  }));
  return {
    positions,
    sizes: packSplitSizes(panes, layout.splitSizes),
    focusedWindowId: panes[layout.splitFocusedIndex || 0]?.windowId || null,
  };
}

function compactProfile(panes, focusedIndex) {
  const focus = panes[focusedIndex] || panes[0];
  const selected = panes.filter(isWindowVisible).slice(0, 2);
  if (focus && !selected.includes(focus)) {
    if (selected.length > 1) selected[1] = focus;
    else selected.push(focus);
  }
  if (!selected.length && panes[0]) selected.push(panes[0]);
  return {
    positions: selected.map((p, column) => ({ windowId: p.windowId, column, row: 0 })),
    focusedWindowId: focus?.windowId || null,
    sizes: null,
  };
}

function cleanProfiles(profiles, panes) {
  const ids = new Set(panes.map(p => p.windowId));
  return Object.fromEntries(Object.entries(profiles || {}).map(([key, profile]) => [key, {
    ...profile,
    focusedWindowId: ids.has(profile?.focusedWindowId) ? profile.focusedWindowId : null,
    positions: (Array.isArray(profile?.positions) ? profile.positions : []).filter(p => p && ids.has(p.windowId)),
  }]));
}

/** Apply a monitor without copying/recreating the window contents. */
export function applyWindowDisplay(layout, display, namespace = 'workspace') {
  const panes = ensureWindowIds(layout.splitPanes || [], namespace);
  const current = { ...layout, splitPanes: panes };
  const profiles = cleanProfiles(layout.windowDisplayLayouts, panes);
  const previousKey = layout.windowDisplayKey;
  if (!profiles[INITIAL]?.positions?.length) profiles[INITIAL] = captureWindowDisplayLayout(current);
  if (previousKey) profiles[previousKey] = captureWindowDisplayLayout(current);
  const target = profiles[display.key] || (display.internal
    ? compactProfile(panes, layout.splitFocusedIndex || 0)
    : profiles[INITIAL]);
  const byId = new Map(panes.map(p => [p.windowId, p]));
  const seen = new Set();
  const positions = (target.positions || []).filter(p => {
    if (!byId.has(p.windowId) || seen.has(p.windowId)) return false;
    seen.add(p.windowId);
    return true;
  }).sort((a, b) => a.column - b.column || a.row - b.row);
  if (panes.length && !positions.length) {
    positions.push({ windowId: panes[0].windowId, column: 0, row: 0 });
    seen.add(panes[0].windowId);
  }
  const rects = paneGridRects(panes, layout.splitSizes);
  const next = positions.map(pos => {
    const { displayHidden, displayRect, ...pane } = byId.get(pos.windowId);
    return { ...pane, column: pos.column };
  });
  panes.forEach((pane, index) => {
    if (seen.has(pane.windowId)) return;
    next.push({ ...pane, displayHidden: true, displayRect: rects[index] || pane.displayRect });
  });
  const focused = next.findIndex(p => isWindowVisible(p) && p.windowId === target.focusedWindowId);
  const out = {
    ...layout,
    splitPanes: next,
    splitFocusedIndex: Math.max(0, focused),
    splitSizes: packSplitSizes(next, target.sizes),
    windowDisplayKey: display.key,
    windowDisplayLayouts: profiles,
  };
  const shown = next[out.splitFocusedIndex];
  out.activeSpaceTab = shown?.tabId ? { projectId: shown.projectId, tabId: shown.tabId } : null;
  if (shown?.tabId) out.activeProjectId = shown.projectId;
  out.windowDisplayLayouts[display.key] = captureWindowDisplayLayout(out);
  return out;
}

/** Persist mutations of the current projection; hidden panes stay in inventory. */
export function reconcileWindowDisplay(layout, display, namespace = 'workspace') {
  if (layout.windowDisplayKey !== display.key) return applyWindowDisplay(layout, display, namespace);
  let panes = ensureWindowIds(layout.splitPanes || [], namespace);
  // Closing the last visible window must leave access to the remaining hidden
  // inventory, without spontaneously activating one of its tabs.
  if (panes.length && !panes.some(isWindowVisible)) {
    panes = [{ projectId: '', tabId: '', windowId: newId() }, ...panes];
  }
  const focused = isWindowVisible(panes[layout.splitFocusedIndex]) ? layout.splitFocusedIndex : 0;
  const out = { ...layout, splitPanes: panes, splitFocusedIndex: focused };
  out.windowDisplayLayouts = cleanProfiles(layout.windowDisplayLayouts, panes);
  out.windowDisplayLayouts[display.key] = captureWindowDisplayLayout(out);
  return out;
}

/** Reveal a whole window, optionally selecting one of its existing chips first. */
export function revealHiddenWindow(layout, targetIndex, hiddenWindowId, selection) {
  const panes = layout.splitPanes || [];
  const from = panes[targetIndex];
  const incomingIndex = panes.findIndex(p => p.windowId === hiddenWindowId && !isWindowVisible(p));
  let incoming = panes[incomingIndex];
  if (!isWindowVisible(from) || !incoming) return null;
  if (selection !== undefined) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return null;
    const keys = Object.keys(selection);
    if (keys.length === 2 && keys.includes('projectId') && keys.includes('tabId')
        && typeof selection.projectId === 'string' && selection.projectId
        && typeof selection.tabId === 'string' && selection.tabId) {
      if (!paneTabs(incoming).some(tab => tab.projectId === selection.projectId && tab.tabId === selection.tabId)) return null;
      incoming = replacePaneShownTab([incoming], 0, selection.projectId, selection.tabId)?.panes[0] || incoming;
    } else if (keys.length === 1 && keys[0] === 'slotId'
        && typeof selection.slotId === 'string' && selection.slotId) {
      if (!paneChooserSlots(incoming).some(slot => slot.slotId === selection.slotId)) return null;
      incoming = selectChooserSlot([incoming], 0, selection.slotId)?.panes[0] || incoming;
    } else {
      return null;
    }
  }
  const rects = paneGridRects(panes, layout.splitSizes);
  const { displayHidden, displayRect, column, ...content } = incoming;
  const consumePlaceholder = isNewEmptyWindow(from);
  const next = panes.map((pane, index) => pane === from
    ? { ...content, column: from.column ?? targetIndex }
    : index === incomingIndex
      ? consumePlaceholder ? null : { ...from, displayHidden: true, displayRect: rects[targetIndex] }
      : pane).filter(Boolean);
  return { ...layout, splitPanes: next,
    splitFocusedIndex: targetIndex - (consumePlaceholder && incomingIndex < targetIndex ? 1 : 0) };
}

const fields = ['splitPanes', 'splitFocusedIndex', 'splitSizes', 'windowDisplayKey', 'windowDisplayLayouts'];
const slice = (layout) => Object.fromEntries(fields.map(key => [key, layout[key]]));

// One store boundary covers UI, restore, MCP, close, move and background writes.
// Only layout mutations enter here; keystrokes/activity do not rebuild profiles.
export function reconcileWorkspaceDisplayPatch(state, patch) {
  if (!patch || typeof patch !== 'object') return patch;
  const display = patch.workspaceDisplay || state.workspaceDisplay;
  if (!display?.key || (patch.isRestoring ?? state.isRestoring)) return patch;
  const changed = fields.some(key => Object.hasOwn(patch, key))
    || Object.hasOwn(patch, 'workspaceDisplay') || Object.hasOwn(patch, 'activeSpaceId')
    || (state.isRestoring && patch.isRestoring === false);
  if (!changed && !Object.hasOwn(patch, 'spaces')) return patch;
  const next = { ...state, ...patch };
  const out = changed
    ? { ...patch, ...slice(reconcileWindowDisplay(next, display, next.activeSpaceId || 'workspace')) }
    : { ...patch };
  if (Object.hasOwn(patch, 'spaces') || Object.hasOwn(patch, 'workspaceDisplay')) {
    out.spaces = (next.spaces || []).map(space => {
      if (!space.layout || space.id === next.activeSpaceId) return space;
      // Preserve exact dormant element identity on unrelated metadata writes.
      const previous = state.spaces?.find(s => s.id === space.id);
      if (previous?.layout === space.layout && space.layout.windowDisplayKey === display.key) return space;
      return { ...space, layout: reconcileWindowDisplay(space.layout, display, space.id) };
    });
  }
  return out;
}
