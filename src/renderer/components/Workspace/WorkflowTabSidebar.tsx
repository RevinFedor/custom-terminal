import {uiDragDiagnostic} from '../../utils/uiPerformanceDiagnostics.mjs';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {retainWorkflowOutline} from '../../utils/workflowOutlineRetention.mjs';
import {workflowGroupDisplayName} from '../../../shared/workflow-groups-projection.cjs';
import {createPortal} from 'react-dom';
import { Folder, ChevronDown, Plus, ArrowLeft, ArrowRight, CircleX, Pause } from 'lucide-react';
import { useOutlineDnd, type OutlineDndNode, type OutlineDndCommitPayload, type OutlineDndFeedback } from '@noted/structured-dnd/react';
import {useCommandHierarchyHint} from '../../hooks/useCommandHierarchyHint';
import TabCard from './TabCard';
import { openTabContextMenuAt, TAB_RENAME_REQUEST_EVENT } from './TabBar';
import type { LinkedFile } from './TabLinkedFiles';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { openFileTabBeside } from '../../utils/openFileTabBeside';
import { startTabSidebarResize } from '../../utils/tabSidebarResize';
import { resolvePaneTabDropTarget,paneTabDropTargetContainsPoint,
  setPaneTabDragTarget, type PaneTabDropTarget, type PaneTabDragEntry } from '../../utils/paneTabDragBridge';
import { getPaneTabPointerSnapshot, subscribePaneTabPointer, subscribePaneTabPointerDrop, type PaneTabPointerSnapshot } from '../../utils/paneTabPointerBridge';
import { selectWorkflowReserve, workflowReserveOutline, reserveNodeEntries, reservePaneEntries, workflowGroupKey,projectReservePaneSource } from '../../utils/workflowReserve.mjs';
import { getTabChromeColorConfig, adjustRgbaAlpha } from './tabChrome';
import { tabOutlineHorizontalPolicy, tabOutlineVerticalSlotPolicy } from './tabOutlineModel.mjs';
import {captureWorkflowDrag,workflowDragSourceValid} from '../../utils/workflowDragModel.mjs';
import {beginReserveDragTransport,reserveReleaseOwner} from '../../utils/reserveDragTransport';
import {useOutlineDragCursor} from '../../hooks/useOutlineDragCursor';
import SidebarTabDragCursorChip from './SidebarTabDragCursorChip';
import type { SharedTabActivityMaps } from './TabSignals';
import { TAB_CARD_LINE_HEIGHT } from '../../utils/tabCardVisual.mjs';
import {createWorkflowGroupExpansionQueue} from '../../utils/workflowGroupExpansion.mjs';
import {reportWorkflowActionError} from '../../utils/workflowActionError';
import {useInlineRenameInputRef} from '../../hooks/useInlineRenameInput';
import {paneTabs} from '../../utils/splitPanesModel.mjs';
import {workflowCreationVisibility} from '../../utils/workflowCreationVisibility.mjs';
import NewTabMenuRows,{type NewTabAction} from './NewTabMenuRows';
import {type WindowCell} from './MoveToWindowMenu';
import {clampMenuToViewport} from '../../utils/menuViewportClamp.mjs';
import {CONTEXT_MENU_PANEL_STYLE,CONTEXT_MENU_ROW_STYLE,CONTEXT_MENU_TOP_DIVIDER_STYLE} from '../UI/contextMenuMetrics.mjs';
import {useWorkspaceOverlayTarget} from '../../hooks/useWorkspaceOverlayTarget';
import './WorkflowTabSidebar.css';

export type WorkflowReserveState = {
  openProjects: Map<string, any>;
  tabWorkflowMembership: Record<string, { workflowId: string; revision: number }>;
  spaces: Array<{ id: string; name: string; kind?: 'user' | 'inbox'; layout?: any }>;
  activeSpaceId: string;
  splitPanes?: any[];
  centerStrips?: Record<string, any[]>;
  activeSpaceTab?: { projectId: string; tabId: string } | null;
  windowDisplayLayouts?: Record<string, any>;
  globalGroups?: any;
  tabCatalog?: Record<string,any>;
};
type Node = OutlineDndNode & { projectId: string; tabId?: string; groupId?: string; label?: string; children: Node[];
  externalPaneSource?: {entries:PaneTabDragEntry[];familyIds:string[]};
  contextParent?: { projectId: string; tabId: string; name: string } | null };
