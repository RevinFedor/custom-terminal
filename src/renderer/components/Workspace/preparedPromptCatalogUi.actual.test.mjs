import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import {loadPickerPromptCatalog,loadPromptCatalogUsage,observePreparedPromptCatalog,
  createPreparedCatalogReceiver,promptCatalogChangeAffectsTarget,promptUsageChangeAffectsTarget} from './promptTabSourcesModel.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const catalog=(name='ready')=>({tabId:'T',sources:[],prompts:[{id:'project-prompt:N:1',title:name,path:'/source/docs/a.prompt.md',file_paths:['/source/docs/a.prompt.md']}]});
function emitter() {
  const listeners=new Set();
  return{on:(_name,fn)=>listeners.add(fn),removeListener:(_name,fn)=>listeners.delete(fn),
    changed:value=>[...listeners].forEach(fn=>fn({},value)),count:()=>listeners.size};
}

test('catalog and usage preserve typed preparing/changed/future errors, never success with a Promise',async()=>{
  for(const code of ['prompt_catalog_preparing','prompt_catalog_changed','root_binding_forward_version']){
    const ipc={invoke:async()=>({success:false,error:'bounded refusal',code})};
    await assert.rejects(loadPickerPromptCatalog(ipc,{tabId:'T',organizationReady:true}),e=>e.code===code);
    await assert.rejects(loadPromptCatalogUsage(ipc,'/source'),e=>e.code===code);
  }
  const ipc={invoke:async()=>({success:true,data:Promise.resolve(catalog())})};
  await assert.rejects(loadPickerPromptCatalog(ipc,{tabId:'T',organizationReady:true}),e=>e.code==='prompt_catalog_unavailable');
  await assert.rejects(loadPromptCatalogUsage(ipc,'/source'),e=>e.code==='prompt_catalog_unavailable');
});

test('subscription exists during the first invoke and an intervening event retires that response synchronously',async()=>{
  const ipc=emitter(),first=deferred(),states=[];let calls=0;
  const observation=observePreparedPromptCatalog({ipc,targetKey:'A',acceptsChange:()=>true,onState:s=>states.push(s),
    read:()=>{calls++;if(calls===1){assert.equal(ipc.count(),1);ipc.changed({tabIds:['T']});return first.promise;}return Promise.resolve(catalog('new'));}});
  first.resolve(catalog('old'));await tick();
  assert.equal(calls,2);assert.equal(observation.receiver.state().data.prompts[0].title,'new');
  assert.ok(!states.some(s=>s.data?.prompts[0]?.title==='old'));
  observation.close();assert.equal(ipc.count(),0);
});

test('burst events coalesce reads, invalidate stale rows before React, and never retry preparing by timer',async()=>{
  const ipc=emitter(),later=deferred();let calls=0;
  const observation=observePreparedPromptCatalog({ipc,targetKey:'A',acceptsChange:()=>true,onState:()=>{},
    read:()=>++calls===1?Promise.resolve(catalog()):later.promise});
  await tick();const old=observation.receiver.state().sequence;assert.ok(observation.receiver.canSelect(old));
  ipc.changed({});assert.equal(observation.receiver.canSelect(old),false);
  assert.equal(observation.receiver.state().status,'stale');assert.equal(observation.receiver.state().data,null);
  for(let i=0;i<20;i++)ipc.changed({});
  assert.equal(calls,2);
  later.reject(Object.assign(new Error('warming'),{code:'prompt_catalog_preparing'}));await tick();
  assert.equal(calls,3,'one coalesced read for the latest event');
  const count=calls;await tick();assert.equal(calls,count,'a preparing reply does not poll');
  observation.close();
});

test('late success after target switch or close is ignored and never revives selection',async()=>{
  const value=deferred(),states=[];let current=true;
  const receiver=createPreparedCatalogReceiver({targetKey:'A',read:()=>value.promise,onState:s=>states.push(s),isCurrent:()=>current});
  receiver.refresh();current=false;receiver.close();value.resolve(catalog());await tick();
  assert.equal(states.length,1);assert.equal(receiver.canSelect(1),false);assert.equal(states[0].data,null);
  const b=createPreparedCatalogReceiver({targetKey:'B',read:()=>Promise.resolve(catalog('B')),onState:()=>{}});
  b.refresh();await tick();assert.equal(b.state().targetKey,'B');assert.equal(b.state().data.prompts[0].title,'B');
});

test('explicit [] consumers are not broadcast; omitted identities preserve unknown-consumer wake',()=>{
  const target={tabId:'T',organizationReady:true};
  assert.equal(promptCatalogChangeAffectsTarget({tabIds:[]},target),false);
  assert.equal(promptCatalogChangeAffectsTarget({},target),true);
  assert.equal(promptUsageChangeAffectsTarget({tabIds:[]}),false);
  assert.equal(promptUsageChangeAffectsTarget({tabIds:['archive']}),true);
  assert.equal(promptUsageChangeAffectsTarget({}),true);
});

