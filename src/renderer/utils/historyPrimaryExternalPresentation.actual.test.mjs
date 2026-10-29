import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { HistoryPrimaryRootReadModel } from './historyPrimaryRootReadModel.mjs';
import { patchHistoryVirtuoso } from '../../../scripts/lib/history-virtuoso-measurement.mjs';
import * as panelInputs from './historyPrimaryPanelBindings.mjs';
import { historyPrimaryToolClaimFingerprint } from './historyPrimaryRootReadModel.mjs';
import { createHistoryPrimaryItemAdmission } from './historyPrimaryItemAdmission.mjs';
const require=createRequire(import.meta.url),ts=require('typescript');
const EVENT='history-panel:external-presentation';
function rig({visible=false,gate=null}={}){
 const slots=[],layouts=[],effects=[],microtasks=[],listeners=new Map();let cursor=0,dirty=false;
 const depsSame=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>v===b[i]);
 const memo=(fn,deps)=>{const at=cursor++,old=slots[at];if(!old||!depsSame(old.deps,deps))slots[at]={value:fn(),deps};return slots[at].value;};
 const effect=(fn,deps,queue)=>{const at=cursor++,old=slots[at];if(!old||!depsSame(old.deps,deps)){old?.cleanup?.();const value=slots[at]={deps};queue.push(()=>{value.cleanup=fn();});}};
 const react={createElement:(type,props,...children)=>({type,props:props||{},children}),forwardRef:fn=>fn,
  useRef:value=>{const at=cursor++;return slots[at]||(slots[at]={current:value});},
  useState:value=>{const at=cursor++;if(!slots[at])slots[at]={value:typeof value==='function'?value():value};return [slots[at].value,next=>{const v=typeof next==='function'?next(slots[at].value):next;if(v!==slots[at].value){slots[at].value=v;dirty=true;}}];},
  useMemo:memo,useCallback:(fn,deps)=>memo(()=>fn,deps),useLayoutEffect:(fn,deps)=>effect(fn,deps,layouts),useEffect:(fn,deps)=>effect(fn,deps,effects)};
 const window={addEventListener:(n,fn)=>{if(!listeners.has(n))listeners.set(n,new Set());listeners.get(n).add(fn);},removeEventListener:(n,fn)=>listeners.get(n)?.delete(fn)};
 const module={exports:{}};
 const code=ts.transpileModule(readFileSync(new URL('../components/Workspace/HistoryPrimaryRootSurface.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,console,window,queueMicrotask:fn=>microtasks.push(fn),
  require:name=>name==='react'?react:name==='react-virtuoso'?{Virtuoso:'Virtuoso'}:name.includes('historyPresentationOwnership')?{HISTORY_SURFACE_PRESENTATION_EVENT:EVENT}:name.includes('historyPrimaryItemAdmission')?{createHistoryPrimaryItemAdmission}:{} });
 const m=new HistoryPrimaryRootReadModel(null,null),calls=[],covered=[];
 m.view={header:{leaseId:'L',generation:'W',totalEntries:7},adoptionId:1,address:{tabId:'own'},reader:{},unitAddresses:new WeakMap()};
 m.presentation={scope:{ownerKey:'own',generation:1,visit:visible?1:0,presented:visible},adoptionId:1,leaseId:'L',outcome:null,waiters:new Set()};
 m.windowDiagnostic=()=>{};
 m.readWindow=async(start,end,options)=>{calls.push({start,end,options});if(gate)await gate;if(!options.owns())throw Object.assign(Error('cancelled'),{code:'HISTORY_READ_CANCELLED'});for(let i=start;i<=end;i++){const unit={kind:'entry',entry:{uuid:'u'+i}},address={index:i,physicalKey:'entry:u'+i,header:m.header,cut:{...m.header}};m.window.set(i,unit);m.addresses.set(i,address);m.view.unitAddresses.set(unit,address);}m.notify();};
 const proof={current:{presented:visible,visit:visible?1:0}};
 const props={primaryRoot:m,legacyData:[],rootRevision:1,presentationScope:{ownerKey:'own',generation:1,visit:0,presented:false},
  presentationChannel:'owned-channel',presentationRef:proof,renderUnit:()=>null,captionSelections:()=>[],onRootError:e=>{throw e},inputsCurrent:()=>true,unitMatches:()=>true,onWindowCommit:v=>covered.push(v)};
 let tree;
 const render=()=>{cursor=0;dirty=false;tree=module.exports.HistoryPrimaryRootSurface(props,null);while(layouts.length)layouts.shift()();while(effects.length)effects.shift()();return tree;};
 const flush=async()=>{for(let i=0;i<12;i++){while(microtasks.length)microtasks.shift()();await Promise.resolve();if(dirty)render();else if(!microtasks.length){await Promise.resolve();if(!dirty)break;}}return tree;};
 const dispatch=(presented,channel='owned-channel')=>{for(const fn of [...listeners.get(EVENT)||[]])fn({detail:{channel,presented,geometryStable:true}});};
 return {m,calls,covered,proof,props,render,flush,dispatch,window,get tree(){return tree;}};
}
test('actual Surface reads the current retained proof rather than its mount-time false prop',async()=>{
 const r=rig({visible:true});r.render();await r.flush();assert(r.calls.length>0,'visible retained surface must bootstrap data');
 assert.equal(r.m.surface.presented,true);assert.equal(r.m.presentation.outcome,null,'data is not paint proof');
});
test('a channel reveal wakes only the small Surface without a parent prop change',async()=>{
 const r=rig();r.render();await r.flush();assert.equal(r.calls.length,0);
 // Child listeners run before the heavy parent updates its shared proof.
 r.dispatch(true);r.proof.current={presented:true,visit:1};await r.flush();
 assert(r.calls.length>0);assert.equal(r.m.surface.presented,true);assert.equal(r.m.surface.visit,1);
 const n=r.calls.length;r.dispatch(true);r.dispatch(true,'foreign-channel');await r.flush();assert.equal(r.calls.length,n);
});
test('hide revokes an in-flight surface synchronously and never certifies a placeholder',async()=>{
 let release;const gate=new Promise(r=>release=r),r=rig({visible:true,gate});r.render();await r.flush();assert(r.calls.length>0);
 const view=r.m.view;r.dispatch(false);assert.equal(r.m.surface,null,'hide must revoke before another React commit');
 r.proof.current={presented:false,visit:1};release();await r.flush();assert.equal(r.m.window.size,0);
 assert.equal(r.m.view,view);assert.equal(r.m.closed,false);assert.equal(r.covered.length,0);
});
test('actual Surface wires bounded admission before keys and commits only measured admitted rows',async()=>{
 const r=rig({visible:true});r.render();await r.flush();
 const props=r.tree.props,context=props.context;
 assert.equal(context.historyPrimaryItemAdmission(0),true);
 assert.equal(props.computeItemKey(0),'entry:u0');
 assert.equal(context.historyPrimaryItemAdmission(6),false);
 assert.throws(()=>props.computeItemKey(6),/HISTORY_PRIMARY_KEY_NOT_ADMITTED/);
 const pending=context.historyPrimaryPendingItem(6,93);
 assert.equal(pending.props['data-index'],undefined);
 assert.equal(pending.props['data-item-index'],undefined);
 context.historyOnPrimaryWindowCommit({totalCount:7,startIndex:0,endIndex:0,itemCount:1,admittedCount:0,stable:true});
 assert.equal(r.covered.length,0,'a stable placeholder is not a paint receipt');
 context.historyOnPrimaryWindowCommit({totalCount:7,startIndex:0,endIndex:0,itemCount:1,admittedCount:1,stable:true});
 assert.equal(r.covered.length,1);
});
test('changed local composition revokes actual Surface admission before a new body demand',async()=>{
 const r=rig({visible:true});r.props.inputsCurrent=()=>false;r.render();await r.flush();
 assert.equal(r.calls.length,0);assert.equal(r.tree.props.context.historyPrimaryItemAdmission(0),false);
 assert.equal(r.m.presentation.outcome?.status,'superseded');assert.equal(r.covered.length,0);
});
test('a primary owner without an adopted view renders status and cannot fall through to legacy rows',async()=>{
 const r=rig({visible:true});r.m.view=null;
 const legacy=[{kind:'entry',entry:{uuid:'unproved-metadata'}}];let legacyBodies=0,legacyKeys=0;
 r.props.legacyData=legacy;r.props.renderUnit=()=>{legacyBodies++;};r.props.computeItemKey=()=>{legacyKeys++;return 'forbidden';};
 r.render();await r.flush();
 assert.equal(r.tree.type,'div');assert.equal(r.tree.props.role,'status');
 assert.equal(r.tree.props['data-history-primary-root-state'],'loading');
 assert.equal(r.tree.props.totalCount,undefined);assert.equal(r.tree.props.data,undefined);
 assert.equal(r.calls.length,0);assert.equal(legacyBodies,0);assert.equal(legacyKeys,0);
 r.m.closed=true;r.props.rootRevision++;r.render();await r.flush();
 assert.equal(r.tree.props['data-history-primary-root-state'],'unavailable');
 assert.equal(r.tree.type,'div');assert.equal(r.covered.length,0);
 const closed=rig({visible:true});closed.m.closed=true;closed.props.legacyData=legacy;closed.render();await closed.flush();
 assert.equal(closed.tree.type,'div');assert.equal(closed.tree.props['data-history-primary-root-state'],'unavailable');
 assert.equal(closed.calls.length,0,'a closed owner cannot reuse a captured nonempty snapshot');
 const permitted=rig();permitted.props.primaryRoot=null;permitted.props.legacyData=legacy;permitted.render();
 assert.equal(permitted.tree.type,'Virtuoso');assert.equal(permitted.tree.props.data,legacy,
   'explicit legacy/composite owner remains supported');
});


