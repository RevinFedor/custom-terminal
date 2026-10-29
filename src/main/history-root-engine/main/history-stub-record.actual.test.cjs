'use strict';

// Finite Source-only SQLite controls. No Electron, live profile or provider.
process.env.NOTED_HISTORY_READER_PROCESS = '1';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const v8=require('node:v8'),crypto=require('node:crypto');
const evidence=process.env.NOTED_STUB_TEST_EVIDENCE;
assert(evidence && path.isAbsolute(evidence),'explicit owned evidence directory required');
const SQLite=require(process.env.NOTED_UNIT_TEST_SQLITE_ADAPTER);
const load=Module._load;
Module._load=function(id,parent,main){return id==='better-sqlite3'?SQLite:load.call(this,id,parent,main);};
const {HistoryPagedStore,materializeHistoryCursorSync:mat,historyPagedCursorAddress}=require('./history-paged-store');
const {HistoryProjectionArena:Arena}=require('./history-projection-arena');
const pagedText=require('./history-paged-text');
function presentation(source){
  const m=new Module(path.join(__dirname,'history-primary-presentation.js'),module);
  m.filename=path.join(__dirname,'history-primary-presentation.js');m.paths=Module._nodeModulePaths(__dirname);
  m._compile(source+'\nmodule.exports._test={nativeAdapter,primaryRowStub};',m.filename);
  return m.exports;
}
const originalSource=fs.readFileSync(path.join(evidence,'history-primary-presentation.js.BEFORE'),'utf8');
const original=presentation(originalSource);
const current=presentation(fs.readFileSync(path.join(__dirname,'history-primary-presentation.js'),'utf8'));
const candidate=process.env.NOTED_STUB_TEST_ORIGINAL_RED==='1'?original:current;
const digest=s=>crypto.createHash('sha256').update(s,'utf16le').digest('hex');
function document(value){return v8.serialize(value).toString('base64');}
function sameValue(actual,expected){
  assert.deepEqual(actual,expected);
  assert.deepEqual(v8.deserialize(Buffer.from(document(actual),'base64')),expected);
  assert.equal(digest(document(actual)),digest(document(expected)));
}
function storeFor(t){
  const dir=fs.mkdtempSync(path.join(evidence,'fixture-'));
  const store=new HistoryPagedStore({filename:path.join(dir,'pages.sqlite'),Database:SQLite,diskBytes:32*1024**2});
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true});assert(!fs.existsSync(dir));});
  return store;
}
function pins(store){return {leases:store.stats().leases,builders:store.stats().activeBuilders,
  pins:store.db.prepare('SELECT count(*) n FROM hp_pins WHERE durable=0').get().n};}
function adapter(mod,arena){
  const metrics={scalarReads:0,maxNativeScalarChars:0};
  return {value:mod._test.nativeAdapter(arena,metrics,()=>{}),metrics};
}
function importRecord(mod,store,build){
  const arena=new Arena(store),a=adapter(mod,arena),raw=build(arena,a.value);
  const saved=arena.writeNode,counts=new Map();
  arena.writeNode=function(id,meta){counts.set(id,(counts.get(id)||0)+1);return saved.call(this,id,meta);};
  const next=arena.nextId,before=arena.metrics.boundaries,start=performance.now();
  let lease;
  try{
    const out=arena.step(()=>a.value.importStubRecord?a.value.importStubRecord(raw):a.value.importValue(raw));
    const wallMs=performance.now()-start,boundaries=arena.metrics.boundaries-before;
    lease=arena.step(()=>arena.publish(out));
    return {value:mat(lease.cursor()),rootWrites:counts.get(next)||0,writes:[...counts.values()].reduce((a,b)=>a+b,0),
      boundaries,wallMs,metrics:a.metrics,ownerCount:arena.nextId-next};
  }finally{lease?.release();a.value.clear();arena.close();}
}

test('controlled fresh scalar record reduces owner writes with identical values, order and one step',t=>{
  const store=storeFor(t),build=()=>{
    const root=Object.assign(Object.create(null),{rowStub:true,uuid:'owned',role:'assistant',timestamp:'2026-10-25',
      undefined:undefined,negativeZero:-0,nan:NaN,infinity:Infinity,negativeInfinity:-Infinity,big:2n**80n,
      null:null,contentLength:4,hasContent:true,hasThinking:false,recordTime:7,unicode:'Ω🙂\r\n\0\ud800'});
    Object.defineProperty(root,'__proto__',{value:'data',enumerable:true});
    root['9']='nine';root['2']='two';return root;
  };
  const old=importRecord(original,store,build),next=importRecord(candidate,store,build);
  sameValue(next.value,old.value);assert.equal(Object.getPrototypeOf(next.value),Object.prototype);
  assert.deepEqual(Object.keys(next.value),Object.keys(old.value));assert(Object.hasOwn(next.value,'undefined'));
  assert.equal(next.boundaries,old.boundaries);assert.equal(next.boundaries,1);
  assert.equal(next.ownerCount,old.ownerCount);assert.equal(next.rootWrites,2);assert(next.rootWrites<old.rootWrites);
  assert(next.writes<old.writes);assert.deepEqual(pins(store),{leases:0,builders:0,pins:0});
  t.diagnostic(JSON.stringify({scope:'finite Source scalar record; wall descriptive only',old:{...old,value:undefined},next:{...next,value:undefined}}));
});

