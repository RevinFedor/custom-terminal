'use strict';
// ONE finite Source control. The actual nested worker handler, controller,
// plane, store, read controls and client run unchanged. Only bootstrap/port,
// SQLite ABI and explicitly held checkpoint/admission boundaries are adapted.
// Run separately with NOTED_LANE_ARM=pre|post under Node22 / 80MiB / semi=2.
process.env.NOTED_HISTORY_READER_PROCESS = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const crypto = require('node:crypto'), v8 = require('node:v8');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const evidence = process.env.NOTED_LANE_EVIDENCE, arm = process.env.NOTED_LANE_ARM;
assert(evidence && path.isAbsolute(evidence)); assert(['pre','post'].includes(arm));
assert.equal(process.versions.node.split('.')[0], '22');
assert(process.execArgv.includes('--max-old-space-size=80'));
assert(process.execArgv.includes('--max-semi-space-size=2'));
const SQLite = require(process.env.NOTED_UNIT_TEST_SQLITE_ADAPTER);
const originalConsole = { ...console }, load = Module._load;
const events = [], checks = [], holds = new Map(), pending = new Map(), controls = new Set();
const started = [], finished = [], stagings = new Map();
let ctl, cache, epochs, epochReader, db, next = 0, acked = 0, stagingClosed = 0;
let scopeCalls = 0, ensures = 0, initialized = 0, saves = 0, cost = 0;
const record = (event, fields = {}) => { assert(events.length < 4000); events.push({event,...fields}); };
const check = name => checks.push(name);
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const gate = name => { const h = {entered:deferred(), exit:deferred()}; holds.set(name,h); return h; };
const sameText = (actual, expected) => {
  assert.equal(actual.length, expected.length); assert.equal(actual, expected);
  assert.equal(crypto.createHash('sha256').update(actual,'utf16le').digest('hex'),
    crypto.createHash('sha256').update(expected,'utf16le').digest('hex'));
};
function compile(filename, text) {
  const mod = new Module(filename, module); mod.filename=filename; mod.paths=Module._nodeModulePaths(path.dirname(filename));
  mod._compile(text, filename); return mod.exports;
}
const realControl = require('./history-read-control');
const dir = fs.mkdtempSync(path.join(evidence, arm+'-fixture-'));
const port = new EventEmitter();
port.postMessage = message => {
  if (message.event === 'source-epoch') queueMicrotask(() => port.emit('message', {
    event:'source-epoch',filePath:message.filePath,slot:0,
  }));
  if (message.event === 'log') {
    const text = message.text;
    if (text.startsWith('[HistoryRootBacking] ')) {
      const entry = JSON.parse(text.slice('[HistoryRootBacking] '.length));
      record('backing', {request:message.correlation?.requestId,...entry});
      if (entry.stage==='maintenance-admission' && entry.event==='begin') waitingWitness?.resolve();
    }
  }
  if (!message.event && pending.has(message.id)) {
    const p=pending.get(message.id); p.reply=message;
    record('reply',{id:message.id,tag:p.tag,error:message.error?.code});
    // A real reply-consumed ACK is a distinct event, never a dispatch tail.
    queueMicrotask(() => {
      port.emit('message',{event:'reply-consumed',id:message.id,retainCapabilities:p.retain && !message.error}); acked++;
      p.resolve(message);
    });
  }
};
let waitingWitness;
Module._load = function(id,parent,main) {
  if (id==='better-sqlite3') return SQLite;
  if (id==='./history-process-epochs' && parent?.filename.endsWith('history-read-worker.js')) {
    const actual = load.call(this,id,parent,main);
    return {...actual,openProcessEpochReader(...args) { epochReader=actual.openProcessEpochReader(...args);return epochReader; }};
  }
  if (id==='./history-read-control' && parent?.filename.endsWith('history-read-worker.js')) return {...realControl,
    createReadControl(options) {
      const control=realControl.createReadControl(options); controls.add(control); return control;
    }};
  if (id==='./history-root-controller' && parent?.filename.endsWith('history-read-worker.js')) {
    const filename=path.join(__dirname,'history-root-controller.js');
    const Actual = (arm==='pre' ? compile(filename,fs.readFileSync(path.join(evidence,'history-root-controller.js.BEFORE'),'utf8'))
      : load.call(this,id,parent,main)).HistoryRootController;
    return {HistoryRootController:class extends Actual {
      constructor(options) {
        super(options); ctl=this;cache=options.cache;
        const create=cache.createPendingPayloads;
        cache.createPendingPayloads=function(...args) {
          const c=realControl.currentReadControl(), p=create.apply(this,args);
          assert(c);assert(!stagings.has(c));stagings.set(c,p);
          const close=p.close.bind(p);p.close=()=>{stagingClosed++;close();};return p;
        };
        const save=cache.savePayloadsAsync;
        cache.savePayloadsAsync=function(...args){saves++;return save.apply(this,args);};
      }
      ensurePlane(...args){ensures++;return super.ensurePlane(...args);}
      initializeBacking(...args){initialized++;return super.initializeBacking(...args);}
      physicalScope(...args){scopeCalls++;return super.physicalScope(...args);}
      async dispatch(method,payload,options) {
        const c=options.control, p=cache.pendingPayloads();
        assert.equal(realControl.currentReadControl(),c);assert.equal(p,stagings.get(c));
        started.push(payload.tag);record('dispatch',{method,tag:payload.tag});
        const h=holds.get(payload.hold);
        if(h) {
          await c.checkpoint(); assert.equal(this.store.depth,0);assert.equal(this.store.db.inTransaction,false);
          h.entered.resolve();await h.exit.promise;c.assertCurrent();
          assert.equal(realControl.currentReadControl(),c);assert.equal(cache.pendingPayloads(),p);
        }
        const value=await super.dispatch(method,payload,options);
        if(payload.cancelAfterCreation) port.emit('message',{event:'cancel',id:next});
        assert.equal(realControl.currentReadControl(),c);assert.equal(cache.pendingPayloads(),p);
        record('dispatch-done',{method,tag:payload.tag});finished.push(payload.tag);return value;
      }
      dispatchOwned(method,payload,options) { cost++;record('owned',{method,tag:payload.tag});return super.dispatchOwned(method,payload,options); }
    }};
  }
  return load.call(this,id,parent,main);
};
function send(method,payload={}, {retain=true}={}) {
  const id=++next, d=deferred();pending.set(id,{...d,tag:payload.tag,retain});
  port.emit('message',{id,method,payload});
  return {id,promise:d.promise};
}
async function ok(method,payload={},options) {
  const response=await send(method,payload,options).promise;
  assert(!response.error,JSON.stringify(response.error)); assert.notEqual(response.result?.success,false,JSON.stringify(response.result));
  return response.result;
}
async function refused(method,payload,expected) {
  const r=await send(method,payload).promise;assert.equal(r.error?.code||r.result?.error,expected);return r;
}
const cap = (root,consumer='A') => ({...root,_historyRootConsumerKey:consumer});
const req = (node,kind='fields',consumer='A',extra={}) => ({...cap(node,consumer),kind,offset:0,limit:3,creditBytes:8192,...extra});
async function fields(node,consumer='A',extra={}) {
  const r=await ok('readHistoryRootPage',req(node,'fields',consumer,extra));
  assert.equal(r.creditBytesUsed,Buffer.byteLength(JSON.stringify(r)));assert(r.creditBytesUsed<=8192);return r;
}
async function text(node,consumer='A') {
  let value='',offset=0;
  for(let n=0;n<40;n++) {
    const r=await ok('readHistoryRootPage',req(node,'leaf',consumer,{offset,limit:700}));
    assert.equal(r.creditBytesUsed,Buffer.byteLength(JSON.stringify(r)));assert(r.creditBytesUsed<=8192);
    value+=r.text;if(r.done)return value;assert(r.nextOffset>offset);offset=r.nextOffset;
  }
  assert.fail('finite text exceeded 40 packets');
}
const cancel = request => port.emit('message',{event:'cancel',id:request.id});
async function fence() { await ok('stats',{sessionId:'fence',cwd:dir}); }
function bytesIn(root) {
  let sum=0;for(const name of fs.readdirSync(root)){const file=path.join(root,name),s=fs.lstatSync(file);assert(!s.isSymbolicLink());sum+=s.isDirectory()?bytesIn(file):s.size;}return sum;
}
const bodyA='A '+ 'x'.repeat(509)+'🙂Ω\r\n\0'+String.fromCharCode(0xd800)+' end A';
const bodyB='B '+ 'y'.repeat(1021)+'🙂Ж\r\n\0'+String.fromCharCode(0xdc00)+' end B';
const summaries={arm,substitutions:['in-process runtime/parentPort','Node22 node:sqlite adapter for better-sqlite3 ABI',
  'explicit deferred real maintenance lease and real-control checkpoints'],checks,events};
