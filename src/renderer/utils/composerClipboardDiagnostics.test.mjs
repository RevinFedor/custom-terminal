import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { installUIActionDiagnostics } from './uiPerformanceDiagnostics.mjs';
import { measureComposerClipboardCall, armComposerClipboardOracle, writeMeasuredClipboardText, captureClipboardWriteContext } from './composerClipboardDiagnostics.mjs';

test('measured clipboard calls preserve latest content, errors and privacy without extra native reads', t => {
  const before=Object.getOwnPropertyDescriptor(globalThis,'performance'), documentBefore=globalThis.document;
  let time=100;
  Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>time,timeOrigin:1000}});
  globalThis.document={styleSheets:[]};
  t.after(()=>{Object.defineProperty(globalThis,'performance',before);globalThis.document=documentBefore;});
  const d=installUIActionDiagnostics({now:()=>time,emit() {}});
  const action=d.capture('keydown',90,{},true,{keyClass:'Other',shortcutClass:'Copy',meta:true});
  let value='old',writes=0,reads=0;
  for(const text of ['abc','111','xyz']) {
    measureComposerClipboardCall('write-text',()=>{writes++;value=text;},{chars:text.length});
    assert.equal(measureComposerClipboardCall('read-text',()=>{reads++;return value;}),text);
  }
  assert.equal(writes,3);assert.equal(reads,3);
  assert.deepEqual(action.phases.map(x=>x.chars),[3,3,3,3,3,3]);
  const failure=Error('SECRET clipboard error');const warnings=[];
  t.mock.method(console,'warn',line=>warnings.push(line));
  assert.throws(()=>measureComposerClipboardCall('write-text',()=>{time+=120;throw failure;},{chars:3}),e=>e===failure);
  assert.equal(action.phases.at(-1).failed,true);
  assert.equal(action.phases.at(-1).ms,120);
  assert.equal(JSON.parse(warnings[0].slice(warnings[0].indexOf('{'))).actionId,action.id);
  assert.doesNotMatch(JSON.stringify({phases:action.phases,warnings}),/abc|111|xyz|SECRET/);
});

test('an unavailable native adapter is explicit and diagnostic failure cannot change a result', t => {
  const warnings=[];t.mock.method(console,'warn',line=>warnings.push(line));
  assert.equal(measureComposerClipboardCall('read-text',()=>'',{missing:true}),'');
  assert.equal(JSON.parse(warnings[0].slice(warnings[0].indexOf('{'))).missing,true);
  const metadata=Object.defineProperty({},'missing',{get(){throw Error('diagnostic accessor');}});
  const expected={value:'unchanged'};
  assert.equal(measureComposerClipboardCall('unknown',()=>expected,metadata),expected);
});

test('History/file Copy buttons use the same phase/action and preserve one native call without content logging', t => {
  const old=Object.getOwnPropertyDescriptor(globalThis,'performance'), oldDocument=globalThis.document;
  let time=100, calls=0;const logs=[];
  Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>time,timeOrigin:1000}});
  globalThis.document={styleSheets:[]};
  t.after(()=>{Object.defineProperty(globalThis,'performance',old);globalThis.document=oldDocument;});
  t.mock.method(console,'warn',line=>logs.push(line));
  const d=installUIActionDiagnostics({now:()=>time,emit(){}}), action=d.capture('click',90,{},true);
  const clipboard={writeText(text){assert.equal(this,clipboard);assert.equal(text,'PRIVATE_COPY_CANARY');calls++;time+=125;return 'native-result';}};
  assert.equal(writeMeasuredClipboardText(clipboard,'PRIVATE_COPY_CANARY','history'),'native-result');
  assert.equal(writeMeasuredClipboardText(clipboard,'PRIVATE_COPY_CANARY','file-preview'),'native-result');
  assert.equal(calls,2);assert.deepEqual(action.phases.map(p=>p.name),['history-clipboard-write-text','file-preview-clipboard-write-text']);
  assert.ok(logs.every(line=>JSON.parse(line.slice(line.indexOf('{'))).actionId===action.id));
  assert.doesNotMatch(JSON.stringify({logs,phases:action.phases}),/PRIVATE|CANARY/);
});

test('fixed same-length oracle uses exactly the existing read, returns it unchanged and records booleans only',t=>{
  const logs=[];t.mock.method(console,'warn',line=>logs.push(line));let reads=0;
  armComposerClipboardOracle({runId:'clipboard-canary-private',step:1});
  assert.equal(measureComposerClipboardCall('read-text',()=>{reads++;return 'abc';}),'abc');
  const evidence=JSON.parse(logs[0].slice(logs[0].indexOf('{')));
  assert.equal(evidence.matchesExpected,false);assert.equal(evidence.matchesPrevious,true);assert.equal(reads,1);
  assert.doesNotMatch(logs[0],/abc|111/);
  assert.throws(()=>armComposerClipboardOracle({runId:'user text',step:1}));
});