test('shared seen map preserves nested cycles, aliases, maps, sets, holes and normalized prototypes',t=>{
  const store=storeFor(t),build=()=>{
    const root={rowStub:true},shared=Object.assign(Object.create(null),{label:'shared',missing:undefined});
    const sparse=new Array(5);sparse[2]=undefined;sparse[4]=shared;sparse.extra=shared;
    root.self=root;root.a=shared;root.b=shared;root.sparse=sparse;shared.parent=root;
    root.map=new Map([[root,shared],[shared,sparse]]);root.set=new Set([root,shared,sparse]);
    Object.defineProperty(root,'ignored',{value:'non-enumerable'});root[Symbol('ignored')]='symbol';return root;
  };
  const old=importRecord(original,store,build),next=importRecord(candidate,store,build);
  sameValue(next.value,old.value);const r=next.value;
  assert.equal(r.self,r);assert.equal(r.a,r.b);assert.equal(r.a.parent,r);assert.equal(r.map.get(r),r.a);
  assert(r.set.has(r));assert(r.set.has(r.a));assert.equal(r.sparse.extra,r.a);assert.equal(r.sparse.length,5);
  assert(!(0 in r.sparse));assert(2 in r.sparse);assert.equal(Object.getPrototypeOf(r.a),Object.prototype);
  assert.equal(next.ownerCount,old.ownerCount);assert.equal(next.boundaries,old.boundaries);
  assert(next.rootWrites<old.rootWrites);
});

test('native facade references stay handles and import never reads a long body',t=>{
  const store=storeFor(t),body='Ω🙂\ud800'.repeat(4096);
  function run(mod){
    const arena=new Arena(store),a=adapter(mod,arena);let lease;
    try{
      const raw=arena.step(()=>arena.own({content:body,uuid:'raw',child:{nested:1}}));
      const facade=a.value.read(raw),root={rowStub:true,a:facade,b:facade,child:facade.child};
      const out=arena.step(()=>a.value.importStubRecord?a.value.importStubRecord(root):a.value.importValue(root));
      assert(arena.same(out.a,raw));assert(arena.same(out.a,out.b));assert(arena.same(out.child,raw.child));
      assert.equal(a.metrics.scalarReads,0);assert.equal(a.metrics.maxNativeScalarChars,0);
      lease=arena.step(()=>arena.publish(out));return mat(lease.cursor());
    }finally{lease?.release();a.value.clear();arena.close();}
  }
  sameValue(run(candidate),run(original));
});

test('unsafe root fallback preserves getter/proxy/class effects and reentrant general assign',t=>{
  const store=storeFor(t);
  for(const kind of ['getter','proxy','class','array','map','set']){
    function run(mod){
      const log=[];
      const result=importRecord(mod,store,arena=>{
        const base={first:1};
        if(kind==='getter')Object.defineProperty(base,'second',{enumerable:true,get(){
          log.push('getter');base.third=3;
          const target=arena.assign({});
          arena.assign({get x(){target.marker='reentry';return target;}});return target;
        }});
        if(kind==='proxy')return new Proxy(base,{
          getPrototypeOf(o){log.push('prototype');return Reflect.getPrototypeOf(o);},
          ownKeys(o){log.push('keys');return Reflect.ownKeys(o);},
          getOwnPropertyDescriptor(o,k){log.push('descriptor:'+String(k));return Reflect.getOwnPropertyDescriptor(o,k);},
          get(o,k,r){log.push('get:'+String(k));return Reflect.get(o,k,r);}
        });
        if(kind==='class')return new (class Owned{constructor(){this.first=1;this.second=2;}})();
        if(kind==='array')return [1,,undefined];
        if(kind==='map')return new Map([[1,{x:2}]]);
        if(kind==='set')return new Set([1,2]);
        return base;
      });
      return {...result,log};
    }
    const old=run(original),next=run(candidate);sameValue(next.value,old.value);
    assert.deepEqual(next.log,old.log,kind+' trap/getter order');assert.equal(next.writes,old.writes,kind+' old path');
    assert.equal(next.boundaries,old.boundaries);
  }
});

