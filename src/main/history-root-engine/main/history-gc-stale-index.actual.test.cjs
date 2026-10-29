'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Database=process.env.NOTED_UNIT_TEST_SQLITE_ADAPTER?require(process.env.NOTED_UNIT_TEST_SQLITE_ADAPTER):require('better-sqlite3');
const {HistoryPagedStore,materializeHistoryCursorSync:materialize}=require('./history-paged-store');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noted-gc-stale-')),queries=[];
 class Tracking extends Database{
  prepare(sql){const statement=super.prepare(sql);return {run:(...a)=>statement.run(...a),all:(...a)=>statement.all(...a),
   get:(...a)=>{if(/^SELECT page FROM hp_gc WHERE epoch/.test(sql))queries.push({sql,args:a});return statement.get(...a);},
   *iterate(...a){yield*statement.iterate(...a);}};}
 }
 const store=new HistoryPagedStore({filename:path.join(dir,'own.sqlite'),Database:Tracking,diskBytes:16*1024**2});
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});assert(!fs.existsSync(dir));});
 return {store,queries};
}
function collect(store){
 for(let i=0;i<4096;i++){const result=store.collectStep(64);assert(result.work<=64);if(result.complete)return result;}
 assert.fail('finite collection did not complete');
}
test('indexed stale collection preserves full frozen graph, aliases and independent leases',t=>{
 const {store,queries}=fixture(t),shared={text:'full 😀\r\n\0\ud800'+('all source '.repeat(180))};
 const value={shared,alias:shared};value.self=value;
 const root=store.captureLegacy(value),held=root.fork();root.release();
 const garbage=store.captureLegacy({discard:'discard'.repeat(250)});garbage.release();
 collect(store);
 const got=materialize(held.cursor());assert.equal(got.shared.text,shared.text);assert.equal(got.shared,got.alias);assert.equal(got.self,got);
 assert.equal(store.stats().leases,1);assert.equal(store.stats().activeBuilders,0);
 const currentEpoch=store.sql("SELECT value FROM hp_meta WHERE key='gc_epoch'").get().value;
 assert.equal(store.sql('SELECT count(*) AS n FROM hp_gc WHERE epoch<>?').get(currentEpoch).n,0);
 assert(queries.length>0);held.release();collect(store);assert.equal(store.stats().leases,0);
 assert.equal(store.sql('SELECT count(*) AS n FROM hp_pages').get().n,0);
 assert.equal(store.db.pragma('journal_mode',{simple:true}),'delete');assert.equal(store.db.pragma('synchronous',{simple:true}),2);
});
test('actual stale selector uses existing index and removes exact old/future epoch set',t=>{
 const {store,queries}=fixture(t);collect(store);assert(queries.length>0);
 const selector=queries.at(-1).sql,epoch=23;
 const insert=store.sql('INSERT INTO hp_gc(page,epoch,done) VALUES(?,?,?)');
 store.transaction(()=>{for(let i=1;i<=8192;i++)insert.run(i,epoch,i%2);for(let i=8193;i<=8312;i++)insert.run(i,i%2?epoch-1:epoch+1,i%2);});
 const plan=store.db.prepare('EXPLAIN QUERY PLAN '+selector).all(...(selector.includes('UNION ALL')?[epoch,epoch]:[epoch]));
 assert(plan.filter(r=>/SEARCH hp_gc USING COVERING INDEX hp_gc_pending/.test(r.detail)).length>=2,
  'both unequal epoch ranges must use the already existing index');
 assert(!plan.some(r=>/SCAN hp_gc/.test(r.detail)),'no repeated scan over current live marks');
 const expected=store.sql('SELECT page FROM hp_gc WHERE epoch<>? ORDER BY page').all(epoch).map(r=>r.page);
 const actual=[],select=store.sql(selector);
 for(let i=0;i<=120;i++){const row=select.get(...(selector.includes('UNION ALL')?[epoch,epoch]:[epoch]));if(!row)break;actual.push(row.page);store.sql('DELETE FROM hp_gc WHERE page=?').run(row.page);}
 assert.deepEqual(actual.sort((a,b)=>a-b),expected);assert.equal(actual.length,120);
 assert.equal(store.sql('SELECT count(*) AS n FROM hp_gc WHERE epoch=?').get(epoch).n,8192);
 assert.equal(select.get(...(selector.includes('UNION ALL')?[epoch,epoch]:[epoch])),undefined);
});
test('stale batch retains the original work64/transaction rollback on quota failure',t=>{
 const {store}=fixture(t),epoch=10;
 store.transaction(()=>{
  store.sql("UPDATE hp_meta SET value=4 WHERE key='gc_phase'").run();
  store.sql("UPDATE hp_meta SET value=? WHERE key='gc_epoch'").run(epoch);
  for(let i=1;i<=70;i++)store.sql('INSERT INTO hp_gc(page,epoch,done) VALUES(?,?,1)').run(i,i<=5?epoch:epoch-1);
 });
 const check=store.checkDisk,code='HISTORY_BACKING_FULL';
 store.checkDisk=()=>{throw Object.assign(new Error(code),{code});};
 assert.throws(()=>store.collectStep(64),e=>e.code===code);
 assert.equal(store.sql('SELECT count(*) AS n FROM hp_gc WHERE epoch<>?').get(epoch).n,65,'failed transaction publishes no partial stale deletion');
 store.checkDisk=check;
 const first=store.collectStep(64);assert.equal(first.work,64);assert.equal(first.complete,false);
 assert.equal(store.sql('SELECT count(*) AS n FROM hp_gc WHERE epoch=?').get(epoch).n,5);
 assert.equal(store.sql('SELECT count(*) AS n FROM hp_gc WHERE epoch<>?').get(epoch).n,1);
 const end=store.collectStep(64);assert.equal(end.complete,true);assert.equal(end.work,2);
 assert.equal(store.sql('SELECT count(*) AS n FROM hp_gc WHERE epoch<>?').get(epoch).n,0);
 assert.equal(store.stats().leases,0);assert.equal(store.stats().activeBuilders,0);
});
