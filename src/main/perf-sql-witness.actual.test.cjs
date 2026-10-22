'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createCausalContext}=require('./perf-causal-context');
const {createCausalTransport}=require('./perf-causal-transport');
const {createCausalJournal,cleanCausalRecord}=require('./perf-causal-journal');
const {sanitizeSqlWitness,fitCausalRecord}=require('../shared/perf-causal-schema.cjs');
const {createArtifactStore,createFlightRecorder}=require('./perf-flight-recorder');
const START=Date.UTC(2026,9,21,6),origin={pid:71,kind:'main'};
function fixture(sink){let at=START,clocks=0;const records=[];
 const c=createCausalContext({boot:'sql-private',pid:71,now:()=>{clocks++;return at;}});
 c.configure({enabled:true,sink:sink|| (r=>{records.push(r);return true;})});
 return {c,records,tick:n=>at+=n,clocks:()=>clocks,sql:()=>c.snapshot().sqlWitness};
}
function dir(t){const d=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'noted-sql-witness-')),identity=fs.lstatSync(d);t.after(()=>{const current=fs.lstatSync(d);assert.ok(current.isDirectory()&&!current.isSymbolicLink()&&current.dev===identity.dev&&current.ino===identity.ino,'owned fixture replaced');fs.rmSync(d,{recursive:true});});return d;}
function writes(store){return store.entries().filter(e=>e.name.startsWith('causal-')).flatMap(e=>fs.readFileSync(store.file(e.name),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));}
function example(){const f=fixture();f.c.sql('db.named','all',()=>[]);return f.records[0];}

test('all phases have local before-call identity outside work; returned Promise/object/throw exact, no row traversal',()=>{
 const f=fixture();let calls=0;
 for(const phase of ['prepare','get','all','run']){
  const value=phase==='all'?new Proxy([{secret:'SECRET_ROWS'}],{get(t,k){if(k!=='length')throw Error('row walk');return t.length;}}):Promise.resolve('x');
  assert.equal(f.c.sql('fixed.'+phase,phase,()=>{calls++;const w=f.sql();assert.equal(w.active.operation,phase);assert.equal(w.totals.attempted-w.totals.completed,1);return value;}),value);
 }
 const error={body:'SECRET_ERROR'};assert.throws(()=>f.c.sql('fixed.all','all',()=>{calls++;throw error;}),e=>e===error);
 assert.equal(calls,5);const w=f.sql();assert.equal(w.totals.attempted,5);assert.equal(w.totals.completed,5);assert.equal(w.totals.errors,1);assert.equal(w.totals.rows,1);
 assert.equal(w.active,null);assert.equal(w.lastCompleted.outcome,'error');assert.doesNotMatch(JSON.stringify(f.records),/SECRET/);
});

test('nested and reentrant wrappers restore active stack, monotonic revision, distinct attempted/completed',()=>{
 const f=fixture();let outer;
 f.c.sql('outer','all',()=>{
  outer=f.sql().active.sequence;
  f.c.sql('inner','get',()=>{const w=f.sql();assert.equal(w.active.parentSqlSequence,outer);assert.equal(w.totals.completed,0);return 9;});
  assert.equal(f.sql().active.sequence,outer);assert.equal(f.sql().lastCompleted.sequence,2);
  const err={};assert.throws(()=>f.c.sql('throwing','run',()=>{throw err;}),e=>e===err);
  assert.equal(f.sql().active.sequence,outer);return [];
 });
 assert.equal(f.sql().lastCompleted.sequence,1,'last settled is not maximum statement sequence');assert.equal(f.sql().sequence,3);assert.equal(f.sql().revision,6);
 let reenter=true,c;
 c=createCausalContext({boot:'reentrant',pid:72,now:()=>START});
 c.configure({enabled:true,sink:r=>{if(r.kind==='sql-witness' && r.sqlWitness.active && reenter){reenter=false;c.sql('sink.reentry','get',()=>assert.equal(c.snapshot().sqlWitness.active.parentSqlSequence,1));}return true;}});
 c.sql('outer','all',()=>assert.equal(c.snapshot().sqlWitness.active.sequence,1));
 assert.equal(c.snapshot().sqlWitness.totals.completed,2);assert.equal(c.snapshot().sqlWitness.active,null);
});

