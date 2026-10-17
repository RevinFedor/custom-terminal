import {uiDragDiagnostic} from './uiPerformanceDiagnostics.mjs';
import {beginPaneTabDrag,endPaneTabDrag,type PaneTabDragSource} from './paneTabDragBridge';
import {updatePaneTabPointer,finishPaneTabPointer,cancelPaneTabPointer,getPaneTabPointerSnapshot} from './paneTabPointerBridge';
import {beginSidebarTabDrag,endSidebarTabDrag} from './sidebarTabDragBridge.mjs';
import {setTabDragNavigationTarget,clearTabDragNavigationTarget} from './tabDragNavigationBridge';
import {useWorkspaceStore} from '../store/useWorkspaceStore';
import {workflowDragSourceValid} from './workflowDragModel.mjs';

type Point={clientX:number;clientY:number;pointerId:number;metaKey:boolean;grabOffsetY?:number};
let active:{source:PaneTabDragSource;point:Point;cleanup:()=>void;frame:number}|null=null;
export const reserveReleaseOwner=(workflowId:string,source:PaneTabDragSource)=>`reserve:${workflowId}:${source.gestureId}`;

function finish(cancelled:boolean,reason='release') {
  const drag=active;if(!drag)return;
  console.log(`[WorkflowReserveDnd:transport-end] state=${JSON.stringify({sessionId:drag.source.gestureId,cancelled,reason,point:drag.point})}`);
  active=null;drag.cleanup();cancelAnimationFrame(drag.frame);
  if(getPaneTabPointerSnapshot().source?.gestureId===drag.source.gestureId) {
    if(cancelled)cancelPaneTabPointer();else finishPaneTabPointer(drag.point);
  }
  endPaneTabDrag(drag.source.rootTabId,drag.source.gestureId);
  endSidebarTabDrag(drag.source.gestureId);
  clearTabDragNavigationTarget('sidebar');
  uiDragDiagnostic('physical-end',{gestureId:drag.source.gestureId,reason:cancelled?'cancel:'+reason:'release',x:drag.point.clientX,y:drag.point.clientY});
}

/** Physical ownership outlives a reserve host replaced by workflow hover. */
export function beginReserveDragTransport(admission:any,point:Point,sourceNode:any) {
  finish(true,'new-gesture');
  const source:PaneTabDragSource={owner:'sidebar',input:'pointer',gestureId:admission.gestureId,
    entries:admission.paneEntries,rootTabId:admission.paneEntries[0]?.tabId || '',
    sourceSpaceId:admission.sourceWorkflowId,pointerId:point.pointerId,workflowDrag:admission,
    sourceGrabOffsetY:point.grabOffsetY};
  const drag={source,point,cleanup:()=>{},frame:0};active=drag;
  let receivedMoves=0;
  let metaHeld=point.metaKey;
  beginPaneTabDrag(source);
  beginSidebarTabDrag({sessionId:admission.gestureId,sourceProjectId:sourceNode.projectId || source.entries[0]?.projectId,
    sourceId:admission.sourceId,sourceNode,rootTabId:source.rootTabId,tabIds:admission.familyIds,...point});
  const paint=()=>{
    drag.frame=0;if(active!==drag)return;
    const p=drag.point,element=document.elementFromPoint(p.clientX,p.clientY);
    const workflowId=sourceNode.entityType==='tab'
      ? element?.closest<HTMLElement>('[data-space-chip]')?.dataset.spaceChip:null;
    if(workflowId)setTabDragNavigationTarget('sidebar',{kind:'workflow',id:workflowId,...p,
      blocked:workflowId===useWorkspaceStore.getState().activeSpaceId});
    else clearTabDragNavigationTarget('sidebar');
  };
  const publish=()=>{updatePaneTabPointer(source,drag.point);if(!drag.frame)drag.frame=requestAnimationFrame(paint);};
  const move=(event:PointerEvent)=>{
    if(event.pointerId!==point.pointerId)return;
    receivedMoves+=1;
    if(!(event.buttons&1)){finish(true,'buttons-zero');return;}
    drag.point={clientX:event.clientX,clientY:event.clientY,pointerId:event.pointerId,metaKey:event.metaKey || metaHeld};publish();
  };
  const up=(event:PointerEvent)=>{
    if(event.pointerId!==point.pointerId)return;
    console.log(`[WorkflowReserveDnd:transport-release] state=${JSON.stringify({sessionId:admission.gestureId,receivedMoves,
      lastMove:drag.point,release:{x:event.clientX,y:event.clientY,pointerId:event.pointerId,buttons:event.buttons,metaKey:event.metaKey},metaHeld})}`);
    drag.point={...drag.point,clientX:event.clientX,clientY:event.clientY,metaKey:event.metaKey || metaHeld};finish(false);
  };
  const cancel=()=>finish(true,'cancel');
  const pointerCancel=(event:PointerEvent)=>{if(event.pointerId===point.pointerId)cancel();};
  const key=(event:KeyboardEvent)=>{
    if(event.key==='Escape'){event.preventDefault();cancel();return;}
    if(event.key==='Meta'){metaHeld=event.type==='keydown';drag.point={...drag.point,metaKey:metaHeld};publish();}
  };
  const nextPickup=()=>cancel();
  const stop=useWorkspaceStore.subscribe(state=>{if(!workflowDragSourceValid(admission,state))cancel();});
  window.addEventListener('pointermove',move,true);window.addEventListener('pointerup',up,true);
  window.addEventListener('pointercancel',pointerCancel,true);window.addEventListener('blur',cancel);
  window.addEventListener('keydown',key,true);window.addEventListener('keyup',key,true);
  window.addEventListener('pointerdown',nextPickup,true);
  drag.cleanup=()=>{
    stop();window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',up,true);
    window.removeEventListener('pointercancel',pointerCancel,true);window.removeEventListener('blur',cancel);
    window.removeEventListener('keydown',key,true);window.removeEventListener('keyup',key,true);
    window.removeEventListener('pointerdown',nextPickup,true);
  };
  publish();return source;
}
