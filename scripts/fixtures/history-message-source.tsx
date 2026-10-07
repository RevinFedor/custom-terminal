// Actual shared source controls and History/Virtuoso. Only IO and placement
// are synthetic; no provider, production IPC, storage, or clipboard access.
import React from 'react';
import { createRoot } from 'react-dom/client';
import HistoryPanel from '../../src/renderer/components/Workspace/HistoryPanel';
import { HistoryPromptSource } from '../../src/renderer/components/Workspace/TabMessageSourceChip';
import { useWorkspaceStore } from '../../src/renderer/store/useWorkspaceStore';
import { useUIStore } from '../../src/renderer/store/useUIStore';
import '../../packages/claude-blocks/src/theme.css';
import '../../packages/claude-blocks/src/blocks.css';

const ipc = window.require('electron').ipcRenderer;
const width = Number(new URL(location.href).searchParams.get('width')) || 500;
const tabId = 'private-source-tab', projectId = 'private-source-project', sessionId = 'private-source-session';
const state: any = { ready: false, calls: [], opens: [], flashes: [], done: [], rects: [],
  holdLocate: true, holdHydration: true, pendingLocate: [], pendingHydration: [], hydrated: false };
const fixture: any = (window as any).sourceJumpFixture = { state, tabId };
const row = (id: string, role: string, content: string, index: number) => ({uuid:id,role,content,sessionId,
  timestamp:new Date(1700000000000+index*1000).toISOString(),sourceIdentity:'source-'+id});
const raw = (id: string, method: string) => ({tool:'__raw__',rawTool:{toolUseId:id,toolName:'MCP',
  family:'mcp',mcpServer:'terminal',mcpMethod:method,args:{messageId:'question',tabId:'recipient'},result:'{"ok":true}'}});
const callId = 'source-call:canonical:0', replyCallId = 'reply-call:canonical:0';
const entries: any[] = Array.from({length:260},(_,i) => row('row-'+i,i%9===0?'user':'assistant',
  'Historical row '+i+'. '+ 'Visible historical text. '.repeat(i%6+1),i));
const reads = (n:number) => Array.from({length:n},(_,i) => ({tool:'__raw__',rawTool:{toolUseId:'inside-read-'+i,
  toolName:'Read',family:'read',args:{file_path:'/private/synthetic-file-'+i+'.md'},result:'fixture'}}));
const target = {...row('target-row','assistant','',80),actions:[...reads(40),raw(callId,'send_message'),
  raw('other-same-method','send_message')]};
const replyTarget = {...row('reply-row','assistant','',170),actions:[raw(replyCallId,'reply_to_message')]};
entries[80]=target; entries[170]=replyTarget;
for (const index of [79,81,169,171]) entries[index]={...row('tool-row-'+index,'assistant','',index),
  actions:[{tool:'__raw__',rawTool:{toolUseId:'read-'+index,toolName:'Read',family:'read',args:{file_path:'/private/fixture.md'},result:'fixture'}}]};
const initial = entries.map(entry => ['target-row','reply-row'].includes(entry.uuid) ? {
  ...entry,actions:undefined,rowStub:true,actionSummary:entry.actions.map((a:any) => ({...a.rawTool,args:undefined,result:undefined})),
} : entry);
const history = () => ({success:true,entries:structuredClone(state.hydrated ? entries : initial),
  payloadGeneration:'private-source-generation',revision:{sources:[{sessionId,fileIdentity:'source-fixture',
    filePath:'/synthetic-source-history',linkKind:'end'}]}});
const invoke = ipc.invoke.bind(ipc);
ipc.invoke = async (channel:string,...args:any[]) => {
  state.calls.push({channel,payload:args[0],at:performance.now()});
  const payload=args[0]||{};
  if (channel==='tab-messages:source-location') {
    const reply=payload.messageId==='reply';
    const answer=() => ({success:true,location:{messageId:payload.messageId,tabId,projectId,
      readSessionId:state.foreignSession ? 'foreign' : sessionId,
      entryUuid:reply?'reply-row':'target-row',toolUseId:reply?replyCallId:callId}});
    if (state.holdLocate) return new Promise(resolve => state.pendingLocate.push(() => resolve(answer())));
    return answer();
  }
  if (channel==='agent-transcript:get-history') {
    if (payload.hydrate?.centerUuid && state.holdHydration) return new Promise(resolve => state.pendingHydration.push(() => resolve(history())));
    return history();
  }
  if (channel==='agent-session:get-availability-batch') return {success:true,results:(payload.sessions||[]).map((s:any) =>
    ({...s,state:'available',historyState:'available',checkedAt:Date.now()}))};
  if (['agent-transcript:subscribe','agent-transcript:unsubscribe'].includes(channel)) return {success:true};
  if (channel==='agent-transcript:get-terminal-preview') return {success:true,preview:null};
  if (channel==='agent-activity:get-tab-timing') return {success:true,timing:null};
  if (channel==='agent:get-send-receipts'||channel==='agent:list-send-receipts') return {success:true,records:[]};
  if (channel==='tab-work-context:get') return {success:true,updates:[]};
  return invoke(channel,...args);
};
const tab={id:tabId,name:'Source with a long human-readable name',cwd:'/synthetic-source-history',
  commandType:'codex',tabType:'terminal',aiBusy:false,codexSessionId:sessionId,color:'codex'};
