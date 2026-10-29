// SOURCE: actual store/read-plane/position wire/adapter/lane; finite fixture
// replaces the prepared model wrapper with a ref-counted paged-metadata owner.
// Native metadata is only the declared compatibility registration input.
// Poison begins after registration; cold Np model decoding is NOT retired.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHistoryPreparedPositionSource, canBindHistoryPreparedPositionFrame } from '../src/renderer/utils/historyPreparedPosition.mjs';
import { createHistoryPresentationPositionOwner, createHistoryPresentationPositionQuery } from '../src/renderer/utils/historyPresentationPosition.mjs';
import { openHistoryPresentationPosition } from '../src/shared/history-presentation-position-client.mjs';
import { buildHistoryDisplayUnits, isGroupUnit } from '../src/renderer/utils/historyDisplayUnits.mjs';
import { historyLivePresentationKey } from '../src/renderer/utils/historyLiveProjection.mjs';
const require = createRequire(import.meta.url);
const { HistoryPagedStore, materializeHistoryCursor } = require('../src/main/history-root-engine/main/history-paged-store');
const { HistoryRootReadPlane } = require('../src/main/history-root-engine/main/history-root-read-plane');
const { HistoryRootController } = require('../src/main/history-root-engine/main/history-root-controller');
const Database = require('./test-support/history-node-sqlite.cjs');
const OPEN='agent-transcript:get-history',PAGE='agent-transcript:read-page',FORK='agent-transcript:fork-read-leaf',RELEASE='agent-transcript:release-read-root';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const control={assertCurrent(){},checkpoint:tick};
function fixture(t) {
  const store=new HistoryPagedStore({Database,pageBytes:256,indexBytes:512,residentPages:3,diskBytes:12*1024**2});
  const plane=new HistoryRootReadPlane({store,projectHistory:async()=>{throw Error('canonical producer unused by coordinate fixture');}}),calls=[],options={consumerKey:'v52-position',control};
  const f={store,plane,calls,hook:null};
  const route=(channel,payload)=>{
    if(channel===OPEN)return plane.openPosition(payload,options);
    if(channel===PAGE)return plane.readPage(payload,options);
    if(channel===FORK)return plane.forkPositionQuery(payload,options);
    if(channel===RELEASE)return plane.release(payload,options);
    if(channel==='agent-transcript:cancel-read')return {success:true,cancelled:true};
    throw Error('unexpected fixture channel');
  };
  f.invoke=(channel,payload)=>{calls.push({channel,payload});return f.hook?f.hook(channel,payload,route):route(channel,payload);};
  t.after(()=>{plane.close();plane.owner.close();assert.equal(store.stats().leases,0);assert.equal(store.stats().activeBuilders,0);store.close();});
  f.metadata=rows=>{
    const lease=store.captureLegacy(rows);let references=0;
    const weak=new WeakRef(rows), selected=[];
    function retain(){references++;let closed=false;return {
      get closed(){return closed;}, ownsCompatibilityMetadata(array){return !closed&&weak.deref()===array;},
      retain(){assert(!closed);return retain();},
      async readMetadataOrdinal(ordinal,{owns,signal}={}){assert(!closed);assert(!signal?.aborted);assert(owns());selected.push(ordinal);
        const value=await materializeHistoryCursor(lease.cursor().at(ordinal),{control});assert(!closed);assert(owns());return value;},
      close(){if(!closed){closed=true;if(--references===0)lease.release();}return Promise.resolve();},
    };}
    return {owner:retain(),selected,references:()=>references};
  };
  return f;
}
function poison(array) { for(let index=0;index<array.length;index++)Object.defineProperty(array,index,{get(){throw Error('historical N getter read after registration');},configurable:true}); }

