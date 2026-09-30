import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import PaneTabChip from '../../src/renderer/components/Workspace/PaneTabChip';
import {useWorkspaceStore} from '../../src/renderer/store/useWorkspaceStore';
import {useUIStore} from '../../src/renderer/store/useUIStore';
import '../../packages/claude-blocks/src/blocks.css';
const {ipcRenderer}=window.require('electron');
const projectId='synthetic-project', parentId='synthetic-parent', childId='synthetic-child';
const mk=(id:string,name:string,parent?:string)=>({id,name,cwd:'/synthetic',tabType:'terminal',commandType:'codex',color:'codex',
  codexSessionId:id+'-session',visualParentTabId:parent,aiBusy:false});
const parent=mk(parentId,'Parent'),child=mk(childId,'Fork',parentId);
useUIStore.setState({sessionStatuses:[],taskStatuses:[]} as any);
useWorkspaceStore.setState({activeProjectId:projectId,openProjects:new Map([[projectId,{projectId,projectPath:'/synthetic',tabs:new Map([[parentId,parent],[childId,child]]),
  activeTabId:childId,currentView:'terminal',selectedTabIds:[],tabGroups:[],tabHistory:[parentId,childId]}]] )} as any);
const sharedActivity={processStatus:new Map(),busyTabs:new Map(),pasteBusyTabs:new Map()};
(window as any).fixture={ready:true,childId,parentId,projectId};
function Fixture(){
 const [status,setStatus]=useState('Ready');
 const [saved,setSaved]=useState('');
 useEffect(()=>{const handler=(_e:any,value:string)=>setSaved(value);ipcRenderer.on('fixture:saved',handler);return()=>{ipcRenderer.removeListener('fixture:saved',handler);};},[]);
 return <div style={{padding:20,background:'#1a1a1a',minHeight:'100vh',color:'#ddd'}}>
  <div style={{display:'flex',gap:8}}>
   {[parentId,childId].map((id,index)=><PaneTabChip key={id} projectId={projectId} tabId={id} shown={id===childId}
    paneFocused paneIndex={0} inSplit={false} inStrip index={index} sharedActivity={sharedActivity}/>)}
  </div>
  <button data-start-read onClick={()=>{setStatus('Reading');void ipcRenderer.invoke('fixture:read').then((r:any)=>setStatus(r.ok?'Complete':'Failed'));}}>Read fork</button>
  <div data-read-status>{status}</div><div data-saved-name>{saved}</div>
 </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
