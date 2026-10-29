'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fixture, user, answer, call, output, legacyRows, hashRoot, smallText, api } = require('./test-helpers/codex-root-fixture.cjs');
const { MARKER, pieces, quotedPiece, substituted, writer, expected, fieldDigest, expectedField,
  observeInterval, assertBounded } = require('./test-helpers/codex-ingest-fixture.cjs');
const { HistoryPagedStore } = require('./history-paged-store');
const { HistoryProjectionArena } = require('./history-projection-arena');
const { CodexRootProjectionOwner } = require('./codex-root-projection-owner');
const { frozenSourceBytes } = require('./codex-root-jsonl');
const { encodeHistoryStream } = require('./history-stream-codec');
const { HistoryByteSender, HistoryByteReceiver } = require('./history-byte-stream');
const { createJsonNumber } = require('./history-json-number');
const time = '2026-10-22T00:00:00Z';
const custom = input => ({ type: 'response_item', timestamp: time,
  payload: { type: 'custom_tool_call', name: 'inspect_payload', call_id: 'n', input } });
const addRaw = (file, iterable) => { for (const piece of iterable) fs.appendFileSync(file, piece); };
function* repeat(value, count) { while(count--) yield value; }
function rawOracle(rows, marker, body) {
  const wire=JSON.stringify(rows), at=wire.indexOf(marker), h=crypto.createHash('sha256');
  assert.ok(at>=0);let bytes=0;
  const put=value=>{h.update(value);bytes+=Buffer.byteLength(value);};
  put(wire.slice(0,at));for(const part of body())put(part);put(wire.slice(at+marker.length));
  const ids=crypto.createHash('sha256');rows.forEach((row,index)=>ids.update(index+':'+row.uuid+'\n'));
  return {hash:h.digest('hex'),bytes,rows:rows.length,ids:ids.digest('hex')};
}

test('numeric conversion: exact binary64 ties, overflow, -0 and long exponent cancellation', t => {
  const vectors=['0','-0','1.0','-0.000','1e309','-1e309','1e-400','-1e-400',
    '9007199254740993','1.00000000000000011102230246251565404236316680908203125',
    '1.7976931348623157e308','1.7976931348623159e308','2.4703282292062327e-324','2.4703282292062328e-324'];
  const midpoint=(5n**1075n).toString();
  vectors.push('0.'+'0'.repeat(1075-midpoint.length)+midpoint);
  vectors.push(vectors.at(-1)+'0'.repeat(1800)+'1');
  // Finite differential checks cover random magnitudes without a giant oracle.
  let seed=0x730219;
  for(let i=0;i<400;i++){
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    vectors.push((seed&1?'-':'')+String(seed)+'.'+String((seed^0x7fffffff)>>>0)+'e'+String(seed%700-350));
  }
  for(const value of vectors){
    const parser=createJsonNumber();for(let at=0;at<value.length;at+=7)parser.write(value.slice(at,at+7));
    assert.ok(Object.is(parser.finish(),JSON.parse(value)),value);
    assert.ok(parser.stats().retainedSignificantChars<=800);
  }
  t.diagnostic(JSON.stringify({finiteVectors:vectors.length,midpointDigits:midpoint.length}));
});

for(const [name,prefix,unit,count,suffix,result] of [
  ['integer-cancel','1','0',262144,'e-262144',1],
  ['fraction-cancel','0.','0',262144,'5e262145',5],
  ['halfway-even','1.00000000000000011102230246251565404236316680908203125','0',16384,'',1],
  ['after-halfway','1.00000000000000011102230246251565404236316680908203125','0',16384,'1',1+Number.EPSILON],
  ['negative-underflow','-1e-','9',16384,'',-0],
  ['overflow','1e','9',16384,'',Infinity],
])test(`actual numeric token ${name}: bounded conversion and exact scalar/full wire`,async t=>{
  const f=fixture(t,{indexBytes:0}),u=f.append(user('numeric owner'));
  const record=custom({n:MARKER}),located={...record,__line:f.line,__byteOffset:f.offset};
  const wire=JSON.stringify(record),quoted=JSON.stringify(MARKER),at=wire.indexOf(quoted);
  addRaw(f.filePath,(function*(){yield wire.slice(0,at);yield prefix;
    for(let left=count;left>0;left-=32)yield unit.repeat(Math.min(left,32));
    yield suffix;yield wire.slice(at+quoted.length)+'\n';})());
  located.payload={...record.payload,input:{n:result}};
  const oracle=expected(legacyRows(f.sessionId,[u,located]),0);
  const interval=await observeInterval(0,async hooks=>{
    const read=await f.read(hooks);
    try{
      assert.ok(Object.is(read.entries.at(1).field('actions').at(0).field('rawTool').field('args').field('n').scalar(),result));
      assert.deepEqual(await hashRoot(read),oracle);
      return read.readMetrics;
    }finally{read.release();}
  });
  assertBounded(interval);assert.ok(interval.value.maxNumericTokenChars>=count);
  t.diagnostic(JSON.stringify({name,...interval}));
});

