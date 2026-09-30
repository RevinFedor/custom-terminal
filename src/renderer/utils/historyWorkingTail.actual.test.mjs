import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {transformSync} from 'esbuild';
import {createHistoryTailPinScheduler} from './historyBottomScroll.mjs';
const source=fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('HistoryPanel.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function extract(name){let value;function walk(n){if(ts.isVariableDeclaration(n)&&n.name.getText(tree)===name){
 value=ts.isCallExpression(n.initializer)&&n.initializer.expression.getText(tree)==='useCallback'
  ?n.initializer.arguments[0].getText(tree):n.initializer.getText(tree);
 }ts.forEachChild(n,walk);}walk(tree);assert.ok(value,name);return value;}
function install(scope,name){vm.runInContext(transformSync(`globalThis.${name}=${extract(name)};`,{loader:'tsx',format:'cjs',target:'es2022'}).code,scope);}
function timingFixture(){
 const requests=[],changes=[];
 const scope=vm.createContext({tabId:'tab',toolType:'codex',runtime:{logPrefix:'Test'},
  tabIdRef:{current:'tab'},activityTimingOwnerKeyRef:{current:'tab:codex'},activityTimingRequestSeqRef:{current:0},
  pasteBusyRef:{current:false},setActivityTiming:v=>changes.push(['activity',v]),setPasteActivityStartedAt:v=>changes.push(['paste',v]),
  setIsPasteBusy:()=>{},advanceHistoryPromptHandoffTransportPhase:()=>{},console:{warn(){},log(){}},
  ipcRenderer:{invoke:()=>new Promise((resolve,reject)=>requests.push({resolve,reject}))},
 });install(scope,'refreshActivityTiming');install(scope,'handlePasteBusy');
 return {scope,requests,changes};
}
const running={state:'running',startTs:123,sessionId:'s',toolType:'codex'};
const flush=()=>new Promise(setImmediate);
test('paste completion retains provisional Working until the matching activity reply replaces it',async()=>{
 const f=timingFixture();f.scope.handlePasteBusy(null,{tabId:'tab',busy:true});f.changes.length=0;
 f.scope.handlePasteBusy(null,{tabId:'tab',busy:false});assert.equal(f.requests.length,1);assert.deepEqual(f.changes,[]);
 f.requests[0].resolve({success:true,timing:running});await flush();
 assert.equal(f.changes[0][0],'activity');assert.equal(f.changes[0][1].state,'running');assert.deepEqual(f.changes[1],['paste',null]);
});
test('an authoritative empty result or failed read ends the provisional Working rather than inventing work',async()=>{
 for(const failed of [false,true]){const f=timingFixture();f.scope.handlePasteBusy(null,{tabId:'tab',busy:true});f.changes.length=0;
  f.scope.handlePasteBusy(null,{tabId:'tab',busy:false});
  if(failed)f.requests[0].reject(new Error('read failed'));else f.requests[0].resolve({success:true,timing:null});
  await flush();assert.deepEqual(f.changes.at(-1),['paste',null]);
  if(!failed)assert.deepEqual(f.changes[0],['activity',null]);
 }
});
test('stale timing replies cannot clear the next owner or outrun a newer timing request',async()=>{
 for(const ownerChange of [false,true]){const f=timingFixture();f.scope.handlePasteBusy(null,{tabId:'tab',busy:true});f.changes.length=0;
  f.scope.handlePasteBusy(null,{tabId:'tab',busy:false});
  if(ownerChange)f.scope.activityTimingOwnerKeyRef.current='other:codex';else void f.scope.refreshActivityTiming('newer');
  f.requests[0].resolve({success:true,timing:running});await flush();assert.deepEqual(f.changes,[]);
 }
});
test('a new paste still owns its clock when an older reconciliation finishes',async()=>{
 const f=timingFixture();f.scope.handlePasteBusy(null,{tabId:'tab',busy:true});f.scope.handlePasteBusy(null,{tabId:'tab',busy:false});
 f.scope.handlePasteBusy(null,{tabId:'tab',busy:true});f.changes.length=0;
 f.requests[0].resolve({success:true,timing:null});await flush();assert.equal(f.changes.some(([kind])=>kind==='paste'),false);
});
test('duplicate idle paste events do not add timing reads',async()=>{
 const f=timingFixture();f.scope.handlePasteBusy(null,{tabId:'tab',busy:false});assert.equal(f.requests.length,0);
 f.scope.handlePasteBusy(null,{tabId:'tab',busy:true});f.scope.handlePasteBusy(null,{tabId:'tab',busy:false});
 f.scope.handlePasteBusy(null,{tabId:'tab',busy:false});assert.equal(f.requests.length,1);
 f.requests[0].resolve({success:true,timing:null});await flush();
});
test('actual response-timer effect uses the existing bounded writer and cannot rearm a reader or hidden pane',()=>{
 let effect;function walk(n){if(ts.isCallExpression(n)&&n.expression.getText(tree)==='useLayoutEffect'
  &&n.arguments[0]?.getText(tree).includes("keepHistoryTailPinnedAfterMutation('response-timing')"))effect=n.arguments[0].getText(tree);ts.forEachChild(n,walk);}walk(tree);assert.ok(effect);
 for(const scenario of ['tail','reader','hidden','drag','resize','superseded','cancelled']){
  const frames=[],writes=[];let owner='A';
  const scroller={scrollTop:100,scrollHeight:600,clientHeight:400,scrollTo({top}){writes.push(top);this.scrollTop=top-this.clientHeight;}};
  const scheduler=createHistoryTailPinScheduler({getScroller:()=>scroller,getOwnerToken:()=>owner,requestFrame:fn=>frames.push(fn)});
  const scope=vm.createContext({responseTailTiming:running,historyResizeRef:{current:{active:()=>scenario==='resize'}},
   historyPresentationProofRef:{current:{presented:scenario!=='hidden'}},historyPointerScrollActiveRef:{current:scenario==='drag'},
   virtuosoScrollerRef:{current:scroller},isAtBottomRef:{current:scenario!=='reader'},
   historyTailPinScheduler:scheduler,setHistoryTailFollowIntent:()=>{throw Error('must not rearm');},historyDiag:()=>{},tabId:'tab',
   HISTORY_TAIL_MUTATION_MIN_SETTLE_FRAMES:12,HISTORY_TAIL_MUTATION_MAX_SETTLE_FRAMES:48,HISTORY_TAIL_MUTATION_REQUIRED_STABLE_FRAMES:3,
  });install(scope,'keepHistoryTailPinnedAfterMutation');
  vm.runInContext(transformSync('globalThis.effect='+effect,{loader:'tsx',format:'cjs',target:'es2022'}).code,scope);scope.effect();
  if(scenario==='superseded')owner='B';if(scenario==='cancelled')scheduler.cancel();
  let count=0;while(frames.length&&count++<60)frames.shift()();assert.ok(count<60);
  assert.equal(writes.length,scenario==='tail'?1:0,scenario);
 }
});
