import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';

function actual(name,dependencies={},globals={}) {
  const source=readFileSync(new URL(name,import.meta.url),'utf8');
  const code=transformSync(source,{loader:'ts',format:'cjs',target:'node18'}).code;
  const module={exports:{}};
  new Function('module','exports','require',...Object.keys(globals),code)(module,module.exports,
    name=>dependencies[name] || {},...Object.values(globals));
  return module.exports;
}

test('the actual eligible pane click adds no geometry read, activation, or input cancellation',()=>{
  const elementListeners=new Map(),windowListeners=new Map(),phases=[];
  let reads=0,activations=0,sourceReads=0;
  const element={addEventListener:(n,f)=>elementListeners.set(n,f),removeEventListener:n=>elementListeners.delete(n),
    getBoundingClientRect(){reads++;throw Error('ordinary click must not measure');}};
  const window={addEventListener:(n,f)=>windowListeners.set(n,f),removeEventListener:n=>windowListeners.delete(n)};
  const api=actual('paneTabPointerGesture.ts',{'./uiPerformanceDiagnostics.mjs':{
    uiDragDiagnosticsEnabled:()=>true,uiDragDiagnostic:(n)=>phases.push(n)}},{window});
  const dispose=api.bindPaneTabPointerDrag(element,()=>{sourceReads++;return{};},()=>activations++);
  const event={button:0,isPrimary:true,pointerId:7,clientX:100,clientY:200,timeStamp:1,
    metaKey:false,target:{closest:()=>null},preventDefault(){throw Error('ordinary click cancelled');}};
  elementListeners.get('pointerdown')(event);
  windowListeners.get('pointerup')(event);
  assert.deepEqual(phases,['pending','click-release']);
  assert.equal(reads,0);assert.equal(activations,0);assert.equal(sourceReads,0);
  dispose();assert.equal(windowListeners.size,0);assert.equal(elementListeners.size,0);
});

test('the actual preview shares its single existing rect and reports only after the authored write',()=>{
  let reads=0,removed=false;const writes=[],phases=[];
  const clone={style:{},attributes:[],querySelectorAll:()=>[],removeAttribute(){},tabIndex:0};
  const host={dataset:{},style:{},setAttribute(){},appendChild(){},remove(){removed=true;}};
  const source={getBoundingClientRect(){reads++;return{left:100,top:200,width:80,height:20};},cloneNode:()=>clone};
  const document={createElement:()=>host,body:{appendChild(){}}};
  const api=actual('horizontalRowDragPreview.ts',{}, {document});
  const preview=api.createHorizontalRowDragPreview(source,sample=>{
    phases.push('authored');writes.push({sample,transform:host.style.transform});
  },sample=>{phases.push('pickup');assert.deepEqual(sample,{left:100,top:200,width:80,height:20});});
  preview.move(114,205);preview.move(117,209);
  assert.equal(reads,1);assert.deepEqual(phases,['pickup','authored','authored']);
  assert.equal(writes[0].transform,'translate3d(74px, 195px, 0)');
  assert.equal(writes[1].transform,'translate3d(77px, 199px, 0)');
  assert.equal(writes[1].sample.top,199);preview.remove();assert.equal(removed,true);
});
