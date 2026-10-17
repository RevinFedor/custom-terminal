import {beginTabCloseFeedback} from './tabCloseFeedback.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformSync} from 'esbuild';
import {findOpenTabOwner} from './tabLinkNavigation.mjs';
import {archiveReceiptMatches} from './globalTabArchive.mjs';
import {isExactGroupCloseGuard} from './workflowOrganizationClient.mjs';
import {commitArchiveWithStopRetry} from './tabPersistenceTransactions.mjs';
import {createArchiveNavigationIntent} from '../components/Workspace/rootArchiveIntent.mjs';
const captureNavigationFor=state=>request=>{
  Object.assign(state,{view:'workspace',activeSpaceId:'space',activeProjectId:'native',splitPanes:[],splitFocusedIndex:0});
  return {intent:createArchiveNavigationIntent(state,request.requestId),unsubscribe(){}};
};

const storeSource=await readFile(new URL('../store/useWorkspaceStore.ts',import.meta.url),'utf8');
const workspaceSource=await readFile(new URL('../components/Workspace/Workspace.tsx',import.meta.url),'utf8');
function compile(expression,context) {
  const code=transformSync('const actual = '+expression+';',{loader:'tsx',target:'es2022'}).code;
  return new Function(...Object.keys(context),code+'return actual;')(...Object.values(context));
}
function declaration(source,name,next,context={}) {
  const from=source.indexOf('const '+name+' = '),to=source.indexOf('const '+next+' = ',from);
  assert.ok(from>=0&&to>from);
  return compile(source.slice(from+('const '+name+' = ').length,to).trim().replace(/;$/,''),context);
}
const pendingAction=declaration(storeSource,'buildHistoryPendingAction','parseHistoryTaskPlan');

test('actual favorite callback prepares Resume after exact ACK, before runtime, once per intent',async()=>{
  for(const provider of ['claude','codex','gemini']) {
    const tab={id:'created',lazyRuntime:true};const effects=[];
    const state={tabCatalog:{created:{namespace:'native',active:true}},
      openProjects:new Map([['native',{projectId:'native',tabs:new Map([['created',tab]])}]])};
    state.refreshOrganizationCatalog=async()=>effects.push('catalog');
    state.ensureTabRuntime=async()=>{effects.push(['runtime',tab.pendingAction]);return true;};
    let visible=false;state.openTabById=async()=>visible;
    const request={version:1,namespace:'source',requestId:'intent',favoriteId:9,
      record:{id:9,namespace:'source',command_type:provider,[provider+'_session_id']:'saved-sid'}};
    const receipt={success:true,namespace:'source',requestId:'intent',favoriteId:9,tabId:'created'};
    const actual=declaration(workspaceSource,'openFavorite','searchArchive',{
      exactRequest:x=>structuredClone(x),action:()=>async()=>receipt,useWorkspaceStore:{getState:()=>state},
      findOpenTabOwner,archiveReceiptMatches,buildHistoryPendingAction:pendingAction,favoriteLaunchIntents:{current:new Map()},
      captureNavigation:captureNavigationFor(state),
    });
    assert.equal(await actual(request),false);
    assert.deepEqual(effects[1],['runtime',{type:provider+'-continue',sessionId:'saved-sid'}]);
    tab.pendingAction=undefined;visible=true;
    assert.equal((await actual(request)).tabId,'created');
    assert.deepEqual(effects[3],['runtime',undefined],'retry must not launch another Resume after prior pending action was consumed');
  }
});

test('actual favorite callback does not admit runtime for foreign/negative receipt',async()=>{
  for(const changed of [{namespace:'foreign'},{requestId:'foreign'},{favoriteId:8},{success:false}]) {
    let work=0;
    const actual=declaration(workspaceSource,'openFavorite','searchArchive',{
      exactRequest:x=>x,action:()=>async()=>({success:true,namespace:'source',requestId:'intent',favoriteId:9,tabId:'created',...changed}),
      archiveReceiptMatches,useWorkspaceStore:{getState:()=>({refreshOrganizationCatalog:async()=>{work++;}})},
      captureNavigation:captureNavigationFor({openProjects:new Map()}),
    });
    assert.equal(await actual({namespace:'source',requestId:'intent',favoriteId:9,record:{}}),false);
    assert.equal(work,0);
  }
});

function closeCallback(state,ipcRenderer) {
  const from=storeSource.indexOf('closeTab: async (');
  const to=storeSource.indexOf('\n  restoreTabHistoryEntry:',from);
  assert.ok(from>=0&&to>from);
  const expression=storeSource.slice(from+'closeTab: '.length,to).trim().replace(/,$/,'');
  return compile(expression,{get:()=>state,set:patch=>Object.assign(state,patch),
    isExactGroupCloseGuard,nextPaneCloseOrder:()=>1,resolvePtyAgentOwner:()=> 'codex',isAiRuntimeTab:()=>true,
    isAiBusyTab:()=>false,isAiForegroundProcess:()=>false,ipcRenderer,beginTabCloseFeedback,startTransition:fn=>fn(),
    useUIStore:{getState:()=>({showToast:()=>{}})},commitArchiveWithStopRetry,captureTabRestorePlacement:()=>null});
}
test('actual guarded close forwards token, keeps owner and never stops/retries on archive refusal',async()=>{
  for(const failure of ['throw','structured','manual']) {
    const tab={id:'owner',name:'owner',cwd:'/synthetic',commandType:'codex',codexSessionId:'sid'};
    const workspace={projectId:'ns',tabs:new Map([['owner',tab]])};
    const state={openProjects:new Map([['ns',workspace]]),splitPanes:[],clearTerminalBuffer:()=>{}};
    const guard={mutationId:'group-intent',tabId:'owner',guardToken:'guard'};
    let archives=0,stops=0;const payloads=[];
    const actual=closeCallback(state,{invoke:async(channel,payload)=>{
      if(channel==='terminal:getCommandState')return {isRunning:false};
      if(channel==='project:validate-tab-snapshot')return {success:true};
      if(channel==='terminal:stop-ai-process'){stops++;return {success:true};}
      if(channel==='project:archive-tab'){
        archives++;payloads.push(payload);
        if(failure==='throw')throw Object.assign(Error('group_close_execution_changed'),{code:'group_close_execution_changed'});
        return {success:false,error:archives===1?'codex_archive_live_writer_unproven':'refused',
          ...(failure==='structured'?{code:'group_close_execution_changed'}:{})};
      }
      throw Error('Unexpected side effect: '+channel);
    }});
    const options={skipProcessCheck:true,...(failure==='manual'?{}:{groupCloseGuard:guard})};
    assert.equal(await actual('ns','owner',options),false);
    assert.equal(workspace.tabs.get('owner'),tab);assert.equal(tab.aiClosing,false);
    assert.equal(stops,failure==='manual'?1:0);assert.equal(archives,failure==='manual'?2:1);
    if(failure!=='manual')assert.deepEqual(payloads[0].groupCloseGuard,guard);
  }
});
