import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import {buildPaneStripGroupOutlines} from '../../utils/paneStripGroupOutline.mjs';

// Actual component/effect code; finite React/DOM/observer ports, no browser.
function fixture({withFile=false}={}) {
  const slots=[],effects=[],frames=new Map(),mutations=[];let cursor=0,dirty=false,id=0,reads=0,binds=0;
  const rect={left:0,top:0,right:80,bottom:26,width:80,height:26};
  let fileRight=60,attributes=[];
  const file={closest:()=>null,getBoundingClientRect:()=>({left:6,top:24,right:fileRight,bottom:40,width:fileRight-6,height:16})};
  const card={getBoundingClientRect:()=>rect};
  const chip={dataset:{stripTabId:'a'},querySelector:()=>card,querySelectorAll:()=>withFile?[file]:[]};
  const strip={isConnected:true,getBoundingClientRect:()=>rect,querySelectorAll:()=>[chip]};
  const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),
    useRef:value=>slots[cursor++]??={current:value},useMemo:fn=>fn(),
    useState:value=>{const at=cursor++;if(!(at in slots))slots[at]=value;
      return[slots[at],value=>{slots[at]=value;dirty=true;}];},
    useLayoutEffect:(fn,deps)=>{const at=cursor++,old=slots[at];if(!old||deps.some((x,i)=>x!==old.deps[i])){
      slots[at]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[at].cleanup?.();slots[at].cleanup=fn();});}}};
  const module={exports:{}};
  vm.runInNewContext(transformSync(fs.readFileSync(new URL('./PaneStripGroupOutline.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code,{
    module,exports:module.exports,
    requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:key=>frames.delete(key),
    ResizeObserver:class{constructor(){binds++;}observe(){}unobserve(){}disconnect(){}},
    MutationObserver:class{constructor(fn){mutations.push(fn);}observe(_node,options){attributes=options.attributeFilter;}disconnect(){}},
    window:{addEventListener(){},removeEventListener(){}},
    require:name=>{
      if(name==='react')return React;
      if(name.endsWith('paneTabStripGeometry.mjs'))return {readPaneTabStripChips:()=>{reads++;return[{id:'a',...rect}];}};
      if(name.endsWith('paneStripGroupOutline.mjs'))return {buildPaneStripGroupOutlines};
      if(name.endsWith('tabCardVisual.mjs'))return {resolveTabCardMetrics:()=>({borderRadius:6})};
      if(name.endsWith('useUIStore'))return {useUIStore:fn=>fn({tabGeometry:{borderRadius:6}})};
      throw Error(name);
    }});
  const ref={current:strip},props={rootRef:ref,scrollerRef:ref,entriesKey:'P:a',layoutKey:'closed',
    groups:[{id:'g',color:'#abcdef',tabIds:['a']}],presented:true};
  const render=()=>{let result,count=0;do{assert.ok(++count<8);cursor=0;dirty=false;result=module.exports.default(props);
    while(effects.length)effects.shift()();}while(dirty);return result;};
  const flush=()=>{for(const [key,fn]of [...frames]){frames.delete(key);fn();}};
  return{props,render,flush,mutate:target=>mutations.at(-1)([{target}]),
    finishFileScale(){fileRight=66;if(attributes.includes('data-linked-files-opening'))mutations.at(-1)([{target:file,attributeName:'data-linked-files-opening'}]);},
    get reads(){return reads;},get binds(){return binds;},dispose(){for(const value of slots)value?.cleanup?.();}};
}
test('outline remains present at committed OPEN/closed layout, without a blank animation frame',()=>{
  const f=fixture();try{
    f.render();f.flush();assert.equal(f.render()?.type,'svg');
    f.props.layoutKey='open';assert.equal(f.render()?.type,'svg','OPEN must not remove the existing frame until rAF');
    f.props.layoutKey='closed';assert.equal(f.render()?.type,'svg','close must not remove it either');
  }finally{f.dispose();}
});
test('unaffected outline keeps its observer and measured receipt across unrelated parent renders',()=>{
  const f=fixture();try{
    f.render();f.flush();f.render();const reads=f.reads,binds=f.binds;
    for(let i=0;i<8;i++){f.props.groups=[{id:'g',color:'#abcdef',tabIds:['a']}];assert.equal(f.render()?.type,'svg');}
    assert.equal(f.reads,reads);assert.equal(f.binds,binds);
  }finally{f.dispose();}
});
test('peer outline ignores internal SVG/progress mutations but still measures an actual structural change',()=>{
  const f=fixture();try{
    f.render();f.flush();f.render();const reads=f.reads;
    f.mutate({closest:selector=>selector.includes('outlines')?{}:null});
    f.mutate({closest:selector=>selector.includes('collapsed-group')?{}:null});
    f.flush();f.render();assert.equal(f.reads,reads);
    f.mutate({closest:()=>null});f.flush();f.render();assert.equal(f.reads,reads+1);
  }finally{f.dispose();}
});
test('existing observer captures the final file-scale endpoint on finite animation completion, without a frame loop',()=>{
  const f=fixture({withFile:true});try{
    let receipt;f.props.onMeasured=chips=>{receipt=chips;};f.render();f.flush();f.render();const reads=f.reads;
    assert.equal(receipt[0].files[0].right,60);f.finishFileScale();f.flush();f.render();
    assert.equal(receipt[0].files[0].right,66);assert.equal(f.reads,reads+1);
    f.flush();f.render();assert.equal(f.reads,reads+1);
  }finally{f.dispose();}
});
