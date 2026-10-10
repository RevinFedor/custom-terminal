import React, {useLayoutEffect,useMemo} from 'react';
import {ArrowLeft,ArrowRight,CircleX} from 'lucide-react';
import {useOutlineDnd} from '@noted/structured-dnd/react';
import {useWorkspaceStore} from '../../store/useWorkspaceStore';
import {useUIStore} from '../../store/useUIStore';
import {useOutlineDragCursor} from '../../hooks/useOutlineDragCursor';
import {useCommandHierarchyHint} from '../../hooks/useCommandHierarchyHint';
import {linkedFileOutline,captureLinkedFileDrag,linkedFileDragValid,linkedFileDragRequest} from '../../utils/tabLinkedFileTree.mjs';
import {tabOutlineHorizontalPolicy,tabOutlineVerticalSlotPolicy} from './tabOutlineModel.mjs';
import {isLinkedFilePreview} from '../../utils/tabLinkedFiles.mjs';
import {linkedFileWindowSnapshot} from '../../utils/tabLinkedFilePlacement.mjs';
import {openFileTabBeside} from '../../utils/openFileTabBeside';
import TabCard from './TabCard';
import type {LinkedFile} from './TabLinkedFiles';
import './WorkflowTabSidebar.css';

export default function TabLinkedFileTree({ownerTabId,files,onOpen,onContextMenu,onDraggingChange}:{
  ownerTabId:string;files:LinkedFile[];onOpen:(file:LinkedFile)=>void;
  onContextMenu:(event:React.MouseEvent,file:LinkedFile)=>void;onDraggingChange:(active:boolean)=>void;
}) {
  const outline=useMemo(()=>linkedFileOutline(files),[files]);
  const space=useWorkspaceStore(s=>s.activeSpaceId),view=useWorkspaceStore(s=>s.view);
  const preview=useUIStore(s=>s.filePreview);
  const windowSnapshot=useWorkspaceStore(s=>linkedFileWindowSnapshot(s,files));
  const windowStates=useMemo(()=>new Map<string,string|null>(JSON.parse(windowSnapshot)),[windowSnapshot]);
  const dnd=useOutlineDnd({outline,scopeKey:`file-tree:${space}:${view}:${ownerTabId}`,
    hierarchyModifier:'meta',
    outsidePointerPolicy:'cancel',ignoreSelector:'input,[data-no-drag]',
    layoutAnimation:{duration:120,easing:'cubic-bezier(0.2, 0, 0, 1)',respectReducedMotion:false,
      maxAnimatedRows:14,minRetargetInterval:72,animateDuringScroll:false},
    getDragSource:input=>{
      const admission=captureLinkedFileDrag(useWorkspaceStore.getState(),ownerTabId,input);
      return admission ? {rootIds:admission.sourceRootIds,context:admission}:false;
    },
    validateDragSource:drag=>linkedFileDragValid(drag.sourceContext,useWorkspaceStore.getState()),
    canHorizontalMove:tabOutlineHorizontalPolicy,canUseVerticalSlot:tabOutlineVerticalSlotPolicy,
    onCommit:payload=>useWorkspaceStore.getState().commitWorkflowDrag(
      linkedFileDragRequest(payload.sourceContext,payload.previewOutline),{isCurrent:payload.isCurrent}),
    onLog:event=>{if(['start','commit','cancel','horizontal','horizontal-blocked','commit-rejected','commit-error'].includes(event.type))
      console.log(`[LinkedFileDnd:${event.type}] owner=${ownerTabId} session=${event.sessionId} source=${event.sourceId} detail=${JSON.stringify(event.detail)}`);},
  });
  useOutlineDragCursor(dnd.dragState,dnd.scrollerRef);
  useCommandHierarchyHint(dnd.scrollerRef);
  const active=!!dnd.dragState;
  useLayoutEffect(()=>{onDraggingChange(active);return()=>onDraggingChange(false);},[active,onDraggingChange]);
  const nodes=new Map<string,any>();
  const walk=(tree:any[])=>tree.forEach(node=>{nodes.set(String(node.id),node);walk(node.children || []);});walk(dnd.previewOutline);
  return <div data-linked-file-tree={ownerTabId} className="tab-linked-file-tree" ref={element=>{dnd.scrollerRef.current=element;}}>
    {dnd.rows.map(row=>{
      const node=nodes.get(String(row.id)),file=node.file as LinkedFile;
      const windowState=windowStates.get(file.id);
      const feedback=dnd.dragState?.sourceId===row.id ? dnd.dragState.feedback:null;
      return <div {...dnd.getRowProps(row)} key={row.id} className="tab-linked-file-tree-row"
        style={{marginLeft:row.depth*12,maxWidth:`calc(100% - ${row.depth*12}px)`}}>
        {row.depth>0 && <span aria-hidden className="workflow-reserve-connectors" style={{color:'#a78bfa66'}}>
          {row.ancestorContinuationDepths.map(depth=><span key={depth} className="workflow-reserve-connector continuation" style={{left:-7-(row.depth-depth-1)*12}}/>)}
          <span className="workflow-reserve-connector top"/>{row.hasNextSibling && <span className="workflow-reserve-connector bottom"/>}
          <span className="workflow-reserve-connector elbow"/>
        </span>}
        <TabCard projectId={file.projectId} tabId={file.id} as="span" role="menuitem" tabIndex={0}
          className="tab-linked-files-row" data-linked-file-id={file.id}
          active={isLinkedFilePreview(preview,ownerTabId,file.id,file.projectId)||windowState==='shown'}
          style={{width:'max-content',maxWidth:'100%',boxShadow:windowState
            ? `inset 2px 0 0 ${windowState==='shown'?'#7dd3fc':'#7dd3fc77'}`:undefined}}
          title={file.path+(windowState?`\n${windowState==='shown'?'Open in a window':'Open as tab'}`:'')}
          data-file-window-state={windowState || undefined}
          data-file-selected={isLinkedFilePreview(preview,ownerTabId,file.id,file.projectId)||windowState==='shown'?'1':undefined}
          onClick={event=>{event.stopPropagation();onOpen(file);}}
          onPointerDown={event=>{if(event.button===1){event.preventDefault();event.stopPropagation();}}}
          onMouseDown={event=>{if(event.button===1){event.preventDefault();event.stopPropagation();}}}
          onAuxClick={async event=>{
            if(event.button!==1)return;
            event.preventDefault();event.stopPropagation();
            if(dnd.dragState)return;
            await openFileTabBeside(file.projectId,file.id,file);
          }}
          onKeyDown={event=>{if(event.key==='Enter' || event.key===' '){event.preventDefault();event.currentTarget.click();}}}
          onContextMenu={event=>onContextMenu(event,file)}>
          <span>{file.name}</span>
          {feedback && <span className="tab-linked-file-feedback" data-file-dnd-feedback={feedback.direction}
            data-blocked={feedback.blocked?'1':undefined} style={{opacity:Math.max(.18,feedback.progress || 0)}}>
            {feedback.blocked?<CircleX size={12}/>:feedback.direction==='left'?<ArrowLeft size={12}/>:<ArrowRight size={12}/>}
          </span>}
        </TabCard>
      </div>;
    })}
    <div {...dnd.scrollSpacerProps}/>
  </div>;
}
