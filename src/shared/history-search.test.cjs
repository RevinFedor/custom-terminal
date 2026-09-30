'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {searchHistoryEntries,historyImageCountFromProviderRecord}=require('./history-search.cjs');
const rows=[
 {uuid:'u1',role:'user',content:'Первый промпт',imagePaths:[{id:1,path:'/test.png'}]},
 {uuid:'a1',role:'assistant',content:'needle and needle'},
 {uuid:'u2',role:'user',content:'Only a literal [Image #1] marker'},
 {uuid:'u3',role:'user',content:'',imageCount:1,sourceIdentity:'source:3'},
 {uuid:'a3',role:'assistant',content:'needle'},
];
test('empty image filter lists only prompts with actual attachments, including a pathless image',()=>{
 const r=searchHistoryEntries(rows,{type:'user-images'});
 assert.deepEqual(r.matches.map(m=>m.entryUuid),['u1','u3']);assert.equal(r.total,2);assert.equal(r.entryTotal,2);
 assert.ok(r.turnKeys.includes('source:3'));
 assert.equal(searchHistoryEntries(rows).total,0);
});
test('literal text intersects the selected role, and assistant hits mark their owning user iteration',()=>{
 const r=searchHistoryEntries(rows,{query:'NEEDLE',type:'assistant'});
 assert.equal(r.total,3);assert.equal(r.entryTotal,2);assert.deepEqual(r.matches.map(m=>m.offset),[0,11,0]);
 assert.deepEqual(r.matches.map(m=>m.occurrence),[0,1,0]);assert.deepEqual(r.turnKeys,['u1','u3','source:3']);
 assert.equal(searchHistoryEntries(rows,{query:'needle',type:'user-images'}).total,0);
});
test('paging bounds snippets but keeps totals and all Timeline iterations',()=>{
 const rows=Array.from({length:260},(_,i)=>({uuid:'u'+i,role:'user',content:'x x',imageCount:1}));
 const r=searchHistoryEntries(rows,{query:'x',offset:100,limit:100});
 assert.equal(r.total,520);assert.equal(r.entryTotal,260);assert.equal(r.turnKeys.length,260);
 assert.equal(r.matches[0].matchIndex,100);assert.equal(r.matches[0].entryUuid,'u50');assert.equal(r.matches.length,100);
 const images=searchHistoryEntries(rows,{type:'user-images',offset:200,limit:100});
 assert.equal(images.total,260);assert.equal(images.matches.length,60);assert.equal(images.truncated,false);
});
test('image evidence comes from both providers structured records, never literal image words',()=>{
 assert.equal(historyImageCountFromProviderRecord({message:{content:[{type:'image',source:{type:'base64',data:'AA'}}]}}),1);
 assert.equal(historyImageCountFromProviderRecord({payload:{content:[{type:'input_image',image_url:'data:image/png;base64,AA'}]}}),1);
 assert.equal(historyImageCountFromProviderRecord({payload:{message:'[Image #1]'}}),0);
});