// Real Surface callbacks + real hash-pinned Hn. Only hooks/JSX/Mn geometry and
// finite body preparation are doubles; no locally reconstructed row callback order.
const upstream = readFileSync(require.resolve('react-virtuoso').replace(/index\.cjs$/, 'index.mjs'), 'utf8');
const actualHn = patchHistoryVirtuoso(upstream);
function renderHn(props, count) {
 const start=actualHn.indexOf('Hn = /* @__PURE__ */ E.memo('),end=actualHn.indexOf('\n}), hr =',start)+3;
 const layouts=[],listState={totalCount:count,firstItemIndex:0,offsetTop:0,offsetBottom:0,top:0,bottom:count*32,
  topItems:[],items:Array.from({length:count},(_,index)=>({index,originalIndex:index,offset:index*32,size:32}))};
 const values={listState,context:props.context,itemContent:props.itemContent,computeItemKey:props.computeItemKey,
  groupIndices:[],initialItemFinalLocationReached:true,ItemComponent:'row',ListComponent:'list',EmptyPlaceholder:null};
 const jsx=(type,props,...children)=>({type,props,children});
 const runtime={E:{memo:fn=>fn,useRef:value=>({current:value}),useState:value=>[value,()=>{}],useLayoutEffect:fn=>layouts.push(fn)},
  A:name=>values[name],Ct:()=>()=>{},on:()=>{},Mn:()=>({callbackRef:()=>{}}),Jt:()=>{},fr:'seek',
  ot:()=>({}),ao:()=>({}),G:jsx,Dt:jsx,mr:{},pr:{},uo:{}};
 const Hn=new Function(...Object.keys(runtime),'return '+actualHn.slice(start+5,end))(...Object.values(runtime));
 return {tree:Hn({}),commit(){for(const fn of layouts)fn();}};
}
async function transactionRig(count=16) {
 const r=rig({visible:true});r.m.view.header.totalEntries=count;
 await r.m.readWindow(0,count-1,{owns:()=>true});
 const presentation={localEntries:[],liveEntries:[{uuid:'live',content:'x'.repeat(1024*1024)}],
  liveToolResults:null,rewindPreview:null,grouping:{enabled:true,threshold:2,expandedKeys:[]},captionSelections:[],settingsPresentationKeys:[]};
 const current={root:r.m,header:r.m.header,ownerKey:'own',entries:[],rewind:null,presentation,
  live:{ownerKey:'own',entries:presentation.liveEntries},results:{ownerKey:'own',results:new Map()},suppressions:new Map(),captions:new Map()};
 let hashes=0,bodies=0;
 const previousWindow=globalThis.window;globalThis.window={require};
 const fingerprint=value=>{hashes++;return historyPrimaryToolClaimFingerprint(value);};
 const witness=panelInputs.captureHistoryPrimaryPanelWitness({...current,
  fingerprint:panelInputs.historyPrimaryPanelInputFingerprint(presentation,[],[],fingerprint)});
 const read=()=>({...current,witness});
 // Red control runs old production predicates; the final path uses the scoped owner.
 const transaction=panelInputs.createHistoryPrimaryPanelInputTransaction
  ? panelInputs.createHistoryPrimaryPanelInputTransaction(read,fingerprint)
  : {current:()=>panelInputs.historyPrimaryPanelWitnessCurrent(witness,current,fingerprint),run:fn=>fn()};
 r.props.inputsCurrent=transaction.current;r.props.inputTransaction=transaction.run;
 r.props.unitMatches=(index,unit)=>transaction.current()&&r.m.addressAt(index)?.physicalKey==='entry:'+unit.entry.uuid;
 r.props.renderUnit=()=>{assert.equal(transaction.current(),true);bodies++;return null;};
 r.render();await r.flush();hashes=0;
 return {...r,current,presentation,transaction,
  renderList:()=>renderHn(r.tree.props,count),reset:()=>{hashes=bodies=0;},stats:()=>({hashes,bodies}),
  restore(){if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;}};
}
test('actual Surface/Hn full proof is once per transaction, independent of 1 vs 16 ready rows / 1MiB input',async()=>{
 for(const count of [16,1]){
  const r=await transactionRig(count);
  try{
   const list=r.renderList();
   assert.deepEqual(r.stats(),{hashes:1,bodies:count});
   r.reset();list.commit();
   assert.equal(r.stats().hashes,1,'commit is a fresh proof, not one full hash per matched row');
   assert.equal(r.covered.length,1);
  }finally{r.restore();}
 }
});
test('same-reference live mutation at next actual Hn render or commit revokes old input proof',async()=>{
 for(const phase of ['render','commit']){
  const r=await transactionRig();
  try{
   const before=r.renderList();r.reset();
   r.presentation.liveEntries[0].content='new same-object content';
   if(phase==='render'){
    r.renderList();
    assert.deepEqual(r.stats(),{hashes:1,bodies:0});
   }else{
    before.commit();
    assert.equal(r.stats().hashes,1);assert.equal(r.covered.length,0);
    assert.equal(r.m.presentation.outcome.status,'superseded');
   }
  }finally{r.restore();}
 }
});
test('render admission does not certify a cancelled actual Surface commit',async()=>{
 const r=await transactionRig();
 try{
  const list=r.renderList();r.dispatch(false);r.proof.current={presented:false,visit:1};
  list.commit();
  assert.equal(r.covered.length,0);assert.equal(r.m.hasCurrentPresentationCoverage({ownerKey:'own',generation:1,visit:1,presented:true}),false);
 }finally{r.restore();}
});

