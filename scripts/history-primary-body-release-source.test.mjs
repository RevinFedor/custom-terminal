import test from 'node:test';
import assert from 'node:assert/strict';
import {readHistoryPrimaryEntryBody} from '../src/renderer/utils/historyPrimaryEntryBody.mjs';
const root={protocol:'history-root-v1',kind:'object',nodeToken:'root'};
test('primary decode failure survives independent release failure; exactly one release',async()=>{
 const primary=Object.assign(Error('owned decode'),{code:'OWN_DECODE'}),release=Object.assign(Error('owned release'),{code:'OWN_RELEASE'});
 let closes=0;
 await assert.rejects(readHistoryPrimaryEntryBody({root,assertOpen(){},async page(){throw primary;},async close(){closes++;throw release;}}),e=>e===primary);
 assert.equal(closes,1);
});
test('a release failure after a full body is not declared success',async()=>{
 const release=Object.assign(Error('release unknown'),{code:'OWN_UNKNOWN'});let closes=0;
 await assert.rejects(readHistoryPrimaryEntryBody({root,assertOpen(){},async page(){return{items:[],done:true,nextOffset:0};},async close(){closes++;throw release;}}),e=>e===release);
 assert.equal(closes,1);
});
test('owner change during successful release revokes returned old body without replay',async()=>{
 let owns=true,reads=0,closes=0;
 await assert.rejects(readHistoryPrimaryEntryBody({root,assertOpen(){},async page(){reads++;return{items:[],done:true,nextOffset:0};},async close(){closes++;owns=false;}},{owns:()=>owns}),{code:'HISTORY_READ_CANCELLED'});
 assert.equal(reads,1);assert.equal(closes,1);
});