for(const depth of [8,128,512])test(`actual depth ${depth}: parser AND codec ancestry on backing, no recursive AST`,async t=>{
  const f=fixture(t,{indexBytes:0}),u=f.append(user('depth'));
  const record=custom({nest:MARKER}),located={...record,__line:f.line,__byteOffset:f.offset};
  const wire=JSON.stringify(record),marker=JSON.stringify(MARKER),at=wire.indexOf(marker);
  const body=function*(){yield* repeat('[',depth);yield '1';yield* repeat(']',depth);};
  addRaw(f.filePath,(function*(){yield wire.slice(0,at);yield* body();yield wire.slice(at+marker.length)+'\n';})());
  const oracle=rawOracle(legacyRows(f.sessionId,[u,located]),marker,body),codec={};
  const interval=await observeInterval(0,async hooks=>{
    const read=await f.read(hooks);
    try{
      assert.deepEqual(await hashRoot(read),oracle);
      let cursor=read.entries.at(1).field('actions').at(0).field('rawTool').field('args').field('nest');
      for(let i=0;i<depth;i++)cursor=cursor.at(0);
      assert.equal(cursor.scalar(),1);
      const h=crypto.createHash('sha256');
      for await(const frame of encodeHistoryStream(read.entries,{frameBytes:1024,stats:codec}))h.update(frame);
      assert.equal(h.digest('hex'),oracle.hash);
      return read.readMetrics;
    }finally{read.release();}
  });
  assertBounded(interval);assert.ok(interval.max.maxParserFrames>=depth);
  assert.ok(codec.maxDepth>=depth);assert.equal(codec.maxResidentTraversalFrames,1);
  assert.equal(f.store.stats().activeBuilders,0);
  t.diagnostic(JSON.stringify({depth,codec,oracle,...interval}));
});

for(const chars of [1024,16384,262144])test(`actual long key ${chars}, duplicate keys/numeric enumeration/forced digest collision`,async t=>{
  const collision=()=>({update(){return this;},digest(){return 'f'.repeat(64);}});
  const f=fixture(t,{store:{textDigestFactory:collision},indexBytes:2048}),u=f.append(user('keys'));
  const input={z:1,'2':2,'1':1,[MARKER]:'old','__proto__':null};
  Object.defineProperty(input,'__proto__',{value:{safe:true},enumerable:true});
  const record=custom(input),located={...record,__line:f.line,__byteOffset:f.offset};
  // Duplicate the long property at the end; JSON.parse keeps its first ordinal.
  const wire=JSON.stringify(record),tail=wire.lastIndexOf('}}}');
  assert.ok(tail>0);
  const raw=wire.slice(0,tail)+',"'+MARKER+'":"new"'+wire.slice(tail);
  addRaw(f.filePath,substituted(raw,chars,{pattern:'k'}));fs.appendFileSync(f.filePath,'\n');
  input[MARKER]='new';
  const oracle=expected(legacyRows(f.sessionId,[u,located]),chars,{pattern:'k'});
  const interval=await observeInterval(2048,async hooks=>{
    const read=await f.read(hooks);
    try{
      assert.deepEqual(await hashRoot(read),oracle);
      let seen=0;for(const [key,value] of read.entries.at(1).field('actions').at(0).field('rawTool').field('args').fields()){
        if(key.length===chars){assert.deepEqual(fieldDigest(key),expectedField(chars,'k'));assert.equal(smallText(value),'new');seen++;}
      }
      assert.equal(seen,1);return read.readMetrics;
    }finally{read.release();}
  });
  assertBounded(interval);t.diagnostic(JSON.stringify({chars,oracle,...interval}));
});

