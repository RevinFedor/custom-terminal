import React from 'react';
import {createRoot} from 'react-dom/client';
import HistoryPanel from '../../src/renderer/components/Workspace/HistoryPanel';
import {useWorkspaceStore} from '../../src/renderer/store/useWorkspaceStore';
import {useUIStore} from '../../src/renderer/store/useUIStore';
import {CODEX_PRESENCE_SNAPSHOT_FIELDS} from '../../src/renderer/utils/codexPtyPresence.mjs';
import {searchHistoryEntries} from '../../src/shared/history-search.mjs';
import {requestHistorySearch} from '../../src/renderer/utils/historySearchMarkers';
import '../../packages/claude-blocks/src/blocks.css';
const {ipcRenderer}=window.require('electron');
const tabId='controls-tab',sessionId='controls-session',projectId='controls-project',cwd='/synthetic';
const entries:any[]=Array.from({length:100},(_,i)=>({uuid:'row-'+i,role:i%2?'assistant':'user',sessionId,
 timestamp:new Date(1700000000000+i*1000).toISOString(),content:'Record '+i+'\n\n'+'Readable text. '.repeat(45)}));
// A real card-level reveal target near the tail, independent of transport mocks.
entries[99].actions=[{tool:'__raw__',rawTool:{toolName:'Read',toolUseId:'tail-tool',family:'read',args:{file_path:'/synthetic/example.ts'},
 result:Array.from({length:30},(_,i)=>'line '+i+' from the synthetic file').join('\n')}}];
let timing:any=null;let heldTiming=false;const timingReads:Array<()=>void>=[];
const state={sends:[] as any[],reads:0,wheels:[] as any[],scrolls:[] as any[],frames:[] as any[],
 phase:'idle',observing:false,streamUpdates:0,forbidden:[] as string[],invokes:[] as string[],searches:0};
const runtime={...Object.fromEntries(CODEX_PRESENCE_SNAPSHOT_FIELDS.map(k=>[k,null])),
 success:true,projectId,sessionStatus:'active',busy:false,inputReady:true,liveLifecycle:true,sessionId,
 readSessionId:sessionId,readIdentitySource:'live-writer',savedSessionId:sessionId,conversationMaterialized:true,
 timelineCount:50,canCopySessionId:true,hasTerm:true,hasWatcher:true,catchUpPending:false,outcomeKnown:true,
 writerConfirmed:true,writerStatus:'adopted',writerUsableForMutation:true,provenWriterSessionId:sessionId,
 writerProof:'fixture-only',launchId:'fixture-launch',lifecycleGeneration:1};