test('actual selected wire returns exact original source ordinal and full physical key after model parent close',async t=>{
  const f=fixture(t),id='same\0\ud800😀\udc00'.repeat(250),key='work:full\0\udc00😀\ud800'.repeat(80);
  const first={uuid:id,sourceIdentityAliases:['first\0\ud800']},second={uuid:id,sourceIdentityAliases:['second-full']};
  const rows=[first,second,{uuid:1},{uuid:'1'}],meta=f.metadata(rows),local={uuid:7n,content:'CURRENT',isLocal:true};
  const units=[{kind:'entry',entry:local},{kind:'entry',entry:first},{kind:'group',entries:[second,first]},
    {kind:'entry',entry:rows[2]},{kind:'entry',entry:rows[3]}];
  const keys=['local-key','original-key',key,'number-key','string-key'],frame={};
  const source=createHistoryPreparedPositionSource({invoke:f.invoke,prepared:meta.owner,metadata:rows,currentRows:[local],units,itemKeys:keys});
  const owner=createHistoryPresentationPositionOwner({invoke:f.invoke}),publication=owner.publish({source,frame,witness:frame,owns:()=>true});
  assert.equal((await publication.promise).status,'ready');
  assert.equal(source.stats().compatibilityBorrowed,0);assert.equal(source.stats().nativeHistoricalEntries,0);
  await meta.owner.close();assert.equal(meta.references(),1);
  poison(rows);poison(units);poison(keys);
  const lane=createHistoryPresentationPositionQuery(owner);
  try{
    const result=await lane.resolve(publication,id);
    assert.equal(result.status,'ready');assert.equal(result.address.index,2);assert.equal(result.address.memberIndex,0);
    assert.equal(result.address.memberCount,2);assert.equal(result.address.physicalKey,key);
    assert.deepEqual(owner.entryAt(result.address).sourceIdentityAliases,['second-full']);
    assert.deepEqual(meta.selected,[1],'source ordinal is exact first member of last physical unit, never UUID-only first source');
    const current=await lane.resolve(publication,7n);assert.equal(owner.entryAt(current.address),local);
    assert.equal((await lane.resolve(publication,1)).address.index,3);assert.equal((await lane.resolve(publication,'1')).address.index,4);
    assert.equal((await lane.resolve(publication,'absent')).status,'absent');
    assert.equal(owner.stats().unitVisits,0);
    assert(f.calls.some(call=>call.payload.operation==='selection'));
    for(const call of f.calls.filter(call=>call.payload.events))assert(call.payload.events.length<=3&&call.payload.events.every(event=>event.text.length<=128));
  }finally{lane.dispose();await owner.dispose();await tick();}
  assert.equal(meta.references(),0);assert.equal(f.plane.stats().roots,0);
});

test('actual current-local-only source remains usable without a prepared/canonical root',async t=>{
  const f=fixture(t),local={uuid:'local-first-send',content:'full native current object',isLocal:true},frame={};
  const source=createHistoryPreparedPositionSource({invoke:f.invoke,currentRows:[local],units:[{kind:'entry',entry:local}],itemKeys:['current-full-key']});
  const owner=createHistoryPresentationPositionOwner({invoke:f.invoke}),publication=owner.publish({source,frame,witness:frame,owns:()=>true});
  await publication.promise;const lane=createHistoryPresentationPositionQuery(owner);
  const result=await lane.resolve(publication,local.uuid);assert.equal(result.status,'ready');assert.equal(owner.entryAt(result.address),local);
  lane.dispose();await owner.dispose();await tick();
});

test('an unbound historical clone fails explicitly and releases exact children instead of binding by UUID',async t=>{
  const f=fixture(t),rows=[{uuid:'same',sourceIdentityAliases:['original']}],meta=f.metadata(rows),clone={...rows[0],sourceIdentityAliases:['different']};
  const source=createHistoryPreparedPositionSource({invoke:f.invoke,prepared:meta.owner,metadata:rows,units:[{kind:'entry',entry:clone}],itemKeys:['actual']});
  const owner=createHistoryPresentationPositionOwner({invoke:f.invoke}),frame={},publication=owner.publish({source,frame,witness:frame,owns:()=>true});
  assert.equal((await publication.promise).status,'failed');assert.equal(publication.error.code,'HISTORY_PREPARED_POSITION_UNBOUND_ROW');
  await owner.dispose();await tick();assert.equal(meta.references(),1);await meta.owner.close();
});

test('actual full physical key aggregate corruption is rejected by an independent no-write query',async t=>{
  const f=fixture(t),key='original\0\ud800😀'.repeat(80);
  const client=await openHistoryPresentationPosition(f.invoke,{projectionId:'v52-key-corrupt',unitCount:1,
    records:[{uuid:'target',index:0,memberIndex:-1,memberCount:1,physicalKey:key,selection:{kind:'prepared',ordinal:123}}]});
  const state=f.plane.state(client.identity,'v52-position'),projection=state.positionProjection;
  const item=f.store.json(f.store.vectorGet(projection.meta.items,0)),leaf=f.store.json(item.physicalKey.id),page=f.store.vectorGet(leaf.chunks,0);
  const bytes=Buffer.from(f.store.read(page));bytes[0]^=2;const hash=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  f.store.db.prepare('UPDATE hp_pages SET body=?,digest=? WHERE id=?').run(bytes,hash,page);f.store.cache.clear();f.store.cacheBytes=0;
  const originals={};for(const method of ['transaction','lease','put','leafWriter','beginBuild']){originals[method]=f.store[method];f.store[method]=()=>{throw Error('held read allocated '+method);};}
  try{await assert.rejects(client.resolve('target'),{code:'history_leaf_corrupt'});assert.equal(client.closed,false);}
  finally{for(const[name,method]of Object.entries(originals))f.store[name]=method;await client.close();}
});


