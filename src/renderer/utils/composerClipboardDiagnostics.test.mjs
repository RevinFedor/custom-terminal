import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { installUIActionDiagnostics } from './uiPerformanceDiagnostics.mjs';
import { measureComposerClipboardCall, armComposerClipboardOracle } from './composerClipboardDiagnostics.mjs';

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

test('fixed same-length oracle uses exactly the existing read, returns it unchanged and records booleans only',t=>{
  const logs=[];t.mock.method(console,'warn',line=>logs.push(line));let reads=0;
  armComposerClipboardOracle({runId:'clipboard-canary-private',step:1});
  assert.equal(measureComposerClipboardCall('read-text',()=>{reads++;return 'abc';}),'abc');
  const evidence=JSON.parse(logs[0].slice(logs[0].indexOf('{')));
  assert.equal(evidence.matchesExpected,false);assert.equal(evidence.matchesPrevious,true);assert.equal(reads,1);
  assert.doesNotMatch(logs[0],/abc|111/);
  assert.throws(()=>armComposerClipboardOracle({runId:'user text',step:1}));
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