async function main() {
  // Fixture DB only; the normal existingConnection worker manager is real.
  const dbFile=path.join(dir,'fixture.sqlite');db=new SQLite(dbFile);
  db.exec(`CREATE TABLE agent_activity_intervals(id INTEGER PRIMARY KEY,start_ts,end_ts,duration_ms);
    CREATE TABLE history_response_timings(interval_id INTEGER PRIMARY KEY,tool_type,tab_id,session_id,entry_uuid,source_identity,updated_at);
    CREATE TABLE history_response_timing_aliases(interval_id,tool_type,session_id,entry_uuid,source_identity,updated_at,PRIMARY KEY(interval_id,tool_type,session_id),UNIQUE(tool_type,session_id,entry_uuid));
    CREATE TABLE history_freshness_versions(domain,provider,owner_id,version,PRIMARY KEY(domain,provider,owner_id));
    CREATE TABLE history_prompt_revision_versions(tool_type PRIMARY KEY,version);
    CREATE TABLE history_prompt_presentations(tool_type,session_id,audit_timestamp,transport_hash,entry_uuid,schema_version,chips_json,created_at,updated_at,UNIQUE(tool_type,session_id,audit_timestamp,transport_hash));
    CREATE INDEX idx_history_prompt_presentations_uuid ON history_prompt_presentations(tool_type,entry_uuid);`);
  const schema=require('./timeline-fork-presentation-version-schema');for(const t of schema.TABLES)db.exec(t.ddl);
  schema.installTimelineForkPresentationVersionSchema(db);db.close();db=null;
  const ids=[crypto.randomUUID(),crypto.randomUUID()];
  ids.forEach((id,i)=>fs.writeFileSync(path.join(dir,'rollout-'+id+'.jsonl'),[
    {type:'session_meta',payload:{id,cwd:dir}},
    {type:'event_msg',timestamp:'2026-10-25T00:00:00Z',payload:{type:'user_message',message:'finite '+i}},
    {type:'response_item',timestamp:'2026-10-25T00:00:01Z',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:i?bodyB:bodyA}]}},
  ].map(x=>JSON.stringify(x)+'\n').join('')));
  const {SLOTS}=require('./history-worker-epochs');
  const epochsArray=()=>new Int32Array(new SharedArrayBuffer(SLOTS*4));
  epochs=require('./history-process-epochs').createProcessEpochOwner({sourceEpochs:epochsArray(),sourceRewriteEpochs:epochsArray(),directory:dir});
  require('./history-read-runtime').initializeHistoryReadRuntime({parentPort:port,workerData:{
    databasePath:dbFile,cacheDirectory:path.join(dir,'cache'),diskBudgetBytes:48*1024**2,
    sessionsDir:dir,sourceEpochFile:epochs.filePath,indexBudgetBytes:256*1024,diagnosticReadPhases:true,
  }});
  const filename=path.join(__dirname,'history-read-worker.js');
  if(arm==='pre')compile(filename,fs.readFileSync(path.join(evidence,'history-read-worker.js.BEFORE'),'utf8'));
  else require(filename);
  if(arm==='post') {
    const n=ensures;for(const method of ['readHistoryRootPage','forkHistoryRootLeaf','releaseHistoryRoot','openHistoryRoot','historyInputDocument'])
      assert.equal(ctl.installedCapabilityLane(method,{}),null);
    assert.equal(ensures,n);assert.equal(ctl.plane,null);for(const operation of ['measure','resize','status','document','retain','iteration'])
      assert(ctl.allocates('readHistoryRootPage',{kind:'timeline-query',operation}));
    for(const operation of ['prepare','replace','undo','redo'])assert(ctl.allocates('historyInputDocument',{operation}));
    for(const method of ['openHistoryRoot','openHistoryPayload','forkHistoryRootLeaf'])assert(ctl.allocates(method,{}));
    assert(!ctl.allocates('readHistoryRootPage',{kind:'fields'}));assert(!ctl.allocates('releaseHistoryRoot',{}));
    check('absent-plane lookup no bootstrap; unchanged allocation classification');
  }
  const A=await ok('openHistoryRoot',{toolType:'codex',sessionId:ids[0],cwd:dir,tabId:'A',_historyRootConsumerKey:'A',readProfile:'timeline-primary-v1'});
  const B=await ok('openHistoryRoot',{toolType:'codex',sessionId:ids[1],cwd:dir,tabId:'B',_historyRootConsumerKey:'B'});
  assert.equal(ctl.plane.roots.size,2);assert.notEqual(A.revision,B.revision);
  const s=ctl.store, plane=ctl.plane;
  const materialize=require('./history-paged-store').materializeHistoryCursorSync;
  const {forkFrozenCanonical}=require('./history-frozen-canonical');
  const aState=plane.state(A,'A'),bState=plane.state(B,'B');
  const frozen=forkFrozenCanonical(s,aState.canonicalSource);
  const frozenValue=materialize(frozen.entries);
  const aEntries=plane.cursor(aState,A.root.nodeToken),bEntries=plane.cursor(bState,B.root.nodeToken);
  const allA=materialize(aEntries),allB=materialize(bEntries);
  function findText(cursor,expected,depth=0) {
    assert(depth<24);if(cursor.kind==='text')return [...cursor.textChunks()].join('')===expected?cursor:null;
    const children=cursor.kind==='array'?[...cursor.rows()]:cursor.kind==='object'?[...cursor.fields()].map(x=>x[1]):[];
    for(const c of children){const found=findText(c,expected,depth+1);if(found)return found;}return null;
  }
  const aText=findText(aEntries,bodyA),bText=findText(bEntries,bodyB);assert(aText&&bText);
  const aNode=plane.describe(aState,aText,{inline:false}),bNode=plane.describe(bState,bText,{inline:false});
  const heldLeaf=s.transaction(()=>s.lease(s.referenceForCursor(aText)));
  const aRow=plane.describe(aState,aEntries.at(0),{inline:false});
  const bRow=plane.describe(bState,bEntries.at(0),{inline:false});
  const oracle=await fields(aRow);sameText(await text(aNode),bodyA);sameText(await text(bNode,'B'),bodyB);
  const edge=await ok('readHistoryRootPage',req(aNode,'leaf','A',{limit:512}));
  assert.equal(edge.nextOffset,511);sameText(edge.text,bodyA.slice(0,511));
  await refused('readHistoryRootPage',req(aNode,'leaf','A',{offset:512,limit:16}),'HISTORY_ROOT_TEXT_RANGE');
  check('two real roots, exact fields/UTF16 seam/refusal/packet oracle and independent frozen/leaf pins');
  const before={...s.metrics}, beforeScope=scopeCalls,beforeSaves=saves;
  waitingWitness=deferred();const unlock=await ctl.maintenanceAdmission.acquire(realControl.createReadControl());
  const fork=send('forkHistoryRootLeaf',{...cap(bNode,'B'),tag:'boundary-B'});
  await waitingWitness.promise;waitingWitness=null;assert.equal(ctl.maintenanceAdmission.waiting,1);
  const read=send('readHistoryRootPage',req(aRow,'fields','A',{tag:'boundary-A'}));
  const leaf=send('readHistoryRootPage',req(aNode,'leaf','A',{tag:'boundary-leaf',limit:700}));
  const wrong=send('readHistoryRootPage',{...req(aRow),ownerKey:'wrong',tag:'boundary-wrong'});
  const wrongNode=send('readHistoryRootPage',{...req(aRow),nodeToken:'bad',tag:'boundary-token'});
  await fence();assert(!started.includes('boundary-wrong'));
  if(arm==='pre') {assert(!started.includes('boundary-A'));assert(!started.includes('boundary-leaf'));record('old-boundary-blocked');}
  else {
    const r=await read.promise;assert(!r.error);assert.deepEqual(r.result,oracle);
    sameText((await leaf.promise).result.text,bodyA);
    assert.equal(ctl.maintenanceAdmission.waiting,1);assert(!events.some(e=>e.event==='owned'&&e.tag==='boundary-B'));
    assert.deepEqual(materialize(frozen.entries),frozenValue);sameText([...heldLeaf.cursor().textChunks()].join(''),bodyA);
    assert.equal(scopeCalls,beforeScope);assert.equal(saves,beforeSaves);assert.equal(s.metrics.pagesWritten,before.pagesWritten);
    assert.equal((await wrongNode.promise).error.code,'HISTORY_ROOT_NODE_TOKEN');
    record('A-content-validated-while-B-waits');
  }
  record('maintenance-release');unlock();
  const child=(await fork.promise).result;assert(child?.success);
  assert.equal((await wrong.promise).error.code,'HISTORY_ROOT_OWNER_MISMATCH');
  assert.equal((await wrongNode.promise).error.code,'HISTORY_ROOT_NODE_TOKEN');assert.deepEqual((await read.promise).result,oracle);
  sameText((await leaf.promise).result.text,bodyA);sameText(await text(child.payloadDocument,'B'),bodyB);
  check('old/new discriminating boundary with unchanged exact content');
  // Every allocating capability must ALSO wait on the legacy null predecessor.
  waitingWitness=deferred();const unlock2=await ctl.maintenanceAdmission.acquire(realControl.createReadControl());
  const cancelB=send('forkHistoryRootLeaf',{...cap(bNode,'B'),tag:'null-first'});await waitingWitness.promise;waitingWitness=null;
  const cancelA=send('forkHistoryRootLeaf',{...cap(aNode),tag:'null-second'});
  await fence();assert(!started.includes('null-second'));assert.equal(ctl.maintenanceAdmission.waiting,1);
  cancel(cancelB);assert.equal((await cancelB.promise).error.code,'HISTORY_READ_CONSUMER_REVOKED');
  waitingWitness=deferred(); // second may already reach gate; use dispatch event + bounded event-turn fence
  await fence();waitingWitness=null;assert.equal(ctl.maintenanceAdmission.waiting,1);
  cancel(cancelA);assert.equal((await cancelA.promise).error.code,'HISTORY_READ_CONSUMER_REVOKED');
  assert.equal(ctl.maintenanceAdmission.waiting,0);unlock2();
  assert.equal(plane.roots.size,3);check('allocator old null edge; cancelled waiters detach before cost; failed predecessor continues');
  const waitingRead=gate('allocator-lease');
  const ar=send('readHistoryRootPage',req(aRow,'fields','A',{hold:'allocator-lease',tag:'allocator-read'}));
  await waitingRead.entered.promise;
  const aa=send('forkHistoryRootLeaf',{...cap(aNode),tag:'allocator-A'});
  const ab=send('forkHistoryRootLeaf',{...cap(bNode,'B'),tag:'allocator-B'});
  await fence();assert(!started.includes('allocator-A'));assert(!started.includes('allocator-B'));
  waitingRead.exit.resolve();assert(!(await ar.promise).error);
  const aaCap=(await aa.promise).result, abCap=(await ab.promise).result;assert(aaCap.success&&abCap.success);
  assert(events.findIndex(e=>e.event==='owned'&&e.tag==='allocator-A')<events.findIndex(e=>e.event==='owned'&&e.tag==='allocator-B'));
  sameText(await text(aaCap.payloadDocument),bodyA);sameText(await text(abCap.payloadDocument,'B'),bodyB);
  await ok('releaseHistoryRoot',cap(aaCap));await ok('releaseHistoryRoot',cap(abCap,'B'));
  assert.equal(plane.roots.size,3);check('allocator joins lease AND old null edge before admission; cross-parent allocator arrival order retained');
  // Capture both predecessors: source edge across independent roots and lease
  // edge across explicit/no-source calls. Old completion must not clear a new tail.
  const h=gate('mixed');
  const r1=send('readHistoryRootPage',req(aRow,'fields','A',{sessionId:'shared',cwd:dir,hold:'mixed',tag:'mixed-first'}));
  await h.entered.promise;
  const h2=gate('mixed-second');
  const r2=send('readHistoryRootPage',req(bRow,'fields','B',{sessionId:'shared',cwd:dir,tag:'mixed-source',hold:'mixed-second'}));
  const r3=send('readHistoryRootPage',req(aRow,'fields','A',{tag:'mixed-lease'}));
  await fence();assert(!started.includes('mixed-source'));
  assert.equal(started.includes('mixed-lease'),arm==='pre');
  h.exit.resolve();await h2.entered.promise;assert(!(await r1.promise).error);
  const r4=send('readHistoryRootPage',req(aRow,'fields','A',{sessionId:'shared',cwd:dir,tag:'mixed-new-tail'}));
  await fence();assert(!started.includes('mixed-new-tail'));h2.exit.resolve();
  for(const r of [r2,r3,r4])assert(!(await r.promise).error);
  assert(events.findIndex(e=>e.event==='dispatch-done'&&e.tag==='mixed-first')<events.findIndex(e=>e.event==='dispatch'&&e.tag==='mixed-source'));
  check('explicit source+lease joins and request-local ALS/staging across yields');
  // Bad auth stays on exact old key; no routing I/O or new state. Dispatch
  // still emits exactly the same refusal as its direct real controller call.
  const bads=[['consumer',req(aRow,'fields','wrong'),'HISTORY_ROOT_OWNER_MISMATCH'],
    ['owner',{...req(aRow),ownerKey:'wrong'},'HISTORY_ROOT_OWNER_MISMATCH'],
    ['revision',{...req(aRow),revision:'wrong'},'HISTORY_ROOT_OWNER_MISMATCH'],
    ['generation',{...req(aRow),generation:'retired'},'HISTORY_ROOT_OWNER_MISMATCH'],
    ['absent',{...req(aRow),leaseId:'not-installed'},'HISTORY_ROOT_RELEASED'],
    ['node',{...req(aRow),nodeToken:'bad'},'HISTORY_ROOT_NODE_TOKEN'],
    ['missing-consumer',{...req(aRow),_historyRootConsumerKey:undefined},'HISTORY_ROOT_CONSUMER']];
  for(const [name,p,expected] of bads) {
    if(arm==='post') {
      const counts=[ensures,initialized,scopeCalls,plane.roots.size,cost];
      const lane=ctl.installedCapabilityLane('readHistoryRootPage',p);
      assert.equal(lane===null,name!=='node');assert.deepEqual([ensures,initialized,scopeCalls,plane.roots.size,cost],counts);
    }
    let direct;const directControl=realControl.createReadControl();
    try{await realControl.withReadControl(directControl,()=>ctl.dispatchOwned('readHistoryRootPage',p,{control:directControl}));}
    catch(e){direct=e.code;}finally{directControl.finish();}
    assert.equal(direct,expected);await refused('readHistoryRootPage',p,expected);
  }
  check('wrong/absent consumer owner revision generation lease token exact typed refusal; lookup zero cost');
  // Same-lease FIFO/release, including requests captured while parent is live.
  const order=gate('same');const first=send('readHistoryRootPage',req(bRow,'fields','B',{hold:'same',tag:'same-1'}));
  await order.entered.promise;
  const second=send('readHistoryRootPage',req(bRow,'fields','B',{tag:'same-2'}));
  const release=send('releaseHistoryRoot',{...cap(B,'B'),tag:'same-release'});
  const late=send('readHistoryRootPage',req(bRow,'fields','B',{tag:'same-late'}));
  await fence();assert(!started.includes('same-2'));assert(!started.includes('same-release'));order.exit.resolve();
  for(const r of [first,second,release])assert(!(await r.promise).error);
  assert.equal((await late.promise).error.code,'HISTORY_ROOT_RELEASED');
  if(arm==='post')assert.equal(ctl.installedCapabilityLane('readHistoryRootPage',cap(B,'B')),null);
  sameText(await text(child.payloadDocument,'B'),bodyB);assert.equal(plane.roots.size,2);
  check('read1 read2 release queued-late typed refusal; independent child survives parent release');
  // No-consumption cleanup and late exact result release cannot drop parents.
  const abandoned=await ok('forkHistoryRootLeaf',{...cap(aNode),tag:'unretained'},{retain:false});
  await turn();assert(!plane.roots.has(abandoned.leaseId));assert(plane.roots.has(A.leaseId));
  const discarded=await ok('forkHistoryRootLeaf',{...cap(aNode),tag:'discarded'});
  port.emit('message',{event:'release-root-result',consumerKey:'A',capability:{kind:'root',...discarded}});
  port.emit('message',{event:'release-root-result',consumerKey:'A',capability:{kind:'root',...discarded}});
  assert(!plane.roots.has(discarded.leaseId));assert(plane.roots.has(A.leaseId));
  const rejected=send('forkHistoryRootLeaf',{...cap(aNode),tag:'created-then-revoked',cancelAfterCreation:true});
  assert.equal((await rejected.promise).error.code,'HISTORY_READ_CONSUMER_REVOKED');await turn();assert.equal(plane.roots.size,2);
  check('reply-consumed false, result revoked after creation, late exact cleanup; unrelated pins survive');
  const capLimit=plane.maxRoots;plane.maxRoots=plane.roots.size;
  await refused('forkHistoryRootLeaf',cap(aNode),'HISTORY_ROOT_LEASE_LIMIT');plane.maxRoots=capLimit;
  check('unchanged root-cap typed refusal');
  // Real finite pressure and SQL transaction boundaries on this fixture only.
  const builder=s.beginBuild();assert(s.collectStep(1).blockedByBuilders);builder();
  s.collectStep(1);const extraPin=heldLeaf.fork();
  assert.equal(s.sql("SELECT value FROM hp_meta WHERE key='gc_phase'").get().value,0);extraPin.release();
  const sqlBudget=s.db.pragma('max_page_count',{simple:true});
  const pageCount=s.db.pragma('page_count',{simple:true});
  s.db.pragma('max_page_count = '+pageCount);
  plane.retainGroupDocument(aState,heldLeaf,{rank:0,headerIdentity:'finite',encoding:'finite',bytes:bodyA.length*2});
  assert.equal(aState.groupDocuments.length,1);
  let pressureError;const pressureControl=realControl.createReadControl();
  try {await ctl.makeRoom('readHistoryRootPage',{kind:'timeline-query',operation:'measure'},pressureControl);}
  catch(e){pressureError=e;}finally{pressureControl.finish();}
  assert.equal(pressureError?.errcode,13);record('finite-pressure-quota-refusal',{code:pressureError.code,errcode:pressureError.errcode});
  assert.equal(aState.groupDocuments.length,0);
  // Exact-cap pressure has no headroom for GC metadata. Keep that refusal;
  // separately prove existing LRU eviction under the restored fixture budget.
  s.db.pragma('max_page_count = '+sqlBudget);assert(ctl.evictOldest());await ctl.collect();
  s.db.pragma('max_page_count = '+s.db.pragma('page_count',{simple:true}));
  const quotaControl=s.diskBudget;s.diskBudget=s.diskUsage()-1;
  assert.throws(()=>s.transaction(()=>s.put({kind:'scalar-root',value:'quota'})),e=>e.code==='HISTORY_BACKING_FULL');
  s.diskBudget=quotaControl;
  s.db.exec('CREATE TABLE finite_quota_probe(body BLOB)');
  assert.throws(()=>s.db.transaction(()=>{const put=s.db.prepare('INSERT INTO finite_quota_probe VALUES (?)');
    for(let i=0;i<256;i++)put.run(Buffer.alloc(8192));})(),e=>e.errcode===13||e.code==='SQLITE_FULL');
  s.db.exec('DROP TABLE finite_quota_probe');s.db.pragma('max_page_count = '+sqlBudget);
  sameText(await text(aNode),bodyA);assert.deepEqual(materialize(frozen.entries),frozenValue);
  check('finite exact-cap pressure: memo drop then SQL FULL refusal; separate restored-budget owner eviction, builder exclusion, mark restart and disk refusal; frozen content survives');
  // The real shared client rejects a built packet delivered after local close.
  const {HistoryRootClient}=await import(pathToFileURL(path.resolve(__dirname,'../../../shared/history-root-read-client.mjs')).href);
  const lateCap=await ok('forkHistoryRootLeaf',cap(aNode));
  const deliver=deferred(),built=deferred();let closeCalls=0;
  const client=new HistoryRootClient(async(channel,payload)=>{
    if(channel==='history:release-root'){closeCalls++;return ok('releaseHistoryRoot',{...payload,_historyRootConsumerKey:'A'});}
    const result=await ok('readHistoryRootPage',{...payload,_historyRootConsumerKey:'A'});
    built.resolve();await deliver.promise;return result;
  },lateCap.payloadDocument,{pageBytes:8192,pageItems:3,releaseChannel:'history:release-root'});
  const pulled=client.page(lateCap.payloadDocument,'leaf',{limit:700}).then(()=>assert.fail('late packet applied'),e=>assert.equal(e.code,'HISTORY_READ_CANCELLED'));
  await built.promise;await client.close();assert(!plane.roots.has(lateCap.leaseId));
  deliver.resolve();await pulled;assert.equal(closeCalls,1);assert(client.closed);
  check('actual shared client rejects already-built late packet after close');
  // Revocation at a real-control checkpoint before any read cost. Retirement
  // bypasses RPC queues as in production, then normal dispatch reauthenticates.
  const revoke=gate('revoke');const c0=cost;
  const revoked=send('readHistoryRootPage',req(child.payloadDocument,'leaf','B',{hold:'revoke',tag:'revoke'}));
  await revoke.entered.promise;port.emit('message',{event:'release-root-consumer',consumerKey:'B'});revoke.exit.resolve();
  assert.equal((await revoked.promise).error.code,'HISTORY_ROOT_RELEASED');assert.equal(cost,c0+1);
  const cancelGate=gate('cancel');const cancellation=send('readHistoryRootPage',req(aRow,'fields','A',{hold:'cancel',tag:'cancel-read'}));
  await cancelGate.entered.promise;const c1=cost;cancel(cancellation);cancelGate.exit.resolve();
  assert.equal((await cancellation.promise).error.code,'HISTORY_READ_CONSUMER_REVOKED');assert.equal(cost,c1);
  sameText(await text(aNode),bodyA);check('consumer retirement and cancellation at checkpoint; unrelated A preserved');
  await ok('releaseHistoryRoot',cap(A));
  assert.equal(plane.roots.size,0);await ctl.collect();
  assert.deepEqual(materialize(frozen.entries),frozenValue);sameText([...heldLeaf.cursor().textChunks()].join(''),bodyA);
  assert(allA.length>0);assert(allB.length>0);
  frozen.release();heldLeaf.release();await ctl.collect();
  check('frozen old container and independent leaf survive parent retirement plus real bounded GC');
  await turn();await turn();
  const stats=s.stats();assert.equal(s.metrics.leases,0);assert.equal(s.db.prepare('SELECT count(*) AS n FROM hp_pins WHERE durable=0').get().n,0);
  for(const c of controls)assert.throws(()=>c.assertCurrent(),e=>e.code==='HISTORY_READ_CONSUMER_REVOKED');
  assert.equal(saves,0);assert.equal(stagingClosed,stagings.size);assert.equal(acked,next);
  summaries.counters={requests:next,acked,controls:controls.size,stagingClosed,stagings:stagings.size,payloadSaves:saves,
    publicRoots:plane.roots.size,transientPins:0,leases:stats.leases,scopeCalls,bytesOnDisk:bytesIn(dir),store:stats};
  assert(summaries.counters.bytesOnDisk<64*1024**2);assert.equal(ctl.maintenanceAdmission.waiting,0);
  check('all request controls/staging settled; zero public roots/transient pins/leases; fixture below 64MiB');
}
// Failure bound only, never an ordering or success oracle.
const failureBound=deferred();
const deadline=setTimeout(()=>failureBound.reject(Error('finite control deadline')),30000);
(async()=>{
  let failure;
  try{await Promise.race([main(),failureBound.promise]);summaries.outcome='PASS';}
  catch(error){failure=error;summaries.outcome='FAIL';summaries.error={message:error.message,stack:error.stack};}
  finally{
    clearTimeout(deadline);
    try{ctl?.close();cache?.clearMemory();epochReader?.close();epochs?.disposeAfterExit();db?.close();}catch(error){failure ||= error;}
    Module._load=load;Object.assign(console,originalConsole);
    summaries.fixtureBytes=fs.existsSync(dir)?bytesIn(dir):0;
    fs.rmSync(dir,{recursive:true});summaries.cleanup={fixtureRemoved:!fs.existsSync(dir)};
    const out=path.join(evidence,arm+'-'+crypto.randomUUID()+'.json');fs.writeFileSync(out,JSON.stringify(summaries,null,2));
    console.log(JSON.stringify({arm,outcome:summaries.outcome,evidence:out,checks:checks.length,counters:summaries.counters,cleanup:summaries.cleanup}));
  }
  if(failure){console.error(failure);process.exitCode=1;}
})();