test('two post-await request owners and nested work roots use current IDs, never earlier caller',async()=>{
 const f=fixture();let a,b;
 const run=(name,gate)=>f.c.run('ipc.'+name,{tabId:name},async()=>{await gate;return f.c.syncWork('work.'+name,{},()=>f.c.sql('db.shared','all',()=>{
  const s=f.c.snapshot(),w=s.sqlWitness;assert.equal(w.active.workId,s.active.find(x=>x.name==='work.'+name).spanId);return [];
 }));},{explicit:false});
 const pa=run('A',new Promise(r=>a=r)),pb=run('B',new Promise(r=>b=r));b();await pb;a();await pa;
 const pre=f.records.filter(r=>r.kind==='sql-witness'&&r.sqlWitness.active);
 assert.equal(pre.length,2);assert.notEqual(pre[0].sqlWitness.active.parentSpanId,pre[1].sqlWitness.active.parentSpanId);
});

test('OFF has zero clock/sink reads; malformed site/operation and clock/send failure cannot replace result/throw',()=>{
 let reads=0,sends=0,calls=0;const c=createCausalContext({boot:'off',now:()=>{reads++;return START;}});
 c.configure({sink:()=>{sends++;throw Error('bad');}});const before=reads,value={},err={};
 assert.equal(c.sql('s','all',()=>{calls++;return value;}),value);assert.throws(()=>c.sql('s','all',()=>{calls++;throw err;}),e=>e===err);
 assert.equal(reads,before);assert.equal(sends,0);assert.equal(calls,2);
 c.configure({enabled:true});assert.equal(c.sql('/SECRET/path','all',()=>value),value);assert.equal(c.sql('s','unknown',()=>value),value);
 assert.equal(c.sql('s','all',()=>value),value);assert.throws(()=>c.sql('s','all',()=>{throw err;}),e=>e===err);
 assert.equal(c.snapshot().sqlWitness.health.transportFailures,4);
 let fail=false;const d=createCausalContext({boot:'clock',now:()=>{if(fail)throw Error();return START;}});d.configure({enabled:true});fail=true;
 assert.equal(d.sql('s','all',()=>value),value);
 const f=fixture();const rows=new Proxy([],{get(){throw err;}});assert.equal(f.c.sql('s','all',()=>rows),rows);assert.equal(f.sql().totals.completed,1);assert.equal(f.sql().lastCompleted.rows,null);
});

test('source pair budget is fixed under flood; local sites bounded; failed sends not retried, sampled settle independent',()=>{
 const f=fixture();for(let i=0;i<4096;i++)f.c.sql('db.'+(i%20),'all',()=>[]);
 assert.equal(f.records.length,8);assert.equal(f.sql().totals.attempted,4096);assert.equal(f.sql().sites.length,16);assert.equal(f.sql().health.siteOverflow,816);
 assert.equal(f.sql().health.preCallAttempts,4);assert.equal(f.sql().health.suppressed,4092);
 for(const r of f.records){assert.equal(r.sqlWitness.sites.length,0);assert.ok(Buffer.byteLength(JSON.stringify(r))<2048);}
 f.tick(60000);f.c.sql('db.0','all',()=>[]);assert.equal(f.records.length,10);
 const lost=fixture(()=>false);let calls=0;for(let i=0;i<20;i++)lost.c.sql('s','all',()=>calls++);
 assert.equal(calls,20);assert.equal(lost.sql().health.transportFailures,8);assert.equal(lost.sql().health.suppressed,16);
});

