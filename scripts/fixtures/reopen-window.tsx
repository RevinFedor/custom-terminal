import React from 'react';
import {createRoot} from 'react-dom/client';
import TabBar from '../../src/renderer/components/Workspace/TabBar';
import {SplitPaneAttachRow} from '../../src/renderer/components/Workspace/SplitPaneChrome';
import {useWorkspaceStore} from '../../src/renderer/store/useWorkspaceStore';
import {useProjectsStore} from '../../src/renderer/store/useProjectsStore';
import {useUIStore} from '../../src/renderer/store/useUIStore';
import {paneTabs} from '../../src/renderer/utils/splitPanesModel.mjs';
import {emptySpaceLayout} from '../../src/renderer/utils/workspaceSpacesModel.mjs';
import {installReopenHotkey} from './reopen-window-hotkey';
const {ipcRenderer}=window.require('electron');
const boot=await ipcRenderer.invoke('fixture:boot');
const {projectId:p,cwd,ids}=boot;
const makeTabs=()=>new Map(boot.tabs.map((t:any)=>[t.id,{...t}]));
function resetState(){
 const panes=[{projectId:p,tabId:ids.full,windowId:'window-main',tabs:[{projectId:p,tabId:ids.local},{projectId:p,tabId:ids.full}]},
  {projectId:p,tabId:ids.parent,windowId:'window-neighbour'}];
 const layout={...emptySpaceLayout(),splitPanes:panes,splitFocusedIndex:0,activeSpaceTab:{projectId:p,tabId:ids.full},activeProjectId:p,focusedProjectId:p};
 useWorkspaceStore.setState({view:'workspace',isRestoring:false,activeProjectId:p,focusedProjectId:p,openProjects:new Map([[p,{projectId:p,projectPath:cwd,
   tabs:makeTabs(),activeTabId:ids.full,tabHistory:[],tabCounter:1000,tabGroups:[],selectedTabIds:[],currentView:'terminal',sidebarOpen:false}]]),
   spaces:[{id:'fixture-main',name:'Main',projectIds:[p],layout}],activeSpaceId:'fixture-main',...layout,globalTabMru:[],projectHistory:[p],centerStrips:{},workspaceDisplay:null,windowDisplayKey:null,windowDisplayLayouts:{}} as any);
 useProjectsStore.setState({projects:{[p]:{id:p,path:cwd,name:'Reopen fixture'}}} as any);
 useUIStore.setState({activeArea:'workspace',showTabNumbers:false,terminalHistoryStreamingEnabled:false} as any);
}
resetState();
window.addEventListener('auxclick',event=>console.log('[FixtureAux] button='+event.button+' target='+
  (event.target as HTMLElement)?.tagName+' tab='+(event.target as HTMLElement)?.closest('[data-tab-id]')?.getAttribute('data-tab-id')),true);
installReopenHotkey({useWorkspaceStore,useUIStore,view:'workspace',showToast:(message:string)=>console.log('[FixtureToast] '+message)});
const snapshot=()=>{
 const s=useWorkspaceStore.getState(),w=s.openProjects.get(p)!;
 return{panes:s.splitPanes.map(pane=>({windowId:pane.windowId,shown:pane.tabId,tabs:paneTabs(pane).map(t=>({id:t.tabId,name:w.tabs.get(t.tabId)?.name}))})),
 tabs:[...w.tabs.values()].map(t=>({id:t.id,name:t.name,parent:t.visualParentTabId,session:t.codexSessionId})),focus:s.splitFocusedIndex};
};
(window as any).fixture={ready:true,ids,snapshot,reset:async()=>{await ipcRenderer.invoke('fixture:reset');resetState();}};
const empty=new Map<string,boolean>();
function Fixture(){
 const panes=useWorkspaceStore(s=>s.splitPanes);
 return <div style={{display:'flex',height:'100vh',background:'#181818',color:'#ccc'}}>
  <div style={{width:280,borderRight:'1px solid #444'}}><TabBar projectId={p} layout="vertical" sharedProcessStatus={empty} sharedBusyTabs={empty}/></div>
  <div style={{flex:1,display:'flex'}}>{panes.map((pane,index)=><div key={pane.windowId} data-fixture-pane={index} style={{flex:1,position:'relative',border:'1px solid #666'}}>
   <SplitPaneAttachRow projectId={pane.projectId||p} tabId={pane.tabId} vacant={!pane.tabId} paneIndex={index} focused={index===0} presented/>
   <div style={{paddingTop:70,fontSize:15}}>Окно {index+1}</div>
  </div>)}</div>
 </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
