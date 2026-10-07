import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as intents from './rootArchiveIntent.mjs';
import {GLOBAL_EXECUTION_NAMESPACE as root} from '../../utils/workflowMembership.mjs';
import {archiveReceiptMatches} from '../../utils/globalTabArchive.mjs';
import {findOpenTabOwner} from '../../utils/tabLinkNavigation.mjs';
import {tabNavigationLocation} from '../../utils/tabNavigationLocation.mjs';

// Run the real Root caller and its JSX callbacks without mounting other owners' UI.
const source = fs.readFileSync(new URL('./Workspace.tsx',import.meta.url),'utf8');
const parsed = ts.createSourceFile('Workspace.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const node = parsed.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'RootGlobalArchive');
assert.ok(node);
const compiled = ts.transpile(node.getText(parsed).replace(/^export /,''),{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React});
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve;const promise = new Promise(r => {resolve=r;});return {promise,resolve};};
const scope = (namespace=root,historyIds=[1,2],cwds=['/alpha','/beta'],rowsHash='main-hash') => ({namespace,historyIds,cwds,rowsHash,count:historyIds.length,notesCount:1});
const snapshot = () => ({version:1,history:[{namespace:root,id:1,cwd:'/alpha'},{namespace:root,id:2,cwd:'/beta'}],favorites:[],clearScopes:[scope(),scope('legacy',[3],['/legacy'],'legacy-hash')]});

function fixture({invoke,refresh,restore,runtime,open}={}) {
  const calls=[],listeners=new Set(),cells=[],effects=[];
  let cursor=0,tree,current=snapshot(),uuid=0,prepared=0;
  const tab={id:'restored',cwd:'/alpha'};
  let state={view:'workspace',activeSpaceId:'workflow',activeProjectId:root,splitPanes:[],splitFocusedIndex:0,
    openProjects:new Map([[root,{activeTabId:'source',currentView:'terminal',tabs:new Map([[tab.id,tab]])}]]),
    activeTabNavigationIntent:null,navigationRevision:0,navigationMutationOwner:null,spaces:[],tabCatalog:{restored:{namespace:root,active:true}},
    async refreshOrganizationCatalog(){calls.push(['catalog']);await refresh?.();},
    async restoreTabHistoryEntry(...args){calls.push(['restore',...args]);return restore ? restore(...args) : {tabId:tab.id,success:true};},
    async ensureTabRuntime(...args){calls.push(['runtime',...args]);return runtime ? runtime(...args) : true;},
    async openTabById(...args){calls.push(['foreground',...args]);return open ? open(...args) : true;},
  };
  const mutate=(patch,owner=null) => {
    const before=tabNavigationLocation(state),next={...state,...patch};
    if (tabNavigationLocation(next)!==before) {next.navigationRevision++;next.navigationMutationOwner=owner;}
    next.navigationKey=tabNavigationLocation(next);state=next;listeners.forEach(fn=>fn(state));
  };
  const useWorkspaceStore=selector=>selector(state);
  useWorkspaceStore.getState=()=>state;
  useWorkspaceStore.setState=patch=>mutate(patch);
  useWorkspaceStore.subscribe=fn=>{listeners.add(fn);return ()=>listeners.delete(fn);};
  const useState=initial=>{const i=cursor++;if (!(i in cells)) cells[i]=initial;return [cells[i],value=>{cells[i]=typeof value==='function'?value(cells[i]):value;}];};
  const useRef=initial=>{const i=cursor++;if (!(i in cells)) cells[i]={current:initial};return cells[i];};
  const useCallback=(fn,deps)=>{const i=cursor++;if (!cells[i] || deps.some((d,j)=>d!==cells[i].deps[j])) cells[i]={fn,deps};return cells[i].fn;};
  const useEffect=(fn,deps)=>{const i=cursor++;if (!cells[i] || deps.some((d,j)=>d!==cells[i].deps[j])) {cells[i]?.cleanup?.();cells[i]={deps};effects.push(()=>{cells[i].cleanup=fn();});}};
  const context={...intents,GLOBAL_EXECUTION_NAMESPACE:root,useWorkspaceStore,useState,useRef,useCallback,useEffect,
    React:{createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)})},
    crypto:{randomUUID:()=>`request-${++uuid}`},window:{addEventListener(){},removeEventListener(){}},
    ipcRenderer:{async invoke(channel,request){calls.push([channel,request]);if(channel==='workflow:archive-read')return current;
      if(channel==='workflow:archive-clear-receipt')return null;
      if(invoke)return invoke(channel,request);
      const exact=request?.request || request;
      return {...exact,success:true,deletedIds:exact?.historyIds || [],tabId:tab.id};},on(){},removeListener(){}},
    createArchiveTitleRefresher:()=>()=>{},generateTabTitleFromSession(){},archiveReceiptMatches,findOpenTabOwner,
    buildHistoryPendingAction(){prepared++;return {type:'resume'};},GlobalTabArchive:'GlobalTabArchive',GlobalArchivePreview:'Preview',
  };
  const component=vm.runInNewContext(compiled+'\nRootGlobalArchive;',context);
  const render=()=>{cursor=0;tree=component({onClose:()=>calls.push(['close'])});effects.splice(0).forEach(fn=>fn());return tree;};
  const find=(predicate,element=tree)=>{if(!element || typeof element!=='object')return null;if(predicate(element))return element;for(const child of element.children||[]){const found=find(predicate,child);if(found)return found;}return null;};
  const text=element=>typeof element==='string'||typeof element==='number'?String(element):(element?.children||[]).map(text).join('');
  const button=label=>find(n=>n.type==='button'&&text(n)===label);
  const child=()=>find(n=>n.type==='GlobalTabArchive').props;
  render();
  return {render,find,button,child,calls,mutate,state:()=>state,prepared:()=>prepared,listeners,
    async services(){await child().readArchive();render();button('Индексы и очистка').props.onClick();render();},
    setSnapshot(value){current=value;},text,
    unmount(){cells.forEach(c=>c?.cleanup?.());},
  };
}

