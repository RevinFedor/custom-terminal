import fs from 'node:fs';import vm from 'node:vm';import test from 'node:test';import assert from 'node:assert/strict';import {transformSync} from 'esbuild';
function fixture(file=new URL('./useRequestDockLayout.ts',import.meta.url)){
 const source=fs.readFileSync(file,'utf8'),code=transformSync(source,{loader:'ts',format:'cjs'}).code;let value,effect,cleanup,reads=0,created=0,disconnected=0,listeners=0;
 const module={exports:{}},rect={left:500,right:550,top:20,bottom:40,width:50,height:20};
 const rail={closest:()=>null,getBoundingClientRect:()=>{reads++;return{...rect}}};const root={current:{parentElement:rail}};
 vm.runInNewContext(code,{module,exports:module.exports,require:()=>({useState:initial=>{value??=initial;return[value,update=>{value=typeof update==='function'?update(value):update}]},useLayoutEffect:fn=>{effect=fn}}),
 window:{innerWidth:800,innerHeight:600,addEventListener:()=>listeners++,removeEventListener:()=>listeners--},
 ResizeObserver:class{constructor(){created++}observe(){}disconnect(){disconnected++}}});
 return{root,rect,render:enabled=>{cleanup?.();module.exports.useRequestDockLayout(root,false,200,enabled);cleanup=effect();return JSON.parse(JSON.stringify(value));},counts:()=>({reads,created,disconnected,listeners})};
}
test('empty dock does no layout read/observer work; incoming rows and popovers resume the unchanged geometry',()=>{
 const f=fixture();f.render(false);assert.deepEqual(f.counts(),{reads:0,created:0,disconnected:0,listeners:0});
 const shown=f.render(true);assert.equal(shown.visible,true);assert.equal(f.counts().reads,1);
 f.render(false);assert.equal(f.counts().reads,1);assert.equal(f.counts().disconnected,1);assert.equal(f.counts().listeners,0);
 f.rect.left=100;f.rect.right=150;const resized=f.render(true);assert.equal(resized.visible,false);assert.notDeepEqual(resized,shown);
});
test('active dock remains byte-equivalent to the complete before implementation',()=>{
 const old=fixture(new URL('./fixtures/useRequestDockLayout.before.ts',import.meta.url)),current=fixture();
 assert.deepEqual(current.render(true),old.render(true));
});