test('input transaction revokes changed bindings, explicit cancellation, nested runs and exceptional exits',async()=>{
 const r=await transactionRig(1);
 try{
  r.transaction.run(()=>{
   assert.equal(r.transaction.current(),true);
   const previous=r.current.captions;r.current.captions=new Map();
   assert.equal(r.transaction.current(),false);
   r.current.captions=previous;
   assert.equal(r.transaction.current(),false,'restoring a binding cannot revive its old version');
  });
  r.transaction.run(()=>{
   assert.equal(r.transaction.current(),true);r.transaction.invalidate();
   assert.equal(r.transaction.current(),false);
  });
  r.transaction.run(()=>{
   assert.equal(r.transaction.current(),true);
   r.transaction.run(()=>assert.equal(r.transaction.current(),true));
   assert.equal(r.transaction.current(),false,'nested proof does not revive the outer transaction');
  });
  assert.throws(()=>r.transaction.run(()=>{throw Error('exit');}),/exit/);
  assert.throws(()=>r.transaction.run(()=>Promise.resolve(true)),/INPUT_TRANSACTION_ASYNC/);
  r.reset();r.presentation.liveEntries[0].content='after return/throw/thenable';
  assert.equal(r.transaction.current(),false);assert.equal(r.stats().hashes,1,'no cached proof leaked out');
 }finally{r.restore();}
});
test('same-reference authoring, results, suppressions, captions and grouping changes revoke next transaction',async()=>{
 for(const mutate of [
  r=>r.presentation.localEntries.push({uuid:'local',content:'new authoring'}),
  r=>r.current.results.results.set('T',{result:'new result'}),
  r=>r.current.suppressions.set('S',{uuid:'suppressed'}),
  r=>r.current.captions.set('G','new caption'),
  r=>r.presentation.grouping.expandedKeys.push('G'),
 ]){
  const r=await transactionRig(1);
  try{
   r.renderList();r.reset();mutate(r);r.renderList();
   assert.equal(r.stats().bodies,0);assert.equal(r.stats().hashes,1);
  }finally{r.restore();}
 }
});
test('one synchronous transaction cannot admit rows after its exact cut changes',async()=>{
 const r=await transactionRig(1);
 try{
  const original=r.m.header;
  r.transaction.run(()=>{
   assert.equal(r.transaction.current(),true);
   r.m.view.header={...original,leaseId:'changed'};
   r.current.header=r.m.header;
   assert.equal(r.transaction.current(),false);
   r.m.view.header=original;r.current.header=original;
   assert.equal(r.transaction.current(),false);
  });
  r.renderList();assert(r.stats().bodies>0,'next fresh transaction can prove restored current inputs');
 }finally{r.restore();}
});
