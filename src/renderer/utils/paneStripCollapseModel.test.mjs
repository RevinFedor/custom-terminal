import test from 'node:test';import assert from 'node:assert/strict';
import {fitPaneStripGroupAtAnchor,paneStripGroupRepresentative,paneStripCollapsedRuns,
  paneStripGroupOffsets,paneStripGroupHoverStep,paneStripGroupMetaStep,paneStripVisibleInsertion,
  paneStripOpenGroupGeometry} from './paneStripCollapseModel.mjs';
const ids=['1','2','3','4','5'],widths=new Map(ids.map(id=>[id,80]));
test('OPEN preserves physical representative; only insufficient side moves it minimally and persistently in logical order',()=>{
  const fit=anchorLeft=>fitPaneStripGroupAtAnchor({ids,representative:'3',widths,anchorLeft,viewportRight:600,gap:6});
  assert.deepEqual(fit(200).order,ids);assert.equal(fit(200).changed,false);
  assert.deepEqual(fit(510).order,['1','2','4','5','3']);
  assert.deepEqual(fit(430).order,['1','2','4','3','5']);
  const moved=fit(430).order;
  assert.deepEqual(fitPaneStripGroupAtAnchor({ids:moved,representative:'3',widths,anchorLeft:270,viewportRight:700}).order,moved);
  assert.deepEqual(fit(0).order,['3','1','2','4','5']);
});
test('fit uses actual mixed widths and truthful overflow, no hidden member clipping presented as full fit',()=>{
  const mixed=new Map([['a',25],['b',160],['c',40]]);
  const fit=fitPaneStripGroupAtAnchor({ids:['a','b','c'],representative:'b',widths:mixed,anchorLeft:80,viewportRight:300});
  assert.deepEqual(fit.order,['a','b','c']);assert.equal(fit.left,-31);
  assert.equal(fitPaneStripGroupAtAnchor({ids,representative:'3',widths,anchorLeft:50,viewportRight:150}).overflow,true);
  assert.throws(()=>fitPaneStripGroupAtAnchor({ids,representative:'3',widths:new Map(),anchorLeft:0,viewportRight:500}));
});
test('projection keeps chooser/foreign gaps and missing/unknown members intact; current/history representative count is active-only input',()=>{
  const items=['a','b','x'].map(tabId=>({kind:'tab',projectId:'P',tabId})),group={id:'g',collapsed:true,tabIds:['a','b']};
  const out=paneStripCollapsedRuns(items,[group],'b');assert.equal(out[0].representative,'b');assert.equal(out[1].tabId,'x');
  assert.equal(out[0].entries.length,2);assert.equal(paneStripGroupRepresentative(group,items,'x',['b']),'b');
  assert.deepEqual(paneStripCollapsedRuns([items[0],{kind:'chooser',slotId:'c'},items[1]],[group],'a'),[items[0],{kind:'chooser',slotId:'c'},items[1]]);
  assert.deepEqual(paneStripCollapsedRuns([items[0]],[group],'a'),[items[0]]);
});
test('same-row offsets include representative exactly once and move normally during explicit reorder',()=>{
  assert.equal(paneStripGroupOffsets(ids,widths,6,'3').get('3'),0);
  assert.equal(paneStripGroupOffsets(['3','1','2','4','5'],widths,6,'3',-172).get('3'),-172);
});
test('hover drag outside/release/re-enter/re-leave re-arms close; click-open is sticky',()=>{
  let state={mode:'hover',inside:true,dragging:false,waitForReentry:false};
  state=paneStripGroupHoverStep(state,'drag-start');state=paneStripGroupHoverStep(state,'leave');assert.equal(state.close,false);
  state=paneStripGroupHoverStep(state,'drag-end');state=paneStripGroupHoverStep(state,'leave');assert.equal(state.close,false);
  state=paneStripGroupHoverStep(state,'enter');state=paneStripGroupHoverStep(state,'leave');assert.equal(state.close,true);
  assert.equal(paneStripGroupHoverStep({...state,mode:'click'},'leave').close,false);
});
test('Meta tap toggles once but repeat, Cmd+click/chord, blur do not toggle',()=>{
  const down=paneStripGroupMetaStep({}, {type:'down',key:'Meta'});
  assert.equal(paneStripGroupMetaStep(down,{type:'up',key:'Meta'}).toggle,true);
  for(const event of [{type:'pointer'},{type:'down',key:'a'},{type:'cancel'}])
    assert.equal(!!paneStripGroupMetaStep(paneStripGroupMetaStep(down,event),{type:'up',key:'Meta'}).toggle,false);
});
test('visible gap maps to full post-removal order including hidden first/last/end; unknown/inactive representative does not guess',()=>{
  const fullIds=['x','a','b','c','y'],blocks=[{visibleId:'x',ids:['x']},{visibleId:'b',ids:['a','b','c']},{visibleId:'y',ids:['y']}];
  for(const [at,expected] of [[0,0],[1,1],[2,4],[3,5]])assert.equal(paneStripVisibleInsertion({fullIds,blocks,at}).at,expected);
  assert.equal(paneStripVisibleInsertion({fullIds,blocks,excludedIds:['x'],at:1}).at,3);
  assert.equal(paneStripVisibleInsertion({fullIds,blocks,at:1,rowStartId:'b'}).rowStartId,'a');
  assert.equal(paneStripVisibleInsertion({fullIds,blocks,excludedIds:['b'],at:1}),null);
  assert.equal(paneStripVisibleInsertion({fullIds,blocks:blocks.slice(1),at:0}),null);
  const opened=fullIds.map(id=>({visibleId:id,ids:[id]}));
  assert.equal(paneStripVisibleInsertion({fullIds,blocks:opened,excludedIds:['b'],at:3}).at,3);
});

