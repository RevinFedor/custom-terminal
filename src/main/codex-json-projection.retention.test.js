'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');

// Measure the public parser while a selected string is still open. Keeping a
// pointer for every encoded byte is avoidable even when the value must be full.
if(process.argv[2]==='--retention-child'){
  const {createJsonProjection}=require(process.argv[3]);
  const fixture=process.argv[4],n=393216;
  const body=fixture==='unicode'?'\\u0430'.repeat(n):fixture==='newline'?'\\n'.repeat(3*n):'x'.repeat(6*n);
  // Materialize fixture storage before the baseline GC. The fixture itself is
  // identical for PRE/POST; the measured growth belongs to the pending parser.
  const flat=Buffer.from(body,'latin1').toString('latin1');
  const parser=createJsonProjection({value:true});parser.write('{"value":"',0);
  global.gc();const before=process.memoryUsage().heapUsed;
  if(fixture==='ascii-byte')for(let i=0;i<flat.length;i++)parser.write(flat[i],10+i);
  else for(let i=0;i<flat.length;i+=32768)parser.write(flat.slice(i,i+32768),10+i);
  global.gc();const retained=process.memoryUsage().heapUsed-before;
  parser.write('"}',10+flat.length);const result=parser.finish(12+flat.length);
  const expected=fixture==='unicode'?'а'.repeat(n):fixture==='newline'?'\n'.repeat(3*n):'x'.repeat(6*n);
  assert.equal(result.valid,true);assert.equal(result.value.value,expected);
  process.stdout.write(JSON.stringify({fixture,encodedBytes:flat.length,retainedHeapBytes:retained,decodedChars:result.value.value.length,semanticEqual:true,node:process.versions.node,v8:process.versions.v8})+'\n');
}else{
  const modulePath=process.env.NOTED_PROJECTION_RETENTION_TARGET||path.join(__dirname,'codex-json-projection.js');
  for(const fixture of ['unicode','newline','ascii-byte'])test('pending selected '+fixture+' retains bytes without a pointer per fragment',t=>{
    const p=spawnSync(process.execPath,['--max-old-space-size=128','--expose-gc',__filename,'--retention-child',modulePath,fixture],{
      encoding:'utf8',timeout:30000,maxBuffer:65536,env:{...process.env,ELECTRON_RUN_AS_NODE:process.versions.electron?'1':process.env.ELECTRON_RUN_AS_NODE||''},
    });
    assert.equal(p.status,0,p.error?.message||p.stderr);const r=JSON.parse(p.stdout);t.diagnostic(JSON.stringify(r));
    assert.equal(r.semanticEqual,true);
    assert.ok(r.retainedHeapBytes<r.encodedBytes*3+1024*1024,'pending token grew '+r.retainedHeapBytes+' for '+r.encodedBytes+' encoded bytes');
  });
  test('fragment compaction preserves long keys, surrogate escapes, duplicate keys and offsets',()=>{
    const {createJsonProjection,DEFER,RANGE}=require(modulePath),key='k'.repeat(1800),value='\\uD800\\uDC00\\uDFFF'.repeat(3000);
    const text='{"'+key+'":"old","'+key+'":"'+value+'","deferred":"raw"}';
    for(const stride of [1,7,257]){
      const parser=createJsonProjection({[key]:true,deferred:DEFER});
      for(let i=0;i<text.length;i+=stride)parser.write(text.slice(i,i+stride),i+50);
      const r=parser.finish(text.length+50);assert.equal(r.valid,true);assert.equal(r.value[key],JSON.parse(text)[key]);
      assert.equal(r.value.deferred[RANGE],true);assert.equal(text.slice(r.value.deferred.from-50,r.value.deferred.to-50),'"raw"');
    }
  });
  test('oversized ignored key and invalid selected suffix keep validation semantics',()=>{
    const {createJsonProjection}=require(modulePath),key='wanted'.repeat(500),ignored='z'.repeat(key.length*7);
    for(const suffix of ['"}','\\q"}']){
      const text='{"'+ignored+'":0,"'+key+'":"'+'\\u0430'.repeat(10000)+suffix;
      const parser=createJsonProjection({[key]:true});for(let i=0;i<text.length;i+=13)parser.write(text.slice(i,i+13),i);
      const r=parser.finish(text.length);assert.equal(r.valid,suffix==='"}');if(r.valid)assert.equal(r.value[key],'а'.repeat(10000));
    }
  });
}
