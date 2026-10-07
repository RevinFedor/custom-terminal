'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {parseProcessObservation,readProcessObservation,matchesProcessObservation}=require('./process-observation');
test('process birth observation includes date/seconds and exact parent/command; PID reuse or exec cannot pass',()=>{
  const current=parseProcessObservation('123 45 Tue Oct 6 22:18:19 2026 /owned/tool --mode');
  assert.equal(matchesProcessObservation(current,current),true);
  for(const change of [{pid:124},{ppid:46},{processStartedAt:'Tue Oct 6 22:18:20 2026'},{command:'/other/tool'}])
    assert.equal(matchesProcessObservation(current,{...current,...change}),false);
  assert.equal(matchesProcessObservation(null,current),false);
});
test('actual self observation is read-only and can be validated without signalling a process',()=>{
  const current=readProcessObservation(process.pid);
  assert.equal(current.pid,process.pid);assert.equal(current.ppid,process.ppid);
  assert.equal(matchesProcessObservation(readProcessObservation(process.pid),current),true);
  assert.equal(readProcessObservation(-1),null);
});
