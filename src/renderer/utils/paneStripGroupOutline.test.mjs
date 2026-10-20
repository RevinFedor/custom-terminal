import test from 'node:test';import assert from 'node:assert/strict';
import {buildPaneStripGroupOutlines,stripSilhouetteEdges} from './paneStripGroupOutline.mjs';
const chip=(id,left,top=0)=>({id,left,right:left+80,top,bottom:top+24});
test('outline follows file bump and returns to the card base between attachments',()=>{
  const a=chip('a',0),b=chip('b',86);a.files=[{left:6,right:60,top:20,bottom:31}];b.files=[{left:92,right:130,top:20,bottom:31}];
  const [p]=buildPaneStripGroupOutlines({chips:[a,b],groups:[{id:'g',tabIds:['a','b'],color:'#123456'}]});
  assert.ok(p.solid);assert.equal(p.dashed,'');
  assert.ok(p.edges.some(e=>e.y1===31.5&&e.y2===31.5));
  assert.ok(p.edges.some(e=>e.y1===24.5&&e.y2===24.5&&e.x1>=60.5&&e.x2<=91.5));
  assert.ok(!p.edges.some(e=>e.y1===31.5&&e.y2===31.5&&e.x1<60&&e.x2>92));
});
test('noncontiguous members cannot put a foreign intervening chip inside a frame',()=>{
  const output=buildPaneStripGroupOutlines({chips:[chip('a',0),chip('foreign',86),chip('c',172)],groups:[{id:'g',tabIds:['a','c'],color:'#fff'}]});
  assert.equal(output.length,2);assert.deepEqual(output.map(p=>p.tabIds),[['a'],['c']]);
  assert.ok(output.every(p=>!p.edges.some(e=>e.x1<86&&e.x2>166)));
});
test('wrapped group has solid occupied silhouette and only the unoccupied upper tail is dashed',()=>{
  const output=buildPaneStripGroupOutlines({chips:[chip('foreign',0),chip('a',86),chip('b',0,36),chip('c',86,36),chip('other',172,36)],
    groups:[{id:'g',tabIds:['a','b','c'],color:'#123456'}],rows:[{top:0,left:0,right:300},{top:36,left:0,right:300}]});
  assert.equal(output.length,2);assert.ok(output[0].solid);assert.ok(output[0].dashed);
  assert.equal(output[1].dashed,'');assert.ok(output[0].edges.filter(e=>e.dashed).every(e=>e.x1>=166.5&&e.x2>=166.5));
  assert.ok(output[1].edges.every(e=>e.x1<=166.5&&e.x2<=166.5));
});
test('a foreign trailing chip prevents drawing a dashed tail across it; first row honors the action-block edge',()=>{
  const groups=[{id:'g',tabIds:['a','b'],color:'#123456'}];
  const [bounded]=buildPaneStripGroupOutlines({chips:[chip('a',0),chip('b',0,36)],groups,rows:[{top:0,left:0,right:120},{top:36,left:0,right:200}]});
  assert.equal(bounded.clip.right,120);assert.ok(bounded.edges.some(e=>e.x2>120));
  const [foreign]=buildPaneStripGroupOutlines({chips:[chip('a',0),chip('foreign',86),chip('b',0,36)],groups,rows:[{top:0,left:0,right:300}]});
  assert.equal(foreign.dashed,'');
});
test('union has no internal boundary where card and its overlapping file meet',()=>{
  const edges=stripSilhouetteEdges([{left:0,right:80,top:0,bottom:24},{left:6,right:60,top:20,bottom:31}]);
  assert.ok(!edges.some(e=>e.y1===20&&e.y2===20));
  assert.ok(!edges.some(e=>e.y1===24&&e.y2===24&&e.x1>=6&&e.x2<=60));
});

