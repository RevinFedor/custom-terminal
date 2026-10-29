'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const os=require('node:os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'noted-root-cache-budget-'));
const Database=require('./test-support/history-node-sqlite.cjs');
const main=name=>require('../src/main/history-root-engine/main/'+name);
test.after(()=>{if(fs.existsSync(root)&&fs.readdirSync(root).length===0)fs.rmdirSync(root);});
const policy=require('../src/main/history-root-engine/main/history-root-cache-budget');
const {HistoryRootController}=main('history-root-controller');
const {HistoryPreparedCache}=main('history-prepared-cache');
const {HistoryPagedStore,materializeHistoryCursorSync:materialize,historyPagedCursorAddress}=main('history-paged-store');
const {validateCanonicalMetadata,validatePreparedMetadata}=main('history-primary-metadata-validation');
const MiB=1024**2;

test('bounded share is carved out of existing indexes, with no tiny/zero/default widening',()=>{
  for(const total of [0,1,1023,1024,4095,4096,32768,65536,131072,262144,8*MiB,32*MiB,Number.MAX_SAFE_INTEGER]){
    const p=policy.splitHistoryRootCacheBudget(total);
    assert.equal(p.preparedIndexBudgetBytes+p.rawPageReservationBytes+p.sqliteCacheTargetBytes,total);
    assert(p.rootReservationBytes<=Math.floor(total/8));assert(p.rootReservationBytes<=4*MiB);
    assert(p.storeOptions.residentPages<=128);assert.equal(p.storeOptions.pageBytes,1024);
    assert.equal(p.sqliteCacheTargetBytes,2*p.storeOptions.sqlCacheKiB*1024);
  }
  const normal=policy.splitHistoryRootCacheBudget(32*MiB);
  assert.deepEqual(normal.storeOptions,{pageBytes:1024,indexBytes:128*1024,residentPages:128,sqlCacheKiB:1024});
  assert.equal(normal.preparedIndexBudgetBytes,28*MiB);
  const zero=policy.splitHistoryRootCacheBudget(0);
  assert.equal(zero.rootReservationBytes,0);assert.equal(zero.storeOptions.sqlCacheKiB,0);
  for(const invalid of [undefined,null,NaN,Infinity,-1,1.5,'33554432'])assert.throws(()=>policy.splitHistoryRootCacheBudget(invalid),{code:'HISTORY_ROOT_MEMORY_BUDGET'});
});

test('reservation sheds already retained excess before allowing a Root and preserves failure identity',()=>{
  let clears=0;
  const cache={indexMemoryBudget:32*MiB,indexMemoryBytes:31*MiB,clearMemory(){clears++;this.indexMemoryBytes=0;}};
  const p=policy.reserveHistoryRootCacheBudget(cache);
  assert.equal(clears,1);assert.equal(cache.indexMemoryBudget,28*MiB);
  assert.equal(policy.historyRootCacheMemory(cache,null,p).accountedIndexMemoryBytes,0);
  const original=Object.assign(Error('owned cache failure'),{code:'OWN_CLEAR_FAILURE'});
  assert.throws(()=>policy.reserveHistoryRootCacheBudget({indexMemoryBudget:32*MiB,indexMemoryBytes:32*MiB,clearMemory(){throw original;}}),e=>e===original);
});

function fixture(t,indexBudgetBytes,inject=false){
  const dir=fs.mkdtempSync(path.join(root,'test-private-'));
  const cache=new HistoryPreparedCache({directory:dir,maxBytes:28*MiB,indexBudgetBytes,schema:'finite'});
  const injected=inject?new HistoryPagedStore({filename:path.join(dir,'injected.sqlite'),Database,
    pageBytes:1024,indexBytes:2048,residentPages:3,sqlCacheKiB:8,diskBytes:28*MiB}):null;
  const ctl=new HistoryRootController({cache,service:{},Database,store:injected,rootDiskBudgetBytes:28*MiB,
    api:{projectCodexFullHistoryFromFile(){throw Error('unexpected source read');}}});
  ctl.ensurePlane();const store=ctl.store;
  t.after(()=>{
    assert.equal(store.stats().leases,0);assert.equal(store.stats().activeBuilders,0);
    assert.equal(store.db.prepare('SELECT count(*) n FROM hp_pins').get().n,0);
    ctl.close();if(injected)injected.close();cache.clearMemory();fs.rmSync(dir,{recursive:true});
  });
  return {cache,ctl,store};
}

