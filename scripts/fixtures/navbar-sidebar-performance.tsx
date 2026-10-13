import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import PaneTabChip from '../../src/renderer/components/Workspace/PaneTabChip';
import ConnectedWorkflowSidebar from '../../src/renderer/components/Workspace/ConnectedWorkflowSidebar';
import {useWorkspaceStore,reset} from './workflow-reserve-dnd-store';
import {getPaneTabPointerSnapshot} from '../../src/renderer/utils/paneTabPointerBridge';
import {cancelPaneTabPointerDrag} from '../../src/renderer/utils/paneTabPointerGesture';

const metrics=(window as any).__dndPerf={active:false,publishes:0,hostRenders:0,cardRenders:0,boundaries:0,rowReads:0,folderReads:0,storeChanges:0,frames:[]};
let generation=0;
function setup(count:number) {
  cancelPaneTabPointerDrag('fixture-reset');reset({pane:true,selected:[]});
  const state=useWorkspaceStore.getState(),old=state.openProjects.get('P'),tabs=new Map(old.tabs);
  for(const id of ['A','Q','Z','child'])tabs.delete(id);
  Object.assign(tabs.get('B'),{tabType:'claude',commandType:'claude',color:'claude',name:'Claude source',claudeSessionId:'fixture-closed-claude'});
  const ids=Array.from({length:count},(_,i)=>'R'+i);
  for(const id of ids)tabs.set(id,{id,name:'Reserve '+id,cwd:'/fixture',tabType:'terminal'});
  const catalog=Object.fromEntries([...tabs.keys()].map((id,i)=>[id,{active:true,storageId:i+1,physicalParentTabId:null,executionSubject:{version:1,projectId:'P'}}]));
  const membership=Object.fromEntries([...tabs.keys()].map(id=>[id,{workflowId:'w1',revision:1}]));
  const pane={windowId:'window-w1',projectId:'P',tabId:'B',tabs:[{projectId:'P',tabId:'B'}]};
  useWorkspaceStore.setState({openProjects:new Map([['P',{...old,tabs}]]),tabCatalog:catalog,tabWorkflowMembership:membership,
    splitPanes:[pane],spaces:state.spaces.map((s:any)=>s.id==='w1'?{...s,reserveOrder:ids,layout:{...s.layout,splitPanes:[pane]}}:s),
    activateCenterTab:()=>{},focusSplitPane:()=>{},detachTabFromWindow:()=>true,clearTabFromSplitPane:()=>{},
  });
}
setup(10);
const nativeRaf=window.requestAnimationFrame.bind(window),nativeCancel=window.cancelAnimationFrame.bind(window);
let gated=false,rafId=0;const queuedRaf=new Map<number,FrameRequestCallback>();
function gateFrames(enabled:boolean){
  if(enabled===gated)return;gated=enabled;
  if(enabled){window.requestAnimationFrame=callback=>{const id=--rafId;queuedRaf.set(id,callback);return id;};
    window.cancelAnimationFrame=id=>{if(id<0)queuedRaf.delete(id);else nativeCancel(id);};}
  else {window.requestAnimationFrame=nativeRaf;window.cancelAnimationFrame=nativeCancel;
    const callbacks=[...queuedRaf.values()];queuedRaf.clear();callbacks.forEach(callback=>nativeRaf(callback));}
}
const activity={processStatus:new Map(),busyTabs:new Map(),pasteBusyTabs:new Map()};
function App() {
  const [version,setVersion]=useState(0);
  (window as any).navbarFixture={reset:(n:number)=>{metrics.active=false;setup(n);setVersion(++generation);},
    gateFrames,
    begin:()=>{Object.assign(metrics,{active:true,publishes:0,hostRenders:0,cardRenders:0,boundaries:0,rowReads:0,folderReads:0,storeChanges:0,frames:[]});metrics.debug.capture();},
    end:()=>{metrics.active=false;return{publishes:metrics.publishes,hostRenders:metrics.hostRenders,cardRenders:metrics.cardRenders,boundaries:metrics.boundaries,rowReads:metrics.rowReads,folderReads:metrics.folderReads,storeChanges:metrics.storeChanges,
      frames:metrics.frames,gate:metrics.gate,pointer:getPaneTabPointerSnapshot(),oracle:metrics.debug.read(),attempts:(window as any).fixture.attempts,commits:(window as any).fixture.commits};},
    rename:()=>{const s=useWorkspaceStore.getState(),ws=s.openProjects.get('P'),tabs=new Map(ws.tabs);tabs.set('R0',{...tabs.get('R0'),name:'LIVE R0'});useWorkspaceStore.setState({openProjects:new Map([['P',{...ws,tabs}]])});},
  };
  return <div key={version}><header data-source-header style={{position:'absolute',left:380,top:10,width:400,height:45}}>
    <PaneTabChip projectId="P" tabId="B" shown paneFocused paneIndex={0} inSplit inStrip sharedActivity={activity}/>
  </header><main style={{position:'absolute',left:20,top:80,height:480,width:280}}>
    <ConnectedWorkflowSidebar activity={activity}/></main></div>;
}
useWorkspaceStore.subscribe(()=>{if(metrics.active)metrics.storeChanges++;});
const frame=(t:number)=>{if(metrics.active)metrics.frames.push(t);requestAnimationFrame(frame);};requestAnimationFrame(frame);
createRoot(document.getElementById('root')!).render(<App/>);
