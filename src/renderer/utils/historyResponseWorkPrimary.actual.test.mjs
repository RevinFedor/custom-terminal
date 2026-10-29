import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { HistoryPrimaryRootReadModel } from './historyPrimaryRootReadModel.mjs';

const require=createRequire(import.meta.url);
globalThis.window={require};
const {createPrimaryAddressFixture}=require('../../../scripts/test-support/history-primary-address-fixture.cjs');
const scope={ownerKey:'response-work-owned-test',generation:1,visit:1,presented:true};
const entry=(uuid,phase,content)=>({uuid,role:'assistant',sessionId:'s',textPhase:phase,content});
const tool=(uuid,family)=>({uuid,role:'assistant',sessionId:'s',content:'',actions:[{tool:'__raw__',rawTool:{
  toolUseId:uuid+'-call',toolName:family==='edit'?'Edit':'Read',family,args:{},result:'ok'}}]});
const input=keys=>({localEntries:[],liveEntries:[],liveToolResults:[],rewindPreview:null,
  grouping:{enabled:true,responseWork:true,threshold:2,expandedKeys:keys},captionSelections:[],settingsPresentationKeys:[]});

test('actual primary reader keeps exact source identity through work and tool collapse/reopen',async()=>{
  const rows=[{uuid:'u',role:'user',sessionId:'s',content:'prompt'},entry('c','commentary','**проверка**'),
    {...tool('r','read'),sourceIdentity:'source-r',sourceIdentityAliases:['alias-r']},
    tool('e','edit'),{...entry('composite','commentary','text and calls'),
      actions:[...tool('x','read').actions,...tool('y','edit').actions]},
    {...entry('f','final_answer','final'),
      responseTiming:{intervalId:7,startTs:1000,endTs:4000,durationMs:3000}}];
  const f=await createPrimaryAddressFixture(null,{entries:rows});
  const model=new HistoryPrimaryRootReadModel(f.invoke,f.transport);model.windowDiagnostic=()=>{};
  try{
    let options=input([]),payload={...f.payload,primaryPresentation:options};
    await model.open(payload,{presentationScope:scope});
    await model.readWindow(0,model.totalCount-1);
    const work=[...model.window.values()].find(unit=>unit.familyKey==='response-work');
    assert(work);assert.equal(work.expanded,false);
    assert.equal(work.previewEntry.uuid,'composite');assert.equal(work.previewEntry.content,'text and calls');
    assert.equal(work.responseTiming.durationMs,3000);
    assert.equal([...model.window.values()].find(unit=>unit.entry?.uuid==='f').suppressResponseTiming,true);
    assert.equal(model.metadata.entries.find(row=>row.uuid==='f').responseTiming.intervalId,7,
      'thin metadata can prove the final clock has already moved into the heading');
    let target=await model.resolveUuid('e');
    assert.equal(target.entryUuid,'e','source target never becomes the first carrier UUID');
    assert.equal(target.groupKey,work.key);assert.equal(target.expanded,false);
    const alias=await model.resolvePresentationTarget('alias-r');
    assert.equal(alias.entryUuid,'r');assert.equal(alias.groupKey,work.key);
    const exactCall=await model.resolvePresentationTarget('e',{toolUseId:'e-call'});
    assert.equal(exactCall.entryUuid,'e');assert.equal(exactCall.groupKey,work.key);
    const final=await model.resolveUuid('f');assert.equal(final.entryUuid,'f');assert.equal(final.kind,'entry');
    assert.equal((await model.resolveGroup(work.key)).physicalKey,work.key);
    options=input([work.key]);
    await model.open({...payload,primaryRequestClass:'view',primaryViewOptions:options},{presentationScope:scope});
    await model.readWindow(0,model.totalCount-1);
    const tools=[...model.window.values()].find(unit=>unit.kind==='group'&&unit.familyKey==='work');
    assert(tools);target=await model.resolveUuid('e');
    assert.equal(target.entryUuid,'e');assert.equal(target.groupKey,tools.key);assert.equal(target.expanded,false);
    const compositeCall=await model.resolvePresentationTarget('composite',{toolUseId:'y-call'});
    assert.equal(compositeCall.entryUuid,'composite');assert.equal(compositeCall.kind,'entry');
    assert.equal(compositeCall.physicalKey,'uuid:composite');
    options=input([work.key,tools.key]);
    await model.open({...payload,primaryRequestClass:'view',primaryViewOptions:options},{presentationScope:scope});
    target=await model.resolveUuid('e');assert.equal(target.entryUuid,'e');assert.equal(target.kind,'entry');
    await model.readWindow(target.index,target.index);
    assert.equal(model.unitAt(target.index).entry.uuid,'e');
    assert.equal(model.addressAt(target.index).physicalKey,'uuid:e');
  }finally{await model.close();f.close();}
});

test('manual expansion of a live work chapter survives appended commentary and final publication',async()=>{
  const base=[{uuid:'u',role:'user',sessionId:'s',content:'prompt'},tool('first','read')];
  const f=await createPrimaryAddressFixture(null,{entries:base});
  const model=new HistoryPrimaryRootReadModel(f.invoke,f.transport);model.windowDiagnostic=()=>{};
  try{
    await model.open({...f.payload,primaryPresentation:input([])},{presentationScope:scope});
    await model.readWindow(0,model.totalCount-1);
    const work=[...model.window.values()].find(unit=>unit.familyKey==='response-work');
    assert(work);assert.equal(work.expanded,false);assert.equal(work.previewFact.family,'read');
    const live=[...base,entry('comment','commentary','working text'),tool('edit','edit')];
    f.setEntries(live);
    await model.open({...f.payload,primaryPresentation:input([])},{presentationScope:scope});
    await model.readWindow(0,model.totalCount-1);
    const closed=[...model.window.values()].find(unit=>unit.familyKey==='response-work');
    assert.equal(closed.key,work.key);assert.equal(closed.expanded,false);
    assert.equal(closed.previewEntry.content,'working text');assert.equal(closed.previewFact,null,
      'a later tool cannot replace the latest commentary');
    await model.open({...f.payload,primaryPresentation:input([work.key])},{presentationScope:scope});
    await model.readWindow(0,model.totalCount-1);
    let current=[...model.window.values()].find(unit=>unit.familyKey==='response-work');
    assert.equal(current.key,work.key);assert.equal(current.expanded,true);
    f.setEntries([...live,entry('final','final_answer','done')]);
    await model.open({...f.payload,primaryPresentation:input([work.key])},{presentationScope:scope});
    await model.readWindow(0,model.totalCount-1);
    current=[...model.window.values()].find(unit=>unit.familyKey==='response-work');
    assert.equal(current.key,work.key);assert.equal(current.expanded,true);
    assert.equal((await model.resolveUuid('final')).kind,'entry');
  }finally{await model.close();f.close();}
});
