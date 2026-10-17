import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import {beginPromptNativeMenuIntent,invalidatePromptNativeMenuSource,validatePromptNativeMenuIntent,capturedPromptCommandTarget} from './promptNativeMenuIntent.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function events() {
  const listeners=new Map();
  return{addEventListener:(n,f)=>{const set=listeners.get(n)||new Set();set.add(f);listeners.set(n,set)},
    removeEventListener:(n,f)=>listeners.get(n)?.delete(f),emit:(n,e)=>[...listeners.get(n)||[]].forEach(f=>f(e)),
    count:()=>[...listeners.values()].reduce((n,s)=>n+s.size,0)};
}
test('one pending owner accepts a visible unfocused source, retires away-return/replacement/escape/blur/deletion and frees listeners',()=>{
  const port=events(),source=Symbol('source');let shown=true,alive=true;
  const begin=()=>beginPromptNativeMenuIntent({tabId:'T',projectId:'N',kind:'terminal',source,isPresented:()=>shown,isAlive:()=>alive,events:port});
  const first=begin();assert.equal(validatePromptNativeMenuIntent(first.intent),true);
  assert.equal(port.count(),3);
  const second=begin();assert.equal(validatePromptNativeMenuIntent(first.intent),false);assert.equal(port.count(),3);
  shown=false;invalidatePromptNativeMenuSource(source);shown=true;assert.equal(validatePromptNativeMenuIntent(second.intent),false);
  for(const name of ['keydown','blur','pointerdown']){const current=begin();port.emit(name,{key:'Escape'});assert.equal(validatePromptNativeMenuIntent(current.intent),false);assert.equal(port.count(),0);}
  const closed=begin();alive=false;assert.equal(validatePromptNativeMenuIntent(closed.intent),false);closed.close();
});

test('actual terminal origin captures before first async read and suppresses a replaced intent before getCwd/send',async t=>{
  const text=fs.readFileSync(new URL('../components/Workspace/Terminal.tsx',import.meta.url),'utf8');
  const start=text.indexOf('  const openTerminalContextMenu = async'),end=text.indexOf('\n  // Handle context menu',start);
  const port=events(),prior=globalThis.window;globalThis.window=port;t.after(()=>{globalThis.window=prior});
  const pending=deferred(),calls=[],source=Symbol('terminal'),state={openProjects:new Map([['N',{tabs:new Map([['T',{}]])}]])};
  const context={tabId:'T',cwd:'/source',xtermInstance:{current:{hasSelection:()=>false}},useWorkspaceStore:{getState:()=>state},
    tabAllowsShellActions:()=>true,nativeMenuSourceRef:{current:source},nativeMenuPresentedRef:{current:true},beginPromptNativeMenuIntent,
    ipcRenderer:{invoke:(name,...args)=>{calls.push([name,...args]);return pending.promise;},send:(...args)=>calls.push(args)}};
  vm.runInNewContext(transformSync(text.slice(start,end)+'\nglobalThis.open=openTerminalContextMenu;',{loader:'tsx'}).code,context);
  const opening=context.open();assert.equal(calls[0][0],'prompts:get');assert.equal(port.count(),3,'intent was captured before invoke');
  port.emit('pointerdown',{});pending.resolve({success:true,data:[]});await opening;
  assert.equal(calls.length,1,'cancelled origin does not continue to cwd/IPC');
});

test('actual App command→file-read chain keeps captured T even after UI moves to B, and preserves unstamped compatibility',async()=>{
  const text=fs.readFileSync(new URL('../App.tsx',import.meta.url),'utf8');
  const start=text.indexOf("      if (cmd === 'insert-prompt')"),end=text.indexOf("} else if (cmd === 'add-to-favorites-from-terminal')",start);
  const code=transformSync('globalThis.run=()=>{'+text.slice(start,end)+'}};',{loader:'tsx'}).code;
  const file=deferred(),calls=[];let fallback=0;
  const state={openProjects:new Map([['N',{tabs:new Map([['T',{}],['B',{}]])}]])};
  const context={cmd:'insert-prompt',data:{tabId:'T',projectId:'N',intent:{tabId:'T',projectId:'N'},content:'prefix',filePaths:['/prompt']},
    capturedPromptCommandTarget,getEffectiveTabId:()=>{fallback++;return 'B'},useWorkspaceStore:{getState:()=>state},console:{warn(){}},
    ipcRenderer:{send:(...args)=>calls.push(args),invoke:(name,data)=>{calls.push([name,data]);return name==='ai-prompts:read-files'?file.promise:Promise.resolve({success:true});}}};
  vm.runInNewContext(code,context);context.run();assert.equal(fallback,0);assert.equal(calls[0][1],'T');
  file.resolve({success:true,data:[{content:'body'}]});await tick();assert.equal(calls.find(c=>c[0]==='terminal:paste')[1].tabId,'T');
  context.data={content:'old',filePaths:[]};context.run();assert.equal(fallback,1);assert.equal(calls.at(-1)[1],'B');
  context.data={sdk:true,tabId:'T',content:'sdk',filePaths:[]};const before=calls.length;context.run();assert.equal(calls.length,before,'SDK has one existing writer');
  state.openProjects.get('N').tabs.delete('T');context.data={tabId:'T',projectId:'N',content:'gone',filePaths:[]};context.run();assert.equal(calls.length,before,'deleted explicit target is never redirected');
});