test('actual owned production zero and small budgets retain exact data with DELETE/FULL',async t=>{
  for(const budget of [0,1,65536,262144])await t.test(String(budget),st=>{
    const {cache,ctl,store}=fixture(st,budget);
    const p=ctl.cacheMemoryPlan;
    assert.equal(store.db.pragma('cache_size',{simple:true}),-p.storeOptions.sqlCacheKiB||0);
    assert.equal(store.db.pragma('temp.cache_size',{simple:true}),-p.storeOptions.sqlCacheKiB||0);
    assert.equal(store.db.pragma('journal_mode',{simple:true}),'delete');assert.equal(store.db.pragma('synchronous',{simple:true}),2);
    const input=['full\ud800\0😀'.repeat(200)],lease=store.captureLegacy(input);
    try{assert.deepEqual(materialize(lease.cursor()),input);assert(ctl.cacheMemoryStats().accountedIndexMemoryBytes<=budget);}
    finally{lease.release();}
    assert.equal(cache.indexMemoryBudget,p.preparedIndexBudgetBytes);
  });
});

test('injected adversarial store keeps 3 pages / 2 KiB / 8 KiB and its prepared allowance',t=>{
  const {cache,ctl,store}=fixture(t,32*MiB,true);
  assert.equal(store.residentPages,3);assert.equal(store.indexBytes,2048);
  assert.equal(store.db.pragma('cache_size',{simple:true}),-8);assert.equal(store.db.pragma('temp.cache_size',{simple:true}),-8);
  assert.equal(cache.indexMemoryBudget,32*MiB);assert.equal(ctl.cacheMemoryStats().status,'unknown');
});

test('larger bounded cache still cold-checks corruption and preserves cancellation and lease release',async t=>{
  const {ctl,store}=fixture(t,32*MiB);
  // Finite scalar frontier deliberately reaches the validator's existing
  // 64-work checkpoint, so the cancellation test actually crosses an await.
  const lease=store.captureLegacy([{uuid:'u',rowStub:true,questionReplyProof:{text:'full\ud800\0😀'.repeat(200),
    cancellationBoundary:Array.from({length:64},(_,i)=>i)}}]);
  try{
    const nc=await validateCanonicalMetadata(store,lease),np=await validatePreparedMetadata(store,lease);
    assert.equal(nc.canonicalEntryCount,1);assert.equal(np.preparedEntryCount,1);
    const cursor=lease.cursor().at(0).field('questionReplyProof').field('text');
    const meta=store.json(historyPagedCursorAddress(cursor).ref.id),id=store.vectorGet(meta.chunks,0);
    const old=store.db.prepare('SELECT body,digest FROM hp_pages WHERE id=?').get(id),body=Buffer.from(old.body);body[0]^=1;
    store.db.prepare('UPDATE hp_pages SET body=?,digest=? WHERE id=?').run(body,createHash('sha256').update(body).digest('hex'),id);
    try{await assert.rejects(validatePreparedMetadata(store,lease),error=>/digest|corrupt/i.test(error.message));}
    finally{store.db.prepare('UPDATE hp_pages SET body=?,digest=? WHERE id=?').run(old.body,old.digest,id);store.cache.clear();store.cacheBytes=0;}
    const original=Object.assign(Error('owned cancellation'),{code:'HISTORY_READ_CANCELLED'});
    let cancelled=false;
    await assert.rejects(validatePreparedMetadata(store,lease,{control:{assertCurrent(){if(cancelled)throw original;},
      async checkpoint(){assert.equal(store.db.inTransaction,false);cancelled=true;throw original;}}}),e=>e===original);
    assert.equal(cancelled,true,'actual checkpoint was reached');
    assert.equal(store.db.prepare('SELECT count(*) n FROM hp_primary_metadata_work').get().n,0);
    assert.equal((await validatePreparedMetadata(store,lease)).preparedEntryCount,1);
    assert(ctl.cacheMemoryStats().accountedIndexMemoryBytes<=32*MiB);
  }finally{lease.release();}
  assert.throws(()=>lease.cursor());
});

test('zero-cache configuration and reporting preserve explicit errors/unknown instead of claiming zero',()=>{
  const p=policy.splitHistoryRootCacheBudget(0),original=Object.assign(Error('pragma failure'),{code:'SQLITE_IOERR'});
  assert.throws(()=>policy.configureHistoryRootZeroCache({db:{pragma(){throw original;}}},p),e=>e===original);
  assert.equal(policy.historyRootCacheMemory({},null,null).accountedIndexMemoryBytes,null);
  assert.throws(()=>policy.historyRootCacheMemory({indexMemoryBytes:1},null,p),{code:'HISTORY_ROOT_MEMORY_BUDGET'});
});
