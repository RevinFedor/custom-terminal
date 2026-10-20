// Existing terminalViewportPresentation.actual.test.mjs technique: exact xterm
// compiled modules, real RenderService/SelectionService/DomRenderer methods.
// Controlled DOM, row-glyph creation, geometry, frames and theme/decor services.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
const require=createRequire(import.meta.url);
const ts=require('typescript'),lib=require.resolve('@xterm/xterm'),text=fs.readFileSync(lib,'utf8');
assert.equal(crypto.createHash('sha256').update(text).digest('hex'),'1f991ac3b4b283ebf96e60ae23a00a52765dd3a2e46fa6fdda9f1aab032f7495');
const tree=ts.createSourceFile('xterm.js',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);let map;
function walk(n){if(ts.isVariableDeclaration(n)&&n.initializer&&ts.isObjectLiteralExpression(n.initializer)
  &&n.initializer.properties.some(p=>p.name?.getText(tree)==='1680'))map=n.initializer;ts.forEachChild(n,walk);}
walk(tree);assert.ok(map);
const {Terminal}=require(lib);
const modulePath=process.env.SELECTION_HELPER||new URL('./terminalCanvasPresentation.mjs',import.meta.url);
const {retainXtermViewportPresentation:bind}=await import(typeof modulePath==='string'?pathToFileURL(path.resolve(modulePath)):modulePath);

function fixture(){
  let id=0,presented=true,ready=false,palette=0,decorations=0;
  const frames=new Map(),timers=new Map();
  const window={requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:n=>frames.delete(n),devicePixelRatio:1,
    setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:n=>timers.delete(n),clearInterval:n=>timers.delete(n)};
  const factories=vm.runInNewContext('('+map.getText(tree)+')',{console,Date,window,navigator:{platform:'MacIntel',userAgent:'controlled-fixture'},
    setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:n=>timers.delete(n),clearInterval:n=>timers.delete(n)}),cache={};
  function req(n){if(cache[n])return cache[n].exports;const m=cache[n]={exports:{}};factories[n](m,m.exports,req);return m.exports;}
  const {EventEmitter}=req(8460),{RenderService}=req(3230),{DomRenderer}=req(1296),{SelectionService}=req(9312);
  const {DomRendererRowFactory}=req(3787),{createSelectionRenderModel}=req(6052);
  const event=()=>new EventEmitter(),dpr=event(),windowChange=event(),char=event(),colors=event(),add=event(),remove=event();
  const term=new Terminal({cols:10,rows:4,scrollback:20,allowProposedApi:true}),core=term._core;
  const browser={window,dpr:1,onDprChange:dpr.event,onWindowChange:windowChange.event};
  const charSize={onCharSizeChange:char.event,hasValidSize:true,measure(){char.fire();}};
  const theme={onChangeColors:colors.event};
  const render=new RenderService(4,{},core.optionsService,charSize,
    {onDecorationRegistered:add.event,onDecorationRemoved:remove.event},core._bufferService,browser,theme);
  const counts={selection:0,rows:0,resizes:0,css:0,char:0,viewport:0};
  const element=()=>({children:[],style:{},classList:{add(){},remove(){}},
    appendChild(x){this.children.push(x);},replaceChildren(...x){this.children=x;},
    addEventListener(){},removeEventListener(){},setAttribute(){},remove(){}});
  const doc={createElement:element,createDocumentFragment:element,addEventListener(){},removeEventListener(){}};
  const dimensions={css:{canvas:{width:100,height:72},cell:{width:10,height:18}},device:{cell:{width:10,height:18}}};
  function renderer(){
    const r=Object.create(DomRenderer.prototype),rowFactory=Object.create(DomRendererRowFactory.prototype);
    r._document=doc;r._selectionContainer=element();r._rowContainer=element();
    r._rowElements=Array.from({length:term.rows},element);r._bufferService=core._bufferService;
    r._terminal={get rows(){return term.rows;},get cols(){return term.cols;},buffers:core._bufferService.buffers};
    r._selectionRenderModel=createSelectionRenderModel();r._optionsService=core.optionsService;r.dimensions=dimensions;
    r._rowFactory=rowFactory;r._widthCache={clear(){counts.char++;},setFont(){counts.char++;}};
    r._themeService={colors:{}};r._injectCss=()=>counts.css++;r._setDefaultSpacing=()=>{};
    r._updateDimensions=()=>{};r._refreshRowElements=()=>{counts.resizes++;r._rowElements=Array.from({length:term.rows},element);};
    rowFactory.createRow=function(line){return [{text:line.translateToString(true),palette,decorations,
      selected:!!this._selectionStart&&!!this._selectionEnd,cols:term.cols}];};
    const originalPaint=r.renderRows,originalSelection=r.handleSelectionChanged;
    r.renderRows=function(...args){counts.rows++;return originalPaint.apply(this,args);};
    r.handleSelectionChanged=function(...args){counts.selection++;return originalSelection.apply(this,args);};
    const optionSubscription=core.optionsService.onOptionChange(()=>r._handleOptionsChanged());
    const themeSubscription=colors.event(()=>r._injectCss());
    r.onRequestRedraw=event().event;r.dispose=()=>{r.disposed=true;optionSubscription.dispose();themeSubscription.dispose();};
    return r;
  }
  let current=renderer();render.setRenderer(current);core._renderService=render;
  const node=element();node.ownerDocument=doc;
  const selection=new SelectionService(node,node,{},core._bufferService,core.coreService||core._coreService,
    {},core.optionsService,render,browser);core._selectionService=selection;
  selection.onRequestRedraw(e=>render.handleSelectionChanged(e.start,e.end,e.columnSelectMode));
  selection.onSelectionChange(()=>core._onSelectionChange.fire());
  term.onResize(()=>render.handleResize(term.cols,term.rows));
  const viewport={_refreshAnimationFrame:null,_coreBrowserService:browser,_viewportElement:node,
    _refresh(){counts.viewport++;},_innerRefresh(){},syncScrollArea(){},_handleScroll(){}};
  core.viewport=viewport;
  const view=bind(term,()=>!ready||presented);assert.ok(view);
  const frame=()=>{const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn());};
  const settle=()=>{for(let n=0;frames.size&&n<20;n++)frame();assert.equal(frames.size,0);};
  settle();selection.refresh();settle();ready=true;
  const emit=()=>{selection.refresh();settle();};
  const write=data=>new Promise(resolve=>term.write(data,resolve));
  return {term,core,render,selection,view,counts,frame,settle,emit,write,renderer,
    get current(){return current;},get ready(){return ready;},set ready(x){ready=x;},
    hide(){presented=false;},show(){presented=true;view.sync();},
    swap(){current=renderer();render.setRenderer(current);},
    theme(){palette++;colors.fire();},decoration(){decorations++;add.fire();},removeDecoration(){decorations--;remove.fire();},
    rendered(){return current._rowElements.map(e=>e.children[0]);},
    close(){selection.dispose();render.dispose();term.dispose();},
  };
}

