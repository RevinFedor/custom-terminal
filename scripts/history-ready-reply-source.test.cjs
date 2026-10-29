'use strict';
// Actual worker reply-fence statements and real read control. A scheduler
// gate substitutes an unrelated heavy event-loop slice; no app or source IO.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {createReadControl}=require('../src/main/history-root-engine/main/history-read-control');
const source=fs.readFileSync(require('node:path').resolve(__dirname,'../src/main/history-root-engine/main/history-read-worker.js'),'utf8');
const a=source.indexOf('    if ((readOnlyRootReply || completedBodyPinReply) && !message.binary && !message.stream) {');
const b=source.indexOf('    if (message.stream) {',a);assert(a>0&&b>a);
const branch=new Function('control','readOnlyRootReply','message','completedBodyPinReply=false','return(async()=>{let replyFenceMode;'+source.slice(a,b)+'return replyFenceMode;})();');
const declaration=name=>{const a=source.indexOf('const '+name+' = '),b=source.indexOf(';',a);assert(a>=0&&b>a);return source.slice(a,b+1);};
const classify=new Function('method','leaseKey','rootController','result','message','context',
 'const payload={};'+declaration('installedReadPacket')+'\n'+declaration('readOnlyRootReply')+'\nreturn readOnlyRootReply;');
const turn=()=>new Promise(r=>setImmediate(r));
function gated(){let release;const promise=new Promise(r=>release=r);return{promise,release};}
test('ready installed read returns before an unrelated scheduler gate with every source fence retained',async()=>{
 const gate=gated(),seen=[];
 const control=createReadControl({assertSourceCurrent(){seen.push('assert');},refreshSourceCurrent(){seen.push('refresh');},
  schedule(){seen.push('schedule');return gate.promise;}});
 assert.equal(await branch(control,true,{}),'sync-installed-read');
 assert.deepEqual(seen,['assert','refresh','assert']);
 let done=false;const pending=branch(control,false,{}).then(x=>{done=true;return x;});
 await turn();assert.equal(done,false);assert.equal(seen.at(-1),'schedule');
 gate.release();assert.equal(await pending,'yield-checkpoint');assert.equal(done,true);control.finish();
});
test('allocating/binary/stream replies keep their existing scheduler admission',async()=>{
 for(const message of [{binary:true},{stream:{format:'json'}}]){
  const gate=gated();let scheduled=0,done=false;
  const c=createReadControl({schedule(){scheduled++;return gate.promise;}});
  const p=branch(c,true,message).then(x=>{done=true;return x;});await turn();assert.equal(done,false);assert.equal(scheduled,1);
  gate.release();assert.equal(await p,'yield-checkpoint');c.finish();
 }
});
test('already cancelled, changed source and settled controls refuse the synchronous read fence',async()=>{
 const abort=new AbortController();abort.abort();let refreshed=0;
 const cancelled=createReadControl({signal:abort.signal,refreshSourceCurrent(){refreshed++;}});
 await assert.rejects(branch(cancelled,true,{}),{code:'HISTORY_READ_CONSUMER_REVOKED'});assert.equal(refreshed,0);
 const original=Object.assign(Error('owned epoch moved'),{code:'OWN_SOURCE_MOVED'});let changed=false;
 const c=createReadControl({refreshSourceCurrent(){changed=true;},assertSourceCurrent(){if(changed)throw original;}});
 await assert.rejects(branch(c,true,{}),e=>e===original);
 const settled=createReadControl();settled.finish();
 await assert.rejects(branch(settled,true,{}),{code:'HISTORY_READ_CONSUMER_REVOKED'});
});
test('actual worker classification excludes missing capability, writes, new resources, codecs and errors',()=>{
 const pure={allocates(){return false;}},empty={payloads:{size:0},capabilityReleases:[]};
 assert.equal(classify('readHistoryRootPage','lease',pure,{success:true},{},empty),true);
 for(const x of [
  ['readHistoryRootPage',null,pure,{success:true},{},empty],
  ['forkHistoryRootLeaf','lease',pure,{success:true},{},empty],
  ['readHistoryRootPage','lease',{allocates(){return true;}},{success:true},{},empty],
  ['readHistoryRootPage','lease',pure,{success:false},{},empty],
  ['readHistoryRootPage','lease',pure,{success:true},{binary:true},empty],
  ['readHistoryRootPage','lease',pure,{success:true},{stream:{}},empty],
  ['readHistoryRootPage','lease',pure,{success:true},{},{payloads:{size:1}}],
  ['readHistoryRootPage','lease',pure,{success:true},{},{payloads:{size:0},capabilityReleases:[()=>{}]}],
 ])assert.equal(!!classify(...x),false);
});