test('actual picker projection keeps ready globals usable during project preparing/failed and does not revive old project arrays',()=>{
  const source=fs.readFileSync(new URL('./PromptPickerOverlay.tsx',import.meta.url),'utf8');
  const start=source.indexOf('  const flatLeft = useMemo'),end=source.indexOf('\n  useEffect(',start);
  const js=transformSync(source.slice(start,end)+'\nglobalThis.result=flatLeft;',{loader:'tsx'}).code;
  for(const projectReady of [false,true]){
    const context={useMemo:fn=>fn(),projectTarget:true,projectReady,projectCatalog:projectReady?{prompts:[]}:null,
      projectLabel:{id:'tab:T',name:'Docs'},catalogTargetKey:'T',libraryLoaded:true,promptOutline:[{entityType:'group',rawGroup:{id:4,position:0}},
      {entityType:'prompt',rawPrompt:{id:8,title:'Global',position:1}}],flattenPromptOutlineNodes:n=>n.map(x=>x.rawPrompt)};
    vm.runInNewContext(js,context);
    assert.ok(context.result.some(r=>r.kind==='group'&&r.group.id===4));
    assert.ok(context.result.some(r=>r.kind==='prompt'&&r.prompt.id===8));
    assert.equal(context.result.some(r=>r.kind==='project'),!projectReady);
  }
  assert.ok(source.includes('libraryLoaded && projectReady && flatLeft.length === 0'));
  assert.ok(!source.includes('libraryLoaded && catalogLoadedKey'));
});

test('actual stale project handlers refuse selection/copy before any body or clipboard port',async()=>{
  const source=fs.readFileSync(new URL('./PromptPickerOverlay.tsx',import.meta.url),'utf8');
  const start=source.indexOf('  const handleSelectPrompt = useCallback'),end=source.indexOf('  const handleSelectScript',start);
  const calls=[],context={useCallback:fn=>fn,catalogReceiverRef:{current:{canSelect:()=>false}},currentCatalogState:{sequence:2},
    closePicker:()=>calls.push('close'),contextRequest:null,shortcutTarget:{tabId:'T'},showToast:()=>calls.push('toast'),
    firstEmptyPromptInChain:()=>null,activePickerGenerationRef:{current:8},deliverPromptChain:()=>calls.push('body'),
    pickerRenderGeneration:8,isCurrentPickerGeneration:(a,b)=>a===b,
    restartCopyFeedback:()=>{},copyRequestSeqRef:{current:0}};
  vm.runInNewContext(transformSync(source.slice(start,end)+'\nglobalThis.actions={select:handleSelectPrompt,copy:handleCopyPrompt};',{loader:'tsx'}).code,context);
  const row={id:'project-prompt:N:1'};
  await context.actions.select(row);await context.actions.copy({preventDefault(){},stopPropagation(){}},row);
  assert.deepEqual(calls,[]);
});

test('actual sidebar effect subscribes first, reports preparing/error and drops a late old-root read',async()=>{
  const source=fs.readFileSync(new URL('./Sidebar.jsx',import.meta.url),'utf8');
  const start=source.indexOf('  useEffect(() => {\n    if (!folderPath) return\n    const ipc'),end=source.indexOf('\n  const adoptFileIconResult',start);
  assert.ok(start>=0&&end>start);
  const ipc=emitter(),first=deferred(),states=[];let invokes=0,cleanup;
  ipc.invoke=()=>{invokes++;if(invokes===1){assert.equal(ipc.count(),1);return first.promise;}return Promise.resolve({success:false,code:'prompt_catalog_preparing',error:'warming'});};
  const context={folderPath:'/A',window:{require:()=>({ipcRenderer:ipc}),addEventListener(){},removeEventListener(){}},
    useEffect:fn=>{cleanup=fn()},observePreparedPromptCatalog,loadPromptCatalogUsage,promptUsageChangeAffectsTarget,
    promptUsageCurrentRef:{current:'/A'},setPromptUsageState:s=>states.push(s)};
  vm.runInNewContext(transformSync(source.slice(start,end),{loader:'jsx'}).code,context);
  ipc.changed({tabIds:['T']});first.resolve({success:true,data:[{path:'/A/file',projects:[]}]});await tick();
  assert.equal(states.at(-1).status,'preparing');assert.equal(states.at(-1).error.code,'prompt_catalog_preparing');
  assert.ok(!states.some(s=>s.status==='ready'));
  context.promptUsageCurrentRef.current='/B';cleanup();ipc.changed({});await tick();assert.equal(invokes,2);assert.equal(ipc.count(),0);
});