export type ReserveDropRequest = {
  workflowId: string;
  entries: PaneTabDragEntry[];
  beforeTabId?: string;
  group?: { projectId: string; groupId: string };
  expectedMembership: WorkflowReserveState['tabWorkflowMembership'];
};
export interface WorkflowTabSidebarProps {
  /** Parent supplies the canonical catalog/membership and effective layout. */
  state: WorkflowReserveState;
  orderedTabIds?: string[];
  selectedTabIds: string[];
  onSelectionChange: (ids: string[]) => void;
  activeGroupId?: string|null;
  onGroupFocus?: (id:string) => void;
  editingGroupId?: string|null;
  onGroupRename?: (id:string,name:string) => Promise<boolean>;
  onGroupRenameEnd?: () => void;
  onGroupClose?: (id:string) => Promise<boolean>;
  onOpenTab: (projectId: string, tabId: string) => Promise<boolean> | boolean;
  onOpenFile: (ownerProjectId: string, file: LinkedFile) => void;
  onCreateTab: (request: { workflowId: string; sourceTabId?: string; cwd?: string; placement: 'reserve'; action?:NewTabAction; windowId?:string }) => Promise<unknown>;
  onCreateGroup: (workflowId: string) => void | Promise<void>;
  onGroupContextMenu: (projectId: string, groupId: string, x: number, y: number) => void;
  /** Projected subset only! Parent merges into complete order/groups/links. */
  onCommitOutline: (request: { workflowId: string; payload: OutlineDndCommitPayload<Node>;
    expectedMembership: WorkflowReserveState['tabWorkflowMembership'] }) => Promise<boolean> | boolean;
  onPlaceTabs: (entries: PaneTabDragEntry[], target: PaneTabDropTarget,
    admission: any,options?:{isCurrent?:()=>boolean}) => Promise<boolean> | boolean;
  sourceTabId?: string;
  fallbackCwd?: string;
  location?: React.ReactNode;
  sharedActivity?: SharedTabActivityMaps;
  scrollTop?: number;
  onScrollOffsetChange?: (workflowId: string, top: number) => void;
}

function ReserveCard({ node, rowProps, selected, activity, onClick, onMiddleClick, onOpenFile, feedback, navigationPaused }: {
  node: Node; rowProps: any; selected: boolean; activity?: SharedTabActivityMaps;
  onClick: (event: React.MouseEvent) => void; onOpenFile: (file: LinkedFile) => void;
  onMiddleClick:()=>void;
  feedback?: OutlineDndFeedback | null; navigationPaused?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null), ref = useRef<HTMLElement | null>(null);
  const liveName=useWorkspaceStore(state=>state.openProjects.get(node.projectId)?.tabs.get(node.tabId!)?.name ?? node.label ?? '');
  const pendingEdit=useWorkspaceStore(state=>state.pendingEditTabId===node.tabId);
  const renameInput=useInlineRenameInputRef(draft!==null);
  useEffect(()=>{if(pendingEdit){setDraft(liveName);useWorkspaceStore.setState({pendingEditTabId:null});}},[pendingEdit,liveName]);
  const host = `workflow-reserve:${node.projectId}:${node.tabId}`;
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.host !== host || detail?.tabId !== node.tabId) return;
      setDraft(useWorkspaceStore.getState().openProjects.get(node.projectId)?.tabs.get(node.tabId!)?.name || '');
    };
    window.addEventListener(TAB_RENAME_REQUEST_EVENT, listener);
    return () => window.removeEventListener(TAB_RENAME_REQUEST_EVENT, listener);
  }, [host, node.projectId, node.tabId]);
  const menu = (x: number, y: number) => openTabContextMenuAt(node.projectId, node.tabId!, x, y,
    { renameHost: host, singleTarget: true,
      isCurrent: () => !!ref.current?.isConnected && !!useWorkspaceStore.getState().openProjects.get(node.projectId)?.tabs.has(node.tabId!) });
  const commit = () => {
    const name = draft?.trim(); setDraft(null);
    if (name) useWorkspaceStore.getState().renameTab(node.projectId, node.tabId!, name);
  };
  return <TabCard ref={ref}
    projectId={node.projectId} tabId={node.tabId!} as="span" fullWidth
    sharedActivity={activity} selected={selected} interactiveStatus
    tabIndex={0} role="button" aria-label={liveName} aria-pressed={selected}
    data-workflow-reserve-tab={node.tabId} data-execution-namespace={node.projectId}
    onClick={event => { if (draft === null) onClick(event); }}
    onMouseDown={event=>{if(event.button===1)event.preventDefault();}}
    onAuxClick={event=>{if(event.button===1){event.preventDefault();event.stopPropagation();onMiddleClick();}}}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); menu(event.clientX, event.clientY); }}
    onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.currentTarget.click(); }
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); menu(rect.left + 12, rect.bottom);
      }
      if (event.key === 'F2') { event.preventDefault(); setDraft(liveName); }
    }}>
    {draft === null ? <span className="workflow-reserve-label" data-has-feedback={feedback || navigationPaused ? 'true' : undefined}>
      <span data-tab-card-label>{liveName}</span>
      {(feedback || navigationPaused) && <span className="workflow-reserve-feedback-anchor" aria-hidden>
        <span className="workflow-reserve-feedback" data-outline-tab-feedback={navigationPaused ? 'paused' : feedback?.direction}
          title={feedback?.reason==='multi-selection' ? 'Вложенность меняется по одной вкладке' : undefined}
          data-outline-tab-feedback-blocked={feedback?.blocked ? 'true' : undefined}
          style={{opacity:navigationPaused ? .82 : Math.max(.18,feedback?.progress || 0)}}>
          {navigationPaused ? <Pause size={10} fill="currentColor" /> : feedback?.blocked ? <CircleX size={11} />
            : feedback?.direction === 'left' ? <ArrowLeft size={11} /> : <ArrowRight size={11} />}
          {feedback && !feedback.blocked && !navigationPaused && <span className="workflow-reserve-feedback-progress"
            style={{width:`${Math.max(0,Math.min(1,feedback.progress))*100}%`}} />}
        </span>
      </span>}
    </span> : <input data-no-drag ref={renameInput.ref}
      style={{padding:'0 4px',border:0,boxShadow:'inset 0 0 0 1px #8b5cf6'}}
      aria-label="Название вкладки" value={draft} onClick={event => event.stopPropagation()}
      onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => {
        event.stopPropagation(); if (event.key === 'Enter') commit(); if (event.key === 'Escape') setDraft(null);
      }} />}
  </TabCard>;
}

