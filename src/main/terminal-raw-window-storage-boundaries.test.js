'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createTerminalRawWindow}=require('./terminal-raw-window');
const {createTerminalRawArtifactStore}=require(process.env.RAW_STORE_SOURCE || './terminal-raw-window-worker');

test('actual bounded aliases + atomic manifests must fit the declared disk cap too',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'noted-raw-metadata-cap-'));
 const maxBytes=65536,store=createTerminalRawArtifactStore({directory,maxBytes});
 t.after(async()=>{await store.close();await fs.rm(directory,{recursive:true,force:true});});
 let chain=Promise.resolve();
 const persist=Object.fromEntries(['start','append','seal'].map(kind=>[kind,(id,payload)=>{
   chain=chain.then(()=>store.process({kind,id,...payload}));return true;
 }]));
 const raw=createTerminalRawWindow({persist}),token={},identity={tabId:'T',runSeq:1,stopRevision:0,lifecycleGeneration:'L',mirrorGeneration:'M'};
 t.after(()=>raw.dispose());
 raw.output(token,'x'.repeat(22000),identity);
 const pin=raw.pin(token,{identity,headlessSeq:1});
 await chain;
 const full=prefix=>prefix+'x'.repeat(256-prefix.length);
 for(let i=0;i<16;i++)raw.pin(token,{identity,incidentId:full('i'+i),sendIdentity:{
   handoffId:full('h'+i),operationKey:full('o'+i),attemptId:full('a'+i),reason:full('r'+i)}});
 raw.commit(token,{authoritativeFrameCommitted:true,writeSeq:1,flushedSeq:1},identity);
 await chain;
 const stats=await store.stats();assert.ok(stats.bytes<=maxBytes,JSON.stringify(stats));
 const manifest=JSON.parse(await fs.readFile(path.join(directory,'raw-'+pin.id,'manifest.json'),'utf8'));
 assert.equal(manifest.state,'sealed');
 if(manifest.persistenceLost.events>0)assert.equal(manifest.rawWindowCompleteWithinAdvertisedRange,false);
});