test('transport existing 24/32 caps, callback error/backpressure/throw/target failure leave product once unchanged',()=>{
 let callback;const child={connected:true,send(_r,cb){callback=cb;return false;}};let errors=0;
 const tx=createCausalTransport({target:()=>child,onFailure:()=>errors++}),f=fixture(r=>tx.sendRecord(r));
 const value=[];assert.equal(f.c.sql('s','all',()=>value),value);assert.equal(tx.snapshot().accepted,2);callback(Error('SECRET'));
 assert.equal(errors,1);assert.equal(tx.snapshot().callbackErrors,1);assert.equal(tx.snapshot().backpressure,2);
 for(let i=0;i<23;i++)tx.sendRecord({kind:'span'});assert.equal(tx.snapshot().pending,24);
 assert.equal(tx.sendRecord(example()),false);for(let i=0;i<8;i++)assert.equal(tx.sendRecord({kind:'work-summary'}),true);assert.equal(tx.snapshot().pending,32);
 const throwing=createCausalTransport({target:()=>({connected:true,send(){throw Error('SECRET');}})});
 const bad=fixture(r=>throwing.sendRecord(r));let calls=0;assert.equal(bad.c.sql('s','all',()=>++calls),1);assert.equal(calls,1);assert.equal(throwing.snapshot().throws,2);assert.equal(throwing.snapshot().pending,0);
 const targetBad=createCausalTransport({target:()=>{throw Error('bad target');}}),g=fixture(r=>targetBad.sendRecord(r));assert.equal(g.c.sql('s','all',()=>value),value);assert.equal(g.sql().health.transportFailures,2);
});

test('schema rejects malformed capsules and getters; allowlists secret-bearing payloads; fitting preserves mandatory SQL core',()=>{
 const r=example(),input={...r,sql:'SECRET_SQL',bindings:['SECRET_BIND'],rows:[{data:'SECRET_ROW'}],stack:'SECRET_STACK',path:'/SECRET/PATH'};
 input.sqlWitness={...r.sqlWitness,sql:'SECRET_SQL',bindings:'SECRET_BIND',stack:'SECRET_STACK',path:'/SECRET/PATH'};
 const cleaned=cleanCausalRecord(input,origin,START);assert.ok(cleaned);assert.doesNotMatch(JSON.stringify(cleaned),/SECRET/);
 for(const change of [{active:{...r.sqlWitness.active,siteId:'/SECRET/PATH'}},{version:2},{sequence:-1},{active:undefined},{totals:{...r.sqlWitness.totals,completed:2}}])assert.equal(sanitizeSqlWitness({...r.sqlWitness,...change}),null);
 const getter={};Object.defineProperty(getter,'version',{get(){throw Error('SECRET');}});assert.equal(sanitizeSqlWitness(getter),null);
 assert.equal(cleanCausalRecord({...r,sqlWitness:{version:1}},origin,START),null);
 assert.equal(cleanCausalRecord({...r,sourcePid:72},origin,START),null);
 for(let i=0;i<40;i++)cleaned['optional'+i]='x'.repeat(100);
 const fitted=fitCausalRecord(cleaned);assert.ok(fitted);assert.ok(Buffer.byteLength(JSON.stringify(fitted))<=2048);assert.equal(fitted.sqlWitness.active.sequence,1);
 assert.equal(fitCausalRecord(cleaned,80),null);
});