function ReserveGroupHeader({node,group,displayName,expanded,editing,focused,dragging,dwell,onExpand,onFocus,onRename,onRenameEnd,onClose,onContextMenu,onError}: {
  node:Node;group:any;expanded:boolean;editing:boolean;focused:boolean;dragging:boolean;
  displayName:string;
  dwell?:{progress:number;blocked?:boolean;pending?:boolean}|null;
  onExpand:()=>void;onFocus:()=>void;onRename:(name:string)=>Promise<boolean>;onRenameEnd:()=>void;
  onClose:()=>void;onContextMenu:(event:React.MouseEvent)=>void;
  onError:(reason:unknown)=>void;
}) {
  const [draft,setDraft]=useState(displayName),[hovered,setHovered]=useState(false);
  const input=useInlineRenameInputRef(editing),saving=useRef(false);
  const status=useUIStore(state=>state.sessionStatuses.find(status=>status.id===group?.sessionStatus));
  const marker=useUIStore(state=>state.statusMarker);
  useEffect(()=>{if(editing)setDraft(displayName);},[editing]);
  const rename=async()=>{
    if(saving.current)return;
    const name=draft.trim();if(!name || name===displayName){onRenameEnd();return;}
    saving.current=true;
    try {if(await onRename(name))onRenameEnd();else onError('Название не сохранено');}
    catch(error){onError(error);}
    finally{saving.current=false;}
  };
  const color=group?.color && group.color!=='default' ? getTabChromeColorConfig(group):null;
  const highlighted=(hovered&&!dragging)||focused;
  return <div className="workflow-reserve-group" data-reserve-group-id={node.groupId} data-group-focused={focused?'true':undefined}
    data-execution-namespace={node.projectId} style={color?{background:adjustRgbaAlpha(color.bgColor,highlighted ? .1 : expanded ? -.06 : .04),borderColor:color.borderColor}:undefined}
    role="button" tabIndex={0} aria-expanded={expanded} aria-label={`Группа ${displayName}`}
    onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)} onClick={onFocus}
    onMouseDown={event=>{if(event.button===1)event.preventDefault();}}
    onAuxClick={event=>{if(event.button===1){event.preventDefault();event.stopPropagation();onClose();}}}
    onContextMenu={onContextMenu} onKeyDown={event=>{
      if(event.target!==event.currentTarget)return;
      if(['Enter',' '].includes(event.key)){event.preventDefault();onFocus();onExpand();}
    }}>
    <button className="workflow-reserve-folder" aria-label={`${expanded?'Свернуть':'Раскрыть'} группу ${displayName}`}
      onClick={event=>{event.stopPropagation();onFocus();onExpand();}}>
      <Folder size={14}/><ChevronDown size={9} className="workflow-reserve-folder-chevron" style={{transform:expanded?undefined:'rotate(-90deg)'}}/>
      {dwell && <svg data-dnd-navigation-loader data-dnd-navigation-phase={dwell.blocked?'blocked':dwell.pending?'loading':'waiting'}
        aria-hidden width="20" height="20" viewBox="0 0 20 20" style={{position:'absolute',inset:0,pointerEvents:'none'}}>
        <circle cx="10" cy="10" r="9" fill="none" stroke="#a78bfa33" strokeWidth="2"/>
        <circle cx="10" cy="10" r="9" fill="none" stroke={dwell.blocked?'#a1a1aa':'#c4b5fd'} strokeWidth="2"
          strokeDasharray={Math.PI*18} strokeDashoffset={Math.PI*18*(1-Math.max(0,Math.min(1,dwell.progress)))}
          transform="rotate(-90 10 10)"/>
      </svg>}
    </button>
    {status && <span title={status.label} style={{flexShrink:0,width:marker.sizePx,height:marker.sizePx,background:status.color,borderRadius:marker.shape==='square'?2:'50%'}}/>}
    {editing?<input ref={input.ref} data-no-drag aria-label="Название группы" value={draft}
      style={{padding:'0 4px',border:0,boxShadow:'inset 0 0 0 1px #8b5cf6'}}
      onChange={event=>setDraft(event.target.value)} onBlur={()=>void rename()} onClick={event=>event.stopPropagation()}
      onKeyDown={event=>{event.stopPropagation();if(event.key==='Enter')void rename();if(event.key==='Escape'){event.preventDefault();onRenameEnd();}}}/>
      :<span className="workflow-reserve-group-name">{displayName}</span>}
    <small>{reserveNodeEntries(node).length}</small>
  </div>;
}

