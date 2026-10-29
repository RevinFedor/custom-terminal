import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const source=fs.readFileSync(fileURLToPath(new URL('../components/Workspace/HistoryPanel.tsx',import.meta.url)),'utf8');
const start=source.indexOf('const revealCompositeWorkActions = useCallback');
const marker='}, [tabId]);',end=source.indexOf(marker,start)+marker.length;
assert.ok(start>=0&&end>start,'the actual composite reveal callback must exist');
const compiled=transformSync(source.slice(start,end),{loader:'ts',format:'cjs'}).code;

function fixture(offset=-100){
  const frames=[],events=[],owner={current:'owner'},generation={current:1},gesture={current:3},sequence={current:0};
  const presentation={current:{visit:7,presented:true}};
  const scroller={isConnected:true,scrollTop:200,getBoundingClientRect:()=>({top:0})};
  const anchor={isConnected:true,getBoundingClientRect:()=>({top:offset})};
  const fn=new Function('useCallback','findHistoryScrollParent','historyOwnerKeyRef',
    'historyOwnerGenerationRef','historyUserGestureGenerationRef','historyPresentationProofRef','compositeRevealSequenceRef',
    'applyHistoryRevealUpdate','requestAnimationFrame','historyPresentationOwnsWrite','historyDiag','tabId',
    compiled+'; return revealCompositeWorkActions;')(
      callback=>callback,()=>scroller,owner,generation,gesture,presentation,sequence,
      (_anchor,opening,commit)=>{events.push(opening?'open':'close');commit();},
      callback=>frames.push(callback),(current,visit)=>current.presented&&current.visit===visit,()=>{},'test-tab');
  return {fn,anchor,scroller,frames,events,owner,generation,gesture,presentation,sequence};
}
function flush(frames){while(frames.length)frames.shift()();}

test('actual rail collapse commits once and returns an offscreen header to view',()=>{
  const f=fixture();let commits=0;f.fn(f.anchor,false,()=>commits++,'rail');
  assert.equal(commits,1);assert.equal(f.scroller.scrollTop,200);flush(f.frames);
  assert.equal(f.scroller.scrollTop,92);assert.deepEqual(f.events,['close']);
});

test('a newer user gesture or owner invalidates the deferred landing',()=>{
  for(const change of ['gesture','owner','visit','new-toggle']){
    const f=fixture();f.fn(f.anchor,false,()=>{},'foot');
    if(change==='gesture')f.gesture.current++;
    if(change==='owner')f.owner.current='other';
    if(change==='visit')f.presentation.current.visit++;
    if(change==='new-toggle')f.fn(f.anchor,true,()=>{},'header');
    flush(f.frames);assert.equal(f.scroller.scrollTop,200,change);
  }
});

test('visible-header and opening clicks never schedule a landing scroll',()=>{
  const visible=fixture(12);visible.fn(visible.anchor,false,()=>{},'rail');assert.equal(visible.frames.length,0);
  const opening=fixture();opening.fn(opening.anchor,true,()=>{},'header');assert.equal(opening.frames.length,0);
});