test('journal external latest revision, nested restore, missing settle and gap stay UNKNOWN; no cross-source/stale overwrite',()=>{
 const j=createCausalJournal({now:()=>START,artifacts:{write(){}}}),r=example();j.record(r,origin);
 let entry=j.snapshot().sqlWitnesses[0];assert.equal(entry.currentState,'UNKNOWN');assert.equal(entry.sqlWitness.active.sequence,1);assert.equal(entry.persistence,'queued-not-persisted');
 const f=fixture(p=>j.record(p,origin));f.c.sql('s','all',()=>{f.c.sql('nested','all',()=>[]);assert.equal(j.snapshot().sqlWitnesses[0].sqlWitness.active.sequence,1);return [];});
 const rev=j.snapshot().sqlWitnesses[0].sqlWitness.revision;j.record(r,origin);assert.equal(j.snapshot().sqlWitnesses[0].sqlWitness.revision,rev);
 j.record({...r,sourceBoot:'other',sourceSeq:3},origin);assert.equal(j.snapshot().sqlWitnesses.length,2);
 j.reconcile({sourceBoot:'sql-private',emittedAbs:START,active:[],recent:[]},origin);assert.equal(j.snapshot().sqlWitnesses[0].currentState,'UNKNOWN');
 j.record({...r,sourceSeq:100},origin);assert.ok(j.snapshot().counts.sequenceGaps>0);assert.equal(j.snapshot().sqlWitnesses[0].currentState,'UNKNOWN');
 const newest={...r.sqlWitness,revision:99};j.reconcile({sourceBoot:'sql-private',emittedAbs:START,sqlWitness:newest},origin);assert.equal(j.snapshot().sqlWitnesses[0].persistence,'received-only');
});

test('journal rate/queue/bytes/eviction/bucket/disk losses stay explicit, do not upgrade current certainty',()=>{
 const r=example(),r2={...r,sourceSeq:2,sqlWitness:{...r.sqlWitness,revision:2}};
 const rate=createCausalJournal({now:()=>START,maxPerMinute:1,artifacts:{write(){}}});rate.record(r,origin);assert.equal(rate.record(r2,origin),false);assert.equal(rate.snapshot().sqlWitnesses[0].persistence,'rate-drop');assert.equal(rate.snapshot().counts.losses.detail.rate,1);
 const queue=createCausalJournal({now:()=>START,maxQueued:1,artifacts:{write(){}}});queue.record(r,origin);assert.equal(queue.record(r2,origin),false);assert.equal(queue.snapshot().sqlWitnesses[0].persistence,'queue-drop');
 const evict=createCausalJournal({now:()=>START,maxQueued:1,artifacts:{write(){}}});evict.record(r,origin);evict.record({kind:'main-gap',durationMs:600,sourceBoot:'wd',emittedAbs:START},origin,{critical:true});assert.equal(evict.snapshot().sqlWitnesses[0].persistence,'queue-evicted');
 const bytes=createCausalJournal({now:()=>START,maxRecordBytes:80,artifacts:{write(){}}});assert.equal(bytes.record(r,origin),false);assert.equal(bytes.snapshot().sqlWitnesses[0].persistence,'byte-drop');
 for(const code of ['EIO','CAUSAL_NORMAL_BUCKET_FULL','CAUSAL_TOTAL_BUCKET_FULL','CAUSAL_TORN_BUCKET']){
  const j=createCausalJournal({now:()=>START,artifacts:{writeCausal(){throw Object.assign(Error('SECRET'),{code});}}});j.record(r,origin);j.flush(true);const s=j.snapshot();
  assert.equal(s.sqlWitnesses[0].currentState,'UNKNOWN');assert.equal(s.sqlWitnesses[0].persistence,code.includes('BUCKET_FULL')?'bucket-drop':'disk-unknown');assert.equal(s.counts.written,0);assert.doesNotMatch(JSON.stringify(s),/SECRET/);
 }
 const bounded=createCausalJournal({now:()=>START,artifacts:{write(){}}});for(let i=0;i<70;i++)bounded.record({...r,sourceBoot:'b'+i},origin);
 assert.equal(bounded.snapshot().sqlWitnesses.length,8);assert.equal(bounded.snapshot().sqlSourceEvictions,6);assert.equal(bounded.snapshot().sqlSourcesOmitted,56);
});

