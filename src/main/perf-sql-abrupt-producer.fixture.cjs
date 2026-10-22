'use strict';
// Tiny owned Node fixture only. Import/default cannot exit a caller process.
function run(mode) {
  if(!process.send||!['send','drop'].includes(mode))throw Error('owned test IPC/mode required');
  const {createCausalContext}=require('./perf-causal-context');
  const {createCausalTransport}=require('./perf-causal-transport');
  const tx=createCausalTransport({target:()=>mode==='drop'?null:process});
  const c=createCausalContext({boot:'abrupt-private',pid:process.pid});
  c.configure({enabled:true,sink:r=>tx.sendRecord(r)});
  c.sql('private.abort-inside','all',()=>process.exit(0)); // No return/finally.
  throw Error('unreachable');
}
module.exports={run};
if(require.main===module)run(process.argv[2]);
