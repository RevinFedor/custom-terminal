// SOURCE-only: actual paged producer/read-plane/shared client/model/prepared
// owner and native continuation. Synthetic canonical input, in-process IPC;
// no provider, Electron paint, native latency or user database acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import { HistoryPrimaryRootReadModel } from '../src/renderer/utils/historyPrimaryRootReadModel.mjs';
import { createHistoryAgentCatalogCurrent } from '../src/renderer/utils/historyAgentCatalogCurrent.mjs';
import { agentRow, taskAction, catalogScope } from './test-support/history-agent-catalog-fixtures.mjs';
const require=createRequire(import.meta.url);
const { createPrimaryAddressFixture }=require('./test-support/history-primary-address-fixture.cjs');
const { preparedPresentationBinding }=require('../src/main/history-root-engine/main/history-primary-prepared-presentation.js');
globalThis.window={require};
globalThis.localStorage={getItem(){return null;},setItem(){},removeItem(){}};
assert(getHeapStatistics().heap_size_limit<=80*1024**2,'runtime old64/semi2 cap');
for(const path of ['src/main/history-root-engine/main/history-primary-agent-catalog.js','src/main/history-root-engine/main/history-root-read-plane.js',
  'src/shared/history-agent-catalog-client.mjs','src/renderer/utils/historyAgentCatalogCurrent.mjs']){
  const bytes=readFileSync(new URL('../'+path,import.meta.url));
  console.log('[V53_PROTOCOL_SOURCE_PIN] '+JSON.stringify({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));
}
const identity=h=>Object.fromEntries(['leaseId','ownerKey','revision','generation'].map(k=>[k,h[k]]));
const noControl={assertCurrent(){},async checkpoint(){await new Promise(resolve=>setImmediate(resolve));}};
async function setup(t,entries=[]){
 const f=await createPrimaryAddressFixture(null,{entries,sessionId:'session'}),held=[],calls=[];
 const invoke=async(channel,payload)=>{
  calls.push({channel,kind:payload.kind,encoding:payload.encoding,operation:payload.operation,sequence:payload.sequence,
   textChars:payload.data?.text?.length||0,requestId:payload.catalogRequestId});
  if(channel==='agent-transcript:fork-read-leaf'&&payload.encoding==='history-primary-agent-catalog-v1')
   return f.plane.forkAgentCatalog(payload,{consumerKey:f.consumerKey,control:noControl});
  return f.invoke(channel,payload);
 };
 const model=new HistoryPrimaryRootReadModel(invoke,f.transport);model.windowDiagnostic=()=>{};
 await model.open({...f.payload,primaryPresentation:{localEntries:[],liveEntries:[],liveToolResults:[],
  grouping:{enabled:false,threshold:2,responseWork:true,expandedKeys:[]},captionSelections:[],settingsPresentationKeys:[]}});
 const prepared=model.retainPreparedPresentation();held.push(prepared);
 t.after(async()=>{for(const value of held.reverse())await value.close();await model.close();f.close();});
 const native=(recipe={},context=catalogScope())=>createHistoryAgentCatalogCurrent({recipe:{replacements:[],exclusions:[],insertions:[],live:[],...recipe},
  context,isLocalPromptEntry:e=>e.role==='queued'&&e.uuid.startsWith('local-prompt-'),
  isTaskAction:a=>typeof a==='object'&&a!==null&&'tool'in a&&a.tool==='Task',
  historyAgentKey:(a,u)=>'task:'+(a.toolUseId||a.agentSessionId||a.agentId||u),owns:()=>true,fingerprint:()=>''});
 const open=async(recipe,context)=>{const current=native(recipe,context);const reader=await prepared.openAgentCatalog(current);held.push(reader);return{reader,current};};
 // The public owner intentionally does not expose its read-plane header.
 // The actual checked prepared child installed by model registration is
 // selected from the plane here solely to exercise producer negatives.
 const parent=()=>[...f.plane.roots.values()].find(s=>s.preparedPresentationRequestId);
 const request=current=>({...preparedPresentationBinding(f.plane,parent()),encoding:'history-primary-agent-catalog-v1',
  catalogRequestId:randomUUID(),current:current||native().wire});
 const options={consumerKey:f.consumerKey,control:noControl};
 return{f,model,prepared,held,calls,native,open,parent,request,options};
}

test('catalog-owned giant scalar chunks preserve UTF16, selected key/detail and borrowed leaf lifetime',async t=>{
 const c=await setup(t),key=('\u0000\ud800\ud83d\ude42\uffff文').repeat(1200)+'EXACT-END';
 const nativeHistory=new Uint16Array([0,0xd800,0xffff]),launch={model:key};
 const row=agentRow('uuid-'+key,[taskAction(key,{description:key,result:key,history:nativeHistory,launchSettings:launch,subagentStatus:'completed'})]);
 const{reader}=await c.open({live:[row]});
 assert(c.calls.some(x=>x.operation==='append-value'));assert(c.calls.some(x=>x.operation==='advance-value'));
 assert(c.calls.filter(x=>x.operation==='append-value').every(x=>x.textChars<=4096));
 const before=c.f.store.stats(),pages=await reader.readPage({limit:1}),selected=await reader.lookup('task:'+key);
 assert.equal(pages.rows.length,1);assert.equal(pages.rows[0].key,'task:'+key);
 assert.equal(selected.kind,'found');assert.equal(selected.record.taskResult,key);
 assert.equal(selected.record.taskHistory,nativeHistory);assert.equal(selected.record.launchSettings,launch);
 assert.equal(c.f.store.stats().pagesWritten,before.pagesWritten,'ready pages/detail/text are authenticated no-write reads');
 assert.equal(c.calls.filter(x=>x.channel==='agent-transcript:fork-read-leaf'&&x.encoding!=='history-primary-agent-catalog-v1'
  &&x.encoding!=='history-primary-prepared-presentation-v1').length,0,'selected text borrows catalog and never forks a leaf');
 await c.model.close();await c.prepared.close();
 assert.equal((await reader.lookup('task:'+key)).record.taskResult,key,'original Root/model and prepared closes do not revoke catalog');
 const beforeClose=c.f.plane.roots.size;await reader.close();assert.equal(c.f.plane.roots.size,beforeClose-1);
 assert.equal(reader.releaseState,'released');
});

test('ready membership uses exact backing index and rejects forged sequence/parent capability without writes',async t=>{
 const c=await setup(t),context=catalogScope({isTurnBusy:true,agentProcessAlive:true});
 const{reader}=await c.open({live:[agentRow('native-row',[taskAction('live:canonical:12')])]},context);
 assert.deepEqual(await reader.membership('entry',['native-row','missing']),[{value:'native-row',found:true},{value:'missing',found:false}]);
 assert.deepEqual(await reader.membership('call',['live','live:canonical:12']),[{value:'live',found:true},{value:'live:canonical:12',found:false}]);
 const h=reader.header,request={...identity(h),kind:'primary-agent-catalog-membership',catalogRequestId:h.catalogRequestId,
  catalogSequence:h.sequence,operation:'detail',values:['task:live:canonical:12','missing']};
 const written=c.f.store.stats().pagesWritten,result=await c.f.plane.readPage(request,c.options);
 assert.equal(result.items[0].found,true);assert.equal(result.items[0].record.kind,'object');
 assert.deepEqual(result.items[1],{ordinal:1,found:false,record:null});
 assert.equal(c.f.store.stats().pagesWritten,written);
 assert.equal(c.f.plane.assertAgentCatalogRead(request,c.f.consumerKey).leaseId,h.leaseId);
 assert.throws(()=>c.f.plane.assertAgentCatalogRead({...request,...c.f.plane.identity(c.parent())},c.f.consumerKey),/HISTORY_AGENT_CATALOG_READ_BINDING/);
 await assert.rejects(c.f.plane.readPage({...request,catalogSequence:h.sequence+1},c.options),/HISTORY_AGENT_CATALOG_MEMBERSHIP/);
 await assert.rejects(c.f.plane.readPage({...request,values:['a','b','c','d']},c.options),/HISTORY_AGENT_CATALOG_MEMBERSHIP/);
 assert.equal((await reader.lookup('task:live:canonical:12')).kind,'found');
});

test('pending allocation and malformed scalar cleanup cannot release sibling or prepared parent',async t=>{
 const c=await setup(t),a=c.request(c.native({live:[agentRow('a',[taskAction('a')])]}).wire),b=c.request();
 const pending=await c.f.plane.forkAgentCatalog(a,c.options),ready=await c.f.plane.forkAgentCatalog(b,c.options);
 assert.equal(pending.phase,'native');assert.equal(ready.phase,'ready');
 const release=h=>({...identity(h),catalogRequestId:h.catalogRequestId});
 assert.throws(()=>c.f.plane.release({...identity(ready),catalogRequestId:a.catalogRequestId},c.options),/HISTORY_AGENT_CATALOG_RELEASE_BINDING/);
 assert.throws(()=>c.f.plane.release({...c.f.plane.identity(c.parent()),catalogRequestId:a.catalogRequestId},c.options),/HISTORY_PRIMARY_PREPARED_RELEASE_BINDING/);
 const step={...identity(pending),kind:'primary-agent-catalog-step',nodeToken:pending.root.nodeToken,
  catalogRequestId:a.catalogRequestId,sequence:pending.sequence,operation:'append-value',data:{offset:1,text:'wrong-offset'}};
 await assert.rejects(c.f.plane.readPage({...step,catalogRequestId:b.catalogRequestId},c.options),/HISTORY_AGENT_CATALOG_SEQUENCE/);
 assert(c.f.plane.roots.has(pending.leaseId),'wrong request ID has no child side effect');
 await assert.rejects(c.f.plane.readPage(step,c.options),/HISTORY_AGENT_CATALOG_SCALAR/);
 assert.equal(c.f.plane.roots.has(pending.leaseId),false,'authenticated malformed continuation releases only itself');
 assert(c.f.plane.roots.has(ready.leaseId));assert(c.parent());
 assert.equal(c.f.plane.release(release(ready),c.options).released,true);
 await assert.rejects(c.f.plane.readPage(step,c.options),/HISTORY_ROOT_RELEASED/);
});

test('cancelled allocating build releases unpublished paged owner under original finite quotas',async t=>{
 const c=await setup(t,[agentRow('history',[taskAction('one')])]);
 const request=c.request(),roots=c.f.plane.roots.size,leases=c.f.store.stats().leases;
 const error=Object.assign(new Error('HISTORY_READ_CANCELLED'),{code:'HISTORY_READ_CANCELLED'});
 let checkpoints=0;
 await assert.rejects(c.f.plane.forkAgentCatalog(request,{consumerKey:c.f.consumerKey,control:{assertCurrent(){},async checkpoint(){checkpoints++;throw error;}}}),e=>e===error);
 assert(checkpoints>0);assert.equal(c.f.plane.roots.size,roots);assert.equal(c.f.store.stats().leases,leases);
 assert.equal(c.f.store.stats().activeBuilders,0);
 const ready=await c.f.plane.forkAgentCatalog(c.request(),c.options);assert.equal(ready.counts.total,1);
 c.f.plane.release({...identity(ready),catalogRequestId:ready.catalogRequestId},c.options);
});
