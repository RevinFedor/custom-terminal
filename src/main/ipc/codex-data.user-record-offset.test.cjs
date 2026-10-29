'use strict';
const test=require('node:test'),A=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {cloneProjectionGraph}=require('../codex-projection-checkpoint');
const apis=[['main',require('./codex-data')._api],
  ['engine',require('../history-root-engine/main/ipc/codex-data')._api]];
const session='private-user-offset',text='FULL \0 lone\uD800 pair😀\r\nlast';
const record=(carrier,offset,line=1,message=text)=>({type:carrier==='event'?'event_msg':'response_item',
  timestamp:'2026-10-27T00:00:00.000Z',__line:line,__byteOffset:offset,
  payload:carrier==='event'?{type:'user_message',message}:{type:'message',role:'user',content:[{type:'input_text',text:message}]}});
const rows=p=>p.finalize().filter(e=>e.role==='user');
function fixture(t,name,api){
 let store,directory;
 const projectors=[];
 t.after(()=>{
  try{
   for(const p of projectors.reverse())p.close?.();
   if(store){
    A.equal(store.stats().leases,0,'all owned projectors/checkpoints released');
    A.equal(store.stats().activeBuilders,0);
    A.equal(store.db.prepare('SELECT count(*) AS n FROM hp_pins').get().n,0);
   }
  }finally{
   try{store?.close();}finally{if(directory)fs.rmSync(directory,{recursive:true,force:true});}
  }
 });
 if(name==='engine'){
  // Keep the actual owned/rooted reducer. Only its private fixture's SQLite
  // driver is Node-compatible; never rebuild or replace Electron's binding.
  const {HistoryPagedStore}=require('../history-root-engine/main/history-paged-store');
  const Database=require('../../../scripts/test-support/history-node-sqlite.cjs');
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-user-offset-'));
  store=new HistoryPagedStore({filename:path.join(directory,'pages.sqlite'),Database,
   pageBytes:1024,residentPages:3,indexBytes:2048,sqlCacheKiB:8,diskBytes:16*1024**2});
 }
 const create=seed=>{
  const p=api.createCodexHistoryProjector(session,seed,name==='engine'?{canonicalStore:store}:{});
  projectors.push(p);return p;
 };
 const resume=p=>{
  const state=p.exportState();
  if(name==='main')return create(cloneProjectionGraph(state));
  // Engine exportState is an owned checkpoint, not a legacy native graph.
  // Its consumer takes its own pin before the exported lease is released.
  A.equal(state.$codexHistoryState,'codex-history-checkpoint-v1');
  try{return create(state);}finally{state.release();}
 };
 return {create,resume};
}
for(const [name,api]of apis){
 test(name+': actual user births retain zero and positive exact physical byte coordinates',t=>{
  const {create}=fixture(t,name,api);
  for(const carrier of ['event','response'])for(const offset of [0,1708]){
   const p=create();p.feed(record(carrier,offset));const [row]=rows(p);
   A.equal(row.recordByteOffset,offset);A.equal(row.sessionId,session);A.equal(row.content,text);
   A.equal(row.sourceIdentity,'codex-user-source-'+session+'-'+offset);
  }
 });
 test(name+': promotion follows event coordinate while later aliases preserve the selected carrier',t=>{
  const {create}=fixture(t,name,api);
  const p=create();p.feed(record('response',100,1));p.feed(record('event',200,2));p.feed(record('response',300,3));
  const out=rows(p);A.equal(out.length,1);A.equal(out[0].recordByteOffset,200);A.equal(out[0].uuid,'codex-user-'+session+'-2');A.equal(out[0].content,text);
 });
 test(name+': unknown/invalid promoted coordinate removes earlier certainty, with no line or identity fallback',t=>{
  const {create}=fixture(t,name,api);
  for(const invalid of [undefined,null,NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1]){
   const p=create();p.feed(record('response',100,1));p.feed(record('event',invalid,2));
   const out=rows(p);A.equal(out.length,1);A.equal(Object.hasOwn(out[0],'recordByteOffset'),false);A.equal(Number.isNaN(Number(out[0].recordByteOffset)),true);
  }
 });
 test(name+': exported continuation preserves coordinates across finalization and later promotion',t=>{
  const {create,resume}=fixture(t,name,api);
  const p=create();p.feed(record('response',100,1));p.finalize();
  const q=resume(p);A.equal(rows(q)[0].recordByteOffset,100);q.feed(record('event',200,2));
  A.equal(rows(q)[0].recordByteOffset,200);A.equal(rows(p)[0].recordByteOffset,100);
 });
}
