import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Real existing geometry cache + collapse mapping. Rectangles are a finite
// controlled receipt; DOM/native hit testing and pointer performance are not
// claimed. OLD RED can use the exact preserved V1 production module tree.
const source=name=>process.env.NOTED_STRIP_ORIENTATION_SOURCE_ROOT
  ?pathToFileURL(path.resolve(process.env.NOTED_STRIP_ORIENTATION_SOURCE_ROOT,'src/renderer/utils',name))
  :new URL(name,import.meta.url);
const {paneStripVisibleInsertion,paneStripOpenGroupGeometry}=await import(source('paneStripCollapseModel.mjs'));
const {createHorizontalDragGeometryCache}=await import(source('horizontalDragGeometry.mjs'));
const ids=['rep','a','b','c'],fullIds=['x',...ids,'y'];

function fixture(direction='left') {
  const left=[{id:'rep',left:500,right:580},{id:'a',left:350,right:494},
    {id:'b',left:318,right:344},{id:'c',left:112,right:312}];
  const boxes=direction==='left'?left:left.map(box=>({...box,left:1080-box.right,right:1080-box.left}));
  const chips=[{id:'x',left:0,right:494},...boxes,{id:'y',left:1100,right:1130}]
    .map(box=>({...box,top:20,bottom:46}));
  const blocks=fullIds.map(id=>({visibleId:id,ids:[id],
    ...(ids.includes(id)?{openGroupId:'g',openGroupDirection:direction}:{})}));
  const cache=createHorizontalDragGeometryCache();let reads=0;
  const at=(x,excludedIds=[],preferredGroupId='g')=>{
    const slot=cache.resolve({ownerKey:'w:pane:0',clientX:x,clientY:30,wrap:true,includeRowPlacement:true,excludedIds,
      readChips:()=>{reads++;return chips;},selectChips:(captured,point)=>paneStripOpenGroupGeometry({chips:captured,
        blocks,clientX:point.x,clientY:point.y,preferredGroupId})});
    return slot&&paneStripVisibleInsertion({fullIds,blocks,excludedIds,...slot});
  };
  return {at,chips,blocks,reads:()=>reads};
}

test('RTL scoped physical end gaps map to unchanged logical start/end after the canonical prefix',()=>{
  const f=fixture();
  assert.equal(f.at(1000).at,1,'right edge is before logical representative');
  assert.equal(f.at(-10).at,5,'left edge is after logical last member');
  for(const [x,expected] of [[499,2],[347,3],[315,4]])assert.equal(f.at(x).at,expected);
  assert.equal(f.reads(),1,'all samples reuse one existing captured geometry lease');
});

test('RTL pickup at every own midpoint is a no-op with its moving root removed exactly once',()=>{
  for(const id of ids) {
    const f=fixture(),box=f.chips.find(box=>box.id===id);
    assert.equal(f.at((box.left+box.right)/2,[id]).at,1+ids.indexOf(id),id);
  }
});

test('RTL multiple moving roots preserve remaining logical order and the post-removal outside prefix',()=>{
  const f=fixture();
  assert.equal(f.at(1000,['x','a','b']).at,0);
  assert.equal(f.at(400,['x','a','b']).at,1);
  assert.equal(f.at(-10,['x','a','b']).at,2);
  assert.equal(f.at(400,['rep','a','b','c']).at,1,'entire moving group retains its original empty scope');
  assert.equal(f.at(400,['x','rep','a','b','c']).at,0);
});

test('RTL absolute physical left/end never manufactures a logical row-start marker',()=>{
  const f=fixture();
  assert.deepEqual(paneStripVisibleInsertion({fullIds,blocks:f.blocks,scopeId:'g',at:0,rowStartId:'c'}),{at:5,rowStartId:null});
  assert.deepEqual(paneStripVisibleInsertion({fullIds,blocks:f.blocks,scopeId:'g',at:4,rowStartId:'rep'}),{at:1,rowStartId:null});
});

test('unknown/mixed orientation, incomplete full coverage and split group scope refuse ordinal inference',()=>{
  const f=fixture(),run=(blocks,extra={})=>paneStripVisibleInsertion({fullIds,blocks,scopeId:'g',at:0,...extra});
  assert.equal(run(f.blocks.map(block=>block.visibleId==='a'?{...block,openGroupDirection:'right'}:block)),null);
  for(const openGroupDirection of ['inverse','',null])
    assert.equal(run(f.blocks.map(block=>block.openGroupId?{...block,openGroupDirection}:block)),null);
  assert.equal(run(f.blocks.filter(block=>block.visibleId!=='b')),null);
  assert.equal(run(f.blocks.map(block=>block.visibleId==='b'?{...block,openGroupId:undefined}:block)),null);
  assert.equal(run(f.blocks,{at:5}),null);
});

test('LTR/default scope and ordinary wrapped row-start semantics remain unchanged',()=>{
  const f=fixture('right');
  assert.equal(f.at(0).at,1);assert.equal(f.at(1500).at,5);
  const blocks=f.blocks.map(({openGroupDirection,...block})=>block);
  assert.deepEqual(paneStripVisibleInsertion({fullIds,blocks,scopeId:'g',at:0,rowStartId:'rep'}),{at:1,rowStartId:'rep'});
  assert.deepEqual(paneStripVisibleInsertion({fullIds,blocks,at:5,rowStartId:'y'}),{at:5,rowStartId:'y'});
});
