import {uiDragDiagnostic,uiDragAdmission} from './uiPerformanceDiagnostics.mjs';
import { useSyncExternalStore } from 'react';
import {createPaneDropPresentation,paneDropPresentationValid,paneDropPresentationCaughtUp,
  samePaneEntries,panePresentationKey} from './paneTabDropPresentation.mjs';
import {
  createHorizontalDragGeometryCache,
} from './horizontalDragGeometry.mjs';
import {readPaneTabStripChips} from './paneTabStripGeometry.mjs';
import {clampPaneStripGroupInsertion} from './paneStripSelectionModel.mjs';
import {samePaneStripRowPlacement} from '../../shared/pane-strip-row-placement.cjs';

export const PANE_TAB_DND_TYPE = 'PANE_TAB_CHIP_V2';

export type PaneTabDragEntry = { projectId: string; tabId: string };
export type PaneStripKey = 'center' | `pane:${number}`;

export type PaneTabDragSource = {
  /** Renderer-only captured color-group scope, not a durable writer grant. */
  groupDrag?: { boundary: any; isCurrent: () => boolean };
  /** UI-only original sidebar grab; never part of durable workflow admission. */
  sourceGrabOffsetY?: number;
  owner: 'pane' | 'sidebar';
  entries: PaneTabDragEntry[];
  rootTabId: string;
  sourcePaneKey?: PaneStripKey | null;
  sourceSpaceId?: string | null;
  pointerId?: number;
  input?: 'pointer' | 'native';
  gestureId?: string;
  workflowDrag?: any;
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
  /** CSS-width-bound row start, distinct from a previous row's tail at `at`. */
  rowStartId?: string | null;
  stripWidth?: number;
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

export function paneTabGroupDragIsCurrent(source: PaneTabDragSource) {
  const lease=source.groupDrag;
  if(!lease)return true;
  try {return (lease.boundary?.kind==='group' || lease.boundary?.kind==='free') && lease.isCurrent()===true;} catch {return false;}
}

/** Clamp the semantic POST-removal index before it becomes a shown target.
 * A color-group member cannot be adopted by another pane/workflow/sidebar. */
export function constrainPaneTabGroupTarget(source:PaneTabDragSource,target:PaneTabDropTarget|null) {
  if(!target || !source.groupDrag || source.groupDrag.boundary?.kind==='free')return target;
  const boundary=source.groupDrag.boundary;
  if(boundary?.kind!=='group' || target.paneKey!==source.sourcePaneKey
    || target.spaceId!==source.sourceSpaceId)return null;
  const at=clampPaneStripGroupInsertion(boundary,target.zone==='body'?boundary.end:target.at);
  return at===null ? null:at===target.at ? target:{...target,at,rowStartId:null};
}

const publish = (next: PaneTabDragSnapshot) => {
  snapshot = next;
  listeners.forEach((listener) => listener());
};

export const paneStripKey = (paneIndex: number | null | undefined): PaneStripKey => (
  paneIndex === null || paneIndex === undefined ? 'center' : `pane:${paneIndex}`
);

export function beginPaneTabDrag(source: PaneTabDragSource) {
  if(!paneTabGroupDragIsCurrent(source))return;
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
    && snapshot.source?.input === source.input
    && (!source.gestureId || snapshot.source?.gestureId === source.gestureId)
    && snapshot.source?.rootTabId === source.rootTabId
    && snapshot.source?.sourcePaneKey === source.sourcePaneKey
    && snapshot.source?.sourceSpaceId === source.sourceSpaceId
    && snapshot.source.entries.map((entry) => entry.tabId).join('\u0000') === entries.map((entry) => entry.tabId).join('\u0000');
  if (sameSource) return snapshot.source;
  retirePaneTabDropPresentation('new-gesture');
  paintedStrip = null;
  stripGeometry.clear();
  dragSession += 1;
  publish({
    active: true,
    revision: snapshot.revision + 1,
    source: { ...source, entries, gestureId:source.gestureId || `pane-drag:${dragSession}` },
    target: null,
  });
  uiDragAdmission(source.workflowDrag);
  return snapshot.source;
}

export function setPaneTabDragTarget(target: PaneTabDropTarget | null) {
  if (!snapshot.active || !snapshot.source) return;
  target=constrainPaneTabGroupTarget(snapshot.source,target);
  const previous = snapshot.target;
  if (
    previous?.zone === target?.zone
    && previous?.paneKey === target?.paneKey
    && previous?.spaceId === target?.spaceId
    && previous?.at === target?.at
    && previous?.rowStartId === target?.rowStartId
    && previous?.stripWidth === target?.stripWidth
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
  uiDragDiagnostic('target',{gestureId:snapshot.source?.gestureId,revision:snapshot.revision,
    workflowId:target?.spaceId,paneKey:target?.paneKey,zone:target?.zone,at:target?.at,
    presentation:'published-target-not-layout-receipt'});
}

export function claimPaneTabDragDrop(rootTabId?: string) {
  if (!snapshot.active || !snapshot.source || !snapshot.target) return null;
  if (rootTabId && snapshot.source.rootTabId !== rootTabId) return null;
  if(!paneTabGroupDragIsCurrent(snapshot.source))return null;
  if (claimedDropSession === dragSession) return null;
  claimedDropSession = dragSession;
  return { source: snapshot.source, target: snapshot.target, session: dragSession };
}

export function endPaneTabDrag(rootTabId?: string, gestureId?: string) {
  if (!snapshot.active) return;
  if (rootTabId && snapshot.source?.rootTabId !== rootTabId) return;
  if (gestureId && snapshot.source?.gestureId !== gestureId) return;
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

// Released presentation has a separate lifetime from physical input. In
// particular it never makes snapshot.active true or supplies a drop target.
type StripSurface = {workflowId:string;windowId?:string|null;centerKey?:string|null;
  paneKey:PaneStripKey;baseEntries:PaneTabDragEntry[];entries:PaneTabDragEntry[];
  baseRowPlacement?:any;rowPlacement?:any;stripWidth?:number};
const stripSurfaces = new Map<object,StripSurface>();
const presentationListeners = new Set<()=>void>();
let paintedStrip:any = null;
let presentationOwner:any = null;
let presentationSnapshot:any = null;
const publishPresentation = () => {
  presentationSnapshot=presentationOwner ? {token:presentationOwner.token,
    mutationId:presentationOwner.plan.request.mutationId,phase:presentationOwner.plan.phase,
    strips:presentationOwner.plan.strips}:null;
  presentationListeners.forEach(listener=>listener());
};
function retirePaneTabDropPresentation(reason:string,owner=presentationOwner) {
  if(!owner || presentationOwner!==owner)return;
  presentationOwner=null;
  owner.unsubscribe?.();
  if(paintedStrip?.gestureId===owner.plan.request.gestureId)paintedStrip=null;
  uiDragDiagnostic('presentation-end',{gestureId:owner.plan.request.gestureId,
    mutationId:owner.plan.request.mutationId,reason});
  publishPresentation();
}
function retirePaintedCanonical(owner:any) {
  if(presentationOwner!==owner || owner.plan.phase!=='applied')return;
  const target=stripSurfaces.get(owner.plan.targetOwner);
  if(!target || panePresentationKey(target.workflowId,target.windowId,target.centerKey)!==owner.plan.targetKey) {
    retirePaneTabDropPresentation('target-unmounted',owner);return;
  }
  const targetStrip=owner.plan.strips.find((strip:any)=>strip.key===owner.plan.targetKey);
  if(targetStrip?.rowPlacement && target.stripWidth!==undefined
    && Math.abs(targetStrip.rowPlacement.width-target.stripWidth)>0.5) {
    retirePaneTabDropPresentation('target-width-changed',owner);return;
  }
  for(const [surfaceId,key] of owner.surfaces) {
    const surface=stripSurfaces.get(surfaceId);
    if(!surface)continue; // A removed source host cannot own another surface.
    const strip=owner.plan.strips.find((strip:any)=>strip.key===key);
    if(panePresentationKey(surface.workflowId,surface.windowId,surface.centerKey)!==key
      || !samePaneEntries(surface.baseEntries,strip.entries)
      || !samePaneStripRowPlacement(surface.baseRowPlacement,strip.rowPlacement))return;
  }
  retirePaneTabDropPresentation('canonical-react-layout',owner);
}

/** React layout receipt, using existing rendered IDs; no rectangle/paint probe. */
export function observePaneTabStrip(owner:object,surface:StripSurface) {
  const previous=stripSurfaces.get(owner);
  stripSurfaces.set(owner,surface);
  const target=snapshot.target,source=snapshot.source;
  if(snapshot.active && source) {
    // Pane preview is immediate (no FLIP). A newly committed order supplies
    // the next pointer move's boundaries. Never expire geometry merely for a
    // requested target or an unrelated render: that would read the old DOM or
    // create per-move layout work instead of following the shown order.
    if(!previous || !samePaneEntries(previous.entries,surface.entries)
      || !samePaneStripRowPlacement(previous.rowPlacement,surface.rowPlacement)
      || previous.stripWidth!==surface.stripWidth) {
      stripGeometry.clear(`${surface.workflowId}:${surface.paneKey}`);
      uiDragDiagnostic('geometry-invalidated',{gestureId:source.gestureId,
        revision:snapshot.revision,workflowId:surface.workflowId,paneKey:surface.paneKey,
        reason:'committed-strip-layout',presentation:'react-layout-not-compositor'});
    }
  }
  if(snapshot.active && source && target?.paneKey===surface.paneKey && target.spaceId===surface.workflowId) {
    paintedStrip={...surface,owner,source,gestureId:source.gestureId,session:dragSession,
      target:{...target},revision:snapshot.revision};
  }
  if(presentationOwner)retirePaintedCanonical(presentationOwner);
}
export function forgetPaneTabStrip(owner:object) {
  stripSurfaces.delete(owner);
  if(paintedStrip?.owner===owner)paintedStrip=null;
  if(presentationOwner?.plan.targetOwner===owner)retirePaneTabDropPresentation('target-unmounted');
  else if(presentationOwner)retirePaintedCanonical(presentationOwner);
}

/** Called once by the existing async writer, after its admission check and
 * before its first await. Returning a lease never confirms that writer. */
export function beginPaneTabDropPresentation(request:any,store:{getState:()=>any;subscribe:(listener:(state:any)=>void)=>()=>void},isCurrent:()=>boolean) {
  if(presentationOwner)retirePaneTabDropPresentation('new-writer');
  const receipt=paintedStrip;
  if(!receipt || receipt.session!==dragSession || receipt.gestureId!==request.gestureId)return null;
  let plan:any;
  try {plan=createPaneDropPresentation(request,receipt,store.getState());} catch {return null;}
  if(!plan)return null;
  const owner:any={token:{},plan,applying:false,unsubscribe:null,surfaces:new Map()};
  for(const [id,surface] of stripSurfaces) {
    const key=panePresentationKey(surface.workflowId,surface.windowId,surface.centerKey);
    if(plan.strips.some((strip:any)=>strip.key===key))owner.surfaces.set(id,key);
  }
  presentationOwner=owner;
  const check=(state:any)=>{
    if(presentationOwner!==owner)return;
    try {
      if(!isCurrent() || !paneDropPresentationValid(plan,state,{applying:owner.applying}))
        retirePaneTabDropPresentation('current-scope-changed',owner);
    } catch {retirePaneTabDropPresentation('scope-unavailable',owner);}
  };
  owner.unsubscribe=store.subscribe(check);
  publishPresentation();
  uiDragDiagnostic('presentation-held',{gestureId:request.gestureId,mutationId:request.mutationId,
    presentation:'released-strip-layout-not-durable-ack'});
  return {
    applying:()=>{if(presentationOwner===owner)owner.applying=true;},
    settle:(accepted:boolean)=>{
      if(presentationOwner!==owner)return;
      if(!accepted){retirePaneTabDropPresentation('write-not-confirmed',owner);return;}
      const state=store.getState();check(state);
      if(presentationOwner!==owner)return;
      if(!paneDropPresentationCaughtUp(plan,state)) {
        retirePaneTabDropPresentation('newer-canonical-placement',owner);return;
      }
      owner.applying=false;
      plan.navigationRevision=state.navigationRevision;
      plan.phase='applied';
      publishPresentation();
      retirePaintedCanonical(owner);
    },
  };
}
export const getPaneTabDropPresentationSnapshot = () => presentationSnapshot;
export function usePaneTabDropPresentation() {
  return useSyncExternalStore(listener=>{presentationListeners.add(listener);return()=>{presentationListeners.delete(listener);};},
    getPaneTabDropPresentationSnapshot,getPaneTabDropPresentationSnapshot);
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
  if (zone.closest('[data-pane-focus-isolated="1"]')) return false;
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
  if (zone.closest('[data-pane-focus-isolated="1"]')) return null;
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
  // The native preview is centered under the pointer, so the pointer itself is
  // the dragged chip's semantic center. No initial grab offset participates in
  // placement; left-edge and right-edge grabs therefore have identical slots.
  const dragCenterX = Number(clientX) || 0;
  const slot = stripGeometry.resolve({
    ownerKey: `${spaceId || 'unknown'}:${paneKey}`,
    excludedIds: excludedTabIds,
    clientX: dragCenterX,
    clientY,
    viewportLeft: stripRect.left,
    viewportTop: stripRect.top,
    scrollLeft: strip.scrollLeft,
    scrollTop: strip.scrollTop,
    wrap: true,
    includeRowPlacement: true,
    // Reuse this geometry between pointer moves. A committed, non-animated
    // strip order expires it in observePaneTabStrip; requested state does not.
    readChips: () => readPaneTabStripChips(strip),
  });
  return {
    zone: 'strip',
    paneKey,
    paneIndex,
    spaceId,
    at: slot.at,
    rowStartId: slot.rowStartId,
    stripWidth: stripRect.width,
    debug: {
      dragCenterX,
      dragCenterY: clientY,
      wrap: true,
      viewportLeft: stripRect.left,
      viewportWidth: stripRect.width,
      scrollLeft: strip.scrollLeft,
      scrollWidth: strip.scrollWidth,
      autoScrollDelta: 0,
    },
  };
}
