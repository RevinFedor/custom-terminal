import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';

const code=transformSync(fs.readFileSync(new URL('./commandHierarchyHint.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
function fixture(){
  const listeners=new Map(),children=[];let hit=null;
  const window={addEventListener:(type,fn)=>{const set=listeners.get(type)||new Set();set.add(fn);listeners.set(type,set);},
    removeEventListener:(type,fn)=>listeners.get(type)?.delete(fn)};
  const document={elementFromPoint:()=>hit,createElement:()=>({dataset:{},style:{},setAttribute(){},remove(){children.splice(children.indexOf(this),1);}}),
    body:{appendChild:element=>children.push(element)}};
  const phases=[];
  const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,window,document,innerWidth:800,innerHeight:600,Set,Math,performance,
    require:()=>({currentUIActionId:()=> 'key-action',uiPerformancePhaseForAction:(...args)=>phases.push(args)})});
  const row={dataset:{nodeId:'tab-a'},isConnected:true};
  const root={isConnected:true,contains:node=>node===row};
  const target={closest:selector=>selector.startsWith('[data-outline-hierarchy')?row:null};
  const dispatch=(type,extra={})=>{const e={clientX:100,clientY:120,metaKey:false,key:'',type,...extra};for(const fn of listeners.get(type)||[])fn(e);return e;};
  return {register:module.exports.registerCommandHierarchyHint,children,listeners,root,row,target,phases,
    setHit:value=>hit=value,dispatch};
}
test('Cmd paints one passive badge for the pointed owner, not rows or application state',()=>{
  const f=fixture(),stop=f.register(f.root);f.setHit(f.target);
  f.dispatch('pointerover');assert.equal(f.children.length,0);
  let prevented=false;f.dispatch('keydown',{key:'Meta',preventDefault(){prevented=true;}});
  assert.equal(f.children.length,1);const badge=f.children[0];
  assert.equal(badge.dataset.owner,'tab-a');assert.equal(badge.style.pointerEvents,'none');
  assert.match(badge.textContent,/⌘.*↔/);assert.equal(prevented,false);
  assert.equal(f.phases[0][0],'key-action');assert.equal(f.phases[0][2].shown,true);assert.ok(f.phases[0][2].hitTestMs>=0);
  for(let n=0;n<50;n++)f.dispatch('pointermove',{clientX:110+n,metaKey:true});
  assert.equal(f.children.length,1);assert.equal(f.children[0],badge);
  f.dispatch('keyup',{key:'Meta'});assert.equal(f.children.length,0);stop();
});
test('one event lease across retained roots; background and controls have no hierarchy hint',()=>{
  const f=fixture(),a=f.register(f.root),b=f.register({isConnected:true,contains:()=>false});
  assert.equal(f.listeners.get('keydown').size,1);
  f.setHit({closest:()=>null});f.dispatch('pointerover',{metaKey:true});assert.equal(f.children.length,0);
  f.setHit({closest:selector=>selector.startsWith('[data-outline-hierarchy')?f.row:{}});
  f.dispatch('pointermove',{metaKey:true});assert.equal(f.children.length,0);
  f.setHit(f.target);f.dispatch('pointermove',{metaKey:true});assert.equal(f.children.length,1);
  f.root.isConnected=false;a();assert.equal(f.children.length,0);b();
  assert.equal([...f.listeners.values()].reduce((n,s)=>n+s.size,0),0);
});
test('blur, pointercancel, leaving the window and removed hover owner dispose the badge',()=>{
  for(const type of ['blur','pointercancel','pointerout']){
    const f=fixture(),stop=f.register(f.root);f.setHit(f.target);f.dispatch('pointerover',{metaKey:true});
    assert.equal(f.children.length,1);f.dispatch(type,{relatedTarget:null});assert.equal(f.children.length,0);stop();
  }
});
