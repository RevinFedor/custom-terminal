'use strict';
// Finite SOURCE regressions for bounded canonical metadata frontier writes.
// Actual paged store/validator, synthetic metadata and private Node SQLite.
// Fault cases inject transaction/checkDisk refusals; they are not real disk-full tests.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {HistoryPagedStore}=require('../src/main/history-root-engine/main/history-paged-store');
const {validateCanonicalMetadata}=require('../src/main/history-root-engine/main/history-primary-metadata-validation');
const Database=require('./test-support/history-node-sqlite.cjs');
function fixture(t,rows){
 const store=new HistoryPagedStore({Database,pageBytes:1024,residentPages:3,indexBytes:2048,sqlCacheKiB:8,diskBytes:28*1024**2});
 const lease=store.captureLegacy(rows);
 t.after(()=>{lease.release();assert.equal(store.stats().leases,0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM hp_primary_metadata_work').get().n,0);store.close();});
 return {store,lease};
}
const rows=n=>Array.from({length:n},(_,i)=>({uuid:'u'+i,rowStub:true,role:'assistant',sessionId:'s',
 questionReplyProof:{text:'finite\ud800\u0000'.repeat(8),index:i}}));
function observe(store,{insertFailure=Infinity,quotaFailure=false}={}){
 const original={transaction:store.transaction,sql:store.sql,checkDisk:store.checkDisk};
 const stats={transactions:0,inserts:0,maxInserts:0,depth:0,activeInserts:0,checkDisk:0};
 store.transaction=function(callback){
  const outer=stats.depth===0;if(outer){stats.transactions++;stats.activeInserts=0;}stats.depth++;
  try{return original.transaction.call(this,callback);}
  finally{stats.depth--;if(outer)stats.maxInserts=Math.max(stats.maxInserts,stats.activeInserts);}
 };
 store.sql=function(query){
  const statement=original.sql.call(this,query);
  if(!query.startsWith('INSERT OR IGNORE INTO hp_primary_metadata_work'))return statement;
  return {run(...args){
   stats.inserts++;stats.activeInserts++;
   if(stats.inserts===insertFailure)throw Object.assign(new Error('injected frontier insert'),{code:'FINITE_INSERT'});
   return statement.run(...args);
  }};
 };
 store.checkDisk=function(...args){
  stats.checkDisk++;
  if(quotaFailure&&stats.activeInserts>=2)throw Object.assign(new Error('injected quota checkpoint'),{code:'FINITE_QUOTA'});
  return original.checkDisk.apply(this,args);
 };
 return {stats,restore(){Object.assign(store,original);}};
}
test('frontier is transaction-bounded at64 without one transaction per discovered node',async t=>{
 const {store,lease}=fixture(t,rows(256));const observation=observe(store);let checkpoints=0,fact;
 try{fact=await validateCanonicalMetadata(store,lease,{control:{assertCurrent(){},async checkpoint(){checkpoints++;}}});}
 finally{observation.restore();}
 assert.equal(fact.canonicalEntryCount,256);assert.equal(checkpoints,Math.floor(fact.steps/64));
 assert(observation.stats.maxInserts<=64);assert(observation.stats.maxInserts>1);
 assert(observation.stats.transactions<fact.steps/8,'N per-node commit amplification must stay removed');
 assert.equal(observation.stats.checkDisk,observation.stats.transactions);
});
test('cycles/shared references and an alias-only final frontier preserve complete proof',async t=>{
 const input=rows(5);input[0].questionReplyProof.self=input[0].questionReplyProof;
 input[1].questionReplyProof=input[0].questionReplyProof;input[4].questionReplyProof.root=input;
 const {store,lease}=fixture(t,input);const first=await validateCanonicalMetadata(store,lease),second=await validateCanonicalMetadata(store,lease);
 assert.deepEqual(second,first);assert.equal(first.canonicalEntryCount,5);
});
test('partial frontier insert rollback leaves no committed cursor gap or leaked job',async t=>{
 const {store,lease}=fixture(t,rows(128));const expected=await validateCanonicalMetadata(store,lease);
 const observation=observe(store,{insertFailure:3});
 try{await assert.rejects(validateCanonicalMetadata(store,lease),{code:'FINITE_INSERT'});}
 finally{observation.restore();}
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM hp_primary_metadata_work').get().n,0);
 assert.deepEqual(await validateCanonicalMetadata(store,lease),expected);
});
test('injected quota refusal rolls back the complete pending batch and preserves the borrowed lease',async t=>{
 const {store,lease}=fixture(t,rows(128));const expected=await validateCanonicalMetadata(store,lease);
 const observation=observe(store,{quotaFailure:true});
 try{await assert.rejects(validateCanonicalMetadata(store,lease),{code:'FINITE_QUOTA'});}
 finally{observation.restore();}
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM hp_primary_metadata_work').get().n,0);
 assert.equal(lease.cursor().length,128);assert.deepEqual(await validateCanonicalMetadata(store,lease),expected);
});
test('cancellation before frontier flush drops only uncommitted discoveries',async t=>{
 const {store,lease}=fixture(t,rows(16));let checks=0;
 await assert.rejects(validateCanonicalMetadata(store,lease,{control:{assertCurrent(){
  if(++checks===8)throw Object.assign(new Error('injected cancellation'),{code:'FINITE_CANCEL'});
 }}}),{code:'FINITE_CANCEL'});
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM hp_primary_metadata_work').get().n,0);
 assert.equal((await validateCanonicalMetadata(store,lease)).canonicalEntryCount,16);
});
test('cancellation delivered before queue-exhaustion flush starts no new SQL insert',async t=>{
 const {store,lease}=fixture(t,rows(1));
 const originalSql=store.sql;let selectedRoot=false,rootChecks=0,cancelled=false,lateInserts=0;
 store.sql=function(query){
  const statement=originalSql.call(this,query);
  if(query.startsWith('SELECT node_key FROM hp_primary_metadata_work'))return {get(...args){
   const result=statement.get(...args);if(!selectedRoot){selectedRoot=true;rootChecks=0;}return result;
  }};
  if(query.startsWith('INSERT OR IGNORE INTO hp_primary_metadata_work'))return {run(...args){
   if(cancelled)lateInserts++;return statement.run(...args);
  }};
  return statement;
 };
 try{
  await assert.rejects(validateCanonicalMetadata(store,lease,{control:{assertCurrent(){
   if(cancelled)throw Object.assign(new Error('cancelled before flush'),{code:'FINITE_CANCEL_BEFORE_FLUSH'});
   if(selectedRoot&&++rootChecks===2)queueMicrotask(()=>{cancelled=true;});
  }}}),{code:'FINITE_CANCEL_BEFORE_FLUSH'});
  assert.equal(lateInserts,0,'cancelled discoveries must be dropped before transaction admission');
 }finally{store.sql=originalSql;}
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM hp_primary_metadata_work').get().n,0);
});
test('implementation schema includes the actually loaded common metadata grammar',()=>{
 const fs=require('node:fs'),crypto=require('node:crypto');
 const root=path.resolve(__dirname,'..'),filename=path.join(root,'src/main/history-root-engine/main/history-read-worker.js');
 const rules=require.resolve('../src/shared/history-primary-metadata-rules.cjs');
 assert(Object.hasOwn(require.cache,rules),'the real validator must load the common grammar');
 const body=fs.readFileSync(filename,'utf8');
 const start=body.indexOf("const schemaHash = crypto.createHash('sha256');");
 const end=body.indexOf("const sourceSchemaSHA256=schemaHash.digest('hex');",start);
 assert(start>=0&&end>start);
 const block=body.slice(start,end+"const sourceSchemaSHA256=schemaHash.digest('hex');".length);
 const run=(changed,outsideChanged=false)=>{
  const unrelated=path.join(root,'not-a-source-module.cjs'),loaded=Object.assign(Object.create(null),require.cache,{[filename]:{},[unrelated]:{}});
  const scopedRequire=id=>require(id);scopedRequire.cache=loaded;
  const sourceFs={readFileSync(name,...args){
   if(name===unrelated)throw new Error('unrelated module must stay excluded');
   const original=fs.readFileSync(name,...args);
   return changed&&name===rules?Buffer.concat([Buffer.from(original),Buffer.from('\n// finite implementation-byte change\n')]):original;
  }};
  return new Function('crypto','fs','require','process','__dirname','__filename',block+
   '\nreturn {sourceSchemaSHA256,sourceModuleCount,workerSourceSHA256};')(
    crypto,sourceFs,scopedRequire,process,path.dirname(filename),filename);
 };
 const original=run(false),changed=run(true);
 assert.notEqual(changed.sourceSchemaSHA256,original.sourceSchemaSHA256,'common grammar bytes must invalidate derived acceleration');
 assert.equal(changed.sourceModuleCount,original.sourceModuleCount);
 assert.equal(changed.workerSourceSHA256,original.workerSourceSHA256);
 assert.deepEqual(run(false,true),original);
});
test('the new common grammar has the actual renderer DEV alias and build directory admission',async()=>{
 const {pathToFileURL}=require('node:url');
 const root=path.resolve(__dirname,'..'),filename=path.join(root,'src/shared/history-primary-metadata-rules.cjs');
 const module=await import(pathToFileURL(path.join(root,'scripts/lib/renderer-shared-cjs.mjs')).href);
 assert(module.rendererSharedCjsEntries(root).includes(filename));
 assert(module.rendererSharedCjsIds(root).includes('@noted/shared-cjs/history-primary-metadata-rules.cjs'));
 const plugin=module.rendererSharedCjsDevPlugin(root),seen=[];
 const result=await plugin.resolveId.call({async resolve(id,importer,options){seen.push({id,importer,options});return {id};}},
  '../../shared/history-primary-metadata-rules.cjs',path.join(root,'src/renderer/utils/historyPrimaryRootReadModel.mjs'),{});
 assert.equal(result.id,'@noted/shared-cjs/history-primary-metadata-rules.cjs');assert.equal(seen.length,1);
 assert.equal(seen[0].options.skipSelf,true);
 const config=require('node:fs').readFileSync(path.join(root,'electron.vite.config.js'),'utf8');
 const re=config.match(/const SHARED_CJS_RE = (\/.*\/);/);assert(re);
 const actualRegExp=new Function('return '+re[1])();
 assert(actualRegExp.test(filename.replaceAll('\\','/')));
});
test('cold validation resolves the current owner envelope after clearing old cached pages',async t=>{
 const {store}=fixture(t,[]),crypto=require('node:crypto');
 const {HistoryProjectionArena}=require('../src/main/history-root-engine/main/history-projection-arena');
 const publish=value=>{const arena=new HistoryProjectionArena(store);try{return arena.step(()=>arena.publish(value));}finally{arena.close();}};
 const good=publish([{uuid:'first',rowStub:true},{uuid:'last',rowStub:true}]);
 const bad=publish([{uuid:'first',rowStub:false},{uuid:'last',rowStub:true}]);
 const page=good.descriptor.page;
 const original=Buffer.from(JSON.stringify(store.json(page)));
 const replacement=Buffer.from(JSON.stringify(store.json(bad.descriptor.page)));
 const write=bytes=>store.db.prepare('UPDATE hp_pages SET body=?,digest=? WHERE id=?')
  .run(bytes,crypto.createHash('sha256').update(bytes).digest('hex'),page);
 try{
  assert.equal((await validateCanonicalMetadata(store,good)).kind,'validated');
  store.read(page);write(replacement);
  await assert.rejects(validateCanonicalMetadata(store,good),{code:'HISTORY_PRIMARY_ACTION_METADATA_NOT_THIN'});
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM hp_primary_metadata_work').get().n,0);
 }finally{write(original);store.cache.clear();store.cacheBytes=0;bad.release();good.release();}
});