test('actual wide arguments and MCP prefix overlay copy only paged references',async t=>{
  const f=fixture(t,{indexBytes:0}),u=f.append(user('width')),count=160;
  const record={type:'response_item',timestamp:time,payload:{type:'custom_tool_call',name:'mcp__fixture__inspect',call_id:'wide',input:{data:MARKER}}};
  const located={...record,__line:f.line,__byteOffset:f.offset};
  const wire=JSON.stringify(record),marker='"data":'+JSON.stringify(MARKER),at=wire.indexOf(marker);
  function* fields(){for(let i=0;i<count;i++){if(i)yield ',';yield '"k'+i+'":'+i;}yield ',"summary":"provider summary"';}
  addRaw(f.filePath,(function*(){yield wire.slice(0,at);yield* fields();yield wire.slice(at+marker.length)+'\n';})());
  // A constant small semantic oracle locates the output body; its large
  // property sequence is hashed from ordinal arithmetic, never an object.
  const rows=legacyRows(f.sessionId,[u,located]);
  const arg=rows[1].actions[0].rawTool.args;
  delete arg.data;arg.summary='provider summary';arg[MARKER]=1;
  const body=function*(){yield '"summary":"provider summary",';for(let i=0;i<count;i++){if(i)yield ',';yield '"k'+i+'":'+i;}};
  const oracle=rawOracle(rows,'"summary":"provider summary",'+JSON.stringify(MARKER)+':1',body);
  const interval=await observeInterval(0,async hooks=>{
    const read=await f.read(hooks);try{assert.deepEqual(await hashRoot(read),oracle);return read.rootStats;}finally{read.release();}
  });
  assertBounded(interval);assert.ok(interval.max.maxOwnKeyArray<40);t.diagnostic(JSON.stringify({count,oracle,...interval}));
});

test('actual 256Ki provider call/turn IDs retain exact pending match and complete derived tool identity',async t=>{
  const f=fixture(t,{indexBytes:0}),write=writer(f.filePath,f.line),chars=262144;
  const u=write.record(user('long id'));
  const record=call(MARKER);record.payload.turn_id=MARKER;
  const c=write.record(record,chars,{pattern:'i'}),o=write.record(output(MARKER,'exact result'),chars,{pattern:'i'});
  const oracle=expected(legacyRows(f.sessionId,[u,c,o]),chars,{pattern:'i'});
  const interval=await observeInterval(0,async hooks=>{
    const read=await f.read(hooks);try{
      assert.deepEqual(await hashRoot(read),oracle);
      const id=read.entries.at(1).field('actions').at(0).field('rawTool').field('toolUseId');
      assert.equal(id.length,chars+':canonical:0'.length);
      let count=0;for(const _ of read.checkpoint.cursor().field('pendingCalls').pairs())count++;
      assert.equal(count,0);return read.readMetrics;
    }finally{read.release();}
  });
  assertBounded(interval);t.diagnostic(JSON.stringify({chars,oracle,...interval}));
});

