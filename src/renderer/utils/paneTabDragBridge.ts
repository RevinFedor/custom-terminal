import { useSyncExternalStore } from 'react';
import {
  createHorizontalDragGeometryCache,
  horizontalDragAutoScrollDelta,
} from './horizontalDragGeometry.mjs';

export const PANE_TAB_DND_TYPE = 'PANE_TAB_CHIP_V2';

export type PaneTabDragEntry = { projectId: string; tabId: string };
export type PaneStripKey = 'center' | `pane:${number}`;

export type PaneTabDragSource = {
  owner: 'pane' | 'sidebar';
  entries: PaneTabDragEntry[];
  rootTabId: string;
  sourcePaneKey?: PaneStripKey | null;
  sourceSpaceId?: string | null;
  pointerId?: number;
};

export type PaneTabDropDebug = {
  dragCenterX: number;
  dragCenterY: number;
  wrap: boolean;
  viewportLeft: number;
  viewportWidth: number;
  scrollLeft: number;
  scrollWidth: number;
  autoScrollDelta: number;
};

export type PaneTabDropTarget = {
  zone: 'strip' | 'body';
  paneKey: PaneStripKey;
  paneIndex: number | null;
  spaceId?: string | null;
  at: number;
  debug?: PaneTabDropDebug;
};

export type PaneTabDragSnapshot = {
  active: boolean;
  revision: number;
  source: PaneTabDragSource | null;
  target: PaneTabDropTarget | null;
};

const EMPTY: PaneTabDragSnapshot = Object.freeze({
  active: false,
  revision: 0,
  source: null,
  target: null,
});

let snapshot: PaneTabDragSnapshot = EMPTY;
const listeners = new Set<() => void>();
const stripGeometry = createHorizontalDragGeometryCache();
let dragSession = 0;
let claimedDropSession = -1;

const publish = (next: PaneTabDragSnapshot) => {
  snapshot = next;
  listeners.forEach((listener) => listener());
};

export const paneStripKey = (paneIndex: number | null | undefined): PaneStripKey => (
  paneIndex === null || paneIndex === undefined ? 'center' : `pane:${paneIndex}`
);

export function beginPaneTabDrag(source: PaneTabDragSource) {
  const entries: PaneTabDragEntry[] = [];
  const seen = new Set<string>();
  (source.entries || []).forEach((entry) => {
    if (!entry?.tabId || !entry?.projectId || seen.has(entry.tabId)) return;
    seen.add(entry.tabId);
    entries.push({ projectId: entry.projectId, tabId: entry.tabId });
  });
  if (entries.length === 0) return;
  const sameSource = snapshot.active
    && snapshot.source?.owner === source.owner
    && snapshot.source?.rootTabId === source.rootTabId
    && snapshot.source?.sourcePaneKey === source.sourcePaneKey
    && snapshot.source?.sourceSpaceId === source.sourceSpaceId
    && snapshot.source.entries.map((entry) => entry.tabId).join('\u0000') === entries.map((entry) => entry.tabId).join('\u0000');
  if (sameSource) return;
  stripGeometry.clear();
  dragSession += 1;
  publish({
    active: true,
    revision: snapshot.revision + 1,
    source: { ...source, entries },
    target: null,
  });
}

export function setPaneTabDragTarget(target: PaneTabDropTarget | null) {
  if (!snapshot.active || !snapshot.source) return;
  const previous = snapshot.target;
  if (
    previous?.zone === target?.zone
    && previous?.paneKey === target?.paneKey
    && previous?.spaceId === target?.spaceId
    && previous?.at === target?.at
  ) return;
  if (target?.debug) {
    console.log('[PaneTabDnd:resolve] pane=' + target.paneKey
      + ' zone=' + target.zone
      + ' at=' + target.at
      + ' centerX=' + target.debug.dragCenterX.toFixed(1)
      + ' centerY=' + target.debug.dragCenterY.toFixed(1)
      + ' wrap=' + Number(target.debug.wrap)
      + ' viewportLeft=' + target.debug.viewportLeft.toFixed(1)
      + ' viewportWidth=' + target.debug.viewportWidth.toFixed(1)
      + ' scrollLeft=' + target.debug.scrollLeft.toFixed(1)
      + ' scrollWidth=' + target.debug.scrollWidth.toFixed(1)
      + ' autoScroll=' + target.debug.autoScrollDelta.toFixed(1));
  }
  publish({ ...snapshot, revision: snapshot.revision + 1, target });
}

export function claimPaneTabDragDrop(rootTabId?: string) {
  if (!snapshot.active || !snapshot.source || !snapshot.target) return null;
  if (rootTabId && snapshot.source.rootTabId !== rootTabId) return null;
  if (claimedDropSession === dragSession) return null;
  claimedDropSession = dragSession;
  return { source: snapshot.source, target: snapshot.target, session: dragSession };
}

export function endPaneTabDrag(rootTabId?: string) {
  if (!snapshot.active) return;
  if (rootTabId && snapshot.source?.rootTabId !== rootTabId) return;
  stripGeometry.clear();
  publish({ ...EMPTY, revision: snapshot.revision + 1 });
}

