import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformSync} from 'esbuild';

// Execute the shipped callbacks, including await/false behavior. These bounded
// consumer checks complement the actual App/Root Electron matrix.
async function callback(file,name,context) {
  const source=await readFile(new URL('../components/Workspace/'+file,import.meta.url),'utf8');
  const from=source.indexOf('const '+name+' = useCallback(');
  assert.ok(from>=0);
  const start=from+('const '+name+' = useCallback(').length;
  const end=source.indexOf('\n  },',start)+4;
  assert.ok(end>start);
  const code=transformSync('const actual = '+source.slice(start,end)+';',{loader:'tsx',target:'es2022'}).code;
  return new Function(...Object.keys(context),code+'return actual;')(...Object.values(context));
}
function target() {
  let release;const calls=[],effects=[];
  const promise=new Promise(resolve=>{release=resolve;});
  return {calls,effects,release,useWorkspaceStore:{getState:()=>({openTabById:(...args)=>{calls.push(args);return promise;}})}};
}
for (const [file,name,extra,args] of [
  ['ResourceUsageButton.tsx','openResourceTab',{},['target']],
  ['RunAfterTabPicker.tsx','navigateToSelectedTab',{selectedTab:{id:'target'},selectedTabProjectId:'exact-legacy'},[]],
]) {
  test(name+' keeps popup on delayed false and closes only after true',async()=>{
    for(const acknowledged of [false,true]){
      const t=target();const actual=await callback(file,name,{...extra,useWorkspaceStore:t.useWorkspaceStore,setOpen:value=>t.effects.push(value)});
      const pending=actual(...args);assert.equal(t.calls[0][0],'target');assert.deepEqual(t.effects,[]);
      t.release(acknowledged);await pending;assert.deepEqual(t.effects,acknowledged?[false]:[]);
    }
  });
}
test('queued Rewind never publishes picker request before Root positive ACK',async()=>{
  for(const acknowledged of [false,true]){
    const t=target();let requestId;const published=[];
    const actual=await callback('PromptQueueOverlay.tsx','requestQueuedRewindTarget',{tabId:'target',embedded:true,useWorkspaceStore:t.useWorkspaceStore,
      setRewindTargetRequestId:value=>{requestId=value;},setMetaActionsMenu:()=>{},publishQueuedRewindTarget:(...args)=>published.push(args)});
    const pending=actual();assert.deepEqual(published,[]);t.release(acknowledged);await pending;
    assert.deepEqual(published,acknowledged?[['target',requestId]]:[]);
  }
});
test('iteration hit waits for exact Root ACK before opening History or scrolling',async()=>{
  for(const acknowledged of [false,true]){
    const t=target();const actual=await callback('TabSwitcherOverlay.tsx','openIterationHit',{resolveIterationTarget:()=>({projectId:'exact',tabId:'target',entryUuid:'entry'}),
      useWorkspaceStore:t.useWorkspaceStore,useUIStore:{getState:()=>({setHistoryPanelOpen:(...args)=>t.effects.push(['history',...args]),
        setHistoryScrollToUuid:(...args)=>t.effects.push(['scroll',...args])})},requestAnimationFrame:fn=>fn()});
    const pending=actual({});assert.deepEqual(t.effects,[]);t.release(acknowledged);assert.equal(await pending,acknowledged);
    assert.equal(t.effects.length,acknowledged?2:0);
  }
});