test('RED→GREEN: ready hidden fully-cleared redraws coalesce after current-renderer calibration',()=>{
  const f=fixture();try{f.hide();const before=f.counts.selection;
    for(let i=0;i<8;i++)f.emit();
    assert.equal(f.counts.selection,before,'old source executes eight unnecessary synchronous full-row projections');
    assert.equal(f.render._selectionState.start,undefined);assert.equal(f.render._selectionState.end,undefined);
    f.show();assert.equal(f.counts.selection,before+1,'one latest selection projection on existing reveal sync');
    f.show();assert.equal(f.counts.selection,before+1,'no replay of eight requests');
  }finally{f.close();}
});

test('prewarm and visible-unfocused requests stay upstream; nonempty and partial/zero-length are never skipped',()=>{
  const f=fixture();try{
    f.hide();f.ready=false;let n=f.counts.selection;f.emit();f.emit();assert.equal(f.counts.selection,n+2);
    f.ready=true;f.show();n=f.counts.selection;f.emit();f.emit();assert.equal(f.counts.selection,n+2);
    f.hide();n=f.counts.selection;
    f.render.handleSelectionChanged([0,0],[1,0],false);
    f.render.handleSelectionChanged([2,0],[2,0],false);
    f.render.handleSelectionChanged([2,0],undefined,false);
    assert.equal(f.counts.selection,n+3);
  }finally{f.close();}
});

test('actual SelectionService copy and change signals survive hidden nonempty→empty and reveal uses latest state',async()=>{
  const f=fixture();try{
    await f.write('HELLO\r\nSECOND');let signals=0;f.term.onSelectionChange(()=>signals++);
    f.hide();f.selection.setSelection(0,0,5);f.settle();assert.equal(f.term.getSelection(),'HELLO');assert.equal(f.term.hasSelection(),true);
    f.selection.clearSelection();assert.equal(f.term.getSelection(),'');assert.equal(f.term.hasSelection(),false);
    f.settle();assert.ok(signals>0);assert.equal(f.render._selectionState.start,undefined);
    const afterHidden=f.counts.selection;f.show();assert.equal(f.counts.selection,afterHidden+1);
    assert.equal(f.current._rowFactory._selectionStart,undefined);assert.equal(f.current._selectionContainer.children.length,0);
  }finally{f.close();}
});

