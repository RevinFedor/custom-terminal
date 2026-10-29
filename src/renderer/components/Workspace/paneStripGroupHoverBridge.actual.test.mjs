import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {transformSync} from 'esbuild';

// Full CURRENT component + existing finite harness code. This is a scratch
// control, not a mounted React/browser acceptance test. React elements,
// DOM/events and Store transports remain controlled; actual production event
// handlers, group lifecycle, hover ownership and file popup markup execute.
const checkoutRoot=new URL('../../../../',import.meta.url);
const currentRoot=process.env.NOTED_UI_HARNESS_ROOT
  ?pathToFileURL(process.env.NOTED_UI_HARNESS_ROOT.replace(/\/$/,'')+'/'):checkoutRoot;
const proposedRoot=process.env.NOTED_UI_SOURCE_ROOT
  ?pathToFileURL(process.env.NOTED_UI_SOURCE_ROOT.replace(/\/$/,'')+'/'):checkoutRoot;
const sourceURL=path=>{const next=new URL(path,proposedRoot);return fs.existsSync(next)?next:new URL(path,currentRoot);};
const scope=await import(sourceURL('src/renderer/utils/paneStripHoverScope.mjs'));
const badge=await import(sourceURL('src/renderer/utils/paneStripBadgeHover.mjs'));
const hover=await import(sourceURL('src/renderer/utils/chipHoverIntent.mjs'));
const linked=await import(sourceURL('src/renderer/utils/tabLinkedFiles.mjs'));
const require=createRequire(import.meta.url);
const React={Fragment:Symbol.for('review.fragment'),createElement:(type,props,...children)=>({type,props:{...props,children}})};

async function actualHarness(path,{linkedSource=false}={}) {
  const url=new URL(path,currentRoot),text=fs.readFileSync(url,'utf8');
  const modules=new Map();
  for(const match of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g))if(match[1].startsWith('.')&&/\.(mjs|cjs)$/.test(match[1]))
    modules.set(match[1],match[1].endsWith('paneStripHoverScope.mjs')?scope:await import(new URL(match[1],url)));
  const replacement=sourceURL('src/renderer/components/Workspace/TabLinkedFiles.tsx');
  const sourceFS={...fs,readFileSync:(path,...args)=>fs.readFileSync(linkedSource&&String(path).endsWith('/TabLinkedFiles.tsx')?replacement:path,...args)};
  const code=transformSync(text.replaceAll('import.meta.url',JSON.stringify(url.href))
    +'\nmodule.exports.__fixture=fixture;module.exports.__all=typeof all===\'undefined\'?null:all;', {loader:'js',format:'cjs'}).code;
  const module={exports:{}};
  vm.runInNewContext(code,{module,exports:module.exports,URL,console,performance,setImmediate,process,
    require:name=>{
      if(name==='node:test')return ()=>{};
      if(name==='react')return React;
      if(name==='node:fs')return sourceFS;
      if(name==='esbuild')return {transformSync};
      if(modules.has(name))return modules.get(name);
      return require(name);
    }},{filename:url.pathname});
  return {fixture:module.exports.__fixture,all:module.exports.__all};
}
const groups=await actualHarness('src/renderer/components/Workspace/paneStripCollapse.actual.test.mjs');
const files=await actualHarness('src/renderer/components/Workspace/TabLinkedFiles.actual.test.mjs',{linkedSource:true});

function domFrom(actualProps,ownerOverride) {
  const attrs=new Map(Object.entries(actualProps).filter(([key,value])=>key.startsWith('data-')&&value!==undefined));
  if(ownerOverride!==undefined)attrs.set('data-tab-menu-owner-id',ownerOverride);
  const dataset=Object.fromEntries([...attrs].map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),String(value)]));
  const node={dataset,closest:selectors=>selectors.split(',').some(selector=>{
    const match=selector.trim().match(/^\[([^=\]]+)(?:=[^\]]+)?\]$/);return match&&attrs.has(match[1]);
  })?node:null};return node;
}
function fixture() {
  const group=groups.fixture(),file={id:'file-b',ownerTabId:'b',projectId:'P',path:'/fixture/b.md',name:'b.md'};
  const popup=files.fixture([file]);popup.props.ownerTabId='b';popup.render();
  const open=()=>{groups.all(group.render()).find(node=>node.type==='Card'&&node.props.id==='b').props.control.hover();
    assert.equal(group.render().props['data-group-open'],'1');
    popup.event('data-tab-linked-files','onMouseEnter');popup.settleHover();
    assert.equal(popup.by('data-tab-linked-files-popup').length,1);};
  return {group,popup,open,dispose:()=>{popup.dispose();group.dispose();}};
}

