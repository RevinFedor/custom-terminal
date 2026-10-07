import React,{useEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import ConnectedWorkflowSidebar from '../../src/renderer/components/Workspace/ConnectedWorkflowSidebar';
import TabDragNavigationController from '../../src/renderer/components/Workspace/TabDragNavigationController';
import {bindPaneTabPointerDrag} from '../../src/renderer/utils/paneTabPointerGesture';
import {useWorkspaceStore,reset} from './workflow-reserve-dnd-store';
import {getPaneTabPointerSnapshot} from '../../src/renderer/utils/paneTabPointerBridge';
import {getPaneTabDragSnapshot} from '../../src/renderer/utils/paneTabDragBridge';
reset();
function Fixture(){
  const workflow=useWorkspaceStore(state=>state.activeSpaceId),ref=useRef<HTMLDivElement>(null);
  useEffect(()=>bindPaneTabPointerDrag(ref.current!,()=>({owner:'pane',rootTabId:'B',sourcePaneKey:'pane:0',sourceSpaceId:'w1',
    entries:[{projectId:'P',tabId:'A'},{projectId:'P',tabId:'B'}]})),[]);
  return <><nav style={{display:'flex',gap:20,height:40}}>{['w1','w2'].map(id=><button key={id} data-space-chip={id}
    onClick={()=>useWorkspaceStore.getState().switchWorkspaceSpace(id)}>{id}</button>)}</nav>
    <div data-pane-source ref={ref} style={{position:'absolute',left:400,top:10,padding:10,background:'#376'}}>Pane A+B</div>
    <div style={{position:'absolute',top:70,left:20,height:500}}><ConnectedWorkflowSidebar activity={{} as any}/></div>
    <div data-pane-tab-drop-zone="body" data-pane-key="pane:0" data-space-id={workflow}
      style={{position:'absolute',left:330,top:90,width:440,height:450,border:'1px solid #666'}}>Window {workflow}</div>
    <TabDragNavigationController onNavigateProject={()=>{}}/></>;
}
(window as any).fixture.snapshot=()=>({pointer:getPaneTabPointerSnapshot(),pane:getPaneTabDragSnapshot(),
  rows:[...document.querySelectorAll('[data-outline-dnd-row]')].map((el:any)=>({id:el.dataset.nodeId,parent:el.dataset.parentId,
    source:el.dataset.outlineDndSource,rect:el.getBoundingClientRect().toJSON()}))});
createRoot(document.getElementById('root')!).render(<Fixture/>);