export const getPaneTabDragSnapshot = () => snapshot;
export const subscribePaneTabDrag = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function usePaneTabDragSnapshot() {
  return useSyncExternalStore(subscribePaneTabDrag, getPaneTabDragSnapshot, getPaneTabDragSnapshot);
}

export function paneTabSourceFromDragData(data: Record<string, unknown>): PaneTabDragSource | null {
  if (data?.type !== PANE_TAB_DND_TYPE) return null;
  const tabId = typeof data.tabId === 'string' ? data.tabId : '';
  const projectId = typeof data.projectId === 'string' ? data.projectId : '';
  if (!tabId || !projectId) return null;
  return {
    owner: 'pane',
    entries: [{ projectId, tabId }],
    rootTabId: tabId,
    sourcePaneKey: typeof data.paneKey === 'string' ? data.paneKey as PaneStripKey : null,
    sourceSpaceId: typeof data.spaceId === 'string' ? data.spaceId : null,
    pointerId: Number.isFinite(Number(data.pointerId)) ? Number(data.pointerId) : undefined,
  };
}

export function paneTabDropTargetContainsPoint(
  target: PaneTabDropTarget,
  clientX: number,
  clientY: number,
) {
  if (typeof document === 'undefined') return false;
  const pointed = document.elementFromPoint(Number(clientX) || 0, Number(clientY) || 0);
  const zone = pointed?.closest?.<HTMLElement>('[data-pane-tab-drop-zone]');
  if (!zone) return false;
  const paneKey = zone.dataset.paneKey;
  const kind = zone.dataset.paneTabDropZone === 'body' ? 'body' : 'strip';
  const spaceId = zone.dataset.spaceId || null;
  return paneKey === target.paneKey
    && kind === target.zone
    && (!target.spaceId || target.spaceId === spaceId);
}

export function resolvePaneTabDropTarget(
  pointed: Element | null,
  clientX: number,
  excludedTabIds: string[] = [],
  clientY: number = 0,
): PaneTabDropTarget | null {
  const zone = pointed?.closest?.<HTMLElement>('[data-pane-tab-drop-zone]');
  if (!zone) return null;
  const paneKey = zone.dataset.paneKey as PaneStripKey | undefined;
  if (!paneKey || (paneKey !== 'center' && !paneKey.startsWith('pane:'))) return null;
  const paneIndex = paneKey === 'center' ? null : Number(paneKey.slice(5));
  if (paneKey !== 'center' && !Number.isFinite(paneIndex)) return null;
  const kind = zone.dataset.paneTabDropZone === 'body' ? 'body' : 'strip';
  const spaceId = zone.dataset.spaceId || null;
  if (kind === 'body') {
    return { zone: 'body', paneKey, paneIndex, spaceId, at: Number.POSITIVE_INFINITY };
  }
  const strip = zone.matches('[data-pane-tab-strip-scroller]')
    ? zone
    : zone.querySelector<HTMLElement>('[data-pane-tab-strip-scroller]') || zone.closest<HTMLElement>('[data-pane-tab-strip-scroller]');
  if (!strip) return null;
  const stripRect = strip.getBoundingClientRect();
  const wrap = strip.dataset.paneTabStripWrap === 'true';
  const autoScrollDelta = wrap ? 0 : horizontalDragAutoScrollDelta({
    clientX,
    viewportLeft: stripRect.left,
    viewportRight: stripRect.right,
    scrollLeft: strip.scrollLeft,
    scrollWidth: strip.scrollWidth,
    clientWidth: strip.clientWidth,
  });
  if (autoScrollDelta) strip.scrollLeft += autoScrollDelta;
  // The native preview is centered under the pointer, so the pointer itself is
  // the dragged chip's semantic center. No initial grab offset participates in
  // placement; left-edge and right-edge grabs therefore have identical slots.
  const dragCenterX = Number(clientX) || 0;
  const at = stripGeometry.resolve({
    ownerKey: `${spaceId || 'unknown'}:${paneKey}`,
    excludedIds: excludedTabIds,
    clientX: dragCenterX,
    clientY,
    viewportLeft: stripRect.left,
    viewportTop: stripRect.top,
    scrollLeft: strip.scrollLeft,
    scrollTop: strip.scrollTop,
    wrap,
    // This callback runs once per target strip and drag gesture. In particular,
    // it does NOT read rectangles again after the live preview starts moving
    // those same chips under the pointer.
    readChips: () => Array.from(strip.querySelectorAll<HTMLElement>('[data-strip-item]')).map((chip) => {
      const rect = chip.getBoundingClientRect();
      return { id: chip.dataset.stripTabId || '', left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }),
  });
  return {
    zone: 'strip',
    paneKey,
    paneIndex,
    spaceId,
    at,
    debug: {
      dragCenterX,
      dragCenterY: clientY,
      wrap,
      viewportLeft: stripRect.left,
      viewportWidth: stripRect.width,
      scrollLeft: strip.scrollLeft,
      scrollWidth: strip.scrollWidth,
      autoScrollDelta,
    },
  };
}