test('rounded single-card frame has four circular corners at the configured tab radius',()=>{
 const [p]=buildPaneStripGroupOutlines({chips:[chip('a',0)],groups:[{id:'g',tabIds:['a'],color:'#123456'}],radius:6});
 assert.equal((p.solid.match(/A6 6 /g)||[]).length,4);assert.equal(p.dashed,'');
 assert.ok(p.solid.includes('M-0.5 5.5A6 6 0 0 1 5.5 -0.5'));
 assert.ok(p.solid.includes('A6 6 0 0 0 74.5 -0.5'));
 assert.equal(Math.min(...p.edges.flatMap(e=>[e.x1,e.x2])),-.5);
 assert.equal(Math.max(...p.edges.flatMap(e=>[e.y1,e.y2])),24.5);
});
test('file bump rounds both outward and inward turns without adding an internal boundary',()=>{
 const a=chip('a',0);a.files=[{left:6,right:60,top:20,bottom:31}];
 const [p]=buildPaneStripGroupOutlines({chips:[a],groups:[{id:'g',tabIds:['a'],color:'#123456'}],radius:6});
 assert.ok((p.solid.match(/A/g)||[]).length>=8);
 assert.ok(/A[\d.]+ [\d.]+ 0 0 0 /.test(p.solid));assert.ok(/A[\d.]+ [\d.]+ 0 0 1 /.test(p.solid));
 assert.ok(!p.edges.some(e=>e.y1===20&&e.y2===20));
 assert.ok(!/NaN|Infinity/.test(p.solid));
});
test('wrapped rows stay open at both strip edges and round only the actual group ends',()=>{
 const [first,last]=buildPaneStripGroupOutlines({chips:[chip('a',0),chip('b',0,36)],groups:[{id:'g',tabIds:['a','b'],color:'#123456'}],rows:[{top:0,left:0,right:120},{top:36,left:0,right:200}],radius:6});
 assert.equal((first.solid.match(/A6 6 /g)||[]).length,2);assert.ok(!first.dashed.includes('A'));
 assert.ok(first.edges.filter(e=>e.dashed).every(e=>e.y1===e.y2));
 assert.ok(first.edges.filter(e=>e.dashed).every(e=>e.x2>120),'horizontal dashes reach beyond the clipped edge');
 assert.ok(!last.edges.some(e=>e.x1===e.x2&&e.x1<=0),'continued row must not close on its left');
 assert.equal((last.solid.match(/A6 6 /g)||[]).length,2);
 assert.equal(first.clip.right,120);assert.equal(last.clip.left,0);
});
test('a middle row has two open ends, dashed empty margins and an intact file bump',()=>{
 const middle=chip('b',12,36);middle.files=[{left:20,right:70,top:56,bottom:67}];
 const [first,p,last]=buildPaneStripGroupOutlines({chips:[chip('a',0),middle,chip('c',0,72)],groups:[{id:'g',tabIds:['a','b','c'],color:'#fff'}],rows:[{top:0,left:0,right:120},{top:36,left:0,right:150},{top:72,left:0,right:200}],radius:6});
 assert.ok(p.edges.some(e=>e.dashed&&e.x1<0));assert.ok(p.edges.some(e=>e.dashed&&e.x2>150));
 assert.ok(!p.edges.some(e=>e.x1===e.x2&&(e.x1<0||e.x1>150)));
 assert.ok(p.edges.some(e=>e.y1===67.5&&e.y2===67.5&&e.x1<=20&&e.x2>=70));
 assert.deepEqual([p.clip.left,p.clip.right],[0,150]);assert.ok(first.solid.includes('A6 6'));assert.ok(last.solid.includes('A6 6'));
});
test('tight chip geometry bounds large corner radius and zero radius keeps the original silhouette',()=>{
 const options={chips:[{id:'a',left:0,right:4,top:0,bottom:2}],groups:[{id:'g',tabIds:['a'],color:'#123456'}]};
 const [rounded]=buildPaneStripGroupOutlines({...options,radius:999}),[square]=buildPaneStripGroupOutlines({...options,radius:0});
 assert.equal((rounded.solid.match(/A1.5 1.5 /g)||[]).length,4);assert.ok(!square.solid.includes('A'));
 assert.deepEqual(rounded.edges,square.edges);
});
