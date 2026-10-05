import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireTerminalFullView, preserveTerminalViewportScroll, resolveTerminalLiftGeometry } from './terminalFullView.mjs';

const bounds = {left:0,top:80,right:1600,bottom:1000};
test('DOM relocation preserves native offsets independently of unchanged xterm buffer coordinates', () => {
  const a={scrollTop:4645,scrollLeft:0,isConnected:true},b={scrollTop:128.5,scrollLeft:9,isConnected:true};
  const host={querySelectorAll:()=>[a,b]};
  preserveTerminalViewportScroll(host,()=>{a.scrollTop=0;b.scrollTop=0;b.scrollLeft=0;});
  assert.equal(a.scrollTop,4645);assert.equal(b.scrollTop,128.5);assert.equal(b.scrollLeft,9);
});

test('relocation failure restores surviving viewports and leaves removed ones alone', () => {
  const a={scrollTop:17,scrollLeft:0,isConnected:true},b={scrollTop:9,scrollLeft:0,isConnected:true};
  assert.throws(()=>preserveTerminalViewportScroll({querySelectorAll:()=>[a,b]},()=>{
    a.scrollTop=0;b.scrollTop=0;b.isConnected=false;throw Error('placement');
  }),/placement/);
  assert.equal(a.scrollTop,17);assert.equal(b.scrollTop,0);
});
test('revealing a cropped top moves only the existing rectangle into view', () => {
  const source=Object.freeze({left:300,top:-40,width:600,height:800});
  const result=resolveTerminalLiftGeometry(source,bounds);
  assert.deepEqual(result,{left:300,top:80,width:600,height:800,viewportWidth:600,viewportHeight:800});
});

test('a panel already within the screen is lifted without moving or resizing it', () => {
  const source={left:850,top:250,width:360,height:500};
  const result=resolveTerminalLiftGeometry(source,bounds);
  for(const key of ['left','top','width','height'])assert.equal(result[key],source[key]);
});

test('a small app clips a scroll viewport instead of changing the terminal dimensions', () => {
  const source=Object.freeze({left:300,top:100,width:600.375,height:800.5});
  for(const [width,height] of [[420,300],[1600,1000],[200,100]]) {
    const result=resolveTerminalLiftGeometry(source,{left:0,top:0,right:width,bottom:height});
    assert.equal(result.width,source.width);assert.equal(result.height,source.height);
    assert.ok(result.viewportWidth<=width&&result.viewportHeight<=height);
    assert.ok(result.left>=0&&result.top>=0);
    assert.ok(result.left+result.viewportWidth<=width&&result.top+result.viewportHeight<=height);
  }
});

test('only one presentation lease owns the raised view; stale release cannot clear its successor', () => {
  const closed=[];
  const a=acquireTerminalFullView(()=>closed.push('A'));
  const b=acquireTerminalFullView(()=>closed.push('B'));assert.deepEqual(closed,['A']);
  a();const c=acquireTerminalFullView(()=>closed.push('C'));assert.deepEqual(closed,['A','B']);
  b();c();const d=acquireTerminalFullView(()=>closed.push('D'));assert.deepEqual(closed,['A','B']);d();
});