test('data root child accessors retain old importer reads, mutations, aliases and cyclic root',t=>{
  const store=storeFor(t);
  function run(mod){
    const log=[];
    const result=importRecord(mod,store,()=>{
      const root={first:1},child={};
      Object.defineProperty(child,'read',{enumerable:true,get(){
        log.push('child');root.last='changed';root.added='outside original keys';return root;
      }});
      root.child=child;root.last='before';return root;
    });return {...result,log};
  }
  const old=run(original),next=run(candidate);sameValue(next.value,old.value);assert.deepEqual(next.log,old.log);
  assert.equal(next.value.last,'changed');assert(!Object.hasOwn(next.value,'added'));assert.equal(next.value.child.read,next.value);
});

function measuredUnit(mod,store,view,rank,options={}){
  const savedStep=Arena.prototype.step,savedWrite=Arena.prototype.writeNode;
  const work={steps:0,writes:0,current:0,checkpoints:0};
  const control={assertCurrent(){work.current++;options.assertCurrent?.();},async checkpoint(){work.checkpoints++;options.checkpoint?.();}};
  Arena.prototype.step=function(fn){if(!this.inStep)work.steps++;return savedStep.call(this,fn);};
  Arena.prototype.writeNode=function(...args){work.writes++;return savedWrite.apply(this,args);};
  const start=performance.now();
  return mod.projectPrimaryHistoryUnit(store,view,rank,{control}).then(lease=>({lease,work,wallMs:performance.now()-start}))
    .finally(()=>{Arena.prototype.step=savedStep;Arena.prototype.writeNode=savedWrite;});
}
function unitFixture(store){
  const arena=new Arena(store),body='Full Ω🙂\r\n\0\ud800'+ 'x'.repeat(16384);
  const row=(id,content)=>({uuid:id,role:'assistant',timestamp:'2026-10-25',recordTime:42,sessionId:'owned',content,thinking:' rationale ',
    sourceIdentity:{kind:'owned',id},sourceIdentityAliases:['a','b'],settingsFact:{unknown:undefined,negativeZero:-0},
    actions:[{tool:'__raw__',rawTool:{toolUseId:'call-'+id,toolName:'exec_command',family:'read',args:{cmd:'cat /owned/'+id+'.txt'},result:body}}]});
  let root;
  const first=row('one','First exact caption Ω🙂'),second=row('two','Second exact caption'),full=row('full',body);
  // Cross the existing 64-text-chunk checkpoint while keeping hidden thinking
  // dehydrated. This proves the comparator observes a real cooperative yield.
  second.thinking='r'.repeat(40*1024);
  try{root=arena.step(()=>arena.publish(arena.own({units:[{kind:'entry',entry:full},{kind:'group',key:'owned-group',level:2,
    entries:[first,second],captionEntries:[first,second],captionEntry:first}],source:[first,second,full]})));}
  finally{arena.close();}
  const view={root,unitAt(rank){return root.cursor().field('units').at(rank);}};
  const content=root.cursor().field('source').at(2).field('content');
  const fullLeaf=store.transaction(()=>store.lease(historyPagedCursorAddress(content).ref));
  return {view,root,fullLeaf,body};
}

test('entry/group/caption projection matches old full V8 and UTF16 document digest; boundaries unchanged',async t=>{
  const store=storeFor(t),f=unitFixture(store),frozen=mat(f.root.cursor()),baseline=pins(store);
  try{
    for(const [rank,kind] of [[0,'entry'],[1,'group']]){
      const old=await measuredUnit(original,store,f.view,rank);let next;
      try{
        next=await measuredUnit(candidate,store,f.view,rank);
        const expected=mat(old.lease.cursor()),actual=mat(next.lease.cursor());sameValue(actual,expected);
        assert.equal(next.work.steps,old.work.steps);assert.equal(next.work.current,old.work.current);
        assert.equal(next.work.checkpoints,old.work.checkpoints);
        if(kind==='group'){
          assert(next.work.writes<old.work.writes);assert(actual.entries.every(r=>r.rowStub));
          assert(next.work.checkpoints>0,'existing trimmedFacts checkpoints exercised');
          assert(actual.entries.every(r=>!Object.hasOwn(r,'content')&&!Object.hasOwn(r,'actions')&&!Object.hasOwn(r,'thinking')));
          assert.equal(actual.captionEntries[0].content,'First exact caption Ω🙂');assert(actual.captionEntry.captionTextComplete);
          assert(!Object.hasOwn(actual.captionEntry,'actions'));
        }else assert.equal(actual.entry.content,f.body);
        t.diagnostic(JSON.stringify({scope:'finite Source unit; wall descriptive only',kind,rank,utf16DocumentSHA256:digest(document(actual)),
          serializedBytes:v8.serialize(actual).length,old:{work:old.work,wallMs:old.wallMs},next:{work:next.work,wallMs:next.wallMs}}));
      }finally{old.lease.release();next?.lease.release();}
      assert.deepEqual(pins(store),baseline);sameValue(mat(f.root.cursor()),frozen);assert.equal(mat(f.fullLeaf.cursor()),f.body);
    }
  }finally{f.root.release();assert.equal(mat(f.fullLeaf.cursor()),f.body);f.fullLeaf.release();}
  assert.deepEqual(pins(store),{leases:0,builders:0,pins:0});
});

