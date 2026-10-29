'use strict';
// Finite actual page-store Source controls, private SQLite only.
// node --max-old-space-size=64 --max-semi-space-size=8 scripts/history-presentation-position-store-source.test.cjs
const test = require('node:test'), assert = require('node:assert/strict');
assert(require('node:v8').getHeapStatistics().heap_size_limit<=128*1024**2,'finite V8 TOTAL <=128MiB; use documented command');
const { HistoryPagedStore } = require('../src/main/history-root-engine/main/history-paged-store');
const { HistoryPresentationPosition } = require('../src/main/history-root-engine/main/history-presentation-position');
const Database = require('./test-support/history-node-sqlite.cjs');
const noop = {assertCurrent(){},async checkpoint(){}};
function fixture(t, options = {}) {
  const store = new HistoryPagedStore({Database,pageBytes:256,indexBytes:512,residentPages:3,diskBytes:12*1024**2,...options});
  const caps=[];
  const create = unitCount => {const cap=new HistoryPresentationPosition(store,{projectionId:'finite-v51',unitCount});caps.push(cap);return cap;};
  t.after(()=>{for(const cap of caps)cap.close();assert.equal(store.stats().leases,0);assert.equal(store.stats().activeBuilders,0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM hp_pins').get().n,0);store.close();});
  return {store,caps,create};
}
async function row(cap, uuid,index,memberIndex=-1,memberCount=1, control=noop) {
  const type=typeof uuid, supported=['string','number','boolean','bigint'].includes(type), text=uuid&&supported?String(uuid):'';
  const record={index,memberIndex,memberCount,type:!uuid?'skip':supported?type:'unqueryable'};
  const parts=[];if(!text)parts.push({...record,text:'',offset:0,done:true});
  else for(let offset=0;offset<text.length;offset+=128)parts.push({...record,text:text.slice(offset,offset+128),offset,done:offset+128>=text.length});
  for(let at=0;at<parts.length;at+=3)await cap.append(cap.sequence,parts.slice(at,at+3),{control});
}
async function lookup(cap,uuid,control=noop) {
  const query=cap.forkQuery();
  try {return await queryValue(query,uuid,control);}
  finally{query.close();}
}
async function queryValue(query,uuid,control=noop,width=128) {
  const text=String(uuid),type=typeof uuid;let result;
  do {
    for(let offset=0;offset<text.length;offset+=width)result=await query.append(query.sequence,
      [{type,text:text.slice(offset,offset+width),offset,done:offset+width>=text.length}],{control,pass:query.pass});
  }while(result.phase==='replay');
  assert.equal(result.phase,'done');return result.result;
}

test('exact UTF16 hidden member, current local and duplicate last-unit/first-member semantics',async t=>{
  const f=fixture(t),p=f.create(4),long='hidden \0\ud800😀 '+'ж\udc00'.repeat(2100);
  assert.equal(long.length,4212);
  await row(p,'local-current',0);await row(p,'group-first',1,0,3);await row(p,long,1,1,3);await row(p,long,1,2,3);
  await row(p,'duplicate',2);await row(p,'duplicate',3,0,2);await row(p,'duplicate',3,1,2);p.seal(p.sequence);
  assert.deepEqual(await lookup(p,long),{kind:'found',index:1,memberIndex:1});
  assert.deepEqual(await lookup(p,'local-current'),{kind:'found',index:0,memberIndex:-1});
  assert.deepEqual(await lookup(p,'duplicate'),{kind:'found',index:3,memberIndex:0});
  assert.deepEqual(await lookup(p,long+'x'),{kind:'missing'});
  assert.equal(p.metrics.nativeCoordinateEntries,0);assert.equal(p.metrics.maxPartialKeys,1);
  assert(p.metrics.maxEvents<=3);assert(p.metrics.maxKeyFragmentChars<=128);assert(p.pin.cursor().kind==='presentation-position');
});

test('typed primitives are disjoint; truthiness and unqueryable keys do not consume string aliases',async t=>{
  const f=fixture(t),values=[1,'1',true,'true',1n,0,false,0n,NaN,'',null,undefined,{},()=>{},Symbol('x')],p=f.create(values.length);
  for(let i=0;i<values.length;i++)await row(p,values[i],i);p.seal(p.sequence);
  for(const [v,i] of [[1,0],['1',1],[true,2],['true',3],[1n,4]])assert.deepEqual(await lookup(p,v),{kind:'found',index:i,memberIndex:-1});
  assert.deepEqual(await lookup(p,'[object Object]'),{kind:'missing'});
  assert.equal(p.metrics.skippedFalsy,7);assert.equal(p.metrics.unqueryableKeys,3);
});

test('forced text digest collision still compares full exact code units',async t=>{
  const f=fixture(t,{textDigestFactory:()=>({update(){return this;},digest(){return '0'.repeat(64);}})}),p=f.create(3);
  await row(p,'\ud800 A',0);await row(p,'\ud801 A',1);await row(p,'\ud800 A',2);p.seal(p.sequence);
  assert.deepEqual(await lookup(p,'\ud800 A'),{kind:'found',index:2,memberIndex:-1});
  assert.deepEqual(await lookup(p,'\ud801 A'),{kind:'found',index:1,memberIndex:-1});
  assert.deepEqual(await lookup(p,'\ud802 A'),{kind:'missing'});
});

test('query independently pins sealed projection after parent release',async t=>{
  const f=fixture(t),p=f.create(1);await row(p,'retained',0);p.seal(p.sequence);
  const query=p.forkQuery();f.caps.push(query);p.close();
  const result=await queryValue(query,'retained');
  assert.deepEqual(result,{kind:'found',index:0,memberIndex:-1});query.close();
});

test('publication refuses incomplete/invalid order without an empty success',async t=>{
  const f=fixture(t),p=f.create(2);await row(p,'first',0,0,2);
  assert.throws(()=>p.seal(p.sequence),{code:'HISTORY_POSITION_INCOMPLETE'});
  await assert.rejects(row(p,'second',1),{code:'HISTORY_POSITION_ORDER'});assert.equal(p.closed,true);
  const e=f.create(1);await row(e,null,0,-2,0);e.seal(e.sequence);assert.deepEqual(await lookup(e,'x'),{kind:'missing'});
  const invalid=f.create(1);await assert.rejects(row(invalid,'not-an-empty-group',0,-2,0),{code:'HISTORY_POSITION_RECORD'});
});

test('query cancellation at actual 64-work comparison closes child only',async t=>{
  const f=fixture(t),p=f.create(1),key='q'.repeat(9000);await row(p,key,0);p.seal(p.sequence);
  const query=p.forkQuery();let checkpoints=0;
  const control={assertCurrent(){},async checkpoint(){if(query.pass>0){checkpoints++;throw Object.assign(new Error('cancel'),{code:'HISTORY_READ_CANCELLED'});}}};
  try{await assert.rejects(queryValue(query,key,control),{code:'HISTORY_READ_CANCELLED'});}finally{query.close();}
  assert.equal(checkpoints,1);assert.equal(p.closed,false);
  assert.deepEqual(await lookup(p,key),{kind:'found',index:0,memberIndex:-1});
});

test('actual data/publication transaction quota and SQL_FULL rollback preserve unrelated pins with no orphan',async t=>{
  const f=fixture(t),kept=f.create(1);await row(kept,'independent',0);kept.seal(kept.sequence);
  const baseline=f.store.db.prepare('SELECT name,page FROM hp_pins ORDER BY name').all();
  for(const code of ['HISTORY_BACKING_FULL','SQLITE_FULL'])for(const failAt of [3,4]){
    const p=f.create(1),original=f.store.checkDisk.bind(f.store);let calls=0;
    f.store.checkDisk=()=>{if(++calls===failAt)throw Object.assign(new Error('injected final transaction check'),{code,...(code==='SQLITE_FULL'?{errcode:13}:{})});return original();};
    await assert.rejects(row(p,'abc',0),{code});f.store.checkDisk=original;p.close();
    assert.equal(f.store.stats().leases,1);
    assert.deepEqual(f.store.db.prepare('SELECT name,page FROM hp_pins ORDER BY name').all(),baseline);
    assert.deepEqual(await lookup(kept,'independent'),{kind:'found',index:0,memberIndex:-1});
  }
  kept.close();assert.equal(f.store.stats().leases,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM hp_pins').get().n,0);
});

test('aggregate UTF16 corruption after a repaired page checksum is an error, never missing',async t=>{
  const f=fixture(t),p=f.create(1),key='registered-key\0\ud800😀'.repeat(60);
  await row(p,key,0);p.seal(p.sequence);
  const record=f.store.json(f.store.vectorGet(p.meta.items,0)),meta=f.store.json(record.key.id),page=f.store.vectorGet(meta.chunks,0);
  const bytes=Buffer.from(f.store.read(page));bytes[0]^=2;
  const digest=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  f.store.db.prepare('UPDATE hp_pages SET body=?,digest=? WHERE id=?').run(bytes,digest,page);
  f.store.cache.clear();f.store.cacheBytes=0;
  await assert.rejects(lookup(p,key),{code:'history_leaf_corrupt'});
  assert.equal(p.closed,false,'only the failing independent query is released');
});
test('legal selector fragment boundaries preserve exact full UTF16 comparison',async t=>{
  const f=fixture(t),p=f.create(1),key=(' a\0\ud800😀\udc00 ').repeat(63);
  await row(p,key,0);p.seal(p.sequence);const query=p.forkQuery();
  try{
    assert.deepEqual(await queryValue(query,key,noop,17),{kind:'found',index:0,memberIndex:-1});
  }finally{query.close();}
});
test('changed stored leaf metadata is validated before it can filter a negative result',async t=>{
  for(const field of ['digest','totalChars']){
    const f=fixture(t),p=f.create(1),value='metadata-key\0\ud800😀'.repeat(40);
    await row(p,value,0);p.seal(p.sequence);
    const record=f.store.json(f.store.vectorGet(p.meta.items,0)),meta=f.store.json(record.key.id);
    const changed={...meta,...(field==='digest'?{digest:(meta.digest[0]==='0'?'1':'0')+meta.digest.slice(1)}:{totalChars:meta.totalChars+1})};
    const bytes=Buffer.from(JSON.stringify(changed)),digest=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    f.store.db.prepare('UPDATE hp_pages SET body=?,digest=? WHERE id=?').run(bytes,digest,record.key.id);
    f.store.cache.clear();f.store.cacheBytes=0;
    await assert.rejects(lookup(p,value),{code:'history_leaf_corrupt'});
    assert.equal(p.closed,false);
  }
});
test('corrupt stored page rejects query and never fabricates missing',async t=>{
  const f=fixture(t),p=f.create(1);await row(p,'integrity',0);p.seal(p.sequence);
  const record=f.store.json(f.store.vectorGet(p.meta.items,0)),key=f.store.json(record.key.id),page=f.store.vectorGet(key.chunks,0);
  f.store.cache.clear();f.store.cacheBytes=0;f.store.db.prepare('UPDATE hp_pages SET body=? WHERE id=?').run(Buffer.from('bad'),page);
  await assert.rejects(lookup(p,'integrity'),{code:'history_page_corrupt'});
});

test('valid differently chunked stored text and split surrogate pairs compare by continuous full UTF16',async t=>{
  for(const [value,parts]of [['alpha',['al','pha']],['A\ud83d\ude00B',['A\ud83d','\ude00B']]]){
    const f=fixture(t),p=f.create(1);await row(p,value,0);p.seal(p.sequence);
    const record=f.store.json(f.store.vectorGet(p.meta.items,0)),meta=f.store.json(record.key.id);
    f.store.transaction(()=>{let chunks={page:0,depth:0,length:0};
      for(const part of parts)chunks=f.store.vectorSet(chunks,chunks.length,f.store.put(Buffer.from(part,'utf16le')));
      meta.chunks=chunks;f.store.sql('DELETE FROM hp_edges WHERE parent=?').run(record.key.id);f.store.put(meta,[chunks.page],record.key.id);});
    f.store.cache.clear();f.store.cacheBytes=0;
    assert.equal([...f.store.leafChunks(record.key)].join(''),value);
    assert.deepEqual(await lookup(p,value),{kind:'found',index:0,memberIndex:-1});
  }
});

test('held query and independent pin fork allocate no SQL/page/builder state and survive parent close',async t=>{
  const f=fixture(t),p=f.create(1),value='read-only\0\ud800😀'.repeat(400);await row(p,value,0);p.seal(p.sequence);
  const before=f.store.db.prepare('SELECT name,page FROM hp_pins ORDER BY name').all(),originals={};
  for(const method of ['transaction','lease','put','leafWriter','beginBuild']){originals[method]=f.store[method];f.store[method]=()=>{throw new Error('read-only query called '+method);};}
  let query;
  try{
    query=p.forkQuery();p.close();
    assert.deepEqual(f.store.db.prepare('SELECT name,page FROM hp_pins ORDER BY name').all(),before);
    assert.deepEqual(await queryValue(query,value),{kind:'found',index:0,memberIndex:-1});
    assert.equal(query.metrics.targetPageWrites,0);assert.equal(query.metrics.nativeTargetChars,0);
    assert.equal(f.store.stats().activeBuilders,0);assert.equal(f.store.stats().leases,1);
  }finally{for(const [name,method]of Object.entries(originals))f.store[name]=method;query?.close();}
  assert.equal(f.store.stats().leases,0);
});