test('completed installed body pin bypasses only ready fences, preserving exact child classification',async()=>{
 const classifyPin=new Function('bodyPin','method','payload','result','message','context',
  declaration('completedBodyPinReply')+'return completedBodyPinReply;');
 const payload={leaseId:'parent',bodyRequestId:'owned-request'};
 const result={success:true,kind:'entry-body',encoding:'history-entry-body-borrow-v1',
  leaseId:'child',bodyRequestId:'owned-request'};
 const context={payloads:{size:0},capabilityReleases:[()=>{}]};
 assert.equal(classifyPin(true,'forkHistoryRootLeaf',payload,result,{},context),true);
 for(const changed of [{kind:'unsupported'},{leaseId:'parent'},{leaseId:''},
  {bodyRequestId:'sibling'},{encoding:'history-display-unit-v8-v1'},{success:false}])
  assert.equal(classifyPin(true,'forkHistoryRootLeaf',payload,{...result,...changed},{},context),false);
 for(const [pin,method,message,ctx] of [[false,'forkHistoryRootLeaf',{},context],
  [true,'openHistoryRoot',{},context],[true,'forkHistoryRootLeaf',{binary:true},context],
  [true,'forkHistoryRootLeaf',{stream:{}},context],
  [true,'forkHistoryRootLeaf',{}, {...context,payloads:{size:1}}],
  [true,'forkHistoryRootLeaf',{}, {...context,capabilityReleases:[]}],
  [true,'forkHistoryRootLeaf',{}, {...context,capabilityReleases:[()=>{},()=>{}]}]])
  assert.equal(classifyPin(pin,method,payload,result,message,ctx),false);
 let refreshes=0,schedules=0;
 const control=createReadControl({refreshSourceCurrent(){refreshes++;},schedule(){schedules++;return new Promise(()=>{});}});
 const initialStart=source.indexOf('    if (bodyPin || installedReadPacket) control.recheck();');
 const initialEnd=source.indexOf('    requestPhase(',initialStart);assert(initialStart>0&&initialEnd>initialStart);
 const initial=new Function('bodyPin','installedReadPacket','control','return(async()=>{'+source.slice(initialStart,initialEnd)+'})();');
 await initial(true,false,control);await initial(false,true,control);
 assert.equal(await branch(control,false,{},true),'sync-installed-body-pin');
 assert.equal(refreshes,3);assert.equal(schedules,0);
 control.finish();await assert.rejects(branch(control,false,{},true),{code:'HISTORY_READ_CONSUMER_REVOKED'});
});

test('actual terminal acknowledgement keeps or releases only the captured new child after pin fast reply',async()=>{
 const a=source.indexOf('  produced.finally(async () => {'),b=source.indexOf('    }).catch(() => {});',a);
 assert(a>0&&b>a);
 const finalize=new Function('terminalPosted','acknowledgedReply','context','replyAcknowledgements','id','control','requests','emitDiagnostic',
  'return(async()=>{'+source.slice(a+'  produced.finally(async () => {'.length,b)+'})();');
 for(const [posted,ack,releases] of [[true,true,0],[true,false,1],[false,false,1]]){
  let childRelease=0,finish=0;const requests=new Map([['owned',{}],['sibling',{}]]),acks=new Map(requests);
  const context={capabilityReleases:[()=>{childRelease++;}]};
  await finalize(posted,Promise.resolve(ack),context,acks,'owned',{finish(){finish++;}},requests,()=>{});
  assert.equal(childRelease,releases);assert.equal(finish,1);assert.equal(context.capabilityReleases.length,0);
  assert.deepEqual([...requests.keys()],['sibling']);assert.deepEqual([...acks.keys()],['sibling']);
 }
});