test('cancellation/fault/quota retain old frozen view, independent Full and transaction ownership',async t=>{
  const store=storeFor(t),f=unitFixture(store),frozen=mat(f.root.cursor()),baseline=pins(store);
  const stop=Object.assign(Error('owned cancel'),{code:'HISTORY_READ_CONSUMER_REVOKED'});
  const failure=Object.assign(Error('owned final record write fault'),{code:'OWN_STUB_RECORD_FAULT'});
  async function unchanged(){
    assert.deepEqual(pins(store),baseline);sameValue(mat(f.root.cursor()),frozen);assert.equal(mat(f.fullLeaf.cursor()),f.body);
  }
  try{
    for(const mod of [original,candidate]){
      await assert.rejects(measuredUnit(mod,store,f.view,1,{assertCurrent(){throw stop;}}),e=>e===stop);await unchanged();
      const step=Arena.prototype.step;let committed=0;
      Arena.prototype.step=function(fn){const outer=!this.inStep,result=step.call(this,fn);if(outer)committed++;return result;};
      try{
        await assert.rejects(measuredUnit(mod,store,f.view,1,{assertCurrent(){if(committed>=3)throw stop;}}),e=>e===stop);
        assert(committed>=3,'cancel after a stub step committed, rather than only initial validation');
      }finally{Arena.prototype.step=step;}
      await unchanged();
      let checkpoints=0;
      await assert.rejects(measuredUnit(mod,store,f.view,1,{checkpoint(){checkpoints++;throw stop;}}),e=>e===stop);
      assert.equal(checkpoints,1);await unchanged();
    }
    // Fail the new completion after its actual final write: SQL/root-pointer
    // rollback must preserve the same immutable readers and release builders.
    const saved=Arena.prototype._completeDataRecord;
    let completions=0;
    Arena.prototype._completeDataRecord=function(...args){const out=saved.apply(this,args);completions++;throw failure;};
    try{await assert.rejects(measuredUnit(candidate,store,f.view,1),e=>e===failure);assert.equal(completions,1);}
    finally{Arena.prototype._completeDataRecord=saved;}
    await unchanged();
    // Existing commit-time disk admission, not a new approximation or policy.
    const budget=store.diskBudget;store.diskBudget=0;
    try{
      for(const mod of [original,candidate]){
        await assert.rejects(measuredUnit(mod,store,f.view,1),{code:'HISTORY_BACKING_FULL'});await unchanged();
      }
    }finally{store.diskBudget=budget;}
    // Also exercise quota rejection at the optimized record's commit, after
    // successful child import/completion, not only at the earlier group copy.
    const complete=Arena.prototype._completeDataRecord;let quotaCompletions=0;
    Arena.prototype._completeDataRecord=function(...args){const out=complete.apply(this,args);quotaCompletions++;store.diskBudget=0;return out;};
    try{
      await assert.rejects(measuredUnit(candidate,store,f.view,1),{code:'HISTORY_BACKING_FULL'});
      assert.equal(quotaCompletions,1);
    }finally{Arena.prototype._completeDataRecord=complete;store.diskBudget=budget;}
    await unchanged();
    // Check the private completion cannot mutate an already populated owner.
    const arena=new Arena(store);let held;
    try{
      const data=arena.step(()=>arena.record({existing:1}));held=arena.step(()=>arena.publish(data));
      assert.throws(()=>arena.step(()=>arena._completeDataRecord(data,[['replacement',2]])),{code:'history_projection_record_target'});
      sameValue(mat(held.cursor()),{existing:1});
      assert.throws(()=>arena.step(()=>arena._completeDataRecord(arena.make('object'),[['child',{}]])),{code:'history_projection_record_child'});
    }finally{held?.release();arena.close();}
    await unchanged();
    let completeGC=false;
    for(let i=0;i<1024&&!completeGC;i++)completeGC=store.collectStep(128).complete;
    assert(completeGC,'finite fixture collection completed');await unchanged();
  }finally{f.root.release();assert.equal(mat(f.fullLeaf.cursor()),f.body);f.fullLeaf.release();}
  assert.deepEqual(pins(store),{leases:0,builders:0,pins:0});
});
