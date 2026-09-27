import React from 'react';
import { createRoot } from 'react-dom/client';
import TabBar from '../../src/renderer/components/Workspace/TabBar';
import TabSwitcherOverlay from '../../src/renderer/components/Workspace/TabSwitcherOverlay';
import { SplitFilePane } from '../../src/renderer/components/Workspace/SplitPaneChrome';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useProjectsStore } from '../../src/renderer/store/useProjectsStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import { paneTabs } from '../../src/renderer/utils/splitPanesModel.mjs';
import { emptySpaceLayout } from '../../src/renderer/utils/workspaceSpacesModel.mjs';
const p='fixture-p',q='fixture-q',cwd='/synthetic';
const makeTab=(id:string,extra={})=>({id,name:id,cwd,color:'default',tabType:'terminal',commandType:'generic',...extra});
const tabs=new Map(['A','B','PIN','OWNER','FILE','MISSING'].map(id=>[id,makeTab(id,
 id==='FILE'?{tabType:'file',filePath:'/synthetic/FILE.md',visualParentTabId:'OWNER'}:
 id==='MISSING'?{tabType:'file',filePath:'/synthetic/missing.md'}:{})]));
const ws=(projectId:string,ts:Map<string,any>,activeTabId:string)=>({projectId,projectPath:cwd,tabs:ts,activeTabId,
 currentView:'terminal',selectedTabIds:[],tabGroups:[],tabHistory:[],tabCounter:8,sidebarOpen:false,openFilePath:null,
 sidebarExpandedDirs:null,sidebarScrollTop:0,tabListScrollTop:0,viewingSubAgentTabId:null});
const panes=[{projectId:p,tabId:'OWNER',windowId:'window-owner'},{projectId:p,tabId:'A',windowId:'window-main',tabs:[{projectId:p,tabId:'A'},{projectId:p,tabId:'PIN'}]}];
const main={...emptySpaceLayout(),splitPanes:panes,splitFocusedIndex:1,activeSpaceTab:{projectId:p,tabId:'A'},activeProjectId:p,focusedProjectId:p};
useWorkspaceStore.setState({view:'workspace',isRestoring:false,activeProjectId:q,focusedProjectId:q,
 openProjects:new Map([[p,ws(p,tabs,'A')],[q,ws(q,new Map([['OTHER',makeTab('OTHER')]]),'OTHER')]]),
 projectHistory:[p,q],globalTabMru:[{projectId:q,tabId:'OTHER'},{projectId:p,tabId:'A'}],spaces:[
 {id:'main',name:'Main',projectIds:[p],layout:main},
 {id:'other',name:'Other',projectIds:[q],layout:{...emptySpaceLayout(),splitPanes:[{projectId:q,tabId:'OTHER',windowId:'window-other'}],activeSpaceTab:{projectId:q,tabId:'OTHER'},activeProjectId:q,focusedProjectId:q}}],
 activeSpaceId:'other',splitPanes:[{projectId:q,tabId:'OTHER',windowId:'window-other'}],splitFocusedIndex:0,
 centerStrips:{},workspaceDisplay:null,windowDisplayKey:null,windowDisplayLayouts:{}} as any);
useProjectsStore.setState({projects:{[p]:{id:p,path:cwd,name:'Main'},[q]:{id:q,path:cwd,name:'Other'}} as any});
useUIStore.setState({activeArea:'workspace',terminalHistoryStreamingEnabled:false,showTabNumbers:false} as any);
useWorkspaceStore.getState().switchWorkspaceSpace('main');
const snapshot=()=>{const s=useWorkspaceStore.getState();return{active:s.openProjects.get(s.activeProjectId!)?.activeTabId,space:s.activeSpaceId,
 mru:s.globalTabMru.map(e=>e.tabId),panes:s.splitPanes.map(p=>({tabId:p.tabId,tabs:paneTabs(p).map(t=>t.tabId)}))};};
// Hold only this private renderer's frame callbacks to reproduce input arriving
// while the switcher has mounted but has not presented its first frame yet.
const nativeRaf=window.requestAnimationFrame.bind(window);
const nativeCancel=window.cancelAnimationFrame.bind(window);
let framesHeld=false, nextFrame=1000000000;
const pendingFrames=new Map<number,FrameRequestCallback>();
window.requestAnimationFrame=(cb)=>{
 if(!framesHeld)return nativeRaf(cb);
 const id=nextFrame++;pendingFrames.set(id,cb);return id;
};
window.cancelAnimationFrame=(id)=>{if(!pendingFrames.delete(id))nativeCancel(id);};
(window as any).fixture={snapshot,store:useWorkspaceStore,
 showA:()=>{useWorkspaceStore.getState().switchWorkspaceSpace('main');useWorkspaceStore.getState().placeTab(p,'A');},
 holdFrames:()=>{framesHeld=true;},
 releaseFrames:()=>{framesHeld=false;for(const cb of pendingFrames.values())nativeRaf(cb);pendingFrames.clear();},
};
const empty=new Map<string,boolean>();
function Fixture(){
 const s=useWorkspaceStore(st=>st.openProjects);
 const active=useWorkspaceStore(st=>st.activeProjectId)||p;
 const current=s.get(active)?.activeTabId;
 return <><div style={{display:'flex',height:'100vh'}}>
 <div style={{width:280}}><TabBar projectId={p} layout="vertical" sharedProcessStatus={empty} sharedBusyTabs={empty} sharedPasteBusyTabs={empty}/></div>
 <div style={{position:'relative',flex:1}}>{current==='FILE'?<SplitFilePane filePath="/synthetic/FILE.md" visible/>:<div data-current>{current}</div>}</div>
 </div><TabSwitcherOverlay processStatus={empty} busyTabs={empty} pasteBusyTabs={empty}/></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