/** One scroll owner and no terminal/History children. Lifetime stays in Root. */
export default function WorkflowTabSidebar(props: WorkflowTabSidebarProps) {
  const { state } = props, workflowId = state.activeSpaceId;
  const width = useUIStore(ui => ui.tabSidebarWidth);
  const geometry = useUIStore(ui => ui.tabGeometry);
  const fontSize = useUIStore(ui => ui.tabsFontSize);
  const sidebarGap=useUIStore(ui=>ui.tabSidebarGap ?? ui.tabGeometry.gap);
  const overlayTarget=useWorkspaceOverlayTarget(),emptyMenuRef=useRef<HTMLDivElement>(null);
  const [emptyMenu,setEmptyMenu]=useState<{x:number;y:number}|null>(null);
  const model = useMemo(() => selectWorkflowReserve(state, workflowId, props.orderedTabIds),
    [state, workflowId, props.orderedTabIds]);
  const baseCandidate = useMemo(() => workflowReserveOutline(model) as Node[], [model]);
  const baseOutline = useRef<any>(null),projectedOutline = useRef<any>(null);
  baseOutline.current=retainWorkflowOutline(baseOutline.current,workflowId,baseCandidate);
  const outline=baseOutline.current.outline as Node[];
  const sidebar = useRef<HTMLDivElement>(null), latest = useRef(props), anchor = useRef('');
  latest.current = props;
  const stopResize = useRef<(() => void) | null>(null);
  const [expandGroup] = useState(() => createWorkflowGroupExpansionQueue({
    read:()=>useWorkspaceStore.getState().globalGroups,
    refresh:()=>useWorkspaceStore.getState().refreshWorkflowGroups(),
    mutate:(request:any)=>useWorkspaceStore.getState().mutateWorkflowGroup('collapse',request),
  }));
  const [creating, setCreating] = useState(false);
  const reportError = (reason:unknown, action='Не удалось выполнить действие', operation:Record<string,unknown>={}) => {
    const name=state.spaces.find(space=>space.id===workflowId)?.name || workflowId;
    reportWorkflowActionError(reason,{workflowId,workflowName:name,action,...operation});
  };
  const [externalPointer,setExternalPointer] = useState<PaneTabPointerSnapshot|null>(null);
  const externalProjection = useMemo(()=>projectReservePaneSource(model,outline,externalPointer?.source),
    [model,outline,externalPointer?.source]);
  const projectionKey=JSON.stringify([workflowId,externalPointer?.source?.gestureId || null,externalProjection?.sourceId || null]);
  projectedOutline.current=retainWorkflowOutline(projectedOutline.current,projectionKey,externalProjection?.outline || outline);
  const controlledOutline = projectedOutline.current.outline as Node[];
  const externalDrag = externalPointer && externalProjection ? {active:true,
    releaseOwner:'bridge',
    ownerKey:reserveReleaseOwner(workflowId,externalPointer.source!),
    sourceId:externalProjection.sourceId,pointerId:externalPointer.pointerId,pointerType:'mouse',
    sourceRootIds:externalProjection.sourceRootIds,sourceContext:externalPointer.source!.workflowDrag,
    gestureId:externalPointer.source!.gestureId,
    grabOffsetY:externalPointer.source!.owner==='sidebar' ? externalPointer.source!.sourceGrabOffsetY : undefined,
    readCurrentInput:()=>{
      const pointer=getPaneTabPointerSnapshot(),source=externalPointer.source;
      if(!pointer.active || pointer.source!==source || pointer.pointerId!==externalPointer.pointerId
        || latest.current.state.activeSpaceId!==workflowId)return null;
      return Object.freeze({active:true,ownerKey:reserveReleaseOwner(workflowId,source!),gestureId:source!.gestureId!,
        pointerId:pointer.pointerId,clientX:pointer.clientX,clientY:pointer.clientY,metaKey:pointer.metaKey});
    },
    rollbackOutline:outline,
    clientX:externalPointer.clientX,clientY:externalPointer.clientY,metaKey:externalPointer.metaKey} : null;
  const membershipOf=(admission:any)=>Object.fromEntries(Object.entries(admission?.guards || {}).map(([id,guard]:any)=>[id,
    {workflowId:guard.workflowId,revision:guard.membershipRevision}]));
  const sourceFollow = externalPointer?.source?.owner==='pane' ? null : 'y';
  const dnd = useOutlineDnd<Node>({ outline:controlledOutline,
    sourceFollow,
    hierarchyModifier:'meta',
    pointerPublication:externalPointer?.source?.owner==='pane' && projectedOutline.current.immutable ? 'semantic':'frame',
    ...({externalDrag} as any),
    scopeKey:workflowId,
    getDragSource: input=>{
      const admission=captureWorkflowDrag(useWorkspaceStore.getState(),{gestureId:input.sessionId,outline:input.outline,
        sourceId:input.sourceId,selectedTabIds:latest.current.selectedTabIds});
      if(!admission)return false;
      const sourceNode=indexNodes(input.outline).get(String(input.sourceId));
      const source=beginReserveDragTransport(admission,input,sourceNode);
      return {rootIds:admission.sourceRootIds,context:admission,releaseOwnerKey:reserveReleaseOwner(workflowId,source)};
    },
    validateDragSource: drag=>workflowDragSourceValid(drag.sourceContext,useWorkspaceStore.getState()),
    outsidePointerPolicy: 'horizontal-corridor', folderDwellInterval: 500,
    layoutAnimation: { duration: 120, easing: 'cubic-bezier(0.2, 0, 0, 1)', respectReducedMotion: false,
      maxAnimatedRows: 14, minRetargetInterval: 72, animateDuringScroll: false },
    ignoreSelector: 'input,button,[data-no-drag],[data-tab-linked-files]',
    onCommit: payload => payload.sourceContext
      ? latest.current.onCommitOutline({ workflowId, payload, expectedMembership: membershipOf(payload.sourceContext) }) : false,
    onExpansionRequest: async ({ nodeId, expanded }) => {
      const node = indexNodes(outline).get(String(nodeId));
      const globalGroupId=node?.groupId || state.globalGroups?.groups?.find((group:any)=>
        `reserve-group:${workflowGroupKey('__tab_catalog_v2__',group.id)}`===nodeId)?.id;
      if (globalGroupId && state.globalGroups) {
        const operation={groupId:globalGroupId,groupName:state.globalGroups.groups.find((group:any)=>group.id===globalGroupId)?.name,expanded};
        try {
          const accepted=await expandGroup(globalGroupId,expanded);
          if(!accepted)reportError('Изменение группы не подтверждено','Не удалось изменить раскрытие группы',operation);
          return accepted;
        }
        catch (error) { reportError(error,'Не удалось изменить раскрытие группы',operation); return false; }
      } else if (node?.groupId) {
        const workspace = useWorkspaceStore.getState().openProjects.get(node.projectId);
        const group = workspace?.tabGroups?.find(group => group.id === node.groupId);
        if (group && group.collapsed === expanded) useWorkspaceStore.getState().toggleTabGroupCollapsed(node.projectId, node.groupId);
        return !!group;
      }
      return false;
    },
    canHorizontalMove: payload => {
      if(payload.sourceContext?.multiSelected)return {ok:false,reason:'multi-selection'};
      const { sourceNode } = payload;
      // Physical subagents keep exact ownership. Files have organizational visual
      // parents may move through the existing structured hierarchy resolver.
      if (sourceNode.groupId) return false;
      const owner = model.catalog.get(sourceNode.tabId);
      if (owner?.tab.parentTabId) return {ok:false,reason:'physical-parent'};
      return tabOutlineHorizontalPolicy(payload);
    },
    canUseVerticalSlot: payload => (payload.sourceNodes || [payload.sourceNode]).every(sourceNode=>{
      if (!tabOutlineVerticalSlotPolicy({...payload,sourceNode})) return false;
      const guard=payload.sourceContext?.guards[sourceNode.tabId!];
      if (!guard?.parentTabId) return true;
      return outlineParent(controlledOutline, String(sourceNode.id)) === payload.slot.parentId;
    }),
    resolveExternalTarget: ({ clientX, clientY, sourceContext }) => {
      const pointed=document.elementFromPoint(clientX,clientY);
      const target=resolvePaneTabDropTarget(pointed,clientX,(sourceContext?.paneEntries || []).map((entry:PaneTabDragEntry)=>entry.tabId),clientY);
      setPaneTabDragTarget(target);
      return target ? {...target,id:`${target.spaceId}:${target.paneKey}:${target.at}`} : null;
    },
    onExternalCommit: payload => !payload.sourceContext ? false
      : latest.current.onPlaceTabs(payload.sourceContext.paneEntries,
        payload.externalTarget as PaneTabDropTarget,payload.sourceContext,{isCurrent:payload.isCurrent}),
    onDiagnostic: uiDragDiagnostic,
    onLog:event=>{
      if(['start','external-adopt','commit','cancel','vertical','horizontal','horizontal-blocked','expansion','release-preview','commit-error','commit-rejected'].includes(event.type))
        console.log(`[WorkflowReserveDnd:${event.type}] workflow=${workflowId} source=${event.sourceId || ''} reason=${String(event.detail?.reason || '')} state=${JSON.stringify({
          sessionId:event.sessionId,pointer:event.pointer,slot:event.slot,measurement:event.measurement,input:event.input,
          fromBoundary:event.detail?.fromBoundary,toBoundary:event.detail?.toBoundary,
          ...(event.type==='release-preview'?event.detail:{}),
        })}`);
    },
  });
  const dndRef=useRef(dnd);dndRef.current=dnd;
  useOutlineDragCursor(dnd.dragState,dnd.scrollerRef);
  useCommandHierarchyHint(dnd.scrollerRef);
  const nodes = indexNodes(dnd.previewOutline);
  useLayoutEffect(() => {
    if (!workflowCreationVisibility.hasPending()) return;
    workflowCreationVisibility.observe({state,model,element:sidebar.current,dragPhase:dnd.dragState?.phase,
      outlineIds:new Set([...nodes.values()].map(node=>node.tabId).filter(Boolean)),
      rowIds:new Set(dnd.rows.map(row=>nodes.get(String(row.id))?.tabId).filter(Boolean))});
  },[state,model,dnd.previewOutline,dnd.rows,dnd.dragState?.phase]);
  // Adopt the existing pointer while inside this host. Coordinates do not
  // rerender the owner: the shared hook receives the actual pointer events.
  useEffect(() => {
    const sync=()=>{
      const pointer=getPaneTabPointerSnapshot(),rect=dndRef.current.scrollerRef.current?.getBoundingClientRect();
      const inside=pointer.active && pointer.source?.workflowDrag && rect && (pointer.source.owner==='sidebar'
        || pointer.clientX>=rect.left && pointer.clientX<=rect.right && pointer.clientY>=rect.top && pointer.clientY<=rect.bottom);
      setExternalPointer(previous=>{
        if(!inside)return null;
        if(previous?.source===pointer.source && previous.metaKey===pointer.metaKey)return previous;
        return pointer;
      });
    };
    sync();const unsubscribe=subscribePaneTabPointer(sync);
    const release=subscribePaneTabPointerDrop(pointer=>{
      const source=pointer.source,snapshot=dndRef.current.getDragSnapshot(),drag=snapshot.current,host=dndRef.current.scrollerRef.current;
      if(!source?.workflowDrag || !drag || drag.phase!=='dragging' || drag.gestureId!==source.gestureId
        || drag.ownerEpoch!==snapshot.ownerEpoch || drag.pointerId!==pointer.pointerId || !host)return false;
      const currentWorkflow=latest.current.state.activeSpaceId,ownerKey=reserveReleaseOwner(currentWorkflow,source);
      if(drag.externalOwnerKey!==ownerKey)return false;
      const rect=host.getBoundingClientRect(),target=snapshot.painted?.drag.externalTarget as PaneTabDropTarget | null;
      const inside=pointer.clientX>=rect.left && pointer.clientX<=rect.right && pointer.clientY>=rect.top && pointer.clientY<=rect.bottom;
      const corridor=source.owner==='sidebar' && pointer.clientY>=rect.top && pointer.clientY<=rect.bottom;
      const pane=source.owner==='sidebar' && target && ['body','strip'].includes(target.zone)
        && paneTabDropTargetContainsPoint(target,pointer.clientX,pointer.clientY);
      console.log(`[WorkflowReserveDnd:release] workflow=${currentWorkflow} source=${drag.sourceId} state=${JSON.stringify({
        sessionId:drag.sessionId,physical:{x:pointer.clientX,y:pointer.clientY,metaKey:pointer.metaKey},
        preview:{x:drag.pointerX,y:drag.pointerY,revision:drag.previewRevision,slot:drag.slot,
          navigationMode:drag.navigationMode},inside,corridor,pane:!!pane,
      })}`);
      if(!inside && !corridor && !pane){dndRef.current.cancel('release-outside-host');return false;}
      return dndRef.current.commitExternalDrag('pane-tab-pointerup',{ownerKey,pointerId:pointer.pointerId,
        releasePoint:{clientX:pointer.clientX,clientY:pointer.clientY}});
    });
    return () => { unsubscribe();release(); };
  }, []);
  useEffect(() => () => { stopResize.current?.(); }, []);
  useEffect(() => { stopResize.current?.(); anchor.current = ''; }, [workflowId]);
  const userScroll = useRef(false);
  useLayoutEffect(() => {
    const scroller = dnd.scrollerRef.current; if (!scroller) return;
    userScroll.current = false;
    const apply = () => {
      if (!userScroll.current) scroller.scrollTop = Math.min(props.scrollTop || 0, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
    };
    apply(); const observer = new ResizeObserver(apply);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => observer.disconnect();
  }, [workflowId]);
  const select = (id: string, event: React.MouseEvent) => {
    const current = latest.current, ids = dnd.rows.map(row => nodes.get(String(row.id))?.tabId).filter((id): id is string => !!id);
    if (event.shiftKey && anchor.current && ids.includes(anchor.current)) {
      const a = ids.indexOf(anchor.current), b = ids.indexOf(id);
      current.onSelectionChange(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); return;
    }
    anchor.current = id;
    if (event.metaKey || event.ctrlKey) {
      current.onSelectionChange(current.selectedTabIds.includes(id)
        ? current.selectedTabIds.filter(candidate => candidate !== id) : [...current.selectedTabIds, id]); return;
    }
    current.onSelectionChange([id]);
    const owner = model.catalog.get(id);
    Promise.resolve(current.onOpenTab(owner.projectId, id)).catch(reason => reportError(reason,'Не удалось открыть вкладку',{namespace:owner.projectId,tabId:id}));
  };
  const create = async (action:NewTabAction='terminal',target?:WindowCell) => {
    if (creating) return;
    setCreating(true);
    const source = model.catalog.get(props.sourceTabId);
    const request={ workflowId, sourceTabId: source?.tabId,
      cwd: props.fallbackCwd || source?.tab.cwd, placement: 'reserve',action,
      windowId:target?useWorkspaceStore.getState().splitPanes[target.index]?.windowId:undefined } as const;
    try { await props.onCreateTab(request); }
    catch (reason) { reportError(reason,'Не удалось создать вкладку',{...request,action:'Create '+action}); } finally { setCreating(false); }
  };
  useEffect(()=>{setEmptyMenu(null);},[workflowId]);
  useLayoutEffect(()=>{
    if(!emptyMenu || !emptyMenuRef.current)return;
    const rect=emptyMenuRef.current.getBoundingClientRect(),pos=clampMenuToViewport({x:emptyMenu.x,y:emptyMenu.y,
      width:rect.width,height:rect.height,viewportWidth:innerWidth,viewportHeight:innerHeight});
    Object.assign(emptyMenuRef.current.style,{left:`${pos.x}px`,top:`${pos.y}px`});
  },[emptyMenu]);
  useEffect(()=>{
    if(!emptyMenu)return;
    const outside=(event:PointerEvent)=>{
      if(emptyMenuRef.current?.contains(event.target as Node) || (event.target as Element)?.closest?.('[data-new-tab-window-flyout]'))return;
      setEmptyMenu(null);
    };
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.stopPropagation();setEmptyMenu(null);}};
    window.addEventListener('pointerdown',outside,true);window.addEventListener('keydown',escape,true);
    return()=>{window.removeEventListener('pointerdown',outside,true);window.removeEventListener('keydown',escape,true);};
  },[emptyMenu]);
  return <div ref={sidebar} data-tab-sidebar data-workflow-tab-sidebar={workflowId}
    data-keyboard-focus-surface="sidebar" className="workflow-tab-sidebar" style={{width,zIndex:1,
      '--reserve-gap':`${sidebarGap}px`, '--reserve-font-size':`${fontSize}px`,
      '--reserve-row-padding':`${geometry.paddingY}px ${geometry.paddingX}px`,
      '--reserve-row-radius':`${geometry.borderRadius}px`, '--reserve-line-height':TAB_CARD_LINE_HEIGHT,
    } as React.CSSProperties}
    onPointerDownCapture={event => {
      if (event.button === 0 && !(event.target as Element).closest('[data-tab-sidebar-resize-handle],[data-tab-context-menu], [data-tab-status-marker-button], [data-tab-status-marker-menu], [data-task-plan-status-trigger], [data-task-plan-status-menu]'))
        useUIStore.getState().setActiveArea('sidebar');
    }}>
    <SidebarTabDragCursorChip enabled />
    {props.location && <div data-sidebar-location-line style={{padding:'3px 8px 4px',borderBottom:'1px solid #ffffff0f'}}>{props.location}</div>}
    <div ref={element => { dnd.scrollerRef.current = element; }} data-workflow-reserve-scroll
      className="workflow-reserve-scroll" onWheel={() => { userScroll.current = true; }}
      onContextMenu={event=>{
        if((event.target as Element).closest('[data-outline-dnd-row]'))return;
        event.preventDefault();event.stopPropagation();setEmptyMenu({x:event.clientX,y:event.clientY});
      }}
      onDoubleClick={event=>{if(!(event.target as Element).closest('[data-outline-dnd-row]'))void create();}}
      onPointerDown={() => { userScroll.current = true; }}
      onScroll={event => { if (userScroll.current) props.onScrollOffsetChange?.(workflowId, event.currentTarget.scrollTop); }}>
      <div className="workflow-reserve-outline" data-outline-dnd-source-follow={dnd.dragState?.phase==='dragging' ? sourceFollow : undefined}>
        {dnd.rows.map(row => {
          const node = nodes.get(String(row.id))!;
          const rowProps = dnd.getRowProps(row);
          const group = node.groupId && (model.visibleGroups.get(workflowGroupKey(node.projectId, node.groupId))
            || state.globalGroups?.groups?.find((group:any)=>group.id===node.groupId)
            || state.openProjects.get(node.projectId)?.tabGroups?.find(group=>group.id===node.groupId));
          const isSource = String(dnd.dragState?.sourceId) === String(row.id);
          const ancestors = row.path.slice(0,-1).map(id => nodes.get(String(id))).filter(Boolean);
          const groupDepth = ancestors.some(node => node?.groupId) ? 1 : 0;
          const indent = groupDepth * 16 + (row.depth - groupDepth) * 12;
          const parent = ancestors.at(-1), parentTab = parent?.tabId && model.catalog.get(parent.tabId)?.tab;
          const connectorColor = parentTab?.color && parentTab.color !== 'default'
            ? adjustRgbaAlpha(getTabChromeColorConfig(parentTab).bgColor,.22) : '#ffffff24';
          return <div {...rowProps} key={row.id} className="workflow-reserve-row" style={{...rowProps.style,marginLeft:indent}}>
            {row.depth > 0 && <span aria-hidden className="workflow-reserve-connectors" style={{color:connectorColor}}>
              {row.ancestorContinuationDepths.map(depth => <span key={depth} className="workflow-reserve-connector continuation"
                data-visual-connector-continuation={depth} style={{left:-7-(row.depth-depth-1)*12}} />)}
              <span className="workflow-reserve-connector top" data-visual-connector-top />
              {row.hasNextSibling && <span className="workflow-reserve-connector bottom" data-visual-connector-bottom />}
              <span className="workflow-reserve-connector elbow" data-visual-connector-elbow />
            </span>}
            {node.groupId ? <ReserveGroupHeader node={node} group={group} displayName={group?workflowGroupDisplayName(group):node.label || ''} expanded={row.expanded}
              dwell={dnd.dragState?.navigationDwell?.targetId===row.id ? dnd.dragState.navigationDwell : null}
              editing={props.editingGroupId===node.groupId} focused={props.activeGroupId===node.groupId}
              dragging={!!dnd.dragState} onExpand={()=>{void dnd.requestExpansion(row.id,!row.expanded);}}
              onFocus={()=>props.onGroupFocus?.(node.groupId!)}
              onRename={name=>props.onGroupRename?.(node.groupId!,name) || Promise.resolve(false)}
              onError={reason=>reportError(reason,'Не удалось переименовать группу',{groupId:node.groupId,groupName:group?workflowGroupDisplayName(group):node.label})}
              onRenameEnd={()=>props.onGroupRenameEnd?.()} onClose={()=>{void props.onGroupClose?.(node.groupId!);}}
              onContextMenu={event=>{event.preventDefault();event.stopPropagation();props.onGroupContextMenu(node.projectId,node.groupId!,event.clientX,event.clientY);}}/>

              : <ReserveCard node={node} rowProps={rowProps} selected={props.selectedTabIds.includes(node.tabId!)}
                feedback={isSource ? dnd.dragState?.feedback : null} navigationPaused={isSource && dnd.dragState?.navigationMode}
                activity={props.sharedActivity} onClick={event => select(node.tabId!, event)}
                onMiddleClick={()=>{
                  if(dnd.dragState)return;
                  const fileTab=useWorkspaceStore.getState().openProjects.get(node.projectId)?.tabs.get(node.tabId!);
                  if(fileTab?.tabType==='file'){void openFileTabBeside(node.projectId,node.tabId!);return;}
                  const store=useWorkspaceStore.getState(),index=store.splitPanes.length?store.splitFocusedIndex:null;
                  const entries=reservePaneEntries(model,node);
                  const at=index===null?(store.centerStrips[store.centerStripKey()] || []).length:paneTabs(store.splitPanes[index]).length;
                  const admission=captureWorkflowDrag(store,{gestureId:crypto.randomUUID(),outline,sourceId:node.id});
                  Promise.resolve(props.onPlaceTabs(entries,{zone:'body',paneKey:index===null?'center':`pane:${index}`,
                    paneIndex:index,spaceId:workflowId,at},admission))
                    .then(accepted=>{if(!accepted)reportError('Размещение вкладки не подтверждено');})
                    .catch(reason=>reportError(reason));
                }}
                onOpenFile={file => props.onOpenFile(node.projectId, file)} />}
          </div>;
        })}
        <div {...dnd.scrollSpacerProps} />
      </div>
    </div>
    {emptyMenu && createPortal(<div ref={emptyMenuRef} data-workflow-empty-context-menu data-tab-context-menu role="menu"
      className="fixed bg-[#2a2a2a] border border-[#444] shadow-2xl overflow-hidden"
      onPointerDown={event=>event.stopPropagation()} onMouseDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()}
      style={{...CONTEXT_MENU_PANEL_STYLE,position:'fixed',left:emptyMenu.x,top:emptyMenu.y,zIndex:100030}}>
      <NewTabMenuRows rowAttributes={action=>({'data-tab-empty-context-action':`new-${action}`})}
        onCreate={action=>{void create(action);setEmptyMenu(null);}}
        onCreateInWindow={state.splitPanes?.length?(action,target)=>{void create(action,target);setEmptyMenu(null);}:undefined}/>
      <div style={CONTEXT_MENU_TOP_DIVIDER_STYLE}/>
      <button type="button" data-tab-empty-context-action="new-group" className="w-full text-left hover:bg-white/10"
        style={{...CONTEXT_MENU_ROW_STYLE,display:'flex',alignItems:'center',gap:8,color:'#ccc',border:0,background:'transparent',cursor:'pointer'}}
        onClick={()=>{setEmptyMenu(null);Promise.resolve(props.onCreateGroup(workflowId)).catch(reason=>reportError(reason,'Не удалось создать группу'));}}><Folder size={12}/>Group</button>
    </div>,overlayTarget)}
    <div data-tab-sidebar-resize-handle onPointerDown={event => {
      if (event.button !== 0) return;
      stopResize.current?.(); stopResize.current = startTabSidebarResize(event, {
        getWidth: () => useUIStore.getState().tabSidebarWidth,
        commitWidth: value => useUIStore.getState().setTabSidebarWidth(value),
        subscribeCancel: cancel => useUIStore.subscribe((next, previous) => {
          if (next.activeDisplayKey !== previous.activeDisplayKey || next.tabSidebarWidth !== previous.tabSidebarWidth) cancel();
        }), onFinish: () => { stopResize.current = null; },
      });
    }} />
  </div>;
}

function indexNodes(outline: Node[]) {
  const index = new Map<string, Node>();
  const walk = (nodes: Node[]) => nodes.forEach(node => { index.set(String(node.id), node); walk(node.children || []); });
  walk(outline); return index;
}

function outlineParent(outline: Node[], id: string, parent: string | number | null = null): string | number | null | undefined {
  for (const node of outline) {
    if (String(node.id) === id) return parent;
    const found = outlineParent(node.children || [], id, node.id);
    if (found !== undefined) return found;
  }
  return undefined;
}