test('actual journal append fsync/read/prune survival without settle, legacy writer not promoted to append-confirmed',t=>{
 const d=dir(t),store=createArtifactStore(d),j=createCausalJournal({now:()=>START,artifacts:store}),r=example();
 j.record(r,origin);j.flush(true);assert.equal(j.snapshot().sqlWitnesses[0].persistence,'append-confirmed');assert.equal(writes(store)[0].sqlWitness.active.sequence,1);
 store.prune(START);assert.equal(writes(store)[0].sqlWitness.totals.completed,0);
 const legacy=createCausalJournal({now:()=>START,artifacts:{write(){}}});legacy.record(r,origin);legacy.flush(true);assert.equal(legacy.snapshot().sqlWitnesses[0].persistence,'legacy-write-unconfirmed');
});

test('actual watchdog ingress and cleanup extract reuse same receiver/force flush, without starting watchdog/timers/native sampler',t=>{
 const store=createArtifactStore(dir(t)),j=createCausalJournal({now:()=>START,artifacts:store});
 const source=fs.readFileSync(path.join(__dirname,'perf-watchdog.js'),'utf8');
 const a=source.indexOf("  if (m.t === 'causal') {"),b=source.indexOf("  if (m.t === 'hb'",a);
 const feed=vm.runInNewContext('(m)=>{'+source.slice(a,b)+'}',{causalJournal:j,MAIN_PID:71,Number});feed({t:'causal',record:example()});
 let stopped=0,exit;const x=source.indexOf('function cleanupAndExit(code)'),y=source.indexOf('// ── renderer heartbeat socket',x);
 const cleanup=vm.runInNewContext(source.slice(x,y)+'\ncleanupAndExit;',{causalJournal:j,stallSampler:null,flight:{stop(){stopped++;}},SOCKET_PATH:'',process:{exit(c){exit=c;}}});cleanup(0);
 assert.equal(stopped,1);assert.equal(exit,0);assert.equal(writes(store)[0].sqlWitness.active.siteId,'db.named');
});

test('existing flight incident stop snapshot retains latest receiver state and stops its own timer',t=>{
 const d=dir(t),j=createCausalJournal({now:()=>START,artifacts:{write(){}}});
 const flight=createFlightRecorder({directory:d,mainPid:71,log(){},requestCapture(){throw Error('should be startup warmup');},context:()=>({causal:j.snapshot()}),snapshot(){throw Error('no native');},pressure(){throw Error('no pressure');}});
 try{flight.incident('private-control',{durationMs:600});j.record(example(),origin);flight.stop();}finally{flight.stop();}
 const file=fs.readdirSync(d).find(n=>/^incident-.*\.json$/.test(n));const incident=JSON.parse(fs.readFileSync(path.join(d,file),'utf8'));
 assert.equal(incident.context.causal.sqlWitnesses[0].sqlWitness.active.sequence,1);assert.equal(incident.context.causal.sqlWitnesses[0].currentState,'UNKNOWN');assert.equal(incident.capture.requested,false);
});

test('SQL timing excludes pre/settle transport cost; snapshots/results never retain row objects',()=>{
 const f=fixture();let at=START;const c=createCausalContext({boot:'timing',pid:71,now:()=>at});const records=[];
 c.configure({enabled:true,sink:r=>{records.push(r);at+=100;return true;}});
 const rows=[{data:'SECRET_DATA'}];c.syncWork('work',{},()=>c.sql('db.site','all',()=>{at+=7;return rows;}));
 const summary=records.find(r=>r.kind==='work-summary').workSummary;assert.equal(summary.sqlMs[2],7);assert.doesNotMatch(JSON.stringify(c.snapshot()),/SECRET_DATA/);
});

