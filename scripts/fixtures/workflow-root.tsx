import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '../../src/renderer/App';
import {useWorkspaceStore} from '../../src/renderer/store/useWorkspaceStore';
import {useUIStore} from '../../src/renderer/store/useUIStore';
import {terminalRegistry} from '../../src/renderer/utils/terminalRegistry';
import {emptySpaceLayout} from '../../src/renderer/utils/workspaceSpacesModel.mjs';
import {selectWorkflowReserve} from '../../src/renderer/utils/workflowReserve.mjs';
import {buildSessionSnapshot} from '../../src/renderer/utils/sessionSnapshot.mjs';
import '../../packages/claude-blocks/src/blocks.css';
const f:any=(window as any).fullViewFixture;
const syntheticRequire=(window as any).require;
(window as any).require=(name:string)=>name==='os'?{homedir:()=>'/synthetic/home'}:syntheticRequire(name);
const ns='full-view-project', foreign='foreign-execution', inbox='__noted_workflow_inbox__';
const ref=(tabId:string,projectId=ns)=>({projectId,tabId});
const pane=(windowId:string,ids:string[],projectId=ns,hidden=false)=>({windowId,projectId,tabId:ids[0],tabs:ids.map(id=>ref(id,projectId)),displayHidden:hidden});
const layout=(panes:any[],focus=0)=>({...emptySpaceLayout(),splitPanes:panes,splitFocusedIndex:focus,
 activeProjectId:panes[focus]?.projectId || ns,focusedProjectId:panes[focus]?.projectId || ns,
 activeSpaceTab:panes[focus]?.tabId?ref(panes[focus].tabId,panes[focus].projectId):null,splitSizes:{cols:panes.filter(p=>!p.displayHidden).map(()=>1),rows:panes.map(()=>[1])}});
const main:any=layout([pane('main-first',['A','A2']),pane('main-second',['B'],foreign),pane('main-hidden',['H'],ns,true)],1);
main.windowDisplayLayouts={wide:{splitPanes:[pane('profile-exact',['P','P2']),pane('main-first',['S'])]}};
const other:any=layout([pane('other-first',['C']),pane('other-last',['D'])],1);
const rows:any[]=[
 {tabId:'A',name:'Root owner A',cwd:'/synthetic/A',tabType:'terminal',commandType:'codex',codexSessionId:'session-A'},
 {tabId:'A2',name:'Second chip',cwd:'/synthetic/A2',tabType:'terminal'},
 {tabId:'B',name:'Foreign B',cwd:'/synthetic/B',tabType:'terminal',namespace:foreign},
 {tabId:'H',name:'Hidden H',cwd:'/synthetic/H',tabType:'terminal'},
 {tabId:'C',name:'Dormant C',cwd:'/synthetic/C',tabType:'terminal'},
 {tabId:'D',name:'Dormant D',cwd:'/synthetic/D',tabType:'terminal'},
 {tabId:'R',name:'Reserve R',cwd:'/synthetic/R',tabType:'terminal'},
 {tabId:'P',name:'Profile P',cwd:'/synthetic/P',tabType:'terminal'},
 {tabId:'P2',name:'Profile neighbor',cwd:'/synthetic/P2',tabType:'terminal'},
 {tabId:'S',name:'Profile same window',cwd:'/synthetic/S',tabType:'terminal'},
 {tabId:'child',name:'Physical child',cwd:'/synthetic/A',tabType:'terminal',parentTabId:'A'},
 {tabId:'file',name:'work.md',cwd:'/synthetic/A',tabType:'file',filePath:'/synthetic/work.md',visualParentTabId:'A'},
 {tabId:'cold',name:'Cold tab',cwd:'/synthetic/cold',tabType:'terminal',namespace:foreign},
];
const members:any=Object.fromEntries(rows.map(row=>[row.tabId,{tabId:row.tabId,workflowId:['C','D','R','cold'].includes(row.tabId)?'other':'space-1',revision:1}]));
const workflows:any[]=[{id:'space-1',kind:'user',revision:1,metadata:{name:'Main',order:0},layout:main},
 {id:'other',kind:'user',revision:1,metadata:{name:'Other',order:1},layout:other},
 {id:inbox,kind:'inbox',revision:1,metadata:{name:'Inbox',order:2},layout:layout([pane('inbox-empty',[])])}];
