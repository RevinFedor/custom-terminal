import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import HistoryPanel, { HISTORY_SURFACE_PRESENTATION_EVENT } from '../../src/renderer/components/Workspace/HistoryPanel';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
const { ipcRenderer } = window.require('electron');
const sessionId='first-wheel-'+Date.now().toString(36), tabId=sessionId+'-tab', projectId='first-wheel-project', channel='first-wheel-channel';
const entries=Array.from({length:95},(_,i)=>({uuid:'row-'+i,role:'assistant',sessionId,
  timestamp:new Date(1700000000000+i*1000).toISOString(),sourceIdentity:'source-'+i,
  content:'Row '+i+'\n\n'+'Readable paragraph. '.repeat(i%7===0?18:8)}));
const original=ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke=async(channel,payload)=>{
 if(channel==='agent-transcript:get-history') return {success:true,entries,payloadGeneration:'disk:inode:epoch',revision:{sources:[{sessionId,filePath:'/synthetic',fileIdentity:'disk:inode',linkKind:'end'}]}};
 if(channel==='agent-session:get-availability-batch') return {success:true,results:(payload.sessions||[]).map(s=>({...s,state:'available',historyState:'available',checkedAt:Date.now()}))};
 if(channel==='agent-transcript:subscribe'||channel==='agent-transcript:unsubscribe')return {success:true};
 if(channel==='agent-transcript:get-terminal-preview') return {success:true,preview:null};
 return original(channel,payload);
};
useUIStore.setState({terminalHistoryStreamingEnabled:false,historyFontSize:16,promptSummaryGlobalAuto:false} as any);
useWorkspaceStore.setState({openProjects:new Map([[projectId,{projectId,projectPath:'/synthetic',tabs:new Map([[tabId,{id:tabId,name:'First wheel',cwd:'/synthetic',commandType:'codex',tabType:'file',aiBusy:false,codexSessionId:sessionId}]]),activeTabId:tabId,tabGroups:[],currentView:'terminal',selectedTabIds:[]}]])} as any);
(window as any).fixture={loaded:false,events:[],writers:[]};
const originals=new Map();
for(const method of ['scrollTo','scrollBy']){
 const native=Element.prototype[method];
 originals.set(method,native);
 Element.prototype[method]=function(...args){
  if(this.hasAttribute?.('data-virtuoso-scroller')) (window as any).fixture.writers.push({method,at:performance.now(),top:this.scrollTop,args,stack:new Error().stack});
  return native.apply(this,args);
 };
}
const descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');
if(descriptor?.set)Object.defineProperty(Element.prototype,'scrollTop',{...descriptor,set(value){
 if(this.hasAttribute?.('data-virtuoso-scroller'))(window as any).fixture.writers.push({method:'scrollTop=',at:performance.now(),top:this.scrollTop,args:[value],stack:new Error().stack});
 descriptor.set.call(this,value);
}});
(window as any).VIRTUOSO_LOG_LEVEL=0;
function Fixture(){
 const[shown,setShown]=useState(false);
 useLayoutEffect(()=>{window.dispatchEvent(new CustomEvent(HISTORY_SURFACE_PRESENTATION_EVENT,{detail:{channel,presented:shown,geometryStable:true,focused:shown}}));},[shown]);
 return <><button data-show onClick={()=>flushSync(()=>setShown(v=>!v))} style={{height:32}}>Show / hide</button>
 <div style={{height:1007,width:702,position:'relative',visibility:shown?'visible':'hidden'}}>
 <HistoryPanel tabId={tabId} projectId={projectId} sessionId={sessionId} cwd="/synthetic" width={702} notesPanelWidth={0}
 isOpen embedded embeddedFill mainSurface toolType="codex" presented preservePresentationGeometry
 presentationExternallyManaged presentationChannel={channel}
 onInitialSourceSignal={detail=>{if(detail.phase==='load'&&detail.status==='success')(window as any).fixture.loaded=true;}}/>
 </div></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
