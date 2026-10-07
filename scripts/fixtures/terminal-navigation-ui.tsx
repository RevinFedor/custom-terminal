import React from 'react';
import {createRoot} from 'react-dom/client';
import Timeline from '../../src/renderer/components/Workspace/Timeline';
import {HistoryPromptSource} from '../../src/renderer/components/Workspace/TabMessageSourceChip';
import {TabMessageRow} from '../../src/renderer/components/Workspace/TabMessageTracker';
import {useWorkspaceStore} from '../../src/renderer/store/useWorkspaceStore';
import {useUIStore} from '../../src/renderer/store/useUIStore';
const {ipcRenderer}=window.require('electron');
const tabId='private-navigation-tab',sessionId='private-navigation-session',projectId='private-navigation-project';
const state:any=(window as any).navigationFixture={calls:[],ready:false};
const entries=Array.from({length:14},(_,i)=>({uuid:'entry-'+i,type:'user',sessionId,content:'Iteration '+i,
  timestamp:new Date(1700000000000+i*1000).toISOString(),...(i>1&&i<12?{semanticTags:[{kind:'orchestration',runId:'run-'+i,phase:'completion',
    ...(i===3?{runKind:'external-research',targetTabName:'ChatGPT - 6-astra'}:{runKind:'agent'})}],
    ...(i===3?{docsEdited:['sample.md'],docsSearchQueries:['test'],hasPromptChip:true}: {})}: {})}));
const invoke=ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke=async(channel:string,...args:any[])=>{
  state.calls.push(channel);
  if(channel==='agent-transcript:get-timeline')return{success:true,entries};
  if(channel==='agent-transcript:subscribe'||channel==='agent-transcript:unsubscribe')return{success:true};
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
function Fixture(){return <div style={{position:'relative',height:'100vh',background:'#181818',padding:12,color:'#ccc'}}>
  <div style={{maxWidth:'calc(100% - 44px)'}}>
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
