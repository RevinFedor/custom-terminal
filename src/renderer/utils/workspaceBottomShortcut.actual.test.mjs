import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {transformSync} from 'esbuild';

const source=fs.readFileSync(new URL('../components/Workspace/Workspace.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('Workspace.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let body;
function walk(n){if(ts.isCallExpression(n)&&n.expression.getText(tree)==='useEffect'
 &&n.arguments[0]?.getText(tree).includes('const DOUBLE_TAP_MS'))body=n.arguments[0].getText(tree);ts.forEachChild(n,walk);}walk(tree);assert.ok(body);
const code=transformSync('globalThis.effect='+body,{loader:'tsx',format:'cjs',target:'es2022'}).code;
function fixture(tabId='tab-a'){
 let listener;const events=[],terminal=[];
 const scope={workspaceView:'workspace',currentView:'terminal',effectiveTab:tabId?{id:tabId}:null,
  terminalRegistry:{get:id=>({scrollToBottom:()=>terminal.push(id)})},
  window:{addEventListener:(_n,fn)=>{listener=fn;},removeEventListener:()=>{listener=null;},dispatchEvent:e=>events.push([e.type,e.detail.tabId])},
  CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail;}},
 };
 vm.runInNewContext(code,scope);const cleanup=scope.effect();
 return {events,terminal,cleanup,scope,key(key,at,options={}){
  let prevented=false;listener?.({key,timeStamp:at,target:{closest:()=>null},preventDefault:()=>{prevented=true;},...options});return prevented;
 }};
}
for(const key of ['ArrowDown',' '])test(`two ${JSON.stringify(key)} taps address History, Timeline and the same terminal`,()=>{
 const f=fixture();assert.equal(f.key(key,0),false);assert.equal(f.key(key,100),true);
 assert.deepEqual(f.events,[['history-panel:scroll-to-bottom','tab-a'],['timeline:scroll-to-bottom','tab-a']]);
 assert.deepEqual(f.terminal,['tab-a']);
});
test('mixed keys, a slow second tap and another intervening key do not complete a pair',()=>{
 for(const keys of [[['ArrowDown',0],[' ',100]],[[' ',0],[' ',401]],[[' ',0],['x',50],[' ',100]]]){
  const f=fixture();for(const [key,at] of keys)f.key(key,at);assert.equal(f.events.length,0);
 }
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