test('a deferred Copy completion keeps its original action across navigation and reports eviction explicitly', t => {
  const old=Object.getOwnPropertyDescriptor(globalThis,'performance'), oldDocument=globalThis.document;
  let time=100;const logs=[];let writes=0;
  Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>time,timeOrigin:1000}});
  globalThis.document={styleSheets:[]};t.after(()=>{Object.defineProperty(globalThis,'performance',old);globalThis.document=oldDocument;});
  t.mock.method(console,'warn',line=>logs.push(JSON.parse(line.slice(line.indexOf('{')))));
  const d=installUIActionDiagnostics({now:()=>1000+time,emit(){}});
  const original=d.capture('click',1090,{},true), context=captureClipboardWriteContext();
  time=900;const navigation=d.capture('click',1890,{},true);
  const target={writeText(){writes++;}};
  writeMeasuredClipboardText(target,'PRIVATE_CANARY','history',context);
  assert.equal(logs.at(-1).actionId,original.id);assert.equal(logs.at(-1).waitBeforeWriteMs,800);
  assert.equal(original.phases.length,1);assert.equal(navigation.phases.length,0);
  time=1000;for(let i=0;i<97;i++)d.capture('keydown',1990+i,{},true);
  writeMeasuredClipboardText(target,'PRIVATE_CANARY','history',context);
  assert.equal(logs.at(-1).actionId,original.id);assert.equal(logs.at(-1).phaseMissing,true);
  assert.equal(logs.at(-1).phaseMissingReason,'original-action-unavailable');assert.equal(writes,2);
  assert.doesNotMatch(JSON.stringify(logs),/PRIVATE|CANARY/);
});

test('actual snapshot adapter measures native failure before preserving its null fallback',t=>{
  const warnings=[];t.mock.method(console,'warn',line=>warnings.push(line));let reads=0;
  const source=fs.readFileSync(new URL('./electronComposerClipboardAdapter.ts',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const context=vm.createContext({exports:{},Buffer,console:{warn:line=>warnings.push(line),log(){}},
    window:{require:()=>({clipboard:{readHTML(){reads++;throw Error('SECRET native failure');}}})},
    require:name=>name.includes('composerClipboardDiagnostics')?{measureComposerClipboardCall}:name.includes('composerClipboard')?{}:{}});
  vm.runInContext(compiled,context);
  assert.equal(context.exports.readElectronComposerSnapshotClipboard(),null);
  assert.equal(reads,1);
  const evidence=JSON.parse(warnings.find(line=>line.startsWith('[Perf:ComposerClipboard]')).slice('[Perf:ComposerClipboard] '.length));
  assert.equal(evidence.failed,true);assert.equal(evidence.operation,'read-snapshot');
  assert.doesNotMatch(warnings.join('\n'),/SECRET/);
});

test('actual dehydrated-row Copy hook keeps one full-payload write and the original action after an unrelated click', t => {
  const oldDocument=globalThis.document;globalThis.document={styleSheets:[]};
  t.after(()=>{globalThis.document=oldDocument;});
  const source=fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx',import.meta.url),'utf8');
  const a=source.indexOf('const useRehydratedCopy ='), b=source.indexOf('\nconst HistoryThinkBlock',a);
  assert.ok(a>=0&&b>a);
  const effects=[], ref={current:null}, nativeWrites=[], logs=[], requests=[];
  t.mock.method(console,'warn',line=>logs.push(JSON.parse(line.slice(line.indexOf('{')))));
  const clipboard={writeText:text=>nativeWrites.push(text)};
  const context=vm.createContext({useRef:()=>ref,useEffect:fn=>effects.push(fn),captureClipboardWriteContext,
    writeHistoryClipboardText:(text,ctx)=>writeMeasuredClipboardText(clipboard,text,'history',ctx),clipboard});
  const hook=vm.runInContext(ts.transpile(source.slice(a,b)+';useRehydratedCopy;',{target:ts.ScriptTarget.ES2022}),context);
  const d=installUIActionDiagnostics({emit(){}});
  const copy=hook('preview',{payload:true},undefined,x=>requests.push(x));effects.splice(0).forEach(fn=>fn());
  const action=d.capture('click',100,{},true);copy('preview');assert.equal(nativeWrites.length,0);
  d.capture('click',110,{},true);hook('preview',{payload:true},'FULL_PRIVATE_BODY',x=>requests.push(x));
  effects.splice(0).forEach(fn=>fn());effects.splice(0).forEach(fn=>fn());
  assert.deepEqual(requests,[true]);assert.deepEqual(nativeWrites,['FULL_PRIVATE_BODY']);
  assert.equal(logs.at(-1).actionId,action.id);assert.doesNotMatch(JSON.stringify(logs),/PRIVATE|BODY/);
});
