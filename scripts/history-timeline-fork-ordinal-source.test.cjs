'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const Database=require('./test-support/history-node-sqlite.cjs');
const dirpath='../src/main/history-root-engine/main/';
const {HistoryPagedStore,materializeHistoryCursorSync:materialize}=require(dirpath+'history-paged-store');
const {createTimelineLogicalRoot}=require(dirpath+'timeline-root-logical');
const {HistoryProjectionArena}=require(dirpath+'history-projection-arena');
const filename=require.resolve(dirpath+'timeline-root-view');
let create=require(filename).createTimelineRootView;
if(process.env.NOTED_BASELINE_TIMELINE_VIEW){
 const Module=require('node:module'),m=new Module(filename,module);
 m.filename=filename;m.paths=module.paths;m._compile(fs.readFileSync(process.env.NOTED_BASELINE_TIMELINE_VIEW,'utf8'),filename);
 create=m.exports.createTimelineRootView;
}
test('raw skipped fork markers do not misaddress the compact annotation vector',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noted-fork-ordinal-'));
 const store=new HistoryPagedStore({filename:path.join(dir,'pages.sqlite'),Database,diskBytes:28*1024**2});
 const publish=value=>{const arena=new HistoryProjectionArena(store);try{return arena.step(()=>arena.publish(value));}finally{arena.close();}};
 let source,annotation,logical,options,view;
 const wrap=root=>({root,revision:'finite',notes:root.cursor().field('notes'),outline:root.cursor().field('outline'),
  promptSummaries:root.cursor().field('promptSummaries'),turnActionOverrides:root.cursor().field('turnActionOverrides'),
  hasRewindMarker:()=>false,fork(){return wrap(root.fork());},release(){root.release();}});
 try{
  source=publish({entries:['p1','p2'].map(uuid=>({uuid,type:'user',content:'work '+uuid,sessionId:'finite'}))});
  annotation=wrap(publish({notes:[],outline:null,promptSummaries:[],turnActionOverrides:[]}));
  const control={assertCurrent(){},checkpoint:()=>new Promise(r=>setImmediate(r))};
  logical=await createTimelineLogicalRoot(store,{success:true,semanticSnapshotComplete:true,root:source,entries:source.cursor().field('entries')},{annotations:annotation,control});
  options=publish({toolType:'codex',forkMarkers:[null,[],
   {fork_mode:'full',entry_uuids:[' ',null,4,'p1',' p1 ']},
   {fork_mode:'full',entry_uuids:['   ',null]}]});
  view=await create({store,logicalRoot:logical,optionsRoot:options,control});
  const rows=materialize(view.root.field('forkAnnotations'));
  assert.equal(rows.length,2);assert.deepEqual(rows.map(x=>x.snapshotCount),[1,0]);
 }finally{view?.release();options?.release();logical?.release();annotation?.release();source?.release();
  assert.equal(store.stats().leases,0);assert.equal(store.stats().activeBuilders,0);store.close();fs.rmSync(dir,{recursive:true});}
});
