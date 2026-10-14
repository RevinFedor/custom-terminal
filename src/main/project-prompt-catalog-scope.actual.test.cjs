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
  const service=new ProjectPromptCatalogService({db,rootRegistry:legacy?null:rootRegistry,fsImpl,layoutStore,watch:true});
  t.after(()=>service.close());reads.length=0;authorityReads=0;
  return {temp,source,docs,outside,reads,bindings,fsImpl,layoutStore,service,
    authorityReads:()=>authorityReads,layoutReads:()=>layoutReads};
}
test('disjoint usage root skips directory traversal, retains both fresh binding passes and layout reads',t=>{
  const f=fixture(t);assert.deepEqual(f.service.usageForRoot(f.outside),[]);
  assert.equal(f.reads.length,0);assert.equal(f.authorityReads(),48);
  assert.equal(f.layoutReads(),24);assert.equal(f.service.tabCache.size,0,'partial result must not poison full catalogs');
  const full=f.service.listTab('tab0');assert.equal(full.prompts.length,3);
});
test('descendant request visits only its branch and keeps exact scope/project provenance',t=>{
  const f=fixture(t),selected=path.join(f.docs,'selected');
  const result=f.service.usageForRoot(selected);
  assert.deepEqual(result.map(x=>x.path),[path.join(selected,'2.prompt.md')]);
  assert.equal(result[0].tabs.length,24);assert.equal(result[0].projects[0].id,'P');
  assert.deepEqual(f.reads,[f.docs,selected]);
  assert.equal(f.service.listTab('tab0').prompts.length,3,'a later full picker still sees other branches');
});
test('complete ancestor scan retains normal cache and caller DTO shape',t=>{
  const f=fixture(t);const usage=f.service.usageForRoot(f.source);
  assert.equal(usage.length,3);assert.equal(f.service.tabCache.size,24);
  const cached=f.service.tabCache.get('tab0').value;
  assert.equal(f.service.listTab('tab0'),cached);
  assert.equal(Object.getOwnPropertySymbols(cached.sources[0]).length,0);
  assert.equal(f.service.usageForRoot('/').length,3);
});
test('configured source alias and docs symlink use real path proof while retaining configured output paths',t=>{
  const f=fixture(t),alias=path.join(f.temp,'alias');fs.symlinkSync(f.source,alias,'dir');
  f.bindings.set('alias-tab',[alias]);
  const target=path.join(f.docs,'selected'),result=f.service.usageForRoot(target);
  assert.deepEqual(result.map(x=>x.path).sort(),[
    path.join(alias,'docs','selected','2.prompt.md'),path.join(target,'2.prompt.md')].sort());
  const redirected=path.join(f.temp,'redirected');fs.mkdirSync(redirected);fs.symlinkSync(f.docs,path.join(redirected,'docs'),'dir');
  f.bindings.set('redirected-tab',[redirected]);
  const again=f.service.usageForRoot(target);
  assert.ok(again.some(x=>x.path===path.join(redirected,'docs','selected','2.prompt.md')));
});
test('unknown canonical proof takes the original full traversal, not a false disjoint result',t=>{
  const f=fixture(t);f.fsImpl.realpathSync=p=>{if(p===f.docs)throw Object.assign(new Error('private'),{code:'EACCES'});return fs.realpathSync(p);};
  assert.deepEqual(f.service.usageForRoot(f.outside),[]);
  assert.ok(f.reads.includes(f.docs));assert.ok(f.reads.includes(path.join(f.docs,'unrelated')));
  assert.equal(f.service.tabCache.size,24);
});
test('known disjoint symlink directory retains the old lexical fallback for an unknown leaf',t=>{
  const f=fixture(t),wanted=fs.realpathSync(f.outside),alias=path.join(wanted,'alias');
  fs.symlinkSync(f.source,alias,'dir');f.bindings.set('alias-tab',[alias]);
  const leaf=path.join(alias,'docs','selected','2.prompt.md');
  // Real dirs/symlink; only the leaf retrieval error is injected. The configured
  // alias is lexically inside wanted, although its successful directory realpath
  // is outside. Previous usage filtering kept this exact fallback path.
  f.fsImpl.realpathSync=p=>{
    if(p===leaf)throw Object.assign(new Error('controlled leaf retrieval'),{code:'EACCES'});
    return fs.realpathSync(p);
  };
  assert.deepEqual(f.service.usageForRoot(wanted),[{path:leaf,
    projects:[{id:'P',name:'Project',icon:null}],tabs:[{id:'alias-tab',name:'alias-tab'}]}]);
  assert.equal(f.service.listTab('alias-tab').prompts.length,3,'the complete picker remains complete');
});
test('layout failures and future binding errors are not hidden by a disjoint filter',t=>{
  const f=fixture(t),error=new Error('layout failure');f.layoutStore.get=()=>{throw error;};
  assert.throws(()=>f.service.usageForRoot(f.outside),e=>e===error);
  f.layoutStore.get=()=>({layout:{}});const authorityError=Object.assign(new Error('future'),{code:'root_binding_forward_version'});
  f.service.rootRegistry.sourcesForTab=()=>{throw authorityError;};
  assert.throws(()=>f.service.usageForRoot(f.outside),e=>e===authorityError);
});
test('legacy project usage never stores a partial picker catalog',t=>{
  const f=fixture(t,{legacy:true});assert.deepEqual(f.service.usageForRoot(f.outside),[]);
  assert.equal(f.service.cache.size,0);assert.equal(f.service.listProject('P').prompts.length,3);
});
test('request-local realpath proof expires before the next alias target change',t=>{
  const f=fixture(t),link=path.join(f.temp,'request');fs.symlinkSync(f.outside,link,'dir');
  assert.deepEqual(f.service.usageForRoot(link),[]);fs.unlinkSync(link);fs.symlinkSync(path.join(f.docs,'selected'),link,'dir');
  const result=f.service.usageForRoot(link);assert.equal(result.length,1);assert.equal(result[0].tabs.length,24);
});