test('actual confirmation freezes namespace, rows, Main hash and summary across selector edits',async()=>{
  const f=fixture();await f.services();
  const label=f.find(n=>n.type==='option'&&n.props.value===root);
  assert.match(f.text(label),/Общий архив.*Все каталоги \(2\).*2/);
  assert.ok(!f.text(label).includes(root));
  f.button('Очистить архив').props.onClick();f.render();
  f.find(n=>n.props['aria-label']==='Область архива').props.onChange({target:{value:'legacy'}});
  f.find(n=>n.type==='input').props.onChange({target:{value:'2026-10-01'}});f.render();
  assert.match(f.text(f.find(n=>n.props.role==='alertdialog')),/\/alpha.*\/beta/);
  f.button('Подтвердить').props.onClick();await tick();f.render();
  const request=f.calls.find(c=>c[0]==='workflow:archive-clear')[1];
  assert.deepEqual(JSON.parse(JSON.stringify(request)),{version:1,requestId:'request-1',namespace:root,kind:'clear-history',historyIds:[1,2],expectedRowsHash:'main-hash'});
  assert.equal(f.calls.some(c=>c[0].startsWith('project:clear')),false);
  f.unmount();
});

test('false and mismatched receipts stay failed; explicit retry rereads but reuses exact intent',async()=>{
  let attempts=0;
  const f=fixture({invoke:(_channel,request)=>++attempts===1?false:{success:true,...request,requestId:'wrong'}});await f.services();
  f.button('Очистить без заметок').props.onClick();f.render();f.button('Подтвердить').props.onClick();await tick();f.render();
  assert.ok(f.find(n=>n.props.role==='alert'));assert.ok(f.find(n=>n.props.role==='alertdialog'));assert.equal(f.find(n=>n.props.role==='status'),null);
  f.setSnapshot({...snapshot(),clearScopes:[scope(root,[99],['/new'],'new-hash')]});
  f.button('Повторить').props.onClick();await tick();f.render();
  const clears=f.calls.filter(c=>c[0]==='workflow:archive-clear');assert.equal(clears.length,2);
  assert.deepEqual(clears[0][1],clears[1][1]);
  const retryIndex=f.calls.lastIndexOf(clears[1]);assert.equal(f.calls[retryIndex-2][0],'workflow:archive-read');
  assert.equal(f.calls[retryIndex-1][0],'workflow:archive-clear-receipt');
  assert.equal(f.find(n=>n.props.role==='status'),null);f.unmount();
});