test('OPEN row owns its captured boxes and gaps above ordinary neighbours; ambiguous or stale scopes do not guess',()=>{
  const chips=[{id:'x',left:0,right:494,top:0,bottom:26},{id:'a',left:108,right:188,top:0,bottom:26},
    {id:'b',left:194,right:494,top:0,bottom:26},{id:'c',left:500,right:580,top:0,bottom:26}];
  const blocks=chips.map(chip=>({visibleId:chip.id,ids:[chip.id],openGroupId:chip.id==='x'?undefined:'g'}));
  const original=JSON.stringify({chips,blocks});
  for(const clientX of [120,190,450,499]) {
    const selected=paneStripOpenGroupGeometry({chips,blocks,clientX,clientY:15});
    assert.equal(selected.scopeId,'g');assert.deepEqual(selected.chips.map(chip=>chip.id),['a','b','c']);
  }
  assert.equal(paneStripOpenGroupGeometry({chips,blocks,clientX:20,clientY:15}),undefined);
  assert.equal(paneStripOpenGroupGeometry({chips,blocks,clientX:120,clientY:40}),undefined);
  assert.equal(paneStripOpenGroupGeometry({chips,blocks,clientX:120,clientY:15,preferredGroupId:'stale'}),null);
  const overlap=[...blocks,{visibleId:'x',ids:['x'],openGroupId:'other'}];
  assert.equal(paneStripOpenGroupGeometry({chips,blocks:overlap,clientX:120,clientY:15}),null);
  assert.equal(paneStripOpenGroupGeometry({chips,blocks:overlap,clientX:120,clientY:15,preferredGroupId:'g'}).scopeId,'g');
  assert.equal(JSON.stringify({chips,blocks}),original,'selection cannot mutate its geometry lease');
});

test('OPEN local insertion keeps its canonical prefix after exclusions, including an entirely moving group',()=>{
  const fullIds=['x','a','b','c','y'],blocks=fullIds.map(id=>({visibleId:id,ids:[id],
    openGroupId:['a','b','c'].includes(id)?'g':undefined}));
  const map=(at,excludedIds=[],extra={})=>paneStripVisibleInsertion({fullIds,blocks,scopeId:'g',at,excludedIds,...extra});
  for(const [at,expected] of [[0,1],[1,2],[2,3],[3,4]])assert.equal(map(at).at,expected);
  assert.equal(map(1,['a']).at,2);assert.equal(map(1,['x','b']).at,1);
  assert.equal(map(0,['a','b','c']).at,1);assert.equal(map(1,['a','b','c']),null);
  assert.equal(map(0,[],{rowStartId:'a'}).rowStartId,'a');
  assert.equal(map(0,[],{rowStartId:'x'}).rowStartId,null);
  assert.equal(map(0,[],{scopeId:'missing'}),null);
  const split=blocks.map(block=>block.visibleId==='b'?{...block,openGroupId:undefined}:block);
  assert.equal(map(0,[],{blocks:split}),null);
});
