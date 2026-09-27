// Private actual-component fixture. Every IPC is synthetic; no provider/session send.
import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import HistoryPanel, { HISTORY_SURFACE_PRESENTATION_EVENT } from '../../src/renderer/components/Workspace/HistoryPanel';
import Timeline from '../../src/renderer/components/Workspace/Timeline';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import '../../packages/claude-blocks/src/blocks.css';
import { beginHistoryPromptHandoff, settleHistoryPromptHandoff } from '../../src/renderer/utils/historyPromptHandoffs';
const { ipcRenderer } = window.require('electron');
const tabId='timeline-live-tab', sessionId='timeline-live-session', projectId='timeline-live-project', cwd='/synthetic';
const now=Date.now(), stamp=(i:number)=>new Date(now+i).toISOString();
let history=Array.from({length:90},(_,i)=>({uuid:'base-'+i,role:i%2?'assistant':'user',sessionId,
 timestamp:stamp(i),content:'Existing row '+i+'\n\n'+(i%2?'Answer paragraph. '.repeat(30):'Earlier question.')}));
let rail=history.filter(e=>e.role==='user').map(e=>({...e,type:e.role}));
const compact={uuid:'live-compact',role:'compact',sessionId,timestamp:stamp(100),
 sourceIdentity:'compact-source-100',compactEncrypted:true,content:'Conversation compacted'};
const canonical={uuid:'canonical-user',role:'user',sessionId,timestamp:stamp(200),content:'EXACT NEW QUESTION',
 sourceIdentity:'canonical-source-200',sourceIdentityAliases:['carrier-source-190'],recordByteOffset:200};
const state:any={reads:0,acks:[],scrolls:[],ready:false};
window.addEventListener('history-panel:scrolled-to',((e:CustomEvent)=>state.scrolls.push(e.detail)) as EventListener);
const original=ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke=async(channel:string,payload:any)=>{
 if(channel==='agent-transcript:get-history') {state.reads++;return {success:true,entries:history,payloadGeneration:'file:epoch',revision:{sources:[{sessionId,fileIdentity:'file',linkKind:'end'}]}};}
 if(channel==='agent-transcript:get-timeline')return {success:true,entries:rail};
 if(channel==='agent:acknowledge-send-receipt-presentation') {state.acks.push({...payload,rows:[...document.querySelectorAll('[data-uuid]')].map(e=>e.getAttribute('data-uuid'))});return {success:true,applied:true};}
 if(channel==='agent-session:get-availability-batch')return {success:true,results:(payload.sessions||[]).map(s=>({...s,state:'available',historyState:'available',checkedAt:Date.now()}))};
 if(channel==='agent-transcript:get-terminal-preview')return {success:true,preview:null};
 if(channel==='agent-transcript:subscribe'||channel==='agent-transcript:unsubscribe')return {success:true};
 return original(channel,payload);
};
useUIStore.setState({terminalHistoryStreamingEnabled:true,historyFontSize:14,promptSummaryGlobalAuto:false} as any);
useWorkspaceStore.setState({openProjects:new Map([[projectId,{projectId,projectPath:cwd,
 tabs:new Map([[tabId,{id:tabId,name:'Private live timeline',cwd,commandType:'codex',tabType:'file',aiBusy:true,codexSessionId:sessionId}]]),
 activeTabId:tabId,currentView:'terminal',tabGroups:[],selectedTabIds:[]}]]),activeProjectId:projectId} as any);
const emit=(detail:any)=>ipcRenderer.emit('agent-transcript:live-message',{}, {tabId,toolType:'codex',sessionId,...detail});
(window as any).fixture={state,tabId,sessionId,canonical,
 compact:()=>emit({type:'history_entry',timestamp:compact.timestamp,recordByteOffset:100,entry:compact}),
 prompt:()=>{
   beginHistoryPromptHandoff({tabId,handoffId:'h1',toolType:'codex',text:canonical.content,source:'history',statusAtSend:'active',
     submittedAt:now+190,sessionIdHint:sessionId,sendAttemptId:'attempt',sendOperationKey:'operation',requiresAuditIdentity:true});
   settleHistoryPromptHandoff(tabId,'h1',{queueStatus:'sent',reason:'exact-audit',proof:{entryUuid:'carrier-user',sessionId,
     sourceIdentity:'carrier-source-190',recordByteOffset:190,auditTimestamp:stamp(190),actualHash:'hash'}});
   emit({timestamp:canonical.timestamp,recordByteOffset:200,message:{type:'user',uuid:'live-user',sessionId,
     sourceIdentity:canonical.sourceIdentity,sourceIdentityAliases:canonical.sourceIdentityAliases,
     message:{role:'user',content:[{type:'text',text:canonical.content}]}}});
 },
 answer:()=>{for(let i=0;i<12;i++)emit({timestamp:stamp(300+i),message:{type:'assistant',uuid:'live-answer-'+i,sessionId,
   sourceIdentity:'answer-source-'+i,message:{role:'assistant',content:[{type:'text',text:'New answer '+i+'\n\n'+'Text. '.repeat(70)}]}}});},
 promote:()=>{
   history=[...history,compact,canonical,...Array.from({length:12},(_,i)=>({uuid:'answer-'+i,role:'assistant',sessionId,
     sourceIdentity:'answer-source-'+i,timestamp:stamp(300+i),content:'New answer '+i+'\n\n'+'Text. '.repeat(70)}))];
   rail=[...rail,{...compact,type:'compact'},{...canonical,type:'user'}];
   useWorkspaceStore.setState(s=>{const projects=new Map(s.openProjects),ws=projects.get(projectId)!;
     const tabs=new Map(ws.tabs);tabs.set(tabId,{...tabs.get(tabId)!,aiBusy:false});projects.set(projectId,{...ws,tabs});return {openProjects:projects};});
   ipcRenderer.emit('agent-transcript:changed',{}, {tabId,toolType:'codex',sessionId,fileIdentity:'file',reason:'fixture-append'});
 },
};
function Fixture(){
 const [shown,setShown]=useState(true);
 const busy=useWorkspaceStore(s=>s.openProjects.get(projectId)?.tabs.get(tabId)?.aiBusy===true);
 (window as any).fixture.show=setShown;
 useLayoutEffect(()=>{window.dispatchEvent(new CustomEvent(HISTORY_SURFACE_PRESENTATION_EVENT,{detail:{channel:'live-proof',presented:shown,geometryStable:true,focused:shown}}));},[shown]);
 return <div style={{display:'flex',position:'relative',height:'100vh',visibility:shown?'visible':'hidden'}}>
   <div style={{position:'relative',flex:1,minWidth:0}}>
   <HistoryPanel tabId={tabId} projectId={projectId} sessionId={sessionId} cwd={cwd} width={980} notesPanelWidth={0}
     isOpen embedded embeddedFill mainSurface toolType="codex" presented preservePresentationGeometry
     presentationExternallyManaged presentationChannel="live-proof"
     onInitialSourceSignal={d=>{if(d.phase==='load'&&d.status==='success')state.ready=true;}}/>
   </div>
   <Timeline tabId={tabId} sessionId={sessionId} cwd={cwd} toolType="codex" isActive={false} isTurnBusy={busy} isVisible={shown}
     isOpen historySurfaceVisible readOnly backgroundPrewarmAdmitted/>
 </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