test('CAS refusal explains no write; missing Main scope cannot fall back to namespace-wide legacy delete',async()=>{
  const f=fixture({invoke:()=>({success:false,disposition:'not-applied',error:'archive_rows_changed'})});await f.services();
  f.button('Очистить архив').props.onClick();f.render();f.button('Подтвердить').props.onClick();await tick();f.render();
  assert.match(f.text(f.find(n=>n.props.role==='alert')),/Очистка не применена/);
  f.button('Отмена').props.onClick();f.setSnapshot({version:1,history:[],favorites:[]});await f.child().readArchive();f.render();
  assert.equal(f.button('Статистика').props.disabled,false,'empty archive retains index stats namespace');
  f.button('Очистить архив').props.onClick();f.render();assert.equal(f.find(n=>n.props.role==='alertdialog'),null);
  assert.match(f.text(f.find(n=>n.props.role==='alert')),/проверить состав/);f.unmount();
});

test('index clear captures namespace and date before confirmation',async()=>{
  const f=fixture();await f.services();f.find(n=>n.type==='input').props.onChange({target:{value:'2026-10-01'}});f.render();
  f.button('Очистить индекс названий').props.onClick();f.render();
  f.find(n=>n.props['aria-label']==='Область архива').props.onChange({target:{value:'legacy'}});
  f.find(n=>n.type==='input').props.onChange({target:{value:'2026-10-06'}});f.render();f.button('Подтвердить').props.onClick();await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(c=>c[0]==='tab-title-index:clear')[1])),{projectId:root,force:false,dateFrom:'2026-10-01'});f.unmount();
});

test('empty initial archive still exposes read-only index statistics',async()=>{
  const f=fixture();f.setSnapshot({version:1,history:[],favorites:[],clearScopes:[]});await f.services();
  assert.equal(f.button('Статистика').props.disabled,false);f.button('Статистика').props.onClick();await tick();
  assert.equal(f.calls.filter(c=>c[0].endsWith(':stats')).length,2);f.unmount();
});

test('cancel during retry read invalidates the same confirmation callback before another clear is sent',async()=>{
  const gate=deferred();let reads=0;
  const f=fixture({invoke:()=>false});await f.services();f.button('Очистить архив').props.onClick();f.render();
  f.button('Подтвердить').props.onClick();await tick();f.render();
  const retry=f.button('Повторить').props.onClick;
  // Hold the actual read callback at the retry's first await.
  const pendingSnapshot={then:resolve=>{reads++;gate.promise.then(()=>resolve(snapshot()));}};
  f.setSnapshot(pendingSnapshot);retry();await tick();assert.equal(reads,1);
  f.button('Отмена').props.onClick();f.render();gate.resolve();await tick();
  retry();await tick();assert.equal(f.calls.filter(c=>c[0]==='workflow:archive-clear').length,1);f.unmount();
});

test('matching full durable receipt confirms except-notes for the entire frozen scope',async()=>{
  const f=fixture({invoke:(_channel,request)=>({...request,success:true,deletedIds:[1]})});
  await f.services();f.button('Очистить без заметок').props.onClick();f.render();
  assert.match(f.text(f.find(n=>n.props.role==='alertdialog')),/Сохранятся записи с заметками: 1/);
  f.button('Подтвердить').props.onClick();await tick();f.render();
  assert.equal(f.find(n=>n.props.role==='alertdialog'),null);assert.equal(f.find(n=>n.props.role==='alert'),null);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(c=>c[0]==='workflow:archive-clear')[1].historyIds)),[1,2]);f.unmount();
});

test('hash mismatch and reordered ACK IDs cannot confirm even when namespace and request ID match',async()=>{
  for (const patch of [{expectedRowsHash:'other-hash'},{historyIds:[2,1]},{kind:'clear-except-notes'}]) {
    const f=fixture({invoke:(_channel,request)=>({...request,...patch,success:true,deletedIds:[1,2]})});await f.services();
    f.button('Очистить архив').props.onClick();f.render();f.button('Подтвердить').props.onClick();await tick();f.render();
    assert.ok(f.find(n=>n.props.role==='alertdialog'));assert.ok(f.find(n=>n.props.role==='alert'));
    assert.equal(f.find(n=>n.props.role==='status'),null);f.unmount();
  }
});

