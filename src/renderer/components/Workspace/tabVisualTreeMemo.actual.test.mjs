import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import {visualHierarchyAncestorIds} from '../../../../vendor/noted-shared/packages/structured-dnd/src/index.js';

function sourceHarness(){
 const source=fs.readFileSync(process.env.NOTED_TABBAR_TREE_SOURCE||new URL('./TabBar.tsx',import.meta.url),'utf8');
 const depth=source.slice(source.indexOf('function buildVisualDepthMap('),source.indexOf('\nfunction TabBar('));
 const marker=source.includes('  const visualTreeStructureKey =')?'  const visualTreeStructureKey =':'  const visualTreeMetaById =';
 const start=source.indexOf(marker),end=source.indexOf('  const verticalRows =',start);
 assert.ok(start>0&&end>start,'actual TabBar tree calculation must be found');
 const code=transformSync(`${depth}\nfunction read(mainTabsForDisplay,isVerticalLayout,menuOnlyForProject=false){
  const visualDepthById=buildVisualDepthMap(mainTabsForDisplay);
  ${source.slice(start,end)}
  return visualTreeMetaById;
 }\nmodule.exports=read;`,{loader:'ts',format:'cjs'}).code;
 let ancestorCalls=0;const module={exports:{}};
 vm.runInNewContext(code,{module,visualTreeMemo:{current:null},
  visualHierarchyAncestorIds:(...args)=>{ancestorCalls++;return visualHierarchyAncestorIds(...args)}});
 return {read:module.exports,calls:()=>ancestorCalls};
}
const plain=map=>JSON.parse(JSON.stringify([...map]));
const rows=()=>Array.from({length:120},(_,i)=>({id:'t'+i,visualParentTabId:i&&i%4?'t'+(i-1):undefined,name:'Title '+i}));

test('unchanged ordered hierarchy reuses actual connectors across presentation-only renders',()=>{
 const h=sourceHarness(),tabs=rows(),first=h.read(tabs,true);
 assert.equal(h.calls(),120);
 for(let i=0;i<4;i++){
  tabs[3].name='Renamed '+i;tabs[2].sessionStatus='working-'+i;
  const current=h.read(tabs.map(x=>({...x})),true);
  assert.strictEqual(current,first,'name/status/object identity cannot rebuild unchanged ancestry');
 }
 assert.equal(h.calls(),120,'existing shared ancestor helper runs once per row only on structural change');
});

test('order, in-place reparent, removal, duplicate, missing parent and cycles match fresh calculation',()=>{
 const h=sourceHarness();let tabs=rows();let previous=h.read(tabs,true);
 const cases=[
  ()=>{tabs[3].visualParentTabId='t0'},
  ()=>{tabs=[tabs[4],...tabs.slice(0,4),...tabs.slice(5)]},
  ()=>{tabs=tabs.filter(t=>t.id!=='t2')},
  ()=>{tabs.push({id:'extra',visualParentTabId:'missing'})},
  ()=>{tabs.push({id:'t0',visualParentTabId:'extra'})},
  ()=>{tabs.find(t=>t.id==='extra').visualParentTabId='t0'},
  ()=>{tabs.push({id:'self',visualParentTabId:'self'})},
 ];
 for(const change of cases){
  change();const current=h.read(tabs,true),fresh=sourceHarness().read(tabs,true);
  assert.notStrictEqual(current,previous);assert.deepEqual(plain(current),plain(fresh));previous=current;
 }
 assert.deepEqual(plain(h.read(tabs,false)),[]);
 assert.deepEqual(plain(h.read(tabs,true)),plain(sourceHarness().read(tabs,true)));
});

test('unsupported metadata keeps fresh calculations instead of trusting an incomplete key',()=>{
 const h=sourceHarness(),tabs=[{id:'a'},{id:'b',visualParentTabId:{toString:()=> 'a'}}];
 const first=h.read(tabs,true),second=h.read(tabs,true);
 assert.notStrictEqual(first,second);assert.equal(h.calls(),4);
 assert.deepEqual(plain(first),plain(second));
});

test('menu-only owner omits connector work and normal sidebar still gets its real tree',()=>{
 const h=sourceHarness(),tabs=rows();
 assert.deepEqual(plain(h.read(tabs,true,true)),[]);
 assert.equal(h.calls(),0,'context menu does not render the guarded verticalBody connectors');
 const shown=h.read(tabs,true,false);
 assert.equal(h.calls(),120);assert.deepEqual(plain(shown),plain(sourceHarness().read(tabs,true,false)));
 assert.deepEqual(plain(h.read(tabs,true,true)),[]);
 tabs[2].visualParentTabId='t0';
 assert.deepEqual(plain(h.read(tabs,true,false)),plain(sourceHarness().read(tabs,true,false)));
});
