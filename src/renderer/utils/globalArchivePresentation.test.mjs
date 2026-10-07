import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveRecordKey} from './globalTabArchive.mjs';
import {archiveHitKey,reconcileArchiveHits,loadArchivePresentation,saveArchivePresentation,archiveTimestampMillis} from './globalArchivePresentation.mjs';

test('SQL seconds and transcript timestamps display the same date without invented missing dates',()=>{
  const date='2026-10-07T02:59:00.000Z',millis=Date.parse(date);
  for(const value of [millis/1000,String(millis/1000),millis,date]) {
    assert.equal(new Date(archiveTimestampMillis(value)).toISOString(),date);
  }
  for(const value of [undefined,null,'','invalid',{},NaN])assert.equal(archiveTimestampMillis(value),null);
});

test('two iterations have distinct view identity and the same exact mutation address',()=>{
  const a={namespace:'P',id:7,entryUuid:'turn-a'},b={...a,entryUuid:'turn-b'};
  assert.notEqual(archiveHitKey('history',a),archiveHitKey('history',b));
  assert.equal(archiveRecordKey('history',a),archiveRecordKey('history',b));
  assert.notEqual(archiveHitKey('history',a),archiveHitKey('history',{...a,namespace:'Q'}));
});
test('cached hits reattach only to live archive records and never override fresh metadata or SID',()=>{
  const fresh={namespace:'P',id:7,name:'new',notes:'fresh',codex_session_id:'S2',protected:true};
  const stale={...fresh,name:'old',notes:'old',codex_session_id:'S1',protected:false,entryUuid:'turn-a',summary:'hit'};
  const rows=reconcileArchiveHits([stale,{...stale,namespace:'Q'},{...stale,id:8},{id:'bad'}],[fresh]);
  assert.equal(rows.length,1);assert.equal(rows[0].notes,'fresh');assert.equal(rows[0].codex_session_id,'S2');
  assert.equal(rows[0].protected,true);assert.equal(rows[0].entryUuid,'turn-a');
  assert.equal(rows[0].__notedArchiveSourceV1,fresh);
});
test('reopen retains query/filter/hit identity while action data must be reread',()=>{
  const map=new Map(),storage={getItem:key=>map.get(key),setItem:(key,value)=>map.set(key,value)};
  saveArchivePresentation(storage,{query:'query',mode:'iterations',provider:'codex',selectedHit:'exact-hit',
    hits:[{namespace:'P',id:7,entryUuid:'turn-a',summary:'short',notes:'never cached',codex_session_id:'not-authority'}]});
  const state=loadArchivePresentation(storage);
  assert.equal(state.query,'query');assert.equal(state.provider,'codex');assert.equal(state.selectedHit,'exact-hit');
  assert.deepEqual(state.hits,[{namespace:'P',id:7,entryUuid:'turn-a',summary:'short'}]);
});