test('huge single line partial tail survives restart, UTF8/escape split, and frozen in-place rewrite',async t=>{
  const f=fixture(t,{indexBytes:0}),u=f.append(user('partial')),chars=262144;
  const record=answer(MARKER+'😀\ud800'),located={...record,__line:f.line,__byteOffset:f.offset};
  const template=JSON.stringify(answer(MARKER)),at=template.indexOf(MARKER),suffix=template.slice(at+MARKER.length);
  addRaw(f.filePath,(function*(){yield template.slice(0,at);for(const part of pieces(chars))yield quotedPiece(part);})());
  const emoji=Buffer.from('😀');fs.appendFileSync(f.filePath,emoji.subarray(0,2));
  const before=await f.read();
  assert.equal(before.entries.length,1);assert.ok(before.checkpoint.cursor().field('file').field('partial').field('toByte').scalar()>262144);
  const firstBytes=fs.statSync(f.filePath).size;before.release();f.owner.close();f.store.close();
  const store=new HistoryPagedStore({filename:path.join(f.dir,'pages.sqlite'),indexBytes:0,residentPages:3,pageBytes:1024});
  const owner=new CodexRootProjectionOwner(store,{checkpointEvery:2});
  const read=options=>api.projectCodexFullHistoryFromFile(f.sessionId,f.dir,{rootedOwner:owner,sessionsDir:f.dir,highWaterMark:64,...options});
  try{
    fs.appendFileSync(f.filePath,emoji.subarray(2));fs.appendFileSync(f.filePath,'\\uD8');
    const partial=await read();try{assert.equal(partial.fedRecords,0);assert.equal(partial.entries.length,1);assert.ok(partial.readMetrics.replayedPartialBytes>262144);}finally{partial.release();}
    fs.appendFileSync(f.filePath,'00'+suffix);
    const uncommitted=await read();try{assert.equal(uncommitted.fedRecords,0);assert.equal(uncommitted.entries.length,1);}finally{uncommitted.release();}
    const unfinishedBytes=fs.statSync(f.filePath).size-located.__byteOffset;
    fs.appendFileSync(f.filePath,'\n');
    const oracle=expected(legacyRows(f.sessionId,[u,located]),chars);
    const interval=await observeInterval(0,async hooks=>{
      const complete=await read(hooks);try{
        assert.equal(complete.mode,'append');assert.equal(complete.fedRecords,1);
        assert.deepEqual(await hashRoot(complete),oracle);
        // Frozen raw proof is compared independently, in finite byte chunks.
        const rawHash=crypto.createHash('sha256');for await(const part of fs.createReadStream(f.filePath,{highWaterMark:64}))rawHash.update(part);
        const expectedRaw=rawHash.digest('hex'),arena=new HistoryProjectionArena(store,complete.checkpoint);
        try{
          fs.writeFileSync(f.filePath,'rewritten in place');
          const frozen=crypto.createHash('sha256');for(const part of frozenSourceBytes(arena,0,complete.sourceSnapshot.size))frozen.update(part);
          assert.equal(frozen.digest('hex'),expectedRaw);
          assert.deepEqual(await hashRoot(complete),oracle);
        }finally{arena.close();}
        return complete.readMetrics;
      }finally{complete.release();}
    });
    assertBounded(interval);assert.equal(interval.value.replayedPartialBytes,unfinishedBytes);
    t.diagnostic(JSON.stringify({chars,firstBytes,unfinishedBytes,oracle,...interval}));
  }finally{owner.close();store.close();}
});

test('actual locator fallback parses long header before any line String, preserving first header/unknown raw bytes',async t=>{
  const f=fixture(t,{indexBytes:0}),chars=262144;
  fs.writeFileSync(f.filePath,'');
  const write=writer(f.filePath,0);
  write.record({type:'session_meta',payload:{id:f.sessionId,cwd:f.dir,unknown:MARKER,history_base:{tag:'first'}}},chars);
  const u=write.record(user('found by content'));
  const renamed=path.join(f.dir,'header-without-session-in-name.jsonl');fs.renameSync(f.filePath,renamed);
  const oracle=expected(legacyRows(f.sessionId,[u]),0);
  const interval=await observeInterval(0,async hooks=>{
    const read=await f.read(hooks);try{
      assert.equal(read.filePath,renamed);assert.deepEqual(await hashRoot(read),oracle);
      assert.equal(smallText(read.sessionMeta.field('history_base').field('tag')),'first');
      return read.readMetrics;
    }finally{read.release();}
  });
  assertBounded(interval);assert.ok(interval.ingestPhases.locate>0);t.diagnostic(JSON.stringify(interval));
});