test('preflight preserves native compatibility for an unbound clone before any child or registration allocation',async t=>{
  const f=fixture(t),rows=[{uuid:'same',sourceIdentityAliases:['before']}],meta=f.metadata(rows);
  const actual={...rows[0],sourceIdentityAliases:['actual-shown']},units=[{kind:'entry',entry:actual}],keys=['exact-shown'];
  const canBind=await canBindHistoryPreparedPositionFrame({prepared:meta.owner,metadata:rows,units});
  assert.equal(canBind,false);assert.equal(f.calls.length,0);assert.equal(meta.references(),1);
  const owner=createHistoryPresentationPositionOwner({invoke:f.invoke}),frame={};
  // Existing genuine compatibility publication selected once before OPEN.
  const publication=owner.publish({units,itemKeys:keys,frame,witness:frame,owns:()=>true});await publication.promise;
  const selected=await owner.query(publication,'same');assert.equal(owner.entryAt(selected),actual);
  assert.equal(owner.stats().unitVisits,1);assert.equal(f.calls.filter(call=>call.channel===OPEN).length,1);
  await owner.dispose();await meta.owner.close();await tick();
});

test('preflight yields and checks the original owner without recapture or allocation',async t=>{
  const f=fixture(t),rows=Array.from({length:150},(_,i)=>({uuid:'row-'+i})),meta=f.metadata(rows);
  const units=rows.map(entry=>({kind:'entry',entry}));let calls=0;
  await assert.rejects(canBindHistoryPreparedPositionFrame({prepared:meta.owner,metadata:rows,units,owns:()=>++calls<90}),{code:'HISTORY_READ_CANCELLED'});
  assert.equal(f.calls.length,0);assert.equal(meta.references(),1);await meta.owner.close();
});


test('selected registration preserves actual response-work/group/subgroup expansion duplicates',async t=>{
  const f=fixture(t),action=(uuid,id)=>({uuid,role:'assistant',actionSummary:[{toolUseId:id,toolName:'Read',family:'read',aggregateKey:'read:regular'}]});
  const rows=[{uuid:'caption',role:'assistant',content:'commentary',textPhase:'commentary',rewriteRenderKey:'rewrite:exact'},
    action('a','call-a'),action('b','call-b'),{uuid:'thinking',role:'assistant',thinking:'reason'},
    action('c','call-c'),action('d','call-d'),{uuid:'final',role:'assistant',content:'final',textPhase:'final_answer'}];
  const meta=f.metadata(rows);
  const cases=[{responseWork:true},{responseWork:true,expandedKeys:new Set(['work:rewrite:exact','grp:call-a'])},
    {responseWork:false,expandedKeys:new Set(['grp:call-a','sub:call-a','sub:call-c'])}];
  try{for(const options of cases){
    const units=buildHistoryDisplayUnits(rows,options),keys=units.map(unit=>isGroupUnit(unit)?String(unit.key||''):historyLivePresentationKey(unit.entry));
    assert.equal(await canBindHistoryPreparedPositionFrame({prepared:meta.owner,metadata:rows,units}),true);
    const expected=rows.map(row=>{let selected;for(let index=0;index<units.length;index++){
      const unit=units[index],memberIndex=unit.kind==='entry'?(unit.entry.uuid===row.uuid?-1:null):unit.entries.findIndex(entry=>entry.uuid===row.uuid);
      if(memberIndex!==null&&(unit.kind==='entry'||memberIndex>=0))selected={index,memberIndex,key:keys[index]};
    }return selected;});
    const source=createHistoryPreparedPositionSource({invoke:f.invoke,prepared:meta.owner,metadata:rows,units,itemKeys:keys});
    const owner=createHistoryPresentationPositionOwner({invoke:f.invoke}),frame={},publication=owner.publish({source,frame,witness:frame,owns:()=>true});
    assert.equal((await publication.promise).status,'ready');poison(units);poison(keys);
    const lane=createHistoryPresentationPositionQuery(owner);
    try{for(let ordinal=0;ordinal<rows.length;ordinal++){
      const result=await lane.resolve(publication,rows[ordinal].uuid),wanted=expected[ordinal];
      assert.equal(result.status,'ready');assert.equal(result.address.index,wanted.index);assert.equal(result.address.memberIndex,wanted.memberIndex);
      assert.equal(result.address.physicalKey,wanted.key);
    }}finally{lane.dispose();await owner.dispose();await tick();}
  }}finally{await meta.owner.close();}
});


