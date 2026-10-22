'use strict';
const { sanitizeSqlEnvelope } = require('../shared/perf-causal-schema.cjs');

// Existing child-process channel, bounded in one place. Node send(false) has
// enqueued the packet; only the callback is completion of that channel write.
function createCausalTransport({target, onFailure=()=>{}}) {
  let pending=0,ordinary=0;
  const counts={accepted:0,rejected:0,backpressure:0,callbackErrors:0,throws:0,targetErrors:0,disconnected:0,pendingLimit:0,ordinaryLimitDrops:0,malformedWitness:0};
  const canSend = essential => {try{return !!target()?.connected && pending<32 && (essential || ordinary<24);}catch{return false;}};
  function send(message,essential=false,onSettled=()=>{}) {
    let child;
    try {child=target();} catch {counts.targetErrors++;counts.rejected++;return false;}
    if(!child?.connected || pending>=32 || !essential && ordinary>=24) {
      counts.rejected++;
      if(!child?.connected)counts.disconnected++;else if(pending>=32)counts.pendingLimit++;else counts.ordinaryLimitDrops++;
      return false;
    }
    pending++;if(!essential)ordinary++;
    let settled=false;
    const finish=error=>{
      if(settled)return;settled=true;pending--;if(!essential)ordinary--;
      if(error){counts.callbackErrors++;try{onFailure();}catch{}}
      try{onSettled(error);}catch{}
    };
    try {
      const packet=typeof message==='function'?message():message;
      if(child.send(packet,finish)===false)counts.backpressure++;
      counts.accepted++;return true;
    } catch {counts.throws++;finish(true);return false;}
  }
  return {
    canSend,
    sendRecord(record) {
      // sql-witness is source-coalesced (<=4 entry/settle pairs/minute),
      // ordinary traffic: no new slot, retry, ACK gate or essential privilege.
      if(record?.kind==='sql-witness') {
        record=sanitizeSqlEnvelope(record);
        if(!record){counts.rejected++;counts.malformedWitness++;return false;}
      }
      const essential=record?.kind==='work-summary'
        || record?.kind==='main-gap' && Number(record.durationMs)>=500;
      return send({t:'causal',record},essential);
    },
    sendHeartbeat(build,onSettled) {return send(build,true,onSettled);},
    snapshot:()=>({...counts,pending,ordinary,limit:32,ordinaryLimit:24,delivery:'channel-write-not-persistence'}),
  };
}
module.exports={createCausalTransport};
