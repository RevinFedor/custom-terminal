import React from 'react';
import {createRoot} from 'react-dom/client';
import Timeline from '../../src/renderer/components/Workspace/Timeline';
import {HistoryPromptSource} from '../../src/renderer/components/Workspace/TabMessageSourceChip';
import {TabMessageRow} from '../../src/renderer/components/Workspace/TabMessageTracker';
import {OrchestrationStatusChip} from '../../src/renderer/components/Workspace/OrchestrationStatusChip';
import {useWorkspaceStore} from '../../src/renderer/store/useWorkspaceStore';
import {useUIStore} from '../../src/renderer/store/useUIStore';
const {ipcRenderer}=window.require('electron');
const tabId='private-navigation-tab',sessionId='private-navigation-session',projectId='private-navigation-project';
const state:any=(window as any).navigationFixture={calls:[],actions:[],ready:false};
const researchRun={runId:'exact-run',runKind:'external-research',sourceTabId:tabId,
  targetTabId:null,targetTabName:'ChatGPT · 6-astra',targetProjectName:'SC Desktop',
  status:'running',createdAt:1700000000000,updatedAt:1700000000000,externalResearchJobId:'noted_exact-job'};
let observerRun:any=null;
state.showObserver=(patch:any={})=>{
  observerRun={runId:'observed-run',runKind:'response-observation',sourceTabId:tabId,
    targetTabId:'observed-tab',targetTabName:'Observed work',targetProjectName:'Fixture',status:'running',
    createdAt:Date.now(),updatedAt:Date.now(),...patch};
  ipcRenderer.emit('orchestration:changed',{}, {run:observerRun});
};
const makeEntries=(groupSize:number)=>Array.from({length:groupSize+4},(_,i)=>({uuid:'entry-'+i,type:'user',sessionId,content:'Iteration '+i,
  timestamp:new Date(1700000000000+i*1000).toISOString(),...(i>1&&i<groupSize+2?{semanticTags:[{kind:'orchestration',runId:'run-'+i,phase:'completion',
    ...(i===3?{runKind:'external-research',targetTabName:'ChatGPT - 6-astra'}:{runKind:'agent'})}],
    ...(i===3?{docsEdited:['sample.md'],docsSearchQueries:['test'],hasPromptChip:true}: {})}: {})}));
let entries=makeEntries(10);
state.setGroupSize=(size:number)=>{
  entries=makeEntries(size);
  ipcRenderer.emit('agent-transcript:changed',{}, {sessionId,toolType:'codex',reason:'private-group-geometry'});
};
const invoke=ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke=async(channel:string,...args:any[])=>{
  state.calls.push(channel);
  if(channel==='orchestration:list-for-tab')return[researchRun];
  if(channel==='orchestration:get-settings')return null;
  if(channel==='orchestration:action'){
    state.actions.push(args[0]);
    if(args[0].runId!==observerRun?.runId||args[0].action!=='detach')throw Error('Unexpected fixture action');
    observerRun={...observerRun,status:'cancelled',updatedAt:Date.now()};
    return{ok:true,run:observerRun};
  }
  if(channel==='orchestration:acknowledge')return{...researchRun};
  if(channel==='tab-messages:list')return[];
  if(channel==='orchestration:open-research-job'&&state.researchNavigationError)return{success:false,error:state.researchNavigationError};
  if(channel==='agent-transcript:get-timeline')return{success:true,entries};
  if(channel==='agent-transcript:subscribe'||channel==='agent-transcript:unsubscribe')return{success:true};
  if(channel==='timeline:get-notes')return{success:true,notes:{'entry-5':'Child note'},positions:{'entry-5':'after'}};
  if(channel==='tab-work-context:get')return{success:true,context:{tabId,revision:1,files:[],updates:[],pendingCount:0}};
  if(channel==='agent-session:get-availability-batch')return{success:true,results:(args[0]?.sessions||[]).map((s:any)=>({...s,state:'available',historyState:'available',checkedAt:Date.now()}))};
  return invoke(channel,...args);
};
useWorkspaceStore.setState({activeProjectId:projectId,openProjects:new Map([[projectId,{projectId,projectPath:'/synthetic',
  tabs:new Map([[tabId,{id:tabId,name:'Source',commandType:'codex',codexSessionId:sessionId,tabType:'file',aiBusy:false}]]),
  activeTabId:tabId,currentView:'terminal',selectedTabIds:[],tabGroups:[]}]]),view:'workspace'} as any);
useUIStore.setState({promptSummaryGlobalAuto:false,terminalHistoryStreamingEnabled:false,timelineTreeModeTabs:{[tabId]:false}} as any);
state.tree=()=>useUIStore.getState().timelineTreeModeTabs[tabId];
const stages=['pending','sending','sent','unconfirmed','failed'];
function Fixture(){
  const [tracker,setTracker]=React.useState(false);
  state.showTracker=()=>setTracker(true);
  if(tracker)return <div data-split-pane-queue-host style={{position:'relative',height:'100vh',background:'#181818'}}>
    <div data-prompt-queue-owner style={{position:'absolute',top:12,right:12,display:'flex',gap:4}}>
      <OrchestrationStatusChip tabId={tabId} panelOpen={false} effectiveWidth={240}/>
    </div>
  </div>;
  return <div style={{position:'relative',height:'100vh',background:'#181818',padding:12,color:'#ccc'}}>
  <div style={{maxWidth:'calc(100% - 44px)'}}>
    {['question','reply'].map(phase=><div key={phase} data-source-hover-case={phase}
      style={{padding:6,background:'rgba(167,139,250,0.06)'}}>
      <HistoryPromptSource source={{messageId:'hover-'+phase,sourceTabId:tabId,sourceTabName:'optimization windows'}} phase={phase}/>
    </div>)}
    <HistoryPromptSource source={{label:'ChatGPT · 6-astra',researchRunId:'exact-run'}} phase="completion"/>
    {stages.map((deliveryState,i)=>{
      const question:any={messageId:'message-'+i,kind:'question',sourceTabId:tabId,sourceTabName:'Peer '+deliveryState,
        targetTabId:'recipient',deliveryState,createdAt:Date.now(),updatedAt:Date.now()};
      return <TabMessageRow key={i} thread={{question,incoming:true,answerAvailable:false,reply:null}} tabId="recipient" onOpen={()=>{}}/>;
    })}
  </div>
  <Timeline tabId={tabId} sessionId={sessionId} cwd="/synthetic" toolType="codex" isVisible isOpen
    isActive={false} historySurfaceVisible backgroundPrewarmAdmitted/>
</div>}
createRoot(document.getElementById('root')!).render(<Fixture/>);
state.ready=true;