test('actual controller admits only installed no-write selected-key reads past an unrelated maintenance hold',async t=>{
  const f=fixture(t),client=await openHistoryPresentationPosition(f.invoke,{projectionId:'v52-controller-key',unitCount:1,
    records:[{uuid:'target',index:0,memberIndex:-1,memberCount:1,physicalKey:'full-key'.repeat(50),selection:{kind:'prepared',ordinal:0}}]});
  const controller=new HistoryRootController({store:f.store,cache:{maxBytes:16*1024**2,stats:()=>({diskBytes:0})},service:{},
    api:{projectCodexFullHistoryFromFile:async()=>{throw Error('no source producer');}},sourceSchema:'v52-fixture'});
  controller.plane=f.plane;controller.initializedBacking=true;
  const unlock=await controller.maintenanceAdmission.acquire(control);
  let selectedPages=0;
  f.hook=(channel,payload,route)=>{
    if(channel===PAGE&&['target','selection'].includes(payload.operation)){
      const exact={...payload,_historyRootConsumerKey:'v52-position'};
      assert.equal(controller.allocates('readHistoryRootPage',exact),false);
      assert.equal(controller.allocates('readHistoryRootPage',{...exact,leaseId:'forged'}),true);
      if(payload.operation==='selection')selectedPages++;
      return controller.dispatch('readHistoryRootPage',exact,{control});
    }
    return route(channel,payload);
  };
  try{const result=await client.resolve('target');assert.equal(result.physicalKey,'full-key'.repeat(50));assert(selectedPages>=4);}
  finally{unlock();await client.close();controller.close();}
});

test('concrete selected source retirement includes an independently held query cleanup receipt',async t=>{
  const f=fixture(t),local={uuid:'current',isLocal:true},source=createHistoryPreparedPositionSource({invoke:f.invoke,
    currentRows:[local],units:[{kind:'entry',entry:local}],itemKeys:['actual-key']});
  const client=await source.open({projectionId:'v52-selected-retire',unitCount:1,owns:()=>true,signal:new AbortController().signal});
  assert.equal(client.retirement().status,'pending','a live publication has not retired');
  let finish,ack,held=false;
  f.hook=(channel,payload,route)=>{
    const value=route(channel,payload);
    if(channel===RELEASE&&!held){held=true;ack=value;return new Promise(resolve=>{finish=resolve;});}
    return value;
  };
  assert.equal((await client.resolve(local.uuid)).entry,local);
  const close=client.close();assert.equal(client.close(),close);let done=false;close.then(()=>{done=true;});await tick();
  assert.equal(done,false);assert.equal(client.retirement().status,'pending');assert.equal(f.plane.stats().roots,0);
  finish(ack);await close;assert.equal(client.retirement().status,'released');
});

// Regression: a real CURRENT accessor runs after the selected position reply.
test('selected CURRENT uuid getter cannot publish a point after closing its original source', async t => {
  for (const closeFromGetter of [false, true]) {
    const f = fixture(t); let opened, armed = false, closeRequested = false;
    const current = { role: 'user', content: 'full current value', get uuid() {
      if (armed && closeFromGetter && !closeRequested) { closeRequested = true; opened.close(); }
      return 'current-exact-getter';
    } };
    const source = createHistoryPreparedPositionSource({ invoke: f.invoke, currentRows: [current],
      units: [{ kind: 'entry', entry: current }], itemKeys: ['current-physical-key'] });
    try {
      opened = await source.open({ projectionId: 'v52-getter-' + closeFromGetter, unitCount: 1, owns: () => true });
      armed = true;
      if (closeFromGetter) await assert.rejects(opened.resolve('current-exact-getter', { owns: () => true }),
        error => error.code === 'HISTORY_READ_CANCELLED');
      else { const point = await opened.resolve('current-exact-getter', { owns: () => true });
        assert.equal(point.kind, 'found'); assert.equal(opened.entryAt(point), current); }
    } finally { await opened?.close(); }
  }
});
