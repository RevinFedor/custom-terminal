import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import HistoryPanel from '../../src/renderer/components/Workspace/HistoryPanel';
import Timeline from '../../src/renderer/components/Workspace/Timeline';
import {SplitPaneAttachRow} from '../../src/renderer/components/Workspace/SplitPaneChrome';
import {useWorkspaceStore} from '../../src/renderer/store/useWorkspaceStore';
import {useUIStore} from '../../src/renderer/store/useUIStore';
import {searchHistoryEntries} from '../../src/shared/history-search.mjs';
import {requestHistorySearch} from '../../src/renderer/utils/historySearchMarkers';
import '../../packages/claude-blocks/src/blocks.css';
const {ipcRenderer}=window.require('electron');
const projectId='search-project',tabId='search-a',sessionId='search-session',cwd='/synthetic';
const rows=Array.from({length:240},(_,i)=>({uuid:'row-'+i,role:i%2?'assistant':'user',sessionId,
 timestamp:new Date(1700000000000+i*1000).toISOString(),content:'COMMON '+(i===8?'picture alpha':i===80?'picture needle':i===11?'answer needle needle':i===81?'answer needle':'row '+i)+'\n\n'+'Visible text. '.repeat(20),
 ...(i===8||i===80?{imageCount:1}:{}),sourceIdentity:'source-'+i}));
const state:any={reads:0,searches:[],hydrated:[],ready:false};
const original=ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke=async(channel:string,payload:any)=>{
 if(channel==='agent-transcript:get-history'){
  state.reads++;const center=rows.findIndex(e=>e.uuid===payload.hydrate?.centerUuid);if(center>=0)state.hydrated.push(payload.hydrate.centerUuid);
  return {success:true,entries:rows.map((e,i)=>i>215||Math.abs(i-center)<8?e:{...e,content:'',rowStub:true}),payloadGeneration:'search-file',revision:{sources:[{sessionId,fileIdentity:'search-file',linkKind:'end'}]}};
 }
 if(channel==='agent-transcript:search-history'){
  state.searches.push(payload);await new Promise(r=>setTimeout(r,payload.query==='old'?450:30));
  return {success:true,...searchHistoryEntries(rows,payload)};
 }
 if(channel==='agent-transcript:get-timeline')return {success:true,entries:rows.filter(e=>e.role==='user').map(e=>({...e,type:'user'}))};
 if(channel==='agent-transcript:subscribe'||channel==='agent-transcript:unsubscribe')return {success:true};
 if(channel==='agent-transcript:get-terminal-preview')return {success:true,preview:null};
 if(channel==='agent-session:get-availability-batch')return {success:true,results:(payload.sessions||[]).map(s=>({...s,state:'available',historyState:'available',checkedAt:Date.now()}))};
 if(channel==='agent:list-send-receipts'||channel==='agent:get-send-receipts')return {success:true,records:[]};
 if(channel.includes(':send')||channel.includes(':paste')||channel==='terminal:input')throw Error('Provider send forbidden in search fixture: '+channel);
 return original(channel,payload);
};
const tab={id:tabId,name:'Search chat',cwd,commandType:'codex',tabType:'terminal',codexSessionId:sessionId,aiBusy:false};
useUIStore.setState({terminalHistoryStreamingEnabled:false,historyFontSize:14,promptSummaryGlobalAuto:false} as any);
useWorkspaceStore.setState({activeProjectId:projectId,openProjects:new Map([[projectId,{projectId,projectPath:cwd,
 tabs:new Map([[tabId,tab]]),activeTabId:tabId,currentView:'terminal',tabHistory:[tabId],tabGroups:[],selectedTabIds:[]}]] )} as any);
(window as any).fixture={state,tabId,sessionId,rows,showB:()=>{},refresh:()=>{
 rows[rows.length-1].content+=' appended';
 ipcRenderer.emit('agent-transcript:changed',{}, {tabId,toolType:'codex',sessionId,fileIdentity:'search-file',reason:'fixture-append'});
}};
function Fixture(){
 const [showB,setShowB]=useState(false);(window as any).fixture.showB=setShowB;
 return <div style={{display:'flex',position:'relative',height:'100vh'}}>
  <div style={{display:'flex',flexDirection:'column',flex:1,minWidth:0}}>
   <SplitPaneAttachRow projectId={projectId} tabId={tabId} focused presented/>
   <div style={{display:'flex',position:'relative',flex:1,minHeight:0}}>
    <div data-pane-a style={{position:'relative',flex:1,minWidth:0}}>
     <HistoryPanel tabId={tabId} projectId={projectId} sessionId={sessionId} cwd={cwd} width={850} notesPanelWidth={0}
      isOpen embedded embeddedFill mainSurface toolType="codex" presented preservePresentationGeometry enableClaudePtyControls
      onInitialSourceSignal={d=>{if(d.phase==='load'&&d.status==='success')state.ready=true;}}/>
    </div>
    <Timeline tabId={tabId} sessionId={sessionId} cwd={cwd} toolType="codex" isActive={false} isTurnBusy={false}
      isVisible isOpen historySurfaceVisible readOnly backgroundPrewarmAdmitted/>
   </div>
  </div>
  {showB&&<div data-pane-b style={{position:'relative',width:260}}>
   <button data-fixture-search-b onClick={()=>requestHistorySearch('search-b')}
    style={{position:'absolute',right:0,bottom:0,zIndex:100}}>Поиск второго чата</button>
   <HistoryPanel tabId="search-b" projectId={projectId} sessionId="other-session" cwd={cwd} width={260} notesPanelWidth={0}
    isOpen embedded embeddedFill mainSurface toolType="codex" presented preservePresentationGeometry suppressGlobalHotkeys/>
  </div>}
 </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
