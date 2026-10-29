'use strict';
const {createHash,randomUUID}=require('node:crypto');
const {HistoryProjectionArena}=require('./history-projection-arena');
const fail=code=>Object.assign(new Error(code),{code});
// These are the existing bounded authoring handoffs/current live carriers,
// never an export of canonical Timeline rows or a retained renderer ID index.
async function captureTimelinePresentationInput(store,value,{control}={}){
 value??={};
 if(!value||typeof value!=='object'||Array.isArray(value)
  ||Object.keys(value).some(k=>!['revision','sentHandoffs','liveEntries','noteAnchors'].includes(k)))throw fail('TIMELINE_PRESENTATION_INPUT');
 const revision=value.revision??0;if(!Number.isSafeInteger(revision)||revision<0)throw fail('TIMELINE_PRESENTATION_REVISION');
 for(const key of ['sentHandoffs','liveEntries','noteAnchors'])if(value[key]!==undefined&&!Array.isArray(value[key]))throw fail('TIMELINE_PRESENTATION_INPUT');
 const arena=new HistoryProjectionArena(store);let root,transferred=false;
 try{
  arena.step(()=>{for(const key of ['sentHandoffs','liveEntries','noteAnchors'])arena.state()[key]=arena.make('array');});
  for(const key of ['sentHandoffs','liveEntries','noteAnchors'])for(const row of value[key]||[]){
   control?.assertCurrent();
   if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.uuid!=='string'||!row.uuid)throw fail('TIMELINE_PRESENTATION_ROW');
   arena.step(()=>arena.state()[key].push(arena.own(row)));
   if(control?.checkpoint)await control.checkpoint();else await new Promise(resolve=>setImmediate(resolve));
   control?.assertCurrent();
  }
  root=arena.step(()=>arena.publish());control?.assertCurrent();transferred=true;
  return {root,revision,identity:createHash('sha256').update('timeline-prepared-input-v1:'+randomUUID()).digest('hex'),release:()=>root.release()};
 }finally{if(!transferred)root?.release();arena.close();}
}
module.exports={captureTimelinePresentationInput};
