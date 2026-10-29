import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { buildHistoryDisplayUnits } from './historyDisplayUnits.mjs';
import { ordinaryHistoryHydrationDemand } from './historyOrdinaryHydrationWindow.mjs';
import * as materialized from './historyMaterializedWindow.mjs';
const { applyHistoryRowWindow } = createRequire(import.meta.url)('../../main/history-entry-window.js');
const source=fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx',import.meta.url),'utf8');
const from=source.indexOf('const protectedUuids = collectHistoryMaterializedWindowUuids(');
const to=source.indexOf('\n    const retained =',from);
assert(from>0&&to>from);
const protect=(units,range)=>vm.runInNewContext(source.slice(from,to)+'\nprotectedUuids',{
  ...materialized,displayUnitsRef:{current:units},visibleRangeRef:{current:range},
  groupCaptionSelectionsRef:{current:new Map()},toolType:'codex',primaryRootRef:{current:null},
});

test('actual ordinary retention preserves already read neighboring captions through repeated up/down and evicts distant pages',()=>{
  const rows=[];
  const add=e=>rows.push({...e,sourceIdentity:'physical-'+rows.length,contentRevision:'r1'});
  for(let g=0;g<64;g++){
    add({uuid:'u'+g,role:'user',content:'user '+g});
    add({uuid:'c'+g,role:'assistant',textPhase:'commentary',content:'Caption '+g+'\n**Ω🙂**'});
    for(let t=0;t<28;t++)add({uuid:`t${g}-${t}`,role:'assistant',content:'',actions:[{tool:'__raw__',rawTool:{toolUseId:`call${g}-${t}`,toolName:'Read',family:'read',args:{file_path:`file${t}`},result:'ok'}}]});
    add({uuid:'p'+g,role:'assistant',textPhase:'final',content:'partial '.repeat(180)});
    add({uuid:'f'+g,role:'assistant',textPhase:'final',content:'final '.repeat(220)});
  }
  assert.equal(rows.length,2048);
  const project=(center,radius)=>applyHistoryRowWindow(rows,{centerUuid:rows[center].uuid,radius,alwaysHydrateTail:32}).entries;
  const units=e=>buildHistoryDisplayUnits(e,{responseWork:false});
  const a=project(494,97),ua=units(a),rangeA={start:50,end:71},rangeB={start:84,end:106};
  assert.equal(ua.length,256);
  assert.equal(ordinaryHistoryHydrationDemand(a,ua,rangeA,new Map()),null);
  const incomingB=project(767,111),protectedB=protect(ua,rangeB);
  const b=materialized.retainHistoryMaterializedWindow(a,incomingB,protectedB).entries;
  assert.equal(ordinaryHistoryHydrationDemand(b,units(b),rangeA,new Map()),null,
    'return to already read neighboring captions must not perform another disk hydration');
  const incomingFar=project(1518,97),protectedFar=protect(units(b),{start:184,end:204});
  const far=materialized.retainHistoryMaterializedWindow(b,incomingFar,protectedFar).entries;
  assert.ok(ordinaryHistoryHydrationDemand(far,units(far),rangeA,new Map()),'distant bodies must be evicted');
  assert(protectedB.size<=512&&protectedFar.size<=512);
  assert(far.filter(e=>!e.rowStub).length<=incomingFar.filter(e=>!e.rowStub).length+protectedFar.size);
  for(const e of b.filter(e=>!e.rowStub))assert.deepEqual(e,rows.find(r=>r.uuid===e.uuid),'reuse keeps exact full content');
});