test('actual resize/theme/decorations/glyph changes still paint while selection projection is pending',async()=>{
  const f=fixture();try{
    await f.write('OLD');f.hide();f.emit();
    let n=f.counts.rows;f.term.resize(12,5);f.settle();assert.ok(f.counts.rows>n);assert.equal(f.current._rowElements.length,5);
    n=f.counts.rows;f.theme();f.settle();assert.ok(f.counts.rows>n);assert.equal(f.rendered()[0].palette,1);
    n=f.counts.rows;f.decoration();f.settle();assert.ok(f.counts.rows>n);assert.equal(f.rendered()[0].decorations,1);
    n=f.counts.rows;f.removeDecoration();f.settle();assert.ok(f.counts.rows>n);assert.equal(f.rendered()[0].decorations,0);
    n=f.counts.rows;f.term.options.fontSize=17;f.settle();assert.ok(f.counts.rows>n);assert.ok(f.counts.char>0);
    n=f.counts.rows;f.render.handleDevicePixelRatioChange();f.settle();assert.ok(f.counts.rows>n);
    f.show();assert.equal(f.term.cols,12);assert.equal(f.term.rows,5);
  }finally{f.close();}
});

test('counterexample to a global same-empty skip: renderer replacement requires its own initial selection paint',()=>{
  const f=fixture();try{f.hide();f.emit();const old=f.current;f.swap();const next=f.current;
    assert.notEqual(next,old);const n=f.counts.selection;
    f.render.handleSelectionChanged(undefined,undefined,false);
    assert.equal(f.counts.selection,n+1,'first request for new renderer is admitted even hidden');
    f.render.handleSelectionChanged(undefined,undefined,false);assert.equal(f.counts.selection,n+1);
    f.show();assert.equal(f.counts.selection,n+2);f.settle();assert.ok(old.disposed);
    assert.equal(next._rowFactory._selectionStart,undefined);
  }finally{f.close();}
});

test('hidden ordinary row output and onRender/onWriteParsed remain live, independent of selection coalescing',async()=>{
  const f=fixture();try{let parsed=0,renders=0;f.term.onWriteParsed(()=>parsed++);f.render.onRender(()=>renders++);
    f.hide();f.emit();await f.write('FRESH');f.render.refreshRows(0,3);f.settle();
    assert.ok(parsed>0);assert.ok(renders>0);assert.equal(f.rendered()[0].text,'FRESH');
    assert.equal(f.term.buffer.active.getLine(0).translateToString(true),'FRESH');
  }finally{f.close();}
});

test('renderer swapped while empty projection pending flushes the current instance, not the old owner',()=>{
  const f=fixture();try{f.hide();f.emit();const old=f.current;f.swap();const next=f.current;
    const marker=old._rowFactory._selectionStart;f.show();f.settle();
    assert.notEqual(next,old);assert.equal(old._rowFactory._selectionStart,marker);
    assert.equal(next._rowFactory._selectionStart,undefined);
  }finally{f.close();}
});

test('Close clears pending projection and late sync/selection callback cannot paint retired DOM',()=>{
  const f=fixture();f.hide();f.emit();const render=f.render,view=f.view;f.close();const n=f.counts.selection;
  render.handleSelectionChanged(undefined,undefined,false);view.sync();assert.equal(f.counts.selection,n);
});

test('negative control: a global previous-empty shortcut leaves a new renderer blank until another producer paints',async()=>{
  const f=fixture();try{
    await f.write('READY');f.hide();const upstream=f.render.handleSelectionChanged;let previousEmpty=true;
    f.render.handleSelectionChanged=function(start,end,column){
      if(previousEmpty&&start===undefined&&end===undefined)return;
      previousEmpty=start===undefined&&end===undefined;return upstream.apply(this,arguments);
    };
    f.swap();f.render.handleSelectionChanged(undefined,undefined,false);
    assert.equal(f.rendered()[0],undefined,'same logical selection is not proof that this renderer has any painted rows');
    f.settle();assert.equal(f.rendered()[0].text,'READY','normal native replacement refresh is necessary and remains live');
  }finally{f.close();}
});

test('negative control: skipping hidden empty logical writes can resurrect a cleared highlight on renderer replacement',async()=>{
  const f=fixture();try{
    await f.write('READY');f.selection.setSelection(0,0,5);f.settle();
    const native=Object.getPrototypeOf(f.render).handleSelectionChanged;
    f.render.handleSelectionChanged=function(start,end,column){
      if(start===undefined&&end===undefined)return;return native.apply(this,arguments);
    };
    f.hide();f.selection.clearSelection();f.settle();assert.equal(f.term.getSelection(),'');
    assert.ok(f.render._selectionState.start,'bad visual skip left native selection state stale');
    f.swap();f.settle();assert.ok(f.current._rowFactory._selectionStart,'replacement consumes the stale highlight despite empty copy state');
  }finally{f.close();}
});