let revision=1,generation=1,groups:any={version:1,revision:1,groups:[],tabGroups:{}};
const mutations=new Map(),held:any=new Map(),storageRevisions=new Map<string,number>();
const catalog=()=>({publication:{version:1,migrationVersion:1,revision,generation},workflows:structuredClone(workflows),
 tabs:rows.map(row=>({tabId:row.tabId,subjectVersion:row.executionSubject?2:1,executionSubject:row.executionSubject || {version:1,projectId:row.namespace || ns},
 legacyRow:{tab_id:row.tabId},nativeRow:{tab_id:row.tabId},membership:members[row.tabId]})),
 migrationScopes:{},globalGroups:structuredClone(groups),
 namespaces:[ns,foreign,'__tab_catalog_v2__'].map(id=>({id,path:'/synthetic',tabs:rows.filter(row=>(row.namespace || ns)===id),tabGroups:[]}))});
f.rootRequests=[];f.runtimeCreates=[];f.saved=[];f.gates=new Map();f.archiveMutations=[];f.restoreEvents=[];f.fileRestoreFail=true;
const original=f.ipc.invoke.bind(f.ipc);
f.ipc.invoke=async(channel:string,...args:any[])=>{
 const request=args[0];f.rootRequests.push({channel,request:structuredClone(request)});
 if(f.gates.has(channel)) await f.gates.get(channel).promise;
 if(channel==='workflow:bootstrap'||channel==='workflow:catalog'||channel==='workflow:read')return catalog();
 if(channel==='agent:send-queue-ready')return {success:true};
 if(channel==='workspace-switcher:register')return {epoch:'private-root',leaseId:'private-root'};
 if(channel==='app:get-runtime-identity')return {instanceId:'private-root',startedAt:1,pid:9999};
 if(channel==='ai-prompts:get')return {success:true,prompts:[]};
 if(channel==='timeline-outline:get')return {success:true,data:null};
 if(channel==='timeline-turn-action-overrides:get'||channel==='timeline-prompt-summaries:get')return {success:true,data:[]};
 if(channel==='timeline:get-notes')return {success:true,notes:{},positions:{}};
 if(channel==='timeline:get-rewind-markers')return {success:true,markers:[]};
 if(channel==='timeline:get-session-history-events')return {success:true,events:[]};
 if(channel==='file:exists-batch')return Object.fromEntries(request.map((id:string)=>[id,true]));
 if(channel==='workflow:mutation')return mutations.get(request) || null;
 if(channel==='workflow:create-tab') {
   if(request.expectedRevision!==revision)throw Error('workflow_revision_changed');
   const executionSubject={version:2,subjectId:'subject-'+request.tabId,tabId:request.tabId,cwd:request.cwd,executionNamespace:request.executionNamespace};
   rows.push({...request.record,tabId:request.tabId,namespace:request.executionNamespace,executionSubject,executionStorageRevision:1});
   storageRevisions.set(request.tabId,1);members[request.tabId]={tabId:request.tabId,workflowId:request.workflowId,revision:1};
   return {executionSubject,workflowId:request.workflowId,membershipRevision:1,revision:++revision,generation:++generation};
 }
 if(channel==='workflow:mutate'){
   if(mutations.has(request.request.mutationId))return mutations.get(request.request.mutationId);
   if(request.request.expectedRevision!==revision)throw Error('workflow_revision_changed');
   if(Object.keys(request.request.tabWorkflowMembership).length!==rows.length)throw Error('workflow_incomplete_membership_snapshot');
   for(const [id,member] of Object.entries(request.request.tabWorkflowMembership) as any){
     if(members[id].workflowId!==member.workflowId)members[id]={...member,tabId:id,revision:members[id].revision+1};
   }
   workflows.splice(0,workflows.length,...request.request.spaces.map((space:any)=>({id:space.id,kind:space.kind || 'user',revision:1,
     metadata:{...space,layout:undefined},layout:space.layout})));
   const ack={revision:++revision,generation:++generation};mutations.set(request.request.mutationId,ack);return ack;
 }
 if(channel==='workflow:groups-read')return structuredClone(groups);
 if(channel==='workflow:group-mutate'){
   const {kind,request:r}=request;
   if(r.expectedRevision!==groups.revision)throw Error('group_revision_changed');
   if(kind==='create')groups.groups.push({...r.metadata,id:'group-'+r.mutationId,revision:1});
   else if(kind==='assign')for(const id of r.tabIds)groups.tabGroups[id]=r.groupId;
   else if(kind==='rename'){const group=groups.groups.find((g:any)=>g.id===r.groupId);group.name=r.name;group.revision++;}
   groups.revision++;return {success:true,revision:groups.revision};
 }
 if(channel==='terminal:create'){f.runtimeCreates.push(request);return {success:true,pid:1000+f.runtimeCreates.length,cwd:request.cwd};}
 if(channel==='terminal:getCwd')return rows.find(row=>row.tabId===(typeof request==='string'?request:request?.tabId))?.cwd || '/synthetic';
 if(channel==='project:list')return [{id:ns,path:'/synthetic',name:'Legacy namespace'},{id:foreign,path:'/synthetic/foreign',name:'Foreign legacy'}];
 if(channel==='project:getById')return catalog().namespaces.find(row=>row.id===request) || null;
 if(channel==='app:check-path-exists')return true;
 if(channel==='project:save-tabs'){
   f.saved.push(structuredClone(request));const executionRevisions=[];
   for(const row of request.tabs || [])if(row.executionSubject?.version===2){
     if(row.executionStorageRevision!==storageRevisions.get(row.tabId))return {success:false,error:'execution_storage_revision_changed'};
     const revision=(storageRevisions.get(row.tabId)||0)+1;storageRevisions.set(row.tabId,revision);
     executionRevisions.push({tabId:row.tabId,subjectId:row.executionSubject.subjectId,revision});
   }
   return {success:true,executionRevisions};
 }
 if(channel==='workflow:archive-read')return {version:1,revision:1,history:[
   {id:7,namespace:ns,tab_id:'archived',name:'Archived dialogue',cwd:'/synthetic/archive',command_type:'codex',codex_session_id:'session-archive',notes:'retained archive note',workflowId:'other'},
   {id:7,namespace:foreign,name:'Foreign archive',cwd:'/synthetic/foreign',notes:'exact other namespace'}],favorites:[]};
 if(channel==='workflow:archive-mutate'){f.archiveMutations.push(request);return {success:true};}
 if(channel==='project:begin-tab-history-restore'){
   f.restoreEvents.push({channel,request});
   if(f.archiveConsumed)return {ok:false,reason:'not_found'};
   return {ok:true,token:'exact-private-lease',entry:{id:7,tab_id:'archived',restoreTargetTabId:'archived',name:'Archived dialogue',cwd:'/synthetic/archive',
     command_type:'codex',codex_session_id:'session-archive',execution_subject_version:2,execution_subject_id:'subject-archived',
     attachmentManifest:{version:1,hash:'exact-file-manifest',count:1}},
     ...(rows.some(row=>row.tabId==='archived')?{replacement:{namespace:ns,historyId:7,tabId:'archived',sourceTabId:'archived'}}:{})};
 }
 if(channel==='project:restore-execution-tab'){
   if(request.namespace!==ns||request.historyId!==7||request.leaseToken!=='exact-private-lease')throw Error('foreign_restore_lease');
   f.restoreEvents.push({channel,request});
   if(!rows.some(row=>row.tabId==='archived')){
     rows.push({tabId:'archived',name:'Archived dialogue',cwd:'/synthetic/archive',tabType:'terminal',commandType:'codex',codexSessionId:'session-archive',
       executionSubject:{version:2,tabId:'archived',subjectId:'subject-archived',executionNamespace:ns,cwd:'/synthetic/archive'},executionStorageRevision:1});
     storageRevisions.set('archived',1);members.archived={tabId:'archived',workflowId:'other',revision:1};revision++;generation++;
   }
   return {success:true,tabId:'archived'};
 }
 if(channel==='project:restore-file-links'){
   f.restoreEvents.push({channel,request});
   if(request.ownerTabId!=='archived'||request.manifestHash!=='exact-file-manifest'||request.leaseToken!=='exact-private-lease')throw Error('foreign_file_manifest');
   if(f.fileRestoreFail)return {success:false,error:'private-file-restore-refusal'};
   if(!rows.some(row=>row.tabId==='restored-file')){
     rows.push({tabId:'restored-file',name:'archive.md',cwd:'/synthetic/archive',tabType:'file',filePath:'/synthetic/archive.md',visualParentTabId:'archived'});
     members['restored-file']={tabId:'restored-file',workflowId:'other',revision:1};revision++;generation++;
   }
   return {success:true,restoredFileIds:['restored-file']};
 }
 if(channel==='project:finish-tab-history-restore'){
   f.restoreEvents.push({channel,request});
   if(request.commit){if(!rows.some(row=>row.tabId==='restored-file'))return {ok:false,committed:false};f.archiveConsumed=true;}
   return {ok:true,committed:request.commit};
 }
 if(channel==='tab-title-search:semantic'||channel==='tab-iteration-search:semantic')return {success:true,data:[{id:7,entryUuid:request.query==='iteration'?'session-archive-row-2':undefined}]};
 if(/^(tab-(title|iteration)-index):(stats|reindex|clear)$/.test(channel))return {success:true,data:{total:1,indexed:1}};
 if(channel==='sidebar:readFile'||channel==='file:read'||channel==='fs:read-file')return {content:'synthetic file',success:true};
 return original(channel,...args);
};
const workspace=(id:string,tabs:Map<string,any>)=>({projectId:id,projectPath:'/synthetic',tabs,activeTabId:id===ns?'A':'B',
 tabGroups:[],activeGroupId:null,selectedTabIds:[],tabHistory:[],tabCounter:2,sidebarOpen:false,openFilePath:null,
 sidebarExpandedDirs:null,sidebarScrollTop:0,tabListScrollTop:0,currentView:'terminal',viewingSubAgentTabId:null});