test('invalid committed record / ENOSPC injection keep prior publication, no empty success or RAM fallback',async t=>{
  const f=fixture(t);f.append(user('safe'));const old=await f.read(),digest=await hashRoot(old),size=fs.statSync(f.filePath).size;
  const pin=f.owner.read(f.sessionId,f.dir);const page=pin.descriptor.page;pin.release();
  try{
    fs.appendFileSync(f.filePath,'{"type":\n');
    await assert.rejects(f.read(),{code:'CODEX_JSONL_RECORD_INVALID'});
    let current=f.owner.read(f.sessionId,f.dir);assert.equal(current.descriptor.page,page);current.release();
    fs.truncateSync(f.filePath,size);f.append(answer('append after invalid'));
    const put=f.store.put;let count=0;
    f.store.put=function(...args){if(++count===9)throw Object.assign(Error('finite backing fault'),{code:'ENOSPC'});return put.apply(this,args);};
    try{await assert.rejects(f.read(),{code:'ENOSPC'});}finally{f.store.put=put;}
    current=f.owner.read(f.sessionId,f.dir);assert.equal(current.descriptor.page,page);current.release();
    assert.deepEqual(await hashRoot(old),digest);assert.equal(f.store.stats().activeBuilders,0);
    const recovered=await f.read();try{assert.equal(recovered.entries.length,2);}finally{recovered.release();}
  }finally{old.release();}
});

test('concurrent frozen Full leases, credit stall/cancel/disconnect and exact missing-page failure release traversal',async t=>{
  const f=fixture(t),write=writer(f.filePath,f.line);write.record(user('leases'));write.record(answer(MARKER),16384);
  const read=await f.read(),lease=read.root.fork(),expected=await hashRoot(read);
  try{
    f.owner.evict(f.sessionId,f.dir);assert.deepEqual(await hashRoot(read),expected);
    const stats={};let sender;
    const receiver=new HistoryByteReceiver({id:'cancel',frameBytes:1024,credits:2,
      send:message=>message.event==='stream-credit'?sender.credit(message):sender.cancel(Object.assign(Error('finite disconnect'),{code:'HISTORY_READ_UNAVAILABLE'}))});
    sender=new HistoryByteSender({id:'cancel',frameBytes:1024,credits:2,stats,send:message=>receiver.accept(message)});
    const pumping=sender.pump(encodeHistoryStream(lease.cursor(),{frameBytes:1024}),{});
    const rejected=assert.rejects(pumping,{code:'HISTORY_READ_UNAVAILABLE'});
    await receiver.next();await new Promise(resolve=>setImmediate(resolve));
    assert.ok(stats.maxOutstandingBytes<=2048);receiver.fail(Object.assign(Error('finite disconnect'),{code:'HISTORY_READ_UNAVAILABLE'}));
    await rejected;assert.equal(f.store.stats().activeBuilders,0);
    assert.deepEqual(await hashRoot(read),expected,'cancel does not invalidate an independently pinned Full view');
    const leaf=read.entries.at(1).field('content'),id=Number(leaf.identity().split(':').at(-1));
    const meta=f.store.json(id),part=f.store.vectorGet(meta.chunks,0);
    f.store.cache.clear();f.store.cacheBytes=0;f.store.sql('DELETE FROM hp_pages WHERE id=?').run(part);
    // A fault reaches both halves of a credit stream. Await both promises;
    // the success-only v6 hash helper otherwise leaves pump rejection orphaned.
    let missingSender;
    const missingReceiver=new HistoryByteReceiver({id:'missing',frameBytes:1024,credits:2,
      send:message=>message.event==='stream-credit'?missingSender.credit(message):missingSender.cancel()});
    missingSender=new HistoryByteSender({id:'missing',frameBytes:1024,credits:2,
      send:message=>missingReceiver.accept(message)});
    const missingPump=missingSender.pump(encodeHistoryStream(read.entries,{frameBytes:1024}),{});
    const missingConsumer=(async()=>{for await(const _ of missingReceiver){}})();
    const failed=await Promise.allSettled([missingPump,missingConsumer]);
    for(const result of failed){assert.equal(result.status,'rejected');
      assert.equal(result.reason.code,'history_page_missing_or_corrupt');}
    assert.ok(missingSender.stats.maxOutstandingBytes<=2048);
    assert.ok(missingReceiver.stats.maxQueuedFrames<=2);
    assert.equal(f.store.stats().activeBuilders,0);
  }finally{lease.release();read.release();}
});