test('Main CAS and active-lease exceptions explain refusal and retain the frozen confirmation',async()=>{
  for (const [code,expected] of [['archive_clear_scope_changed',/Состав архива изменился/],['archive_restore_busy',/восстановление вкладки/]]) {
    for (const typed of [false,true]) {
      const f=fixture({invoke:()=>{if(typed)return {success:false,disposition:'not-applied',code};throw new Error('IPC: '+code);}});await f.services();
      f.button('Очистить архив').props.onClick();f.render();f.button('Подтвердить').props.onClick();await tick();f.render();
      assert.match(f.text(f.find(n=>n.props.role==='alert')),expected);assert.ok(f.find(n=>n.props.role==='alertdialog'));f.unmount();
    }
  }
});

const request=(kind='history')=>({version:1,namespace:root,requestId:`${kind}-intent`,historyId:kind==='history'?1:undefined,
  favoriteId:kind==='favorite'?1:undefined,record:{id:1,namespace:root,cwd:'/alpha'},targetWorkflowId:'workflow'});

test('same restore callback cannot foreground after close while catalog RPC is pending; durable restore still finishes',async()=>{
  const gate=deferred(),f=fixture({refresh:()=>gate.promise});const callback=f.child().onRestore;
  const pending=callback(request());f.child().onClose();f.render();gate.resolve();
  const receipt=await pending;assert.equal(receipt.tabId,'restored');assert.equal(f.calls.filter(c=>c[0]==='restore').length,1);
  assert.equal(f.calls.filter(c=>c[0]==='foreground').length,0);assert.equal(f.listeners.size,0);f.unmount();
});

test('away and back during restore invalidates old foreground intent, including the same callback retry',async()=>{
  const gate=deferred(),f=fixture({restore:()=>gate.promise});const callback=f.child().onRestore;
  const pending=callback(request());await tick();f.mutate({view:'dashboard'});f.mutate({view:'workspace'});
  gate.resolve({tabId:'restored',success:true});await pending;await callback(request());
  assert.equal(f.calls.filter(c=>c[0]==='foreground').length,0);f.unmount();
});

test('favorite cancellation during runtime admission preserves create and does not prepare Resume twice on retry',async()=>{
  const gate=deferred(),f=fixture({runtime:()=>gate.promise});const callback=f.child().onOpenFavorite;
  const pending=callback(request('favorite'));await tick();assert.equal(f.prepared(),1);f.child().onClose();gate.resolve(true);
  assert.equal((await pending).success,true);await callback(request('favorite'));
  assert.equal(f.prepared(),1);assert.equal(f.calls.filter(c=>c[0]==='foreground').length,0);f.unmount();
});

test('new foreground archive action supersedes an earlier pending action without cancelling either durable restore',async()=>{
  const first=deferred();let count=0;
  const f=fixture({restore:()=>++count===1?first.promise:{tabId:'restored',success:true}});
  const callback=f.child().onRestore,pending=callback(request());await tick();
  await callback({...request(),requestId:'new-foreground'});first.resolve({tabId:'restored',success:true});await pending;
  assert.equal(f.calls.filter(c=>c[0]==='restore').length,2);assert.equal(f.calls.filter(c=>c[0]==='foreground').length,1);f.unmount();
});

test('surviving restore foregrounds and owns only its direct navigation mutations; close cancels its pending reveal',async()=>{
  const gate=deferred();let f;
  f=fixture({open:()=>{f.mutate({activeTabNavigationIntent:{id:'own-open',tabId:'restored'}});return gate.promise;}});
  const pending=f.child().onRestore(request());await tick();assert.equal(f.calls.filter(c=>c[0]==='foreground').length,1);
  f.child().onClose();assert.equal(f.state().activeTabNavigationIntent,null);gate.resolve(false);assert.equal(await pending,false);f.unmount();
});

test('pure intent copies scope arrays and distinguishes owned navigation from an away/back gesture',()=>{
  const original=scope();const frozen=intents.freezeArchiveClearIntent('clear-history',original,'2026-10-01','r');
  original.historyIds.push(8);original.cwds.push('/other');assert.deepEqual(frozen.historyIds,[1,2]);assert.deepEqual(frozen.scopeSummary.cwds,['/alpha','/beta']);
  const f=fixture(),intent=intents.createArchiveNavigationIntent(f.state(),'r');
  f.listeners.add(intent.observe);
  intent.applyOwnedNavMutations(()=>f.mutate({activeTabNavigationIntent:{id:'own'}}));
  f.mutate({view:'dashboard'},'own');assert.equal(intent.isCurrent(f.state()),true);
  f.mutate({view:'workspace'});f.mutate({view:'dashboard'},'own');assert.equal(intent.isCurrent(f.state()),false);f.unmount();
});
