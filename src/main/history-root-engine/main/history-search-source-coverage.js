'use strict';
const {HistoryProjectionArena}=require('./history-projection-arena');
const {frozenSourceBytes}=require('./codex-root-jsonl');
// Search marks turns, including assistant matches arriving after a held
// Timeline cut. Exact immutable raw-prefix proof preserves that existing
// meaning across append without accepting same-UUID rewrites by metadata.
async function proveHistorySearchSourceCoverage(store,a,b,{control}={}){
 for(const key of ['filePath','sessionId','fileIdentity','sourceGeneration'])if(a.sourceSnapshot?.[key]!==b.sourceSnapshot?.[key])return false;
 const bytes=Math.min(a.sourceSnapshot.size,b.sourceSnapshot.size);
 if(!Number.isSafeInteger(bytes)||bytes<0||!a.checkpoint||!b.checkpoint)return false;
 let left,right;
 try{
  left=new HistoryProjectionArena(store,a.checkpoint);right=new HistoryProjectionArena(store,b.checkpoint);
  const x=frozenSourceBytes(left,0,bytes),y=frozenSourceBytes(right,0,bytes);
  let l=x.next(),r=y.next(),li=0,ri=0,compared=0,steps=0;
  while(compared<bytes){
   control?.assertCurrent();if(l.done||r.done||!l.value.length||!r.value.length)return false;
   const count=Math.min(l.value.length-li,r.value.length-ri,bytes-compared);
   if(!l.value.subarray(li,li+count).equals(r.value.subarray(ri,ri+count)))return false;
   compared+=count;li+=count;ri+=count;
   if(li===l.value.length){l=x.next();li=0;}if(ri===r.value.length){r=y.next();ri=0;}
   if(++steps%32===0){if(control?.checkpoint)await control.checkpoint();else await new Promise(resolve=>setImmediate(resolve));}
  }control?.assertCurrent();return compared===bytes;
 }finally{right?.close();left?.close();}
}
module.exports={proveHistorySearchSourceCoverage};
