'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {DatabaseSync}=require('node:sqlite');
const {createCausalContext}=require('./perf-causal-context');
const {createCausalTransport}=require('./perf-causal-transport');
const {createCausalJournal}=require('./perf-causal-journal');
const {createArtifactStore}=require('./perf-flight-recorder');

test('actual chain persists late post-await SQL with lost enter/ACK and exhausted heavy quota',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noted-causal-chain25-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const artifacts=createArtifactStore(dir),base=Date.now();let at=base,cpu=0,allowAck=false;
  for(let i=0;i<4;i++)artifacts.write(`incident-${base-i}-77.capture.json`,{requestedAt:base-i,group:'responsiveness'});
  const quotaBefore=fs.readdirSync(dir).filter(n=>n.endsWith('.capture.json')).map(n=>[n,fs.readFileSync(path.join(dir,n),'utf8')]);
  assert.equal(artifacts.reserveCaptureDetails(`incident-${base+1}-77`,base+1,'heartbeat-silence').reason,'rolling-quota-exhausted');
  const ctx=createCausalContext({now:()=>at,pid:123,boot:'integration-main'});
  const main=fs.readFileSync(path.join(__dirname,'main.js'),'utf8');
  const ackStart=main.indexOf("      if (request?.t === 'causal-ack') {");
  const ackEnd=main.indexOf("      if (request?.t !== 'capture'",ackStart);
  assert.ok(ackStart>0&&ackEnd>ackStart);
  const ackIngress=vm.runInNewContext('(request)=>{'+main.slice(ackStart,ackEnd)+'}',
    {process:{pid:123},perfCausal:ctx});
  const journal=createCausalJournal({artifacts,now:()=>at,onPersisted:ack=>{
    if(!allowAck)return false;ackIngress({t:'causal-ack',...ack});return true;
  }});
  const watchdog=fs.readFileSync(path.join(__dirname,'perf-watchdog.js'),'utf8');
  const start=watchdog.indexOf("  if (m.t === 'causal') {");
  const end=watchdog.indexOf("  if (m.t === 'bye')",start);
  assert.ok(start>0&&end>start);
  const ingress=vm.runInNewContext('(m)=>{'+watchdog.slice(start,end)+'}',{causalJournal:journal,MAIN_PID:123,Number});
  const callbacks=[];
  const child={connected:true,send(packet,callback){callbacks.push(callback);
    if(packet.t==='causal')ingress(packet);
    else if(packet.t==='hb')journal.reconcile(packet.causal,{pid:123,kind:'main'});
    return false;
  }};
  const transport=createCausalTransport({target:()=>child,onFailure:()=>ctx.transportFailed()});
  ctx.configure({enabled:true,sink:r=>transport.sendRecord(r),metrics:{read:()=>cpu,between:before=>({threadCpuMs:cpu-before})}});
  // Hold24 ordinary callbacks. Source prelude cannot use the eight reserved slots.
  for(let i=0;i<24;i++)assert.equal(transport.sendRecord({kind:'gc',sourceBoot:'ambient',sourceSeq:i+1,
    emittedAbs:at,durationMs:1}),true);
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());let release,executions=0;
  const gate=new Promise(r=>release=r);
  const pending=ctx.run('ipc:test-read',{tabId:'fixture-owner'},async()=>{
    await gate;
    const begin=at;
    artifacts.write(`incident-${base}-123.json`,{startedWallMs:begin,completedWallMs:begin+20000,complete:true});
    const result=ctx.syncWork('database.test-loop',{},()=>{
      const statement=ctx.sql('database.test-select','prepare',()=>db.prepare('SELECT ? AS value'));
      let sum=0;
      for(let i=0;i<128;i++)sum+=ctx.sql('database.test-select','get',()=>{
        executions++;at+=250;cpu+=250;return statement.get(i).value;
      });
      return sum;
    });
    ctx.event('main-gap',{startAbs:begin,durationMs:at-begin,threadCpuMs:cpu,workCapsule:ctx.gapCapsule(begin,at)});
    return result;
  },{explicit:false});
  at+=10000;release();assert.equal(await pending,127*128/2);
  assert.equal(ctx.snapshot().workHealth.acknowledged,0,'enqueue has not acknowledged persistence');
  journal.flush(true);
  assert.equal(ctx.snapshot().workHealth.acknowledged,0,'failed ACK is separate from successful append');
  assert.ok(journal.snapshot().counts.ackErrors>0);
  const read=()=>fs.readdirSync(dir).filter(n=>/^causal-.*\.ndjson$/.test(n))
    .flatMap(n=>fs.readFileSync(path.join(dir,n),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  let rows=read(),works=rows.filter(r=>r.kind==='work-summary');
  assert.equal(works.length,1);assert.equal(works[0].enteredRecordMissing,true);
  assert.deepEqual(works[0].workSummary.counts,[1,128,0,0]);
  assert.equal(works[0].workSummary.wallMs,32000);assert.equal(works[0].workSummary.context.tabId,'fixture-owner');
  const gap=rows.find(r=>r.kind==='main-gap');assert.equal(gap.workCapsule.items[0].summaryId,works[0].summaryId);
  assert.equal(gap.workCapsule.items[0].sqlMs[1],32000);
  callbacks.splice(0).forEach(cb=>cb());allowAck=true;at+=5000;
  assert.equal(transport.sendHeartbeat(()=>({t:'hb',causal:ctx.snapshot({delivery:true})})),true);
  journal.flush(true);rows=read();
  assert.equal(rows.filter(r=>r.kind==='work-summary').length,1,'same metadata retry never double-counts a work');
  assert.equal(ctx.snapshot().workHealth.acknowledged,1);assert.equal(executions,128,'product SQL never replays');
  assert.deepEqual(quotaBefore,fs.readdirSync(dir).filter(n=>n.endsWith('.capture.json')).map(n=>[n,fs.readFileSync(path.join(dir,n),'utf8')]));
  assert.equal(artifacts.reserveCaptureDetails(`incident-${base+2}-77`,base+2,'heartbeat-silence').allowed,false);
});
