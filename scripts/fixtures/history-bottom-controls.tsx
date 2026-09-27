import React from 'react';
import {createRoot} from 'react-dom/client';
import HistoryPanel from '../../src/renderer/components/Workspace/HistoryPanel';
import {useWorkspaceStore} from '../../src/renderer/store/useWorkspaceStore';
import {useUIStore} from '../../src/renderer/store/useUIStore';
import '../../packages/claude-blocks/src/blocks.css';
const {ipcRenderer}=window.require('electron');
const tabId='controls-tab',sessionId='controls-session',projectId='controls-project',cwd='/synthetic';
const entries=Array.from({length:100},(_,i)=>({uuid:'row-'+i,role:i%2?'assistant':'user',sessionId,
 timestamp:new Date(1700000000000+i*1000).toISOString(),content:'Record '+i+'\n\n'+'Readable text. '.repeat(45)}));
const invoke=ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke=async(channel,payload)=>{
 if(channel==='agent-transcript:get-history')return {success:true,entries,payloadGeneration:'disk:epoch',revision:{sources:[{sessionId,fileIdentity:'disk',linkKind:'end'}]}};
 if(channel==='agent-session:get-availability-batch')return {success:true,results:(payload.sessions||[]).map(s=>({...s,state:'available',historyState:'available',checkedAt:Date.now()}))};
 if(channel==='agent-transcript:subscribe'||channel==='agent-transcript:unsubscribe')return {success:true};
 if(channel==='agent-transcript:get-terminal-preview')return {success:true,preview:null};
 return invoke(channel,payload);
};
useUIStore.setState({terminalHistoryStreamingEnabled:false,historyFontSize:16,promptSummaryGlobalAuto:false} as any);
useWorkspaceStore.setState({activeProjectId:projectId,openProjects:new Map([[projectId,{projectId,projectPath:cwd,
 tabs:new Map([[tabId,{id:tabId,name:'Controls',cwd,commandType:'codex',tabType:'file',aiBusy:false,codexSessionId:sessionId}]]),
 activeTabId:tabId,currentView:'terminal',selectedTabIds:[],tabGroups:[]}]] )} as any);
const chips=Array.from({length:8},(_,i)=>({id:'prompt-'+i,kind:'prompt' as const,label:'Attached prompt '+i,text:'CONTROL-PROMPT-BODY-'+i}));
useUIStore.getState().setHistoryPromptDraft(tabId,'',{chips});
(window as any).fixture={tabId,ready:false,terminalBottom:0,events:[],snapshot:()=>({
 terminalOpen:!!useUIStore.getState().sideTerminalOpenTabs[tabId],draft:useUIStore.getState().historyPromptDrafts[tabId]||'',
}),setChips:(count:number)=>useUIStore.getState().setHistoryPromptDraftChips(tabId,chips.slice(0,count))};
for(const name of ['history-panel:scroll-to-bottom','timeline:scroll-to-bottom'])window.addEventListener(name,(e:CustomEvent)=>(window as any).fixture.events.push({name,tabId:e.detail.tabId}));
createRoot(document.getElementById('root')!).render(<div style={{position:'relative',height:'100vh',width:'100%'}}>
 <HistoryPanel tabId={tabId} projectId={projectId} sessionId={sessionId} cwd={cwd} width={720} notesPanelWidth={0}
 isOpen embedded embeddedFill mainSurface enableClaudePtyControls toolType="codex" presented preservePresentationGeometry
 onInitialSourceSignal={d=>{if(d.phase==='load'&&d.status==='success')(window as any).fixture.ready=true;}}/>
</div>);
