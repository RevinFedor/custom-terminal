'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const { captureSystemMemory, decodeSystemMemory }=require('./system-memory-source');

test('kernel layout reads compressor and swap without mixing logical and physical pages',()=>{
  const vm=Buffer.alloc(248), swap=Buffer.alloc(32);
  vm.writeBigUInt64LE(100n,128); vm.writeBigUInt64LE(9999n,136);
  swap.writeBigUInt64LE(5000n,16);
  const r=decodeSystemMemory({total:32000,pageSize:16384,pressure:2,swap,vm,vmOk:true});
  assert.equal(r.compressedBytes,100*16384);
  assert.equal(r.swapUsedBytes,5000);
  assert.equal(r.pressureLevel,2);
});

test('missing counters remain unknown rather than healthy zero',()=>{
  const r=decodeSystemMemory({total:null,pageSize:null,pressure:null,swap:null,vm:null,vmOk:false});
  assert.equal(r.available,false);
  assert.equal(r.compressedBytes,null); assert.equal(r.swapUsedBytes,null); assert.equal(r.pressureLevel,null);
});

test('real read-only macOS counters have physical RAM and independent pressure', {skip:process.platform!=='darwin'},()=>{
  const r=captureSystemMemory();
  assert.equal(r.available,true);
  assert.equal(r.totalBytes,require('node:os').totalmem());
  assert.ok(r.compressedBytes>=0&&r.compressedBytes<r.totalBytes);
  assert.ok(r.swapUsedBytes>=0);
  assert.ok([1,2,4].includes(r.pressureLevel));
});