const hotA:any={...rows[0],id:'A'},hotB:any={...rows[2],id:'B'};
useWorkspaceStore.setState({openProjects:new Map([[ns,workspace(ns,new Map([['A',hotA]]))],[foreign,workspace(foreign,new Map([['B',hotB]]))]])} as any);
useUIStore.setState({newTabPrimarySurface:'history',historyPinned:false,terminalHistoryStreamingEnabled:true,sideTerminalWidth:360,
 promptSummaryGlobalAuto:false,activeArea:'workspace'} as any);
f.store=useWorkspaceStore;f.ui=useUIStore;f.members=members;f.catalog=catalog;
f.terminal=(id:string)=>terminalRegistry.get(id);
f.gate=(channel:string)=>{let release:any;const promise=new Promise(resolve=>{release=resolve;});f.gates.set(channel,{promise,release});};
f.release=(channel:string)=>{const gate=f.gates.get(channel);f.gates.delete(channel);gate?.release();};
f.state=()=>{const s=useWorkspaceStore.getState();return {view:s.view,space:s.activeSpaceId,panes:s.splitPanes,
 focus:s.splitFocusedIndex,membership:s.tabWorkflowMembership,pending:s.pendingTabWorkflowMembership,
 current:s.getEffectiveTabId(),intent:s.activeTabNavigationIntent,navRevision:s.navigationRevision,
 reserve:selectWorkflowReserve(s).reserve.map(row=>row.tabId),hotPreserved:s.openProjects.get(ns)?.tabs.get('A')===hotA,
 snapshot:buildSessionSnapshot(s)};};
f.open=(id:string,options:any={})=>useWorkspaceStore.getState().openTabById(id,options);
f.hold=(id:string)=>held.set(id,{tab:useWorkspaceStore.getState().openProjects.get(ns)?.tabs.get(id),term:terminalRegistry.get(id),
 element:terminalRegistry.get(id)?.element,buffer:terminalRegistry.get(id)?.buffer.active});
f.identity=(id:string)=>{const h=held.get(id),term=terminalRegistry.get(id);return {tab:h?.tab===useWorkspaceStore.getState().openProjects.get(ns)?.tabs.get(id),
 terminal:h?.term===term,element:h?.element===term?.element,buffer:h?.buffer===term?.buffer.active,scroll:term?.buffer.active.viewportY};};
f.scroll=(id:string,line:number)=>terminalRegistry.get(id)?.scrollToLine(line);
(window as any).rootFixture=f;
createRoot(document.getElementById('root')!).render(<App/>);