test('actual heartbeat SQL field sanitizer and receiver restore use production function text',()=>{
 const source=fs.readFileSync(path.join(__dirname,'perf-watchdog.js'),'utf8');
 const a=source.indexOf('function onHeartbeat('),b=source.indexOf('\n\ntry {',a);const p={stalled:false};
 const journal=createCausalJournal({artifacts:{write(){}},now:()=>START});
 const heartbeat=vm.runInNewContext(source.slice(a,b)+'\nonHeartbeat;',{ensureProc:()=>p,performance:{now:()=>10},causalJournal:journal,sanitizeSqlWitness});
 const sql={...example().sqlWitness,path:'/SECRET/PATH',sql:'SECRET_SQL'};
 heartbeat('main',71,'main',{causal:{sourceBoot:'sql-private',emittedAbs:START,sqlWitness:sql}});
 assert.doesNotMatch(JSON.stringify(p.causal.sqlWitness),/SECRET/);assert.equal(journal.snapshot().sqlWitnesses[0].sqlWitness.active.sequence,1);assert.equal(journal.snapshot().sqlWitnesses[0].currentState,'UNKNOWN');
});

test('actual hourly cap comparison refuses full normal/total buckets using only tiny inode + synthetic stat-size control',t=>{
 const store=createArtifactStore(dir(t)),name='causal-2026102106.ndjson';store.writeCausal(name,'{}\n');
 const before=fs.readFileSync(store.file(name));const fstat=fs.fstatSync;
 for(const essential of [false,true]){
  fs.fstatSync=(...args)=>{const stat=fstat(...args);return new Proxy(stat,{get(target,k){return k==='size'?(essential?4:2)*1024*1024:Reflect.get(target,k);}});};
  try{assert.throws(()=>store.writeCausal(name,'{}\n',{essential}),e=>e.code===(essential?'CAUSAL_TOTAL_BUCKET_FULL':'CAUSAL_NORMAL_BUCKET_FULL'));}finally{fs.fstatSync=fstat;}
  assert.deepEqual(fs.readFileSync(store.file(name)),before);
 }
});

test('transport cleans SQL envelope BEFORE IPC: no top-level or nested secret reaches child.send; malformed is counted',()=>{
 const packets=[],tx=createCausalTransport({target:()=>({connected:true,send:(m,cb)=>{packets.push(m);cb();return true;}})});
 const r=example();r.sql='SECRET_SQL';r.path='/SECRET/path';r.bindings=['SECRET_BIND'];r.sqlWitness.stack='SECRET_STACK';
 assert.equal(tx.sendRecord(r),true);assert.doesNotMatch(JSON.stringify(packets),/SECRET/);
 assert.equal(tx.sendRecord({...r,sqlWitness:{version:1}}),false);assert.equal(tx.snapshot().malformedWitness,1);assert.equal(packets.length,1);
 const disconnected=createCausalTransport({target:()=>null});assert.equal(disconnected.sendRecord(example()),false);assert.equal(disconnected.snapshot().disconnected,1);
 const badTarget=createCausalTransport({target:()=>{throw Error('secret');}});assert.equal(badTarget.sendRecord(example()),false);assert.equal(badTarget.snapshot().targetErrors,1);
});

test('bounded long-token/numeric SQL envelopes fit existing 2KiB wire/journal cap',()=>{
 const packets=[],c=createCausalContext({boot:'b'.repeat(100),pid:999999,now:()=>Number.MAX_SAFE_INTEGER});
 const tx=createCausalTransport({target:()=>({connected:true,send:(m,cb)=>{packets.push(m.record);cb();return true;}})});
 c.configure({enabled:true,sink:r=>tx.sendRecord(r)});
 c.run('r'.repeat(64),{},()=>c.syncWork('w'.repeat(64),{},()=>{c.sql('s'.repeat(64),'all',()=>[]);c.sql('x'.repeat(64),'all',()=>[]);}));
 const witness=packets.filter(r=>r.kind==='sql-witness');assert.equal(witness.length,4);
 for(const record of witness){const clean=cleanCausalRecord(record,{pid:999999,kind:'main'},Number.MAX_SAFE_INTEGER);const fitted=fitCausalRecord(clean);assert.ok(fitted);assert.ok(Buffer.byteLength(JSON.stringify(fitted))<=2048);}
});