const workspace={projectId,projectPath:tab.cwd,activeTabId:'recipient',currentView:'terminal',tabHistory:[],
  selectedTabIds:[],tabGroups:[],tabs:new Map([[tabId,tab]])};
useWorkspaceStore.setState({view:'workspace',activeProjectId:projectId,activeSpaceId:'private-workflow',
  splitPanes:[],splitFocusedIndex:0,activeSpaceTab:{projectId,tabId:'recipient'},
  openProjects:new Map([[projectId,workspace]]),
  openTabById:async(id:string,options:any) => {
    state.opens.push({id,options});
    useWorkspaceStore.setState({activeSpaceTab:{projectId,tabId:id},
      openProjects:new Map([[projectId,{...workspace,activeTabId:id}]])} as any);
    return true;
  },
} as any);
useUIStore.setState({terminalHistoryStreamingEnabled:false,historyGroupActionsEnabled:true,
  historyFontSize:16,historyLetterSpacing:0,promptSummaryGlobalAuto:false} as any);
fixture.releaseLocate=(index:number) => state.pendingLocate[index]?.();
fixture.releaseHydration=() => {
  state.holdHydration=false;state.hydrated=true;
  state.pendingHydration.splice(0).forEach((done:any) => done());
};
fixture.ui=() => ({uuid:useUIStore.getState().historyScrollToUuid,generation:useUIStore.getState().historyScrollRequestGeneration,
  tool:useUIStore.getState().historyScrollToolTarget,toasts:useUIStore.getState().toasts});
fixture.leave=() => useWorkspaceStore.setState({activeSpaceTab:{projectId,tabId:'recipient'},
  openProjects:new Map([[projectId,workspace]])} as any);
window.addEventListener('history-panel:scrolled-to',(event:any) => state.done.push({...event.detail,at:performance.now()}));
const animate=Element.prototype.animate;
Element.prototype.animate=function(frames:any,options:any) {
  if (this.matches('.cb-tool-head')) {
    const scroller=this.closest<HTMLElement>('[data-virtuoso-scroller]')!;
    const rect=this.getBoundingClientRect(),viewport=scroller.getBoundingClientRect();
    const record:any={at:performance.now(),toolUseId:this.closest('[data-history-tool-use-id]')?.getAttribute('data-history-tool-use-id'),
      uuid:this.closest('[data-uuid]')?.getAttribute('data-uuid'),top:rect.top-viewport.top,
      bottom:rect.bottom-viewport.top,client:scroller.clientHeight,options,
      rect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom}};
    state.flashes.push(record);
    const animation=animate.call(this,frames,options);
    animation.finished.then(() => {record.finished=true;},() => {record.cancelled=true;});
    return animation;
  }
  return animate.call(this,frames,options);
};
const sample=() => {
  const scroller=document.querySelector<HTMLElement>('[data-virtuoso-scroller]');
  const head=document.querySelector<HTMLElement>('[data-history-tool-use-id="'+callId+'"] .cb-tool-head');
  if (scroller&&head) state.rects.push({at:performance.now(),top:head.getBoundingClientRect().top-scroller.getBoundingClientRect().top,scrollTop:scroller.scrollTop});
  requestAnimationFrame(sample);
};
requestAnimationFrame(sample);
function Fixture() {
  return <><div data-fixture-source-headers style={{height:76,width,padding:8,background:'#242424'}}>
    <HistoryPromptSource source={{messageId:'question',sourceTabId:tabId,sourceTabName:tab.name,sourceProjectId:projectId}} phase="question"/>
    <HistoryPromptSource source={{messageId:'reply',sourceTabId:tabId,sourceTabName:tab.name,sourceProjectId:projectId}} phase="reply"/>
  </div><div style={{position:'relative',width,height:650}}>
    <HistoryPanel tabId={tabId} projectId={projectId} sessionId={sessionId} cwd={tab.cwd}
      width={width} notesPanelWidth={0} isOpen embedded embeddedFill mainSurface toolType="codex" presented
      onInitialSourceSignal={detail => {if(detail.phase==='load'&&detail.status==='success') state.ready=true;}}/>
  </div></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
