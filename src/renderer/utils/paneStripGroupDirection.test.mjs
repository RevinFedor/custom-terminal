import test from 'node:test';
import assert from 'node:assert/strict';
import {directionalPaneStripGroup} from './paneStripGroupInterfaceModel.mjs';
import {fitPaneStripGroupAtAnchor,paneStripGroupOffsets} from './paneStripCollapseModel.mjs';

const geometry=(options={})=>directionalPaneStripGroup({ids:['1','2','3'],representative:'1',
  widths:new Map([['1',80],['2',80],['3',80]]),anchorLeft:200,viewportLeft:0,viewportRight:300,gap:6,...options});
const offsets=value=>Object.fromEntries(value.offsets);

test('direction anchor: exact V1 counterexample keeps representative at X200 with logical 1,2,3',()=>{
  const value=geometry();
  assert.equal(value.direction,'left');
  assert.deepEqual(value.order,['1','2','3']);
  assert.deepEqual(offsets(value),{'1':0,'2':-86,'3':-172});
  assert.equal(200+value.offsets.get('1'),200);
  assert.equal(value.anchorOffset,0);
  assert.equal(value.overflow,false);
});

test('direction anchor: enough right space keeps the same anchor and logical sequence',()=>{
  const value=geometry({viewportRight:600});
  assert.equal(value.direction,'right');
  assert.deepEqual(value.order,['1','2','3']);
  assert.deepEqual(offsets(value),{'1':0,'2':86,'3':172});
  assert.equal(value.anchorOffset,0);
});

test('direction anchor: mixed widths reflect boxes with exactly six pixels between logical neighbours',()=>{
  const widths=new Map([['1',80],['2',120],['3',40]]),value=geometry({widths});
  assert.deepEqual(offsets(value),{'1':0,'2':-126,'3':-172});
  assert.equal(value.width,252);
  assert.equal(value.offsets.get('1')-(value.offsets.get('2')+widths.get('2')),6);
  assert.equal(value.offsets.get('2')-(value.offsets.get('3')+widths.get('3')),6);
});

test('direction anchor: changing side never changes or mutates selected-first canonical order',()=>{
  const ids=Object.freeze(['2','1','3','4']),widths=new Map(ids.map(id=>[id,80]));
  const right=geometry({ids,representative:'2',widths,viewportRight:700});
  const left=geometry({ids,representative:'2',widths,viewportRight:300});
  assert.deepEqual(right.order,ids);assert.deepEqual(left.order,ids);
  assert.notEqual(left.order,ids);assert.equal(left.offsets.get('2'),0);
  assert.deepEqual([...left.offsets.values()],[0,-86,-172,-258]);
  assert.deepEqual([...widths.keys()],ids);
});

test('direction anchor: member-origin preview with interior representative keeps IDs and its exact anchor',()=>{
  const ids=['3','2','1'],widths=new Map([['3',40],['2',120],['1',80]]);
  const value=geometry({ids,representative:'2',widths,viewportRight:350});
  assert.equal(value.direction,'left');
  assert.deepEqual(value.order,ids);
  assert.deepEqual(offsets(value),{'1':-86,'2':0,'3':126});
  assert.equal(value.anchorOffset,0);
});

test('direction anchor: over-wide OPEN reports overflow without translating the representative',()=>{
  const value=geometry({widths:new Map([['1',80],['2',220],['3',180]])});
  assert.equal(value.direction,'left');assert.equal(value.overflow,true);
  assert.deepEqual(offsets(value),{'1':0,'2':-226,'3':-412});
  assert.equal(value.anchorOffset,0);
});

test('direction anchor: same IDs and anchor may change side when measured widths change',()=>{
  const right=geometry({anchorLeft:100,viewportRight:400});
  const left=geometry({anchorLeft:100,viewportRight:400,widths:new Map([['1',80],['2',180],['3',80]])});
  assert.equal(right.direction,'right');assert.equal(left.direction,'left');
  assert.deepEqual(left.order,right.order);assert.equal(left.offsets.get('1'),right.offsets.get('1'));
  assert.deepEqual(offsets(left),{'1':0,'2':-186,'3':-272});
});

test('direction anchor: partial, duplicate or nonfinite geometry stays unavailable',()=>{
  for(const options of [{widths:new Map([['1',80],['2',80]])},{ids:['1','2','2']},
    {widths:new Map([['1',80],['2',NaN],['3',80]])},{viewportLeft:NaN},{gap:-1}])
    assert.throws(()=>geometry(options),/strip_group_geometry_unavailable/);
});

test('direction anchor: OFF retains accepted minimal OPEN-fit rather than selected-first arrangement',()=>{
  const options={ids:['1','2','3'],representative:'1',widths:new Map([['1',80],['2',80],['3',80]]),
    anchorLeft:200,viewportLeft:0,viewportRight:300,gap:6};
  const fit=fitPaneStripGroupAtAnchor(options),selected=directionalPaneStripGroup(options);
  assert.deepEqual(fit.order,['2','3','1']);assert.equal(fit.changed,true);
  assert.equal(paneStripGroupOffsets(fit.order,options.widths,6,'1').get('1'),0);
  assert.deepEqual(selected.order,['1','2','3']);assert.equal(selected.offsets.get('1'),0);
});
