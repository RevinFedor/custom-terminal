import {uiDragDiagnostic,uiDragAdmission} from './uiPerformanceDiagnostics.mjs';
import { useSyncExternalStore } from 'react';
import {createPaneDropPresentation,paneDropPresentationValid,paneDropPresentationCaughtUp,
  samePaneEntries,panePresentationKey} from './paneTabDropPresentation.mjs';
import {
  createHorizontalDragGeometryCache,
} from './horizontalDragGeometry.mjs';
import {readPaneTabStripChips} from './paneTabStripGeometry.mjs';
import {paneStripVisibleInsertion,paneStripOpenGroupGeometry} from './paneStripCollapseModel.mjs';
import {clampPaneStripGroupInsertion} from './paneStripSelectionModel.mjs';
import {normalizePaneStripRowPlacement,samePaneStripRowPlacement} from '../../shared/pane-strip-row-placement.cjs';
import {paneStripColorGroupsBasis} from '../../shared/pane-strip-color-groups.cjs';

export const PANE_TAB_DND_TYPE = 'PANE_TAB_CHIP_V2';

export type PaneTabDragEntry = { projectId: string; tabId: string };
export type PaneStripKey = 'center' | `pane:${number}`;

export type PaneTabDragSource = {
  /** Renderer-only captured color-group scope, not a durable writer grant. */
  groupDrag?: { boundary: any; internalScope?: boolean; isCurrent: (releasedRequest?: any) => boolean };
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

export function paneTabGroupDragIsCurrent(source: PaneTabDragSource,releasedRequest?:any) {
  const lease=source.groupDrag;
  if(!lease)return true;
  try {return (lease.boundary?.kind==='group' || lease.boundary?.kind==='free') && lease.isCurrent(releasedRequest)===true;} catch {return false;}
}

/** Only a collapsed member-origin peek owns an internal POST-removal range.
 * Ordinary roots/subsets may leave; the release compiler owns their exact
 * order+membership change through the existing Main transaction. */
export function constrainPaneTabGroupTarget(source:PaneTabDragSource,target:PaneTabDropTarget|null) {
  if(!target || !source.groupDrag || source.groupDrag.boundary?.kind==='free')return target;
  if(source.groupDrag.boundary?.kind!=='group')return null;
  if(!source.groupDrag.internalScope)return target;
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
  // A released Store pair is the next pickup's logical baseline even while
  // retained parent props lag behind it. Keep only its presentation handoff;
  // the new gesture owns target/reveal and will replace it at its release.
  if(presentationOwner?.plan.phase==='pending')retirePaneTabDropPresentation('new-gesture');
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
  const session=dragSession;
  // UI reveal only: physical end keeps this intent, a new gesture revokes it.
  // It never authorizes or cancels the already admitted durable command.
  return { source: snapshot.source, target: snapshot.target, session,
    isRevealCurrent:()=>dragSession===session };
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
  canonicalEntries?:PaneTabDragEntry[];
  baseGroupState?:any;groupState?:any;
  baseRowPlacement?:any;rowPlacement?:any;stripWidth?:number;layoutKey?:string};
const stripSurfaces = new Map<object,StripSurface>();
const presentationListeners = new Set<()=>void>();
const groupBasisMatches=(field:any,basis:string)=>{
  try{return paneStripColorGroupsBasis(field)===basis;}catch{return false;}
};
const samePresentedGroupState=(left:any,right:any)=>{
  if(left===right)return true;
  try{return paneStripColorGroupsBasis(left)===paneStripColorGroupsBasis(right);}catch{return false;}
};
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
  if(presentationOwner!==owner || !['released','applied'].includes(owner.plan.phase))return;
  const target=stripSurfaces.get(owner.plan.targetOwner);
  if(!target || panePresentationKey(target.workflowId,target.windowId,target.centerKey)!==owner.plan.targetKey) {
    retirePaneTabDropPresentation('target-unmounted',owner);return;
  }
  for(const [surfaceId,key] of owner.surfaces) {
    const surface=stripSurfaces.get(surfaceId);
    if(!surface)continue; // A removed source host cannot own another surface.
    const strip=owner.plan.strips.find((strip:any)=>strip.key===key);
    const measuredWidth=typeof surface.stripWidth==='number' && Number.isFinite(surface.stripWidth) && surface.stripWidth>0;
    if(strip.rowPlacement && !measuredWidth)return;
    const effectiveRows=normalizePaneStripRowPlacement(strip.rowPlacement,
      {order:strip.entries.map((entry:PaneTabDragEntry)=>entry.tabId),width:measuredWidth ? surface.stripWidth:undefined});
    if(panePresentationKey(surface.workflowId,surface.windowId,surface.centerKey)!==key
      || !samePaneEntries(surface.canonicalEntries||surface.baseEntries,strip.entries)
      || owner.plan.groupAfterBasis&&!groupBasisMatches(surface.baseGroupState,owner.plan.groupAfterBasis)
      || !samePaneStripRowPlacement(surface.baseRowPlacement,effectiveRows))return;
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
      // Membership can change a closed block's visible coverage without any
      // order change. Reuse the existing measured receipt/cache boundary.
      || !samePresentedGroupState(previous.groupState,surface.groupState)
      || previous.stripWidth!==surface.stripWidth || previous.layoutKey!==surface.layoutKey) {
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
      else if(plan.phase==='pending'&&paneDropPresentationCaughtUp(plan,state)) {
        // Local release has reached Store. This says nothing about durability;
        // Store's existing writer owns the immutable command until its receipt.
        plan.phase='released';publishPresentation();retirePaintedCanonical(owner);
      }
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

// Paired with stripGeometry's own read boundary. Weak keys do not keep retired
// strips alive; this contains IDs only, no second rectangle cache/observer.
const collapsedOrdinalMaps=new WeakMap<HTMLElement,{layoutKey:string;fullIds:string[];blocks:any[]}>();
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
    readChips: () => {
      const chips=readPaneTabStripChips(strip);
      if(strip.dataset.stripCanonicalIds) {
        try {
          const fullIds=JSON.parse(strip.dataset.stripCanonicalIds);
          const nodes=new Map(Array.from(strip.querySelectorAll<HTMLElement>('[data-strip-item]'),node=>[node.dataset.stripTabId,node]));
          // Orientation belongs to this SAME measured receipt. Validate once
          // here, not from live attributes/rectangles on every pointer sample.
          // This temporary map adds no retained geometry owner or observer.
          const openGroups=new Map<string,{node:HTMLElement;ids:string[];seen:string[];direction:string;last:any}>();
          const blocks=chips.map(chip=>{
            const group=nodes.get(chip.id)?.closest<HTMLElement>('[data-pane-strip-collapsed-group]');
            if(group?.dataset.groupOpen==='1') {
              const id=group.dataset.paneStripCollapsedGroup;
              if(!id)throw Error('unknown open group scope');
              let scope=openGroups.get(id);
              if(!scope) {
                const ids=JSON.parse(group.dataset.groupMemberIds||'null'),direction=group.dataset.groupDirection===undefined?'right':group.dataset.groupDirection;
                if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!id)
                  ||new Set(ids).size!==ids.length||direction!=='right'&&direction!=='left')throw Error('unknown open group orientation');
                scope={node:group,ids,seen:[],direction,last:null};openGroups.set(id,scope);
              }
              if(scope.node!==group||![chip.left,chip.right,chip.top,chip.bottom].every(Number.isFinite))
                throw Error('unknown open group geometry');
              const previous=scope.last;
              if(previous&&(chip.top>=previous.bottom-.5||previous.top>=chip.bottom-.5
                ||(scope.direction==='left'?chip.right>previous.left+.5:chip.left<previous.right-.5)))
                throw Error('unknown open group physical order');
              scope.seen.push(chip.id);scope.last=chip;
              return {visibleId:chip.id,ids:[chip.id],openGroupId:id,openGroupDirection:scope.direction};
            }
            return {visibleId:chip.id,ids:group&&group.dataset.groupOpen!=='1'?JSON.parse(group.dataset.groupMemberIds||'null'):[chip.id],
              openGroupId:undefined};
          });
          if(!Array.isArray(fullIds)||fullIds.some(id=>typeof id!=='string'||!id)||new Set(fullIds).size!==fullIds.length
            ||blocks.some(block=>!Array.isArray(block.ids)))throw Error('unknown collapsed coverage');
          for(const scope of openGroups.values())if(JSON.stringify(scope.ids)!==JSON.stringify(scope.seen))
            throw Error('incomplete open group coverage');
          collapsedOrdinalMaps.set(strip,{layoutKey:strip.dataset.stripLayoutKey||'',fullIds,blocks});
        }catch{collapsedOrdinalMaps.delete(strip);}
      }else collapsedOrdinalMaps.delete(strip);
      return chips;
    },
    selectChips:strip.dataset.stripCanonicalIds?(chips:any[],point:{x:number;y:number})=>{
      const map=collapsedOrdinalMaps.get(strip);
      if(!map||map.layoutKey!==(strip.dataset.stripLayoutKey||''))return null;
      const pointedGroup=pointed?.closest<HTMLElement>('[data-pane-strip-collapsed-group]');
      return paneStripOpenGroupGeometry({chips,blocks:map.blocks,clientX:point.x,clientY:point.y,
        preferredGroupId:pointedGroup?.dataset.groupOpen==='1'?pointedGroup.dataset.paneStripCollapsedGroup:undefined});
    }:undefined,
  });
  if(!slot)return null;
  let insertion=slot;
  if(strip.dataset.stripCanonicalIds) {
    const map=collapsedOrdinalMaps.get(strip);
    if(!map||map.layoutKey!==(strip.dataset.stripLayoutKey||''))return null;
    const full=paneStripVisibleInsertion({...map,excludedIds:excludedTabIds,at:slot.at,rowStartId:slot.rowStartId,scopeId:slot.scopeId});
    if(!full)return null;insertion={...slot,...full};
  }
  return {
    zone: 'strip',
    paneKey,
    paneIndex,
    spaceId,
    at: insertion.at,
    rowStartId: insertion.rowStartId,
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