const emit=(detail:any)=>ipcRenderer.emit('agent-transcript:live-message',{}, {tabId,toolType:'codex',sessionId,...detail});
let sendRelease:(()=>void)|null=null;
// Deterministically hold only callbacks scheduled during one trusted wheel
// dispatch. Other UI frames remain real. This lets a real reveal/search action
// take ownership before a pending gesture verification is released.
const nativeFrame=window.requestAnimationFrame.bind(window),nativeCancel=window.cancelAnimationFrame.bind(window);
let captureWheelFrames=false,nextHeldFrame=-1;
const heldFrames=new Map<number,FrameRequestCallback>();
window.requestAnimationFrame=(callback:FrameRequestCallback)=>{
 if(!captureWheelFrames)return nativeFrame(callback);
 const id=nextHeldFrame--;heldFrames.set(id,callback);return id;
};
window.cancelAnimationFrame=(id:number)=>{if(id<0)heldFrames.delete(id);else nativeCancel(id);};
const invoke=ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke=async(channel,...args)=>{
 const payload=args[0];state.invokes.push(channel);
 if(channel==='codex:get-runtime-projection'||channel==='codex:get-runtime-session')return runtime;
 if(channel==='codex:get-draft-state')return {success:true,hasDraft:false,preview:'',source:'fixture-main',proofOutcome:'absent'};
 if(channel==='tab-work-context:prepare')return {success:true,prompt:payload.prompt,prefix:''};
 if(channel==='tab-work-context:get')return {success:true,updates:[]};
 if(channel==='agent:get-send-receipts'||channel==='agent:list-send-receipts')return {success:true,records:[]};
 if(channel==='agent-transcript:search-history'){state.searches++;return {success:true,...searchHistoryEntries(entries,payload)};}
 if(channel==='codex:send-command'){
  const [target,text,options]=args;if(target!==tabId)throw Error('Wrong fixture send target');
  const index=state.sends.length;state.sends.push({target,text,options});
  ipcRenderer.emit('claude:paste-busy',{}, {tabId,busy:true,phase:'sending'});
  const entry={uuid:'fixture-sent-'+index,role:'user',sessionId,timestamp:new Date().toISOString(),content:text,
   sourceIdentity:'fixture-source-'+index};
  entries.push(entry);
  return new Promise(resolve=>{sendRelease=()=>{
   sendRelease=null;
   const value={state:'running',intervalId:null,toolType:'codex',sessionId,startTs:Date.now(),endTs:null,durationMs:null};
   timing=value;ipcRenderer.emit('agent-activity:timing-changed',{}, {tabId});
   ipcRenderer.emit('claude:paste-busy',{}, {tabId,busy:false,phase:'idle'});
   resolve({success:true,accepted:true,submitted:true,pasteWritten:true,enterWritten:true,
    sendAttemptId:options.sendAttemptId||'fixture-attempt-'+index,sendOperationKey:options.sendOperationKey||'fixture-operation-'+index,
    pasteAudit:{confirmed:true,auditTimestamp:entry.timestamp,entryUuid:entry.uuid,sessionId,
     sourceIdentity:entry.sourceIdentity,actualHash:'fixture-proof-'+index}});
  };});
 }
 if(/(?:run-command|stop-ai|interrupt|rewind|fork-session|send-live-slash|terminal:input)/.test(channel)){
  state.forbidden.push(channel);throw Error('Forbidden fixture operation: '+channel);
 }
 if(channel==='agent-activity:get-tab-timing'){const value=timing;return heldTiming?new Promise(resolve=>timingReads.push(()=>resolve({success:true,timing:value}))):{success:true,timing:value};}
 if(channel==='agent-transcript:get-history'){state.reads++;return structuredClone({success:true,entries,payloadGeneration:'disk:epoch',revision:{sources:[{sessionId,fileIdentity:'disk',linkKind:'end'}]}});}
 if(channel==='agent-session:get-availability-batch')return {success:true,results:(payload.sessions||[]).map(s=>({...s,state:'available',historyState:'available',checkedAt:Date.now()}))};
 if(channel==='agent-transcript:subscribe'||channel==='agent-transcript:unsubscribe')return {success:true};
 if(channel==='agent-transcript:get-terminal-preview')return {success:true,preview:null};
 return invoke(channel,...args);
};
useUIStore.setState({terminalHistoryStreamingEnabled:true,historyFontSize:16,promptSummaryGlobalAuto:false} as any);
useWorkspaceStore.setState({activeProjectId:projectId,openProjects:new Map([[projectId,{projectId,projectPath:cwd,
 tabs:new Map([[tabId,{id:tabId,name:'Controls',cwd,commandType:'codex',tabType:'file',aiBusy:false,codexSessionId:sessionId}]]),
 activeTabId:tabId,currentView:'terminal',selectedTabIds:[],tabGroups:[]}]] )} as any);
