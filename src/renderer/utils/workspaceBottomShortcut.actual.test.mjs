import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {transformSync} from 'esbuild';
import {requestFocusedHistoryBottomKey} from './workspaceHistoryBottomKey.mjs';

const source=fs.readFileSync(new URL('../components/Workspace/Workspace.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('Workspace.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let body;
function walk(n){if(ts.isCallExpression(n)&&n.expression.getText(tree)==='useEffect'
 &&n.arguments[0]?.getText(tree).includes('const DOUBLE_TAP_MS'))body=n.arguments[0].getText(tree);ts.forEachChild(n,walk);}walk(tree);assert.ok(body);
const code=transformSync('globalThis.effect='+body,{loader:'tsx',format:'cjs',target:'es2022'}).code;
function fixture(tabId='tab-a'){
 let listener;const events=[],terminal=[];
 const ui={activeArea:'workspace',promptPickerOpen:false,primary:false};
 const state={view:'workspace',activeProjectId:'P',splitPanes:[],splitFocusedIndex:0,
  openProjects:new Map([['P',{currentView:'terminal',activeTabId:tabId,tabs:new Map(tabId?[[tabId,{id:tabId,commandType:'codex'}]]:[])}]])};
 const scope={workspaceView:'workspace',currentView:'terminal',effectiveTab:tabId?{id:tabId}:null,
  requestFocusedHistoryBottomKey,useWorkspaceStore:{getState:()=>state},useUIStore:{getState:()=>ui},resolveTabTerminalPrimary:()=>ui.primary,
  terminalRegistry:{get:id=>({scrollToBottom:()=>terminal.push(id)})},
  window:{addEventListener:(_n,fn)=>{listener=fn;},removeEventListener:()=>{listener=null;},dispatchEvent:e=>events.push([e.type,e.detail.tabId])},
  CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail;}},
 };
 vm.runInNewContext(code,scope);const cleanup=scope.effect();
 return {events,terminal,cleanup,scope,state,ui,key(key,at,options={}){
  let prevented=false;listener?.({key,timeStamp:at,target:{closest:()=>null},preventDefault:()=>{prevented=true;},...options});return prevented;
 }};
}
for(const key of ['ArrowDown',' '])test(`legacy two ${JSON.stringify(key)} taps outside primary History keep all three surfaces`,()=>{
 const f=fixture();f.ui.primary=true;assert.equal(f.key(key,0),false);assert.equal(f.key(key,100),true);
 assert.deepEqual(f.events,[['history-panel:scroll-to-bottom','tab-a'],['timeline:scroll-to-bottom','tab-a']]);
 assert.deepEqual(f.terminal,['tab-a']);
});
test('mixed keys, a slow second tap and another intervening key do not complete a pair',()=>{
 for(const keys of [[['ArrowDown',0],[' ',100]],[[' ',0],[' ',401]],[[' ',0],['x',50],[' ',100]]]){
  const f=fixture();f.ui.primary=true;for(const [key,at] of keys)f.key(key,at);assert.equal(f.events.length,0);
 }
});
test('one ArrowDown uses fresh exact pane/tab across namespaces, without Timeline/terminal/input or stale effectiveTab closure',()=>{
 const f=fixture();f.state.openProjects.set('Q',{currentView:'terminal',tabs:new Map([['tab-b',{id:'tab-b',commandType:'claude'}]])});
 f.state.splitPanes=[{projectId:'Q',tabId:'tab-b'}];
 assert.equal(f.key('ArrowDown',1),true);assert.deepEqual(f.events,[['history-panel:scroll-to-bottom','tab-b']]);assert.deepEqual(f.terminal,[]);
 f.state.splitPanes[0].tabId='';assert.equal(f.key('ArrowDown',2),false);assert.equal(f.events.length,1);
});
test('composer pre-keymap path scrolls once while caret navigation stays native; IME/picker/handled/TUI/search never acquire this command',()=>{
 const f=fixture(),editor={getAttribute:name=>name==='data-history-composer-tab-id'?'tab-a':null};
 const target={closest:selectors=>selectors==='[data-history-composer-tab-id]'?editor:null};
 const events=[],event={key:'ArrowDown',target,preventDefault(){throw Error('caret must remain native');}};
 const args={workspace:f.state,ui:f.ui,composerTabId:'tab-a',dispatchHistory:id=>events.push(id)};
 assert.equal(requestFocusedHistoryBottomKey(event,args),true);assert.equal(requestFocusedHistoryBottomKey(event,args),true);assert.deepEqual(events,['tab-a']);
 for(const flag of ['metaKey','ctrlKey','altKey','shiftKey','repeat','isComposing','defaultPrevented'])
  assert.equal(requestFocusedHistoryBottomKey({...event,[flag]:true},args),false);
 f.ui.promptPickerOpen=true;assert.equal(requestFocusedHistoryBottomKey({...event},args),false);f.ui.promptPickerOpen=false;
 for(const selector of ['input','select','.xterm','[role="dialog"]','[aria-modal="true"]','[role="listbox"]','[role="combobox"]',
  '[role="menu"]','[data-tab-context-menu]','[data-run-after-picker-menu]','[data-history-search-panel]'])
  assert.equal(requestFocusedHistoryBottomKey({...event,target:{closest:value=>value.split(', ').includes(selector)?{}:value==='[data-history-composer-tab-id]'?editor:null}},args),false,selector);
 assert.deepEqual(events,['tab-a']);
});
test('modified, composing, repeated and already handled key events break a pair',()=>{
 for(const flag of ['metaKey','ctrlKey','altKey','shiftKey','repeat','isComposing','defaultPrevented']){
  const f=fixture();f.key(' ',0);f.key(' ',50,{[flag]:true});assert.equal(f.key(' ',100),false);assert.equal(f.events.length,0);
 }
});
test('text/TUI inputs and Space-activated controls keep their ordinary keyboard ownership',()=>{
 for(const selector of ['textarea','input','select','[contenteditable="true"]','.xterm','button','a[href]','summary','[role="button"]','[role="checkbox"]']){
  const f=fixture(),options={target:{closest:selectors=>selectors.split(', ').includes(selector)?{}:null}};
  assert.equal(f.key(' ',0,options),false);assert.equal(f.key(' ',100,options),false);assert.equal(f.events.length,0);
 }
});
test('owner change/disposal does not carry the first tap into another tab',()=>{
 const a=fixture();a.key(' ',0);a.cleanup();a.key(' ',100);assert.equal(a.events.length,0);
 const b=fixture('tab-b');b.key(' ',100);assert.equal(b.events.length,0);b.key(' ',180);assert.deepEqual(b.terminal,['tab-b']);
 const empty=fixture(null);empty.key(' ',0);empty.key(' ',100);assert.equal(empty.events.length,0);
});
