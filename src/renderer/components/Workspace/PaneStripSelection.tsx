import React,{createContext,useContext,useEffect,useMemo,useRef,useState} from 'react';
import {useWorkspaceStore} from '../../store/useWorkspaceStore';
import {prunePaneStripSelection,selectPaneStripTab,paneStripSelectionEntries} from '../../utils/paneStripSelectionModel.mjs';
import type {StripEntry} from './PaneTabStrip';
import {readPaneStripOwnerEntries,capturePaneStripGroupDrag} from '../../utils/paneStripGroupsModel.mjs';
import {registerPaneStripOutsideSelection} from '../../utils/paneStripOutsideSelection.mjs';
import {getPaneTabDragSnapshot,subscribePaneTabDrag} from '../../utils/paneTabDragBridge';
import {getPaneTabPointerSnapshot,subscribePaneTabPointer} from '../../utils/paneTabPointerBridge';

export type PaneStripSelectionLease={
  version:1;workflowId:string;windowId:string|null;paneIndex:number|null;
  entries:StripEntry[];isCurrent:()=>boolean;
};
type Controller={
  selected:(tabId:string)=>boolean;
  click:(tabId:string,event:{metaKey?:boolean;shiftKey?:boolean})=>boolean;
  dragEntries:(tabId:string)=>StripEntry[];
  captureGroupDrag:(tabId:string,options?:{internalScope?:boolean})=>ReturnType<typeof capturePaneStripGroupDrag>|undefined;
  menu:(tabId:string)=>PaneStripSelectionLease|null;
};
export const PaneStripSelectionContext=createContext<Controller|null>(null);
export const usePaneStripSelection=()=>useContext(PaneStripSelectionContext);

/** Local to a retained window. No whole-catalog subscription or sidebar write. */
export function usePaneStripSelectionController({workflowId,windowId,paneIndex,entries,presented=true,rootRef}: {
  workflowId:string;windowId:string|null;paneIndex:number|null;entries:StripEntry[];presented?:boolean;rootRef?:React.RefObject<HTMLElement|null>;
}):Controller {
  const ownerKey=JSON.stringify([workflowId,windowId ?? paneIndex]);
  const orderKey=entries.map(e=>JSON.stringify([e.projectId,e.tabId])).join('|');
  const [selection,setSelection]=useState({ownerKey,tabIds:[] as string[],anchor:null as string|null});
  const latest=useRef<{ownerKey:string;entries:StripEntry[];selection:{tabIds:string[];anchor:string|null};generation:number;presented:boolean}>(
    {ownerKey,entries,selection,generation:0,presented});
  if(latest.current.ownerKey!==ownerKey) {
    latest.current={ownerKey,entries,selection:{tabIds:[],anchor:null},generation:latest.current.generation+1,presented};
  } else {
    const next=selection.ownerKey===ownerKey?prunePaneStripSelection(selection,entries):{tabIds:[],anchor:null};
    if(next.tabIds.join('\0')!==latest.current.selection.tabIds.join('\0')||presented!==latest.current.presented)latest.current.generation++;
    latest.current.entries=entries;latest.current.selection=next;latest.current.presented=presented;
  }
  useEffect(()=>{setSelection(prior=>({ownerKey,...prunePaneStripSelection(prior.ownerKey===ownerKey?prior:null,entries)}));},[ownerKey,orderKey]);
  useEffect(()=>()=>{latest.current.generation++;},[]);
  const hasSelection=latest.current.selection.tabIds.length>0;
  useEffect(()=>{
    if(!hasSelection)return;
    return registerPaneStripOutsideSelection({target:window,ownerKey,containsChip:chip=>!!rootRef?.current?.contains(chip),
      isDragging:()=>getPaneTabDragSnapshot().active||getPaneTabPointerSnapshot().active,
      subscribeDrag:listener=>{const pane=subscribePaneTabDrag(listener),reserve=subscribePaneTabPointer(listener);return()=>{pane();reserve();};},
      clear:()=>{if(!latest.current.selection.tabIds.length)return;latest.current.selection={tabIds:[],anchor:null};latest.current.generation++;
        setSelection({ownerKey:latest.current.ownerKey,tabIds:[],anchor:null});}});
  },[ownerKey,hasSelection,rootRef]);
  return useMemo(()=>({
    selected:(id:string)=>latest.current.selection.tabIds.includes(id),
    click:(id:string,event:{metaKey?:boolean;shiftKey?:boolean})=>{
      const value=selectPaneStripTab(latest.current.selection,latest.current.entries,id,event);
      latest.current.selection=value.selection;latest.current.generation++;
      setSelection({ownerKey,...value.selection});return !value.activate;
    },
    dragEntries:(id:string)=>paneStripSelectionEntries(latest.current.selection,latest.current.entries,id),
    captureGroupDrag:(id:string,options?:{internalScope?:boolean})=>{
      const captured=capturePaneStripGroupDrag({getState:useWorkspaceStore.getState,owner:{workflowId,windowId,paneIndex},
        sourceIds:paneStripSelectionEntries(latest.current.selection,latest.current.entries,id).map(entry=>entry.tabId),
        internalScope:options?.internalScope===true});
      return captured;
    },
    menu:(id:string)=>{
      const live=latest.current;if(!live.selection.tabIds.includes(id))return null;
      const captured=paneStripSelectionEntries(live.selection,live.entries,id).map(entry=>({...entry}));
      const generation=live.generation,key=live.ownerKey;
      const navigationRevision=useWorkspaceStore.getState().navigationRevision;
      return {version:1,workflowId,windowId,paneIndex,entries:captured,isCurrent:()=>{
        if(latest.current.ownerKey!==key||latest.current.generation!==generation||!latest.current.presented)return false;
        const state=useWorkspaceStore.getState();
        if(state.activeSpaceId!==workflowId || state.navigationRevision!==navigationRevision)return false;
        const strip=readPaneStripOwnerEntries(state,{workflowId,windowId,paneIndex});
        return !!strip&&captured.every(entry=>strip.some(item=>item.tabId===entry.tabId&&item.projectId===entry.projectId)
          &&state.openProjects.get(entry.projectId)?.tabs.has(entry.tabId)
          &&(!state.organizationReady||state.tabWorkflowMembership[entry.tabId]?.workflowId===workflowId));
      }};
    },
  }),[ownerKey,paneIndex,selection,orderKey]);
}
