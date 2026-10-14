'use strict';

// Existing child-process channel, bounded in one place. Node send(false) has
// enqueued the packet; only the callback is completion of that channel write.
function createCausalTransport({target, onFailure=()=>{}}) {
  let pending=0,ordinary=0;
  const counts={accepted:0,rejected:0,backpressure:0,callbackErrors:0,throws:0};
  const canSend = essential => !!target()?.connected && pending<32 && (essential || ordinary<24);
  function send(message,essential=false,onSettled=()=>{}) {
    if(!canSend(essential)){counts.rejected++;return false;}
    const child=target();pending++;if(!essential)ordinary++;
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
      const essential=record?.kind==='work-summary'
        || record?.kind==='main-gap' && Number(record.durationMs)>=500;
      return send({t:'causal',record},essential);
    },
    sendHeartbeat(build,onSettled) {return send(build,true,onSettled);},
    snapshot:()=>({...counts,pending,ordinary,limit:32,ordinaryLimit:24,delivery:'channel-write-not-persistence'}),
  };
}
module.exports={createCausalTransport};
