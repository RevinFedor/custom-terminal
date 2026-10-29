'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),v8=require('node:v8');
const Adapter=require(process.env.NOTED_UNIT_TEST_SQLITE_ADAPTER),{HistoryPagedStore,materializeHistoryCursorSync:mat}=require('./history-paged-store');
const evidence=process.env.NOTED_SINGLE_READ_EVIDENCE;assert(evidence&&path.isAbsolute(evidence));fs.mkdirSync(evidence,{recursive:true});
assert(v8.getHeapStatistics().heap_size_limit<=128*1024**2);
let tracking=false,queries=0,maxBlob=0,maxDigest=0;
class SQLite extends Adapter{
 constructor(file,options){super(file,options);this.name=file;}
 prepare(sql){const stmt=super.prepare(sql);return{get:(...args)=>{const row=stmt.get(...args);
  if(tracking&&/^SELECT/.test(sql)&&/FROM hp_pages WHERE id=\?/.test(sql)){
   queries++;if(row?.body)maxBlob=Math.max(maxBlob,row.body.byteLength||0);
   if(typeof row?.digest==='string')maxDigest=Math.max(maxDigest,row.digest.length);
  }return row;},run:(...args)=>stmt.run(...args),all:(...args)=>stmt.all(...args),*iterate(...args){yield*stmt.iterate(...args);}};
 }
}
test('exact paged contents and corruption guards precede one bounded SQL page pull',()=>{
 const dir=fs.mkdtempSync(path.join(evidence,'single-read-')),store=new HistoryPagedStore({filename:path.join(dir,'pages.sqlite'),Database:SQLite,
  diskBytes:16*1024**2,residentPages:3,indexBytes:2048,pageBytes:1024}),roots=[];
 try{
  const shared={full:'full Ω🙂\r\n\0\ud800'+('exact source '.repeat(150))},value={shared,list:[undefined,shared,null,-0,NaN]};value.self=value;
  const root=store.captureLegacy(value),fork=root.fork();roots.push(root,fork);const read=mat(root.cursor());
  assert.equal(read.shared.full,shared.full);assert.equal(read.shared,read.list[1]);assert.equal(read.self,read);assert(Object.is(read.list[3],-0));assert(Number.isNaN(read.list[4]));
  root.release();assert.equal(mat(fork.cursor()).shared.full,shared.full);
  const plain=store.transaction(()=>store.put({finite:'plain source data'},[])),cold=()=>{store.cache.clear();store.cacheBytes=0;};
  cold();tracking=true;queries=0;const body=store.read(plain);tracking=false;
  assert.deepEqual(JSON.parse(body.toString()),{finite:'plain source data'});const coldQueries=queries;
  tracking=true;queries=0;assert(store.read(plain).equals(body));tracking=false;assert.equal(queries,0,'existing ready cache path unchanged');
  const bad=store.transaction(()=>store.put({bad:'digest'},[]));store.db.prepare('UPDATE hp_pages SET digest=? WHERE id=?').run('f'.repeat(1024**2),bad);
  cold();tracking=true;assert.throws(()=>store.read(bad),e=>e.code==='history_page_corrupt');tracking=false;store.db.prepare('DELETE FROM hp_pages WHERE id=?').run(bad);
  const large=store.transaction(()=>store.put({bad:'oversized'},[]));store.db.prepare('UPDATE hp_pages SET body=zeroblob(?) WHERE id=?').run(2*1024**2,large);
  cold();tracking=true;assert.throws(()=>store.read(large),e=>e.code==='history_page_missing_or_corrupt');tracking=false;store.db.prepare('DELETE FROM hp_pages WHERE id=?').run(large);
  const changed=store.transaction(()=>store.put({bad:'changed'},[]));store.db.prepare('UPDATE hp_pages SET digest=? WHERE id=?').run('0'.repeat(64),changed);
  cold();assert.throws(()=>store.read(changed),e=>e.code==='history_page_corrupt');store.db.prepare('DELETE FROM hp_pages WHERE id=?').run(changed);
  // Contents, aliasing, independent pins and all rejection outcomes above
  // complete before work/buffer assertions distinguish this optimization.
  assert(maxBlob<=1024,'invalid large body never crosses the SQL driver');
  assert(maxDigest<=65,'corrupt digest is also a bounded SQL scalar');
  assert.equal(coldQueries,1,'one atomic bounded SELECT for an actual cold page');
  assert(store.stats().peakCachedPages<=3);assert(store.stats().peakIndexBytes<=2048);
  assert.equal(store.db.pragma('journal_mode',{simple:true}),'delete');assert.equal(store.db.pragma('synchronous',{simple:true}),2);
 }finally{
  tracking=false;for(const root of roots)root.release();assert.equal(store.stats().leases,0);assert.equal(store.stats().activeBuilders,0);
  const bytes=fs.readdirSync(dir).reduce((n,f)=>n+fs.statSync(path.join(dir,f)).size,0);assert(bytes<32*1024**2);
  store.close();fs.rmSync(dir,{recursive:true});assert(!fs.existsSync(dir));
 }
});