test('late nested settlements cannot flood a new source minute window',()=>{
 const f=fixture();function nested(depth){return f.c.sql('db.nested','all',()=>{if(depth>1){f.tick(60000);nested(depth-1);}return [];});}nested(20);
 const buckets=new Map();for(const record of f.records){const minute=Math.floor((record.emittedAbs-START)/60000);buckets.set(minute,(buckets.get(minute)||0)+1);}
 assert.ok([...buckets.values()].every(n=>n<=8));assert.equal(f.sql().health.preCallAttempts,20);assert.equal(f.sql().health.settleSuppressed,13);assert.equal(f.sql().totals.completed,20);
});

test('PRE-native: active identity and attempted=1/completed=0 exist INSIDE callback before any finally',()=>{
 const packets=[],c=createCausalContext({boot:'redgreen',pid:71,now:()=>100});
 c.configure({enabled:true,sink:r=>{packets.push(r);return true;}});
 const result=[];
 assert.equal(c.sql('db.fixed.all','all',()=>{
  const witness=c.snapshot().sqlWitness;
  assert.ok(witness,'active capsule missing');
  assert.equal(witness.active.siteId,'db.fixed.all');assert.equal(witness.active.operation,'all');
  assert.equal(witness.active.sequence,1);assert.equal(witness.totals.attempted,1);assert.equal(witness.totals.completed,0);
  const pre=packets.find(r=>r.kind==='sql-witness');assert.ok(pre,'no external BEFORE observation');
  assert.equal(pre.sqlWitness.active.sequence,1);assert.equal(pre.sqlWitness.lastCompleted,null);
  return result;
 }),result);
 assert.equal(c.snapshot().sqlWitness.active,null);assert.equal(c.snapshot().sqlWitness.totals.completed,1);
});
test('PRE-native inside synchronous work distinguishes current all from earlier completed prepare',()=>{
 const c=createCausalContext({boot:'work-redgreen',pid:71,now:()=>100}),packets=[];
 c.configure({enabled:true,sink:r=>{packets.push(r);return true;}});
 c.syncWork('db.outer-work',{},()=>{
  c.sql('db.prepare','prepare',()=>({}));
  c.sql('db.materialize','all',()=>{
   const s=c.snapshot(),w=s.sqlWitness;assert.ok(w,'missing active SQL capsule');
   assert.equal(w.active.sequence,2);assert.equal(w.active.operation,'all');assert.equal(w.lastCompleted.sequence,1);
   assert.equal(w.totals.attempted,2);assert.equal(w.totals.completed,1);assert.equal(w.active.workId,s.active[0].spanId);
   assert.ok(packets.some(r=>r.kind==='sql-witness'&&r.sqlWitness.active.sequence===2));
   return [];
  });
 });
});

test('disabled collection is explicit, so observed zero counters are never presented as measured no-SQL',()=>{
  let calls=0;
  const c=createCausalContext({boot:'parent-mode',pid:71,now:()=>1000});
  c.sql('db.parent','all',()=>{calls++;return [];});
  const off=c.snapshot().sqlWitness;
  assert.equal(off.collectionState,'disabled');
  assert.equal(off.counterScope,'named-wrappers-while-enabled');
  assert.equal(off.totals.attempted,0);
  c.configure({enabled:true,sink:()=>true});
  c.sql('db.parent','all',()=>{
    calls++;
    assert.equal(c.snapshot().sqlWitness.collectionState,'enabled');
    return [];
  });
  c.configure({enabled:false});
  c.sql('db.parent','all',()=>{calls++;return [];});
  const stopped=c.snapshot().sqlWitness;
  assert.equal(stopped.collectionState,'disabled');
  assert.equal(stopped.totals.attempted,1,'prior observed counter stays historical');
  assert.equal(calls,3);
  const legacy={...stopped};delete legacy.collectionState;
  assert.equal(sanitizeSqlWitness(legacy).collectionState,'unknown');
  assert.equal(sanitizeSqlWitness({...stopped,collectionState:'invented'}).collectionState,'unknown');
});
