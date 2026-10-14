'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCausalContext}=require('./perf-causal-context');
const {createCausalTransport}=require('./perf-causal-transport');
const {sanitizeWorkSummary,fitCausalRecord}=require('../shared/perf-causal-schema.cjs');
function fixture(enabled=true) {
  let at=100,cpu=0,clocks=0,metricReads=0;
  const records=[];
  const c=createCausalContext({pid:123,boot:'private-test',now:()=>{clocks++;return at;}});
  c.configure({enabled,sink:r=>{records.push(r);return true;},metrics:{read:()=>{metricReads++;return cpu;},
    between:before=>({threadCpuMs:cpu-before})}});
  return {c,records,advance:(wall,used=wall)=>{at+=wall;cpu+=used;},
    clocks:()=>clocks,metricReads:()=>metricReads,works:()=>records.filter(r=>r.kind==='work-summary').map(r=>r.workSummary)};
}
test('OFF performs callback once and returns exact objects, promises and errors without diagnostic reads',()=>{
  const f=fixture(false),p=Promise.resolve(7),value={},error={},before=f.clocks();let calls=0;
  assert.equal(f.c.syncWork('site',{},()=>{calls++;return value;}),value);
  assert.equal(f.c.sql('site','get',()=>{calls++;return p;}),p);
  assert.throws(()=>f.c.syncWork('site',{},()=>{calls++;throw error;}),e=>e===error);
  assert.equal(calls,3);assert.equal(f.clocks(),before);assert.equal(f.records.length,0);assert.equal(f.metricReads(),0);
});
test('real ALS keeps two post-await owners separate from await wall time',async()=>{
  const f=fixture();let releaseA,releaseB;
  const aGate=new Promise(r=>releaseA=r),bGate=new Promise(r=>releaseB=r);
  const run=(label,gate)=>f.c.run('ipc:'+label,{tabId:label},async()=>{
    await gate;
    return f.c.syncWork('availability.manifests',{},()=>f.c.sql('database.session-history-events','all',()=>{
      f.advance(3000);return label;
    }));
  },{explicit:false});
  const a=run('ownerA',aGate),b=run('ownerB',bGate);
  f.advance(10000,0);releaseB();assert.equal(await b,'ownerB');releaseA();assert.equal(await a,'ownerA');
  assert.deepEqual(f.works().map(w=>[w.context.tabId,w.wallMs,w.sqlMs[2],w.threadCpuMs]),
    [['ownerB',3000,3000,3000],['ownerA',3000,3000,3000]]);
  const roots=f.records.filter(r=>r.kind==='span'&&r.phase==='settle'&&r.name.startsWith('ipc:'));
  assert.equal(roots[0].syncMs,0);assert.equal(roots[0].lifetimeMs,13000);
});
test('4096 short SQL calls aggregate without packets or thread FFI per query',()=>{
  const f=fixture();let calls=0;
  f.c.syncWork('catalog.pass',{},()=>{for(let i=0;i<4096;i++)f.c.sql('roots.scope','get',()=>{calls++;f.advance(.01);});});
  assert.equal(calls,4096);const w=f.works()[0];assert.equal(w.counts[1],4096);
  assert.ok(Math.abs(w.sqlMs[1]-40.96)<.0001);assert.equal(f.metricReads(),1);
  assert.equal(f.records.length,2,'one prelude plus one work summary');
});
test('cached statement executes under current caller and values/errors are untouched',()=>{
  const f=fixture(),rows=[{secret:'not-in-packet'}],statement={all(){return rows;}};
  let created;
  f.c.syncWork('caller.A',{},()=>{created=f.c.sql('roots.bindings','prepare',()=>{f.advance(60);return statement;});});
  const value=f.c.syncWork('caller.B',{},()=>f.c.sql('roots.bindings','all',()=>{f.advance(60);return created.all();}));
  assert.equal(created,statement);assert.equal(value,rows);
  const error=Object.assign(new Error('SECRET_ERROR_BODY'),{secret:'SECRET_BINDING'});
  assert.throws(()=>f.c.syncWork('caller.C',{documentText:'SECRET_DOCUMENT'},()=>
    f.c.sql('roots.bindings','get',()=>{f.advance(60);throw error;})),e=>e===error);
  assert.deepEqual(f.works().map(w=>w.counts),[[1,0,0,0],[0,0,1,0],[0,1,0,0]]);
  assert.equal(f.works()[2].outcome,'error');assert.equal(f.works()[2].sqlErrors,1);
  assert.doesNotMatch(JSON.stringify(f.records),/SECRET_|not-in-packet/);
});
test('syncWork returns a Promise unchanged; later SQL without a fresh synchronous site is explicitly uncovered',async()=>{
  const f=fixture();let release;
  const p=new Promise(r=>release=r).then(()=>f.c.sql('later','get',()=>1));
  assert.equal(f.c.syncWork('prefix',{},()=>p),p);release();await p;
  assert.equal(f.c.snapshot().workHealth.sqlOutsideWork,1);assert.equal(f.works().length,0);
});
test('root callback is not attributed to the request that registered it; gap keeps whole overlapping work',()=>{
  const f=fixture();
  f.c.run('old.request',{tabId:'old'},()=>f.c.syncWork('watch.fire',{fileIdentity:'/private/secret/path'},()=>
    f.c.sql('roots.bindings','all',()=>f.advance(200)),{root:true}));
  const w=f.works()[0];assert.equal(w.parentSpanId,null);assert.equal(w.context.tabId,undefined);
  assert.match(w.context.fileIdentity,/^sha256:/);
  const cap=f.c.gapCapsule(150,220);assert.equal(cap.items[0].wallMs,200);
  assert.equal(cap.items[0].sqlMs[2],200,'partial overlap does not prorate SQL');
});
test('bounded sites/retention expose overflow and ACK requires exact identity',()=>{
  const f=fixture();
  f.c.syncWork('overflow',{},()=>{for(let i=0;i<20;i++)f.c.sql('site.'+i,'get',()=>f.advance(4));});
  const w=f.works()[0];assert.equal(w.sites.length,16);assert.equal(w.overflow.operations,4);
  assert.equal(w.counts[1],20);
  assert.equal(f.c.acknowledge({sourceBoot:'foreign',summaryId:w.summaryId,revision:1}),false);
  assert.equal(f.c.acknowledge({sourceBoot:'private-test',summaryId:w.summaryId,revision:2}),false);
  assert.equal(f.c.acknowledge({sourceBoot:'private-test',summaryId:w.summaryId,revision:1}),true);
  for(let i=0;i<9;i++)f.c.syncWork('next',{},()=>f.advance(60));
  assert.equal(f.c.snapshot().workHealth.retained,8);assert.equal(f.c.snapshot().workHealth.retainedEvictions,2);
});
test('GC is aggregated and source retries are finite metadata attempts, never callback repeats',()=>{
  const f=fixture();let callbacks=0;
  f.c.configure({sink:()=>false});
  f.c.syncWork('lost',{},()=>{callbacks++;f.advance(60);});
  for(let i=0;i<1000;i++)f.c.event('gc',{startAbs:100+i,durationMs:1});
  assert.equal(f.c.snapshot().sourceSeq,2,'GC did not create1000 transport packets');
  f.advance(1000);assert.equal(f.c.snapshot({delivery:true}).completedWork.length,1);
  f.advance(5000);assert.equal(f.c.snapshot({delivery:true}).completedWork.length,1);
  f.advance(5000);assert.equal(f.c.snapshot({delivery:true}).completedWork.length,0);
  assert.equal(callbacks,1);assert.equal(f.c.snapshot().workHealth.attempts,3);
  f.advance(300001);assert.equal(f.c.snapshot().workHealth.retained,0);
  assert.equal(f.c.snapshot().workHealth.unacknowledgedEvictions,1);
});
test('transport reserves eight essential slots and send(false) is accepted without replay',()=>{
  const writes=[],callbacks=[];const child={connected:true,send:(m,cb)=>{writes.push(m);callbacks.push(cb);return false;}};
  const tx=createCausalTransport({target:()=>child});
  for(let i=0;i<24;i++)assert.equal(tx.sendRecord({kind:'gc-summary'}),true);
  assert.equal(tx.sendRecord({kind:'span'}),false);
  for(let i=0;i<8;i++)assert.equal(tx.sendRecord({kind:'work-summary'}),true);
  assert.equal(tx.sendRecord({kind:'work-summary'}),false);assert.equal(writes.length,32);
  callbacks.forEach(cb=>{cb();cb();});assert.equal(tx.snapshot().pending,0);
  assert.equal(tx.snapshot().backpressure,32);
});
test('heartbeat builds metadata only after admission and callback failure releases its exact slot',()=>{
  let cb,built=0,failures=0;const child={connected:false,send:(_m,c)=>{cb=c;return true;}};
  const tx=createCausalTransport({target:()=>child,onFailure:()=>failures++});
  assert.equal(tx.sendHeartbeat(()=>{built++;return {};},()=>{}),false);assert.equal(built,0);
  child.connected=true;assert.equal(tx.sendHeartbeat(()=>{built++;return {};},()=>{}),true);
  cb(new Error('secret'));assert.equal(tx.snapshot().pending,0);assert.equal(failures,1);
});
test('2KiB fitting preserves the causal core and reports omitted optional detail',()=>{
  const f=fixture();f.c.syncWork('sql.loop',{},()=>{
    for(let i=0;i<16;i++){f.c.count('counter.'+i,4);f.c.sql('site.'+i,'get',()=>f.advance(6));}
  });
  const work=f.works()[0];const r={schema:3,kind:'main-gap',sourcePid:123,sourceKind:'main',
    sourceBoot:'private-test',sourceSeq:8,emittedAbs:300,startAbs:90,durationMs:300,
    workCapsule:{version:1,fromAbs:90,toAbs:400,items:[work],omitted:0,retainedEvictions:0}};
  for(let i=0;i<20;i++)r['optional'+i]='x'.repeat(100);
  const fitted=fitCausalRecord(r);assert.ok(fitted);assert.ok(Buffer.byteLength(JSON.stringify(fitted))<=2048);
  assert.equal(fitted.workCapsule.items[0].siteId,'sql.loop');
  assert.equal(fitted.workCapsule.items[0].counts[1],16);assert.ok(fitted.omittedFields>0);
  assert.equal(work.sites.length,16,'fitting does not mutate retained evidence');
  assert.equal(sanitizeWorkSummary({summaryId:'bad',siteId:'/secret/path',revision:1,startAbs:1,endAbs:2}),null);
});