const chips=Array.from({length:8},(_,i)=>({id:'prompt-'+i,kind:'prompt' as const,label:'Attached prompt '+i,text:'CONTROL-PROMPT-BODY-'+i}));
useUIStore.getState().setHistoryPromptDraft(tabId,'',{chips:[]});
(window as any).fixture={tabId,ready:false,state,releaseSend:()=>sendRelease?.(),
 search:()=>requestHistorySearch(tabId),
 stream:(step:number)=>{
  state.streamUpdates++;
  const entry={uuid:'fixture-stream',role:'assistant',sessionId,sourceIdentity:'fixture-stream-source',
   timestamp:new Date().toISOString(),content:'STREAMED TAIL '+step+'\n\n'+'Streamed paragraph. '.repeat(18*step)};
  emit({message:{type:'assistant',uuid:entry.uuid,sessionId,sourceIdentity:entry.sourceIdentity,
   message:{role:'assistant',content:[{type:'text',text:entry.content}]}},timestamp:entry.timestamp,recordByteOffset:20000});
 },
 startObservation:()=>{state.frames=[];state.observing=true;const frame=()=>{
  if(!state.observing)return;const s=document.querySelector<HTMLElement>('[data-virtuoso-scroller]');
  if(s)state.frames.push({t:performance.now(),phase:state.phase,top:s.scrollTop,height:s.scrollHeight,client:s.clientHeight,
   gap:s.scrollHeight-s.scrollTop-s.clientHeight,timer:!!document.querySelector('[data-history-tail-response-timer][data-placement="tail"]'),
   composer:document.querySelector('[data-history-controls]')?.getBoundingClientRect().height});
  requestAnimationFrame(frame);
 };requestAnimationFrame(frame);},
 heldFrameCount:()=>heldFrames.size,
 releaseWheelFrames:()=>{captureWheelFrames=false;for(const callback of heldFrames.values())nativeFrame(callback);heldFrames.clear();},
 installWheelProbe:(cancelUp:boolean,holdFrames=false)=>{
  const s=document.querySelector<HTMLElement>('[data-virtuoso-scroller]')!;
  (window as any).fixture.removeWheelProbe?.();
  captureWheelFrames=holdFrames;
  const capture=()=>{if(holdFrames)captureWheelFrames=true;};
  const wheel=(event:WheelEvent)=>{
   if(cancelUp&&event.deltaY<0)event.preventDefault();
   state.wheels.push({trusted:event.isTrusted,deltaY:event.deltaY,cancelable:event.cancelable,
    prevented:event.defaultPrevented,top:s.scrollTop,height:s.scrollHeight,client:s.clientHeight,t:performance.now()});
   captureWheelFrames=false;
  };
  const scroll=()=>state.scrolls.push({top:s.scrollTop,t:performance.now()});
  s.addEventListener('wheel',capture,{capture:true,passive:true});
  s.addEventListener('wheel',wheel,{passive:false});s.addEventListener('scroll',scroll);
  (window as any).fixture.removeWheelProbe=()=>{s.removeEventListener('wheel',capture,true);s.removeEventListener('wheel',wheel);s.removeEventListener('scroll',scroll);};
 },
 timingReads,
 setTiming:(value:any)=>{timing=value;ipcRenderer.emit('agent-activity:timing-changed',{}, {tabId});},
 holdTiming:()=>{heldTiming=true;},releaseTiming:()=>{heldTiming=false;for(const release of timingReads.splice(0))release();},
 paste:(busy:boolean)=>ipcRenderer.emit('claude:paste-busy',{}, {tabId,busy,phase:busy?'sending':'idle'}),
 running:()=>({state:'running',intervalId:null,toolType:'codex',sessionId,startTs:Date.now(),endTs:null,durationMs:null}),terminalBottom:0,events:[],snapshot:()=>({
 terminalOpen:!!useUIStore.getState().sideTerminalOpenTabs[tabId],draft:useUIStore.getState().historyPromptDrafts[tabId]||'',
}),setChips:(count:number)=>useUIStore.getState().setHistoryPromptDraftChips(tabId,chips.slice(0,count))};
for(const name of ['history-panel:scroll-to-bottom','timeline:scroll-to-bottom'])window.addEventListener(name,(e:CustomEvent)=>(window as any).fixture.events.push({name,tabId:e.detail.tabId}));
createRoot(document.getElementById('root')!).render(<div style={{position:'relative',height:'100vh',width:'100%'}}>
 <HistoryPanel tabId={tabId} projectId={projectId} sessionId={sessionId} cwd={cwd} width={720} notesPanelWidth={0}
 isOpen embedded embeddedFill mainSurface enableClaudePtyControls toolType="codex" presented preservePresentationGeometry
 onInitialSourceSignal={d=>{if(d.phase==='load'&&d.status==='success')(window as any).fixture.ready=true;}}/>
</div>);
