import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {useWorkspaceStore} from '../../store/useWorkspaceStore';
import {useUIStore} from '../../store/useUIStore';
import {directionalPaneStripGroup,paneStripGroupOpenMode} from '../../utils/paneStripGroupInterfaceModel.mjs';
import {fitPaneStripGroupAtAnchor,paneStripGroupOffsets,paneStripGroupHoverStep} from '../../utils/paneStripCollapseModel.mjs';
import {ownPaneStripGroupMetaHover} from '../../utils/paneStripGroupMetaHover.mjs';
import {readPaneStripGroupState,readPaneStripOwnerEntries,readPaneStripActiveGroups} from '../../utils/paneStripGroupsModel.mjs';
import {paneStripColorGroupsBasis} from '../../../shared/pane-strip-color-groups.cjs';
import type {StripEntry} from './PaneTabStrip';
import type {PaneStripSelectionLease} from './PaneStripSelection';
import './PaneStripCollapsedGroup.css';
import PaneStripGroupOutline from './PaneStripGroupOutline';
import {currentUIActionId,uiDiagnosticAbsNow,uiPerformancePhaseForAction} from '../../utils/uiPerformanceDiagnostics.mjs';
import {horizontalDragAutoScrollDelta} from '../../utils/horizontalDragGeometry.mjs';
import {paneStripHoverInside,paneStripHoverMenu} from '../../utils/paneStripHoverScope.mjs';

export type PaneStripGroupControl={groupId:string;revision:number;available:boolean;count:number;color:string;open:boolean;busy:boolean;unread:boolean;
  toggle:()=>void;hover:()=>void;selected:(tabId:string,activate:()=>Promise<boolean>,onActivated?:()=>void)=>void};
type Props={group:{id:string;color:string;tabIds:string[];revision:number;collapsed?:boolean};entries:StripEntry[];
  representative:string;workflowId:string;windowId:string|null;paneIndex:number|null;rowGap:number;presented:boolean;
  membershipPreview?:boolean;
  dragging:boolean;sourceHere?:boolean;layoutKey:string;renderChip:(entry:StripEntry,control?:PaneStripGroupControl)=>React.ReactNode;
  onPresentation:()=>void};

/** One copy of each card in the same strip DOM. Only the representative owns
 * flow space. Opening moves siblings to absolute positions on its SAME row;
 * it never creates a dialog, another History owner or a duplicate active card. */