test('group temporary OPEN survives its own actual linked-file hover bridge beyond the card rectangle',()=>{
  const f=fixture();try{
    f.open();const props=f.popup.by('data-linked-files-hover-bridge')[0].props;
    const anchor={left:206,right:270,top:46,bottom:61};
    const placement=linked.placeLinkedFilePopup(anchor,{width:150,height:100},{width:600,height:400});
    assert.equal(placement.top,65,'actual placement helper leaves a 4px bridge below the overhanging chip');
    const reads=f.group.rectangleReads;
    f.group.emit('mousemove',{target:domFrom(props),clientX:220,clientY:(anchor.bottom+placement.top)/2});
    assert.equal(f.group.render().props['data-group-open'],'1','owned bridge must not close the same group');
    assert.equal(f.group.rectangleReads,reads,'ownership needs no pointer rectangle read');
    f.group.emit('mousemove',{target:domFrom(f.popup.by('data-tab-linked-files-popup')[0].props),clientX:220,clientY:80});
    assert.equal(f.group.render().props['data-group-open'],'1');
    f.group.emit('mousemove',{clientX:999,clientY:999});assert.equal(f.group.render().props['data-group-open'],undefined);
  }finally{f.dispose();}
});

test('a foreign linked-file bridge cannot borrow the open group cached rectangle',()=>{
  const f=fixture();try{
    f.open();const bridge=domFrom(f.popup.by('data-linked-files-hover-bridge')[0].props,'foreign');
    f.group.emit('mousemove',{target:bridge,clientX:220,clientY:40});
    assert.equal(f.group.render().props['data-group-open'],undefined,'foreign owner takes priority over the geometric fallback');
  }finally{f.dispose();}
});

test('an unowned linked-file bridge stays unknown even over the cached group rectangle',()=>{
  const f=fixture();try{
    f.open();const props={...f.popup.by('data-linked-files-hover-bridge')[0].props};delete props['data-tab-menu-owner-id'];
    f.group.emit('mousemove',{target:domFrom(props),clientX:220,clientY:40});
    assert.equal(f.group.render().props['data-group-open'],undefined);
  }finally{f.dispose();}
});

test('actual linked-file popup stays owned while an unrelated popup is rejected',()=>{
  const f=fixture();try{
    f.open();const props=f.popup.by('data-tab-linked-files-popup')[0].props;
    f.group.emit('mousemove',{target:domFrom(props),clientX:220,clientY:80});
    assert.equal(f.group.render().props['data-group-open'],'1');
    f.group.emit('mousemove',{target:domFrom({...props,'data-tab-linked-files-popup':'foreign'}),clientX:220,clientY:40});
    assert.equal(f.group.render().props['data-group-open'],undefined);
  }finally{f.dispose();}
});

test('badge busy cancellation releases the finite endpoint; reentry still requires a full new scale and exact event',()=>{
  const listeners=new Map(),attributes=new Map();let clock=0,calls=0;
  const target={addEventListener:(name,fn)=>{const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set);},
    removeEventListener:(name,fn)=>listeners.get(name)?.delete(fn)};
  const node={isConnected:true,matches:()=>true,setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key)};
  const control={groupId:'g',revision:1,count:2,available:true,open:false,busy:false,hover:()=>calls++};
  const endpoint=badge.createPaneStripBadgeHover({target,getControl:()=>control,isInstant:()=>false,now:()=>clock});
  const finish=values=>endpoint.finish({target:node,currentTarget:node,animationName:badge.PANE_STRIP_BADGE_HOVER_ANIMATION,...values});
  endpoint.enter(node);control.busy=true;clock=hover.CHIP_HOVER_MS;finish();
  assert.equal(calls,0);assert.equal(attributes.size,0);assert.equal([...listeners.values()].reduce((n,x)=>n+x.size,0),0);
  control.busy=false;endpoint.enter(node);clock+=59;finish();assert.equal(calls,0);
  clock++;finish({currentTarget:{}});finish({target:{}});finish({animationName:'other'});assert.equal(calls,0);
  finish();finish();assert.equal(calls,1);assert.equal(attributes.size,0);
});
