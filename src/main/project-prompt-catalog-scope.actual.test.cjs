const prepared=require('./project-prompt-catalog.test-support.cjs');
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ProjectPromptCatalogService}=require('./project-prompt-catalog');

function fixture(t,{legacy=false}={}) {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'noted-usage-scope-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const source=path.join(temp,'source'),docs=path.join(source,'docs'),outside=path.join(temp,'outside');
  fs.mkdirSync(path.join(docs,'selected'),{recursive:true});fs.mkdirSync(path.join(docs,'unrelated'));
  fs.mkdirSync(outside);fs.writeFileSync(path.join(docs,'selected','2.prompt.md'),'private');
  fs.writeFileSync(path.join(docs,'unrelated','10.prompt.md'),'private');
  fs.writeFileSync(path.join(docs,'root.prompt.md'),'private');
  const reads=[],bindings=new Map(Array.from({length:24},(_,i)=>['tab'+i,[source]]));
  let authorityReads=0,layoutReads=0;
  const describe=rootPath=>({id:rootPath,rootId:rootPath,rootPath,projectId:'P',enabled:true});
  const rootRegistry={listSourceScopes:()=>[...bindings.keys()].map(tabId=>({tabId,name:tabId})),
    sourcesForTab:tabId=>{authorityReads++;return bindings.get(tabId).map(describe);},read:()=>({roots:[]})};
  const db={getProjectById:id=>({id,name:'Project',path:source}),
    getProjectsWithPromptSources:()=>[{id:'P'}],getProjectPromptSources:()=>[describe(source)]};
  const fsImpl={...fs,readdirSync:(p,opts)=>{reads.push(p);return fs.readdirSync(p,opts);},
    watch:()=>({close(){}})};
  const layoutStore={get:()=>{layoutReads++;return{layout:{}};}};
  const service=new ProjectPromptCatalogService({db,rootRegistry:legacy?null:rootRegistry,fsImpl,asyncFs:{...fs.promises,opendir:async(p,...a)=>{reads.push(p);return fs.promises.opendir(p,...a);},realpath:async p=>fsImpl.realpathSync.native?fsImpl.realpathSync.native(p):fsImpl.realpathSync(p)},authorityFence:prepared.controlledFence(db),layoutStore,watch:true});
  t.after(()=>service.close());reads.length=0;authorityReads=0;
  return {temp,source,docs,outside,reads,bindings,fsImpl,layoutStore,service,
    authorityReads:()=>authorityReads,layoutReads:()=>layoutReads};
}
test('disjoint usage consumes full prepared source and retains fresh binding/layout authority without read traversal',async t=>{
  const f=fixture(t);assert.deepEqual(await prepared.usage(f.service,f.outside),[]);
  assert.equal(f.service.tabCache.size,0);const scans=f.reads.length;
  assert.deepEqual(await f.service.usageForRoot(f.outside),[]);assert.equal(f.reads.length,scans);
  assert.ok(f.authorityReads()>=48);assert.equal((await f.service.listTab('tab0')).prompts.length,3);
});
test('descendant usage retains exact scope/project provenance and does not publish a pruned inventory',async t=>{
  const f=fixture(t),selected=path.join(f.docs,'selected'),result=await prepared.usage(f.service,selected);
  assert.deepEqual(result.map(x=>x.path),[path.join(selected,'2.prompt.md')]);assert.equal(result[0].tabs.length,24);assert.equal(result[0].projects[0].id,'P');
  assert.ok(f.reads.includes(path.join(f.docs,'unrelated')));assert.equal((await f.service.listTab('tab0')).prompts.length,3);
});
test('complete ancestor usage keeps literal DTO and independently owned records without archived-tab arrays',async t=>{
  const f=fixture(t);assert.equal((await prepared.usage(f.service,f.source)).length,3);const a=await f.service.listTab('tab0'),b=await f.service.listTab('tab0');
  assert.deepEqual(a.prompts,b.prompts);assert.notEqual(a.prompts,b.prompts);assert.equal(f.service.tabCache.size,0);assert.equal(Object.getOwnPropertySymbols(a.sources[0]).length,0);assert.equal((await f.service.usageForRoot('/')).length,3);
});
test('configured source alias/docs symlink keep realpath authority and configured output paths',async t=>{
  const f=fixture(t),alias=path.join(f.temp,'alias');fs.symlinkSync(f.source,alias,'dir');f.bindings.set('alias-tab',[alias]);const target=path.join(f.docs,'selected'),result=await prepared.usage(f.service,target);
  assert.deepEqual(result.map(x=>x.path).sort(),[path.join(alias,'docs','selected','2.prompt.md'),path.join(target,'2.prompt.md')].sort());
  const redirected=path.join(f.temp,'redirected');fs.mkdirSync(redirected);fs.symlinkSync(f.docs,path.join(redirected,'docs'),'dir');f.bindings.set('redirected-tab',[redirected]);
  assert.ok((await prepared.usage(f.service,target)).some(x=>x.path===path.join(redirected,'docs','selected','2.prompt.md')));
});
test('unknown required docs resolution is explicit, never a false disjoint/empty or ready result',async t=>{
  const f=fixture(t);f.fsImpl.realpathSync=p=>{if(p===f.docs)throw Object.assign(Error('private'),{code:'EACCES'});return fs.realpathSync(p);};
  await assert.rejects(f.service.usageForRoot(f.outside),{code:'EACCES'});
  assert.equal(f.service.tabCache.size,0);
});
test('directory-known/leaf-unknown alias keeps original lexical fallback and full inventory',async t=>{
  const f=fixture(t),wanted=fs.realpathSync(f.outside),alias=path.join(wanted,'alias');fs.symlinkSync(f.source,alias,'dir');f.bindings.set('alias-tab',[alias]);const leaf=path.join(alias,'docs','selected','2.prompt.md');
  f.fsImpl.realpathSync=p=>{if(p===leaf)throw Object.assign(Error('controlled leaf'),{code:'EACCES'});return fs.realpathSync(p);};
  assert.deepEqual(await prepared.usage(f.service,wanted),[{path:leaf,projects:[{id:'P',name:'Project',icon:null}],tabs:[{id:'alias-tab',name:'alias-tab'}]}]);assert.equal((await f.service.listTab('alias-tab')).prompts.length,3);
});
test('layout and future exact-scope errors keep precedence over disjoint/preparing',async t=>{
  const f=fixture(t),error=Error('layout failure');f.layoutStore.get=()=>{throw error;};await assert.rejects(f.service.usageForRoot(f.outside),e=>e===error);
  f.layoutStore.get=()=>({layout:{}});const future=Object.assign(Error('future'),{code:'root_binding_forward_version'});f.service.rootRegistry.sourcesForTab=()=>{throw future;};await assert.rejects(f.service.usageForRoot(f.outside),e=>e===future);
});
test('legacy project usage shares full metadata but preserves legacy grouping',async t=>{
  const f=fixture(t,{legacy:true});assert.deepEqual(await prepared.usage(f.service,f.outside),[]);assert.equal(f.service.cache.size,0);assert.equal((await f.service.listProject('P')).prompts.length,3);
});
test('request-local canonical proof expires before next alias retarget',async t=>{
  const f=fixture(t),alias=path.join(f.temp,'alias');fs.symlinkSync(f.source,alias,'dir');f.bindings.set('alias-tab',[alias]);await prepared.usage(f.service,f.source);
  const other=path.join(f.temp,'other');fs.mkdirSync(path.join(other,'docs'),{recursive:true});fs.writeFileSync(path.join(other,'docs','other.prompt.md'),'private');fs.unlinkSync(alias);fs.symlinkSync(other,alias,'dir');
  const value=await prepared.usage(f.service,f.source);assert.ok(!value.some(x=>x.path.startsWith(alias+path.sep)));assert.equal((await f.service.listTab('alias-tab')).prompts[0].title,'other');
});