export default function PaneStripCollapsedGroup(props:Props) {
  const {group,entries,representative,workflowId,windowId,paneIndex,rowGap,presented,dragging,layoutKey,renderChip,onPresentation}=props;
  const root=useRef<HTMLSpanElement|null>(null),alive=useRef(true),epoch=useRef(0),metaRelease=useRef<null|(()=>void)>(null),hovered=useRef(false);
  const latest=useRef(props);latest.current=props;
  const [view,publishView]=useState<any>(null),viewRef=useRef<any>(null);viewRef.current=view;
  const [request,publishRequest]=useState<any>(null),requestRef=useRef<any>(null);requestRef.current=request;
  const [selecting,setSelecting]=useState(false),selectionRef=useRef<any>(null),scopeRef=useRef<any>(null);
  const closeOnClick=useUIStore(state=>state.paneStripCloseOnClick);
  const interaction=useRef<any>({mode:'hover',inside:true,dragging:false,waitForReentry:false});
  const widths=useRef(new Map<string,number>()),boxes=useRef<Array<{left:number;right:number;top:number;bottom:number}>>([]);
  const membersKey=entries.map(entry=>`${entry.projectId}:${entry.tabId}`).join('|');
  const setView=(next:any)=>{const value=typeof next==='function'?next(viewRef.current):next;viewRef.current=value;publishView(value);};
  const setRequest=(next:any)=>{requestRef.current=next;publishRequest(next);};
  const unread=useWorkspaceStore(state=>entries.some(entry=>entry.tabId!==representative
    &&!!state.openProjects.get(entry.projectId)?.tabs.get(entry.tabId)?.completionNotificationFired));
  const cancelNavigation=(intent:any)=>{
    // Only our unfinished activation. A newer navigation and an already
    // accepted selection remain owned by the existing navigation controller.
    if(!intent?.navigationId||intent.activationDone)return;
    if(useWorkspaceStore.getState().activeTabNavigationIntent?.id===intent.navigationId)
      useWorkspaceStore.setState({activeTabNavigationIntent:null});
  };
  const close=(revoke=false)=>{epoch.current++;scopeRef.current=null;
    const selection=selectionRef.current;selectionRef.current=null;cancelNavigation(selection);
    setSelecting(false);setRequest(null);setView(null);
    // Closing on a Meta tap does not move the pointer. Keep this hovered owner
    // armed so the next tap works without a new mouseenter.
    if(revoke||!hovered.current||!latest.current.presented){metaRelease.current?.();metaRelease.current=null;}
    onPresentation();};
  const captureScope=(navigationOnlyTabId?:string)=>{
    const props=latest.current,state=useWorkspaceStore.getState();
    const raw=readPaneStripGroupState(state,props.workflowId),basis=paneStripColorGroupsBasis(raw);
    const active=readPaneStripActiveGroups(state,props.workflowId).find(item=>item.id===props.group.id);
    const navigationOnly=navigationOnlyTabId!==undefined;
    const captured=props.entries.filter(entry=>!navigationOnly||entry.tabId===navigationOnlyTabId).map(entry=>({...entry})),ids=captured.map(entry=>entry.tabId);
    if(!navigationOnly&&(!active||!active.collapsed||active.revision!==props.group.revision||active.color!==props.group.color
      ||active.tabIds.length!==ids.length||active.tabIds.some(id=>!ids.includes(id))))throw Error('strip_group_selection_changed');
    const subjects=captured.map(entry=>state.openProjects.get(entry.projectId)?.tabs.get(entry.tabId));
    const scope:any={epoch:epoch.current,basis,workflowId:props.workflowId,windowId:props.windowId,paneIndex:props.paneIndex,
      navigation:{revision:state.navigationRevision,intentId:state.activeTabNavigationIntent?.id||null,owned:null,starting:false}};
    const lease:PaneStripSelectionLease={version:1,workflowId:props.workflowId,windowId:props.windowId,paneIndex:props.paneIndex,
      entries:captured,isCurrent:()=>{
        const now=useWorkspaceStore.getState(),ui=latest.current,nav=scope.navigation;
        if(!alive.current||!ui.presented||epoch.current!==scope.epoch||ui.workflowId!==scope.workflowId
          ||ui.windowId!==scope.windowId||ui.paneIndex!==scope.paneIndex)return false;
        if(!nav.starting&&(nav.owned
          ?now.activeTabNavigationIntent?.id!==nav.owned
            ||now.navigationRevision!==nav.revision&&now.navigationMutationOwner!==nav.owned
          :now.navigationRevision!==nav.revision||(now.activeTabNavigationIntent?.id||null)!==nav.intentId))return false;
        const owner=readPaneStripOwnerEntries(now,scope);
        try{return !!owner&&captured.length>0&&(navigationOnly||paneStripColorGroupsBasis(readPaneStripGroupState(now,scope.workflowId))===basis)
          &&captured.every((entry,index)=>subjects[index]&&now.openProjects.get(entry.projectId)?.tabs.get(entry.tabId)===subjects[index]
            &&now.tabCatalog?.[entry.tabId]?.active!==false
            &&owner.some(value=>value.projectId===entry.projectId&&value.tabId===entry.tabId));}catch{return false;}
      }};
    scope.lease=lease;return scope;
  };
  const open=(entry:'click'|'hover',toggle=true)=>{
    if(!latest.current.presented)return;
    const current=viewRef.current||requestRef.current;
    if(current) {
      if(entry==='click'&&current.mode==='hover') {
        interaction.current={...interaction.current,mode:'click'};
        if(viewRef.current)setView({...viewRef.current,mode:'click'});
        if(requestRef.current)setRequest({...requestRef.current,mode:'click'});
      // Sticky means outside-click (plus safety revoke). Repeated OPEN inputs
      // do not dismiss it; the accepted Cmd toggle remains for temporary OFF.
      } else if(toggle&&current.mode==='hover')close();
      return;
    }
    const mode=paneStripGroupOpenMode(entry,useUIStore.getState().paneStripCloseOnClick);
    interaction.current={mode,inside:true,dragging:latest.current.dragging,waitForReentry:false};
    const actionId=currentUIActionId();uiPerformancePhaseForAction(actionId,'strip-group:open-request',{memberCount:latest.current.entries.length});
    epoch.current++;
    try {
      const scope=captureScope();scopeRef.current=scope;
      const value={mode,epoch:epoch.current,scope,selectedFirst:useUIStore.getState().paneStripSelectedFirst,
        actionId,startAbs:uiDiagnosticAbsNow(),phase:'measure'};
      // Idle is synchronous. Pending/unknown delivery is reconciled by the
      // SAME organization lane before fresh geometry/order is captured.
      const settle=latest.current.dragging?null:useWorkspaceStore.getState().settlePaneStripGroupPresentation();
      setRequest(settle?{...value,phase:'settling'}:value);
      if(settle)void settle.then(()=>{
        if(scope.lease.isCurrent())setRequest({...value,phase:'measure'});
      }).catch((error:any)=>{console.warn('[PaneStripGroup] recovery refused',error?.code||error?.message);
        if(epoch.current===value.epoch)close();});
    }catch(error){console.warn('[PaneStripGroup] open owner unavailable',error);close();}
  };
  const select=(tabId:string,activate:()=>Promise<boolean>,onActivated?:()=>void)=>{
    // Detach the old scope before cancelling its own navigation: Store emits
    // synchronously, and that expected cancellation must not close this view.
    const prior=selectionRef.current;selectionRef.current=null;scopeRef.current=null;cancelNavigation(prior);
    const reopenMode=requestRef.current?.mode;epoch.current++;setRequest(null);
    let scope:any,canArrange=true;
    try{scope=captureScope();}catch(error){
      // A released order preview is not a group-membership proof. Preserve
      // ordinary navigation with the SAME late-focus safety fences, without
      // manufacturing a group edit or reopening a stale group definition.
      close(true);canArrange=false;scope=captureScope(tabId);
    }
    scopeRef.current=scope;
    const intent:any={scope,activationDone:false,navigationId:null};selectionRef.current=intent;setSelecting(true);
    const current=()=>selectionRef.current===intent&&scope.lease.isCurrent();
    scope.navigation.starting=true;
    let activation:Promise<boolean>;
    try {
      activation=Promise.resolve(activate());
      const nav=useWorkspaceStore.getState().activeTabNavigationIntent;
      if(nav?.tabId===tabId){intent.navigationId=nav.id;scope.navigation.owned=nav.id;}
    }catch(error){activation=Promise.reject(error);}
    finally{scope.navigation.starting=false;}
    // Capture field/order proof before activation can await catalog/runtime.
    // Readiness is renderer admission only and never enters the durable request.
    const ready=activation.then(ok=>{
      intent.activationDone=ok===true;
      if(ok!==true||!current())return false;
      onActivated?.();return current();
    }).catch(error=>{console.warn('[PaneStripGroup] selection activation refused',error?.code||error?.message);return false;});
    const wantsOrder=canArrange&&useUIStore.getState().paneStripSelectedFirst===true;
    const selectionLease={...scope.lease,isCurrent:()=>current()&&useUIStore.getState().paneStripSelectedFirst===true};
    const applied=wantsOrder?useWorkspaceStore.getState().commitPaneStripGroupPresentation(selectionLease,group.id,
      {selectedTabId:tabId,selectionReady:ready}):ready;
    void applied.then(result=>{
      if(result===false||!current())return;
      if(canArrange&&reopenMode&&!viewRef.current){selectionRef.current=null;setSelecting(false);open(reopenMode,false);}
      else if(viewRef.current)setView({...viewRef.current,selectionRevision:(viewRef.current.selectionRevision||0)+1});
    }).catch(error=>{console.warn('[PaneStripGroup] selection arrangement refused',error?.code||error?.message);
      if(selectionRef.current===intent&&!scope.lease.isCurrent())close(true);
    }).finally(()=>{if(selectionRef.current===intent){selectionRef.current=null;setSelecting(false);
      if(!viewRef.current&&!requestRef.current)scopeRef.current=null;}});
  };
  const toggleRef=useRef(()=>{});toggleRef.current=()=>open('hover');
  const isInside=(event:{target:EventTarget|null;clientX?:number;clientY?:number})=>paneStripHoverInside({
    root:root.current,target:event.target,memberIds:latest.current.entries.map(entry=>entry.tabId),boxes:boxes.current,
    open:!!viewRef.current||!!requestRef.current,x:event.clientX,y:event.clientY});
  const ownMeta=()=>{metaRelease.current=ownPaneStripGroupMetaHover(root.current,()=>toggleRef.current(),window,event=>{
    const inside=isInside(event);hovered.current=inside;return inside;
  });};
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;metaRelease.current?.();
    const intent=selectionRef.current;selectionRef.current=null;cancelNavigation(intent);};},[]);
  useEffect(()=>{if(!presented)close(true);},[presented]);
  useEffect(()=>{
    if(!view&&!request&&!selecting)return;
    const check=()=>{if(scopeRef.current&&!scopeRef.current.lease.isCurrent())close(true);};
    const stop=useWorkspaceStore.subscribe(check);check();return stop;
  },[!!view,!!request,selecting]);
  useEffect(()=>{
    if(!closeOnClick)return;
    interaction.current={...interaction.current,mode:'click'};
    if(viewRef.current?.mode==='hover')setView({...viewRef.current,mode:'click'});
    if(requestRef.current?.mode==='hover')setRequest({...requestRef.current,mode:'click'});
  },[closeOnClick]);
  // Widths are read only at OPEN, after hidden siblings mounted outside flow.
  // No polling or geometry reads are performed in the pointer-move handler.
  useLayoutEffect(()=>{
    if(!request||request.phase!=='measure'||!root.current)return;
    const value=request,node=root.current,revision=group.revision;
    try {
      const captured=value.scope.lease,measureStart=uiDiagnosticAbsNow();
      if(!captured.isCurrent()){close(true);return;}
      const nodes=Array.from(node.querySelectorAll<HTMLElement>('[data-strip-item]'));
      widths.current=new Map(nodes.map(chip=>[chip.dataset.stripTabId!,chip.getBoundingClientRect().width]));
      const anchor=nodes.find(chip=>chip.dataset.stripTabId===representative)?.getBoundingClientRect();if(!anchor)throw Error('strip_group_geometry_unavailable');
      boxes.current=[anchor];
      const ids=entries.map(entry=>entry.tabId),memberIds=new Set(ids);
      const canonical=readPaneStripOwnerEntries(useWorkspaceStore.getState(),value.scope)?.filter(entry=>memberIds.has(entry.tabId)).map(entry=>entry.tabId);
      const caught=!!canonical&&JSON.stringify(ids)===JSON.stringify(canonical);
      // Member-origin collapsed peek keeps its internal drag scope. A released
      // order-only preview is display, not an order+membership admission pair.
      const peek=interaction.current.dragging||!caught;
      const selectedOrder=[representative,...ids.filter(id=>id!==representative)];
      const calculated=value.selectedFirst
        ?{...directionalPaneStripGroup({ids:peek?ids:selectedOrder,representative,widths:widths.current,
          anchorLeft:anchor.left,viewportLeft:1,viewportRight:document.documentElement.clientWidth-1,gap:6}),
          changed:!peek&&selectedOrder.some((id,index)=>id!==ids[index])}
        :fitPaneStripGroupAtAnchor({ids,representative,widths:widths.current,
          anchorLeft:anchor.left,viewportLeft:1,viewportRight:document.documentElement.clientWidth-1,gap:6});
      const fit=peek?{...calculated,order:ids,changed:false}:calculated;
      uiPerformancePhaseForAction(value.actionId,'strip-group:measured',{durationMs:uiDiagnosticAbsNow()-measureStart,
        rectangleCount:nodes.length+1,memberCount:entries.length,reorder:fit.changed,overflow:fit.overflow});
      const finish=()=>{
        if(!captured.isCurrent())return;
        const current=readPaneStripGroupState(useWorkspaceStore.getState(),workflowId).groups.find(item=>item.id===group.id);
        if(!current||current.revision!==revision){close();return;}
        // Accepted metadata/order are adopted by Store even if this UI dies.
        // Reveal only THIS still-current intent; do not restore captured IDs.
        const canonicalNow=readPaneStripOwnerEntries(useWorkspaceStore.getState(),value.scope)?.filter(entry=>memberIds.has(entry.tabId)).map(entry=>entry.tabId);
        if(!peek&&JSON.stringify(canonicalNow)!==JSON.stringify(fit.order)){close();return;}
        const geometry=value.selectedFirst?directionalPaneStripGroup({ids:fit.order,representative,widths:widths.current,
          anchorLeft:anchor.left,viewportLeft:1,viewportRight:document.documentElement.clientWidth-1,gap:6}):null;
        const offsets=geometry?.offsets||paneStripGroupOffsets(fit.order,widths.current,6,representative);
        setRequest(null);setView({mode:interaction.current.mode,order:fit.order,offsets,anchorId:representative,
          anchorOffset:geometry?.anchorOffset||0,direction:geometry?.direction,selectedFirst:value.selectedFirst,overflow:geometry?.overflow??fit.overflow,
          viewportLeft:1,viewportRight:document.documentElement.clientWidth-1,anchorLeft:anchor.left,definitionRevision:revision,diagnostic:value});
        window.dispatchEvent(new CustomEvent('pane-strip-group:open',{detail:{owner:node}}));onPresentation();
      };
      if(fit.changed){uiPerformancePhaseForAction(value.actionId,'strip-group:commit-start',{memberCount:entries.length});
        // A phase prevents a second submit when canonical props catch the ACK.
        setRequest({...value,phase:'committing'});
        void useWorkspaceStore.getState().commitPaneStripGroupPresentation(captured,group.id,
        value.selectedFirst?{selectedTabId:representative}:{order:fit.order,representative}).then(()=>{
          uiPerformancePhaseForAction(value.actionId,'strip-group:commit-end',{accepted:true});finish();})
        .catch(error=>{uiPerformancePhaseForAction(value.actionId,'strip-group:commit-end',{accepted:false,reason:error?.code||'failed'});
          console.warn('[PaneStripGroup] open arrangement refused',error?.code||error?.message);if(epoch.current===value.epoch)close();});}
      else finish();
    }catch(error){console.warn('[PaneStripGroup] geometry unavailable',error);close();}
  },[request,membersKey]);
  // A held IN/OUT plan is reversible presentation. Keep the existing OPEN
  // owner until release; its raw canonical scope still revokes on a real edit.
  // Never write this prospective definition back through an arrange/collapse.
  useEffect(()=>{if(!props.membershipPreview&&viewRef.current&&viewRef.current.definitionRevision!==group.revision)close();},[group.revision,props.membershipPreview]);
  // Committed-order invalidation is bounded and shared with the existing DnD
  // strip receipt. Siblings may move during explicit drag; OPEN stays anchored.
  useLayoutEffect(()=>{
    if(!view||!root.current)return;
    const ids=entries.map(entry=>entry.tabId),members=new Set(ids);
    const canonical=readPaneStripOwnerEntries(useWorkspaceStore.getState(),{workflowId,windowId,paneIndex})?.filter(entry=>members.has(entry.tabId)).map(entry=>entry.tabId);
    // An ACK can precede retained React props. Keep its accepted geometry until
    // those exact props catch up; do not turn a preview into membership proof.
    if(!dragging&&JSON.stringify(ids)!==JSON.stringify(canonical))return;
    // A newly previewed member has no width in the original OPEN receipt yet.
    // The existing outline measurement supplies it; do not invent a zero box
    // or introduce another DOM reader in the pointer path.
    if(ids.some(id=>!Number.isFinite(widths.current.get(id))||(widths.current.get(id)||0)<=0))return;
    const geometry=view.selectedFirst?directionalPaneStripGroup({ids,representative,widths:widths.current,
      anchorLeft:view.anchorLeft,viewportLeft:view.viewportLeft,viewportRight:view.viewportRight,gap:6}):null;
    const offsets=geometry?.offsets||paneStripGroupOffsets(ids,widths.current,6,view.anchorId,view.anchorOffset);
    if(view.order.length===entries.length&&(!geometry||view.direction===geometry.direction)
      &&entries.every((entry,index)=>view.order[index]===entry.tabId&&view.offsets.get(entry.tabId)===offsets.get(entry.tabId)))return;
    setView({...view,order:ids,offsets,...(geometry?{anchorId:representative,anchorOffset:geometry.anchorOffset,direction:geometry.direction,overflow:geometry.overflow}:{})});
  },[membersKey,representative,view?.selectionRevision]);
  useLayoutEffect(()=>{
    const node=root.current;if(!node||!view)return;
    boxes.current=Array.from(node.querySelectorAll<HTMLElement>('[data-strip-item]'),chip=>chip.getBoundingClientRect());
    const badge=node.querySelector('[data-pane-strip-group-count]');if(badge)boxes.current.push(badge.getBoundingClientRect());
    uiPerformancePhaseForAction(view.diagnostic?.actionId,'strip-group:layout',{durationMs:uiDiagnosticAbsNow()-view.diagnostic?.startAbs,
      rectangleCount:boxes.current.length,memberCount:entries.length});
    onPresentation();
  },[view,membersKey,layoutKey]);
  useEffect(()=>{
    if(!view&&!request&&!selecting)return;
    const node=root.current;
    const mode=view?.mode||request?.mode||interaction.current.mode;
    const move=(event:MouseEvent)=>{
      if(!viewRef.current&&!requestRef.current)return;
      const inside=isInside(event);
      hovered.current=inside;
      const next=paneStripGroupHoverStep(interaction.current,inside?'enter':'leave');interaction.current=next;
      if(next.close)close();else if(inside)ownMeta();
      const wide=viewRef.current;
      if(next.dragging&&wide?.overflow&&boxes.current.length
        &&event.clientY>=Math.min(...boxes.current.map(box=>box.top))-2
        &&event.clientY<=Math.max(...boxes.current.map(box=>box.bottom))+2) {
        const left=Math.min(...wide.offsets.values())+wide.anchorLeft,
          right=Math.max(...latest.current.entries.map(entry=>(wide.offsets.get(entry.tabId)||0)+(widths.current.get(entry.tabId)||0)))+wide.anchorLeft;
        const step=horizontalDragAutoScrollDelta({clientX:event.clientX,viewportLeft:wide.viewportLeft,viewportRight:wide.viewportRight,
          scrollLeft:Math.max(0,wide.viewportLeft-left),scrollWidth:right-left,clientWidth:wide.viewportRight-wide.viewportLeft});
        if(step)shiftWideRow(-step);
      }
    };
    const outside=(event:PointerEvent)=>{if(!(event.target instanceof Element))return;
      if(!viewRef.current&&!requestRef.current)return;
      if(node?.contains(event.target)||paneStripHoverMenu(event.target,latest.current.entries.map(entry=>entry.tabId)).owned)return;
      if(interaction.current.dragging)return;
      if(mode==='click'){event.preventDefault();event.stopPropagation();close(true);}
    };
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();event.stopImmediatePropagation();close(true);}};
    const other=(event:Event)=>{if((event as CustomEvent).detail?.owner!==node)close(true);};
    const blur=()=>close(true);const resize=()=>close(true);
    window.addEventListener('mousemove',move);window.addEventListener('pointerdown',outside,true);window.addEventListener('keydown',escape,true);
    window.addEventListener('pane-strip-group:open',other);window.addEventListener('blur',blur);window.addEventListener('resize',resize);
    return()=>{window.removeEventListener('mousemove',move);window.removeEventListener('pointerdown',outside,true);window.removeEventListener('keydown',escape,true);
      window.removeEventListener('pane-strip-group:open',other);window.removeEventListener('blur',blur);window.removeEventListener('resize',resize);};
  },[!!view,view?.mode,!!request,request?.mode,selecting]);
  useEffect(()=>{
    interaction.current=paneStripGroupHoverStep(interaction.current,dragging?'drag-start':'drag-end');
    if(dragging&&props.sourceHere&&!viewRef.current&&!requestRef.current&&presented)open('hover',false);
  },[dragging]);
  function shiftWideRow(delta:number) {
    setView((current:any)=>{
      if(!current?.overflow)return current;
      const left=Math.min(...current.offsets.values())+current.anchorLeft;
      const right=Math.max(...latest.current.entries.map(entry=>(current.offsets.get(entry.tabId)||0)+(widths.current.get(entry.tabId)||0)))+current.anchorLeft;
      const shift=Math.max(current.viewportRight-right,Math.min(current.viewportLeft-left,delta));
      return !shift?current:{...current,anchorOffset:current.anchorOffset+shift,
        offsets:new Map([...current.offsets].map(([id,x]:any)=>[id,x+shift]))};
    });
  }
  const scrollWide=(event:React.WheelEvent)=>{
    const current=viewRef.current;if(!current?.overflow||interaction.current.dragging)return;
    const delta=event.deltaX||event.deltaY;if(!delta)return;
    const left=Math.min(...current.offsets.values())+current.anchorLeft;
    const right=Math.max(...entries.map(entry=>(current.offsets.get(entry.tabId)||0)+(widths.current.get(entry.tabId)||0)))+current.anchorLeft;
    const shift=Math.max(current.viewportRight-right,Math.min(current.viewportLeft-left,-delta));
    if(!shift)return;
    event.preventDefault();event.stopPropagation();
    shiftWideRow(shift);
  };
  const visible=!!view,preparing=!!request;
  const measured=(chips:Array<{id:string;left:number;right:number}>)=>{
    const current=viewRef.current;if(!current||request)return;
    const next=new Map(chips.map(chip=>[chip.id,chip.right-chip.left]));
    if(entries.some(entry=>!next.has(entry.tabId)))return;
    if(entries.every(entry=>Math.abs((widths.current.get(entry.tabId)||0)-next.get(entry.tabId)!)<.5))return;
    widths.current=next;
    const geometry=current.selectedFirst?directionalPaneStripGroup({ids:entries.map(entry=>entry.tabId),representative,widths:next,
      anchorLeft:current.anchorLeft,viewportLeft:current.viewportLeft,viewportRight:current.viewportRight,gap:6}):null;
    setView({...current,measurementRevision:(current.measurementRevision||0)+1,
      offsets:geometry?.offsets||paneStripGroupOffsets(entries.map(entry=>entry.tabId),next,6,current.anchorId,current.anchorOffset),
      ...(geometry?{anchorId:representative,anchorOffset:geometry.anchorOffset,direction:geometry.direction,overflow:geometry.overflow}:{})});
  };
  const control:PaneStripGroupControl={groupId:group.id,revision:group.revision,available:presented,count:entries.length-1,color:group.color,open:visible,busy:preparing||selecting,unread,
    toggle:()=>open('click'),hover:()=>open('hover',false),selected:select};
  // Every group keeps exactly one flow slot, even while its other cards are
  // absolute. The current card is the same DOM node before/after OPEN.
  return <span ref={root} className="pane-strip-collapsed-group" data-pane-strip-collapsed-group={group.id}
    data-group-open={visible?'1':undefined} data-group-preparing={preparing?'1':undefined}
    data-group-direction={visible?view.direction:undefined}
    data-group-member-ids={JSON.stringify(entries.map(entry=>entry.tabId))}
    style={{marginBottom:rowGap}}
    onWheel={scrollWide}
    onMouseEnter={event=>{hovered.current=true;ownMeta();if(event.buttons&&!viewRef.current&&!requestRef.current)open('hover',false);}}
    onMouseLeave={event=>{hovered.current=paneStripHoverMenu(event.relatedTarget,latest.current.entries.map(entry=>entry.tabId)).owned;
      if(!viewRef.current&&!hovered.current){metaRelease.current?.();metaRelease.current=null;}}}
    onDoubleClick={event=>event.stopPropagation()}>
    {entries.map(entry=>{
      const isRepresentative=entry.tabId===representative,left=view?.offsets.get(entry.tabId)||0;
      return <span key={entry.tabId} data-strip-item data-strip-tab-id={entry.tabId}
        data-strip-group-inactive={!visible&&!isRepresentative?'1':undefined}
        style={{display:visible||preparing||isRepresentative?'inline-flex':'none',alignItems:'center',verticalAlign:'top',wordSpacing:'normal',
          position:isRepresentative?'relative':'absolute',left:isRepresentative?undefined:left,top:isRepresentative?undefined:0,
          ...(visible&&isRepresentative?{transform:`translateX(${left}px)`}:{}),
          visibility:preparing&&!isRepresentative?'hidden':undefined,pointerEvents:preparing&&!isRepresentative?'none':undefined,
        }}>
        {renderChip(entry,isRepresentative?control:{...control,count:0})}
      </span>;
    })}
    <PaneStripGroupOutline rootRef={root} scrollerRef={root} entriesKey={membersKey}
      layoutKey={JSON.stringify([layoutKey,representative,visible,view?.order,view?.direction,view?.anchorOffset,view?.measurementRevision])}
      groups={[group]} presented={presented} onMeasured={measured}/>
  </span>;
}
