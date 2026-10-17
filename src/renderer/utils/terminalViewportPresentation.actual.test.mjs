// Real xterm 5.5 Viewport + real parser/buffer + real Noted write pump.
// Controlled: DOM layout/scroll-event delivery, rAF, React hooks, IPC/PTY.
// This is not an Electron/browser/native wheel performance test.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import {createXtermWritePump as createSharedWritePump} from '../../shared/xterm-write-pump.cjs';
const require=createRequire(import.meta.url);
const xtermPath=process.env.NOTED_XTERM_LIB || require.resolve('@xterm/xterm');
const source=fs.readFileSync(xtermPath,'utf8');
assert.equal(crypto.createHash('sha256').update(source).digest('hex'),
  '1f991ac3b4b283ebf96e60ae23a00a52765dd3a2e46fa6fdda9f1aab032f7495', 'exact measured xterm 5.5 implementation');
const tree=ts.createSourceFile('xterm.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
let moduleMap;
const walk=(node,fn)=>{fn(node);ts.forEachChild(node,n=>walk(n,fn));};
walk(tree,n=>{if(ts.isVariableDeclaration(n)&&n.initializer&&ts.isObjectLiteralExpression(n.initializer)
  &&n.initializer.properties.some(p=>p.name?.getText(tree)==='1680'))moduleMap=n.initializer;});
assert.ok(moduleMap,'full compiled dependency module map');
const {Terminal}=require(xtermPath);
const candidatePath=process.env.NOTED_VIEWPORT_SOURCE || new URL('./terminalCanvasPresentation.mjs',import.meta.url);
const candidate=await import(typeof candidatePath==='string'?pathToFileURL(path.resolve(candidatePath)):candidatePath);
const pumpSource=fs.readFileSync(new URL('./xtermWritePump.ts',import.meta.url),'utf8');
const pumpModule={exports:{}};
vm.runInNewContext(ts.transpileModule(pumpSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
  {exports:pumpModule.exports,module:pumpModule,Date,Math,Number,Error,Promise});
const {createXtermWritePump}=pumpModule.exports;
// The old source has no adapter: execute its actual unmodified Viewport behavior.
const bind=candidate.retainXtermViewportPresentation || (()=>null);

function fixture({adapter=true}={}) {
  const frames=new Map(),timers=[],events=[],counts={read:0,write:0,height:0},scrollRequests=[];
  let frameId=0,presented=true,ready=false,top=0,areaHeight=72;
  const browser={dpr:1,window:{requestAnimationFrame:fn=>{frames.set(++frameId,fn);return frameId;},cancelAnimationFrame:id=>frames.delete(id)}};
  const listeners=[];
  const viewportElement={style:{},offsetWidth:300,offsetParent:{},
    get offsetHeight(){counts.read++;return 72;},
    get scrollTop(){counts.read++;return top;},
    set scrollTop(value){counts.write++;const next=Math.max(0,Math.min(value,areaHeight-72));if(top!==next){top=next;if(!events.length)events.push({type:'scroll'});}},
    get scrollHeight(){counts.read++;return areaHeight;},
    addEventListener(type,fn,capture=false){listeners.push({type,fn,capture:capture===true});},
    removeEventListener(type,fn,capture=false){const at=listeners.findIndex(x=>x.type===type&&x.fn===fn&&x.capture===(capture===true));if(at>=0)listeners.splice(at,1);},
  };
  const scrollArea={offsetWidth:285,style:{get height(){return areaHeight+'px';},set height(value){counts.height++;areaHeight=parseFloat(value);}}};
  const factories=vm.runInNewContext('('+moduleMap.getText(tree)+')',{
    console,setTimeout:fn=>{timers.push(fn);},WheelEvent:{DOM_DELTA_PIXEL:0,DOM_DELTA_LINE:1,DOM_DELTA_PAGE:2},Date,
  }),cache={};
  function req(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};factories[id](m,m.exports,req);return m.exports;}
  const {Viewport}=req(1680),{EventEmitter}=req(8460);
  const dimensions={css:{canvas:{height:72}},device:{cell:{height:18}}},sizeChange=new EventEmitter();
  const render={dimensions,onDimensionsChange:sizeChange.event};
  const term=new Terminal({cols:30,rows:4,scrollback:100,allowProposedApi:true});
  const core=term._core;
  const viewport=new Viewport(viewportElement,scrollArea,core._bufferService,core.optionsService,{height:18},render,browser,
    {colors:{background:{css:'#000'}},onChangeColors:()=>({dispose(){}})});
  core.viewport=viewport;
  // The exact producer/consumer wiring from Browser.Terminal.open, without its DOM renderer.
  core.register(viewport);
  core.register(core._inputHandler.onRequestSyncScrollBar(()=>viewport.syncScrollArea()));
  core.register(core._onScroll.event(()=>viewport.syncScrollArea()));
  core.register(viewport.onRequestScrollLines(e=>{scrollRequests.push({amount:e.amount,suppressScrollEvent:e.suppressScrollEvent});core.scrollLines(e.amount,e.suppressScrollEvent,1);}));
  core.register(sizeChange.event(()=>viewport.syncScrollArea()));
  const view=adapter?bind(term,()=>!ready||presented):null;
  const drainEvents=()=>{let guard=0;while(events.length){assert.ok(guard++<100,'scroll settles');const event=events.shift();for(const l of [...listeners].sort((a,b)=>Number(b.capture)-Number(a.capture)))l.fn(event);}};
  const frame=()=>{const batch=[...frames.values()];frames.clear();for(const fn of batch)fn();drainEvents();};
  const clearCounts=()=>{counts.read=counts.write=counts.height=0;};
  timers.splice(0).forEach(fn=>fn());frame();ready=true;clearCounts();
  let parsed=0;const replies=[],osc=[];term.onWriteParsed(()=>parsed++);term.onData(d=>replies.push(d));
  term.parser.registerOscHandler(7777,d=>{osc.push(d);return true;});
  const write=data=>new Promise(resolve=>term.write(data,resolve));
  const snapshot=()=>({cols:term.cols,rows:term.rows,active:term.buffer.active.type,
    buffers:[term.buffer.normal,term.buffer.alternate].map(b=>({base:b.baseY,viewport:b.viewportY,x:b.cursorX,y:b.cursorY,
      lines:Array.from({length:b.length},(_,i)=>{const l=b.getLine(i);return {wrapped:l.isWrapped,cells:Array.from({length:l.length},(_,j)=>{
        const c=l.getCell(j);return[c.getChars(),c.getWidth(),c.getFgColor(),c.getBgColor()];})};})})),replies:[...replies],osc:[...osc]});
  return{term,viewport,viewportElement,render,browser,view,frames,timers,events,counts,scrollRequests,write,snapshot,frame,drainEvents,clearCounts,
    get parsed(){return parsed;},get top(){return top;},get areaHeight(){return areaHeight;},
    hide(){presented=false;},show(){presented=true;view?.sync();},setReady(v){ready=v;},
    resize(cell=24){dimensions.device.cell.height=cell;dimensions.css.canvas.height=cell*4;sizeChange.fire(dimensions);},
    close(){term.dispose();},lateDomScroll(value){top=value;events.push({type:'scroll'});drainEvents();}};
}

test('bounded hidden output keeps real parsing/OSC/protocol replies fresh without new visual DOM refreshes',async()=>{
  const f=fixture();try{
    f.hide();for(let i=0;i<16;i++){await f.write(`row-${i}\r\n`);f.frame();}
    await f.write('\x1b]7777;prompt:42\x07\x1b[6n');f.frame();
    assert.ok(f.parsed>0);assert.deepEqual(f.snapshot().osc,['prompt:42']);assert.ok(f.snapshot().replies[0].endsWith('R'));
    assert.ok(f.term.buffer.active.baseY>0);
    assert.deepEqual(f.counts,{read:0,write:0,height:0},'old source executes Viewport DOM work on each frame');
  }finally{f.close();}
});

test('one reveal reconciles latest complete buffer; it does not replay hidden frames',async()=>{
  const f=fixture();try{f.hide();for(let i=0;i<32;i++){await f.write(`tail-${i}\r\n`);f.frame();}
    f.clearCounts();f.show();assert.equal(f.areaHeight,f.term.buffer.active.length*18);
    assert.equal(f.top,f.term.buffer.active.viewportY*18);assert.equal(f.counts.height,1,'one current visual projection');
    f.drainEvents();const at=f.counts.read;f.show();f.frame();assert.equal(f.counts.read,at,'no stale queued replay');
  }finally{f.close();}
});

test('unfocused but presented raw terminal remains identical to original on every write',async()=>{
  const a=fixture(),b=fixture({adapter:false});try{for(let i=0;i<8;i++){
    await a.write(`visible-${i}\r\n`);await b.write(`visible-${i}\r\n`);a.frame();b.frame();
    assert.deepEqual(a.snapshot(),b.snapshot());assert.equal(a.top,b.top);assert.deepEqual(a.counts,b.counts);
  }}finally{a.close();b.close();}
});

test('hidden public scroll/resize/alt-buffer operations preserve buffer identities and reconcile on show',async()=>{
  const a=fixture(),b=fixture({adapter:false});try{
    for(const f of[a,b]){await f.write('row\r\n'.repeat(20));f.frame();f.hide();f.term.scrollLines(-5);f.frame();
      await f.write('while-scrolled\r\n');f.frame();f.resize(22);f.frame();
      await f.write('\x1b[?1049hALT\x1b[2;3HZ\x1b[6n');f.frame();
      await f.write('\x1b[?1049l\x1b]7777;entry:actual\x07');f.frame();f.show();f.frame();}
    assert.deepEqual(a.snapshot(),b.snapshot());assert.equal(a.top,b.top);assert.equal(a.areaHeight,b.areaHeight);
  }finally{a.close();b.close();}
});

test('stale/clamped DOM scroll is reconciled before bound native feedback can rewind a newer buffer',async()=>{
  const f=fixture();try{await f.write('before\r\n'.repeat(10));f.frame();f.hide();await f.write('after\r\n'.repeat(8));
    const expected=f.term.buffer.active.viewportY;f.lateDomScroll(0);
    assert.equal(f.term.buffer.active.viewportY,expected);f.show();f.frame();assert.equal(f.top,expected*18);
  }finally{f.close();}
});

test('already admitted visible frame is allowed to finish once; subsequent hidden requests coalesce',async()=>{
  const f=fixture();try{await f.write('first\r\n'.repeat(8));assert.ok(f.frames.size>0);f.hide();f.frame();
    assert.ok(f.counts.read>0,'existing admitted frame not cancelled');f.clearCounts();
    await f.write('next\r\n');f.frame();assert.equal(f.counts.read,0);
  }finally{f.close();}
});

test('first hidden calibration/prewarm remains admitted, then becomes quiet',async()=>{
  const f=fixture();try{f.hide();f.setReady(false);await f.write('warm\r\n'.repeat(9));f.frame();assert.ok(f.counts.read>0);
    f.setReady(true);f.clearCounts();await f.write('quiet\r\n');f.frame();assert.equal(f.counts.read,0);
  }finally{f.close();}
});

test('late refresh/reset/presentation callbacks after Close cannot write to the retired or replacement DOM',async()=>{
  const old=fixture(),next=fixture();old.hide();await old.write('old\r\n'.repeat(7));
  const lateInner=()=>old.viewport._innerRefresh(),lateSync=()=>old.viewport.syncScrollArea(true);
  old.close();old.clearCounts();next.clearCounts();lateInner();lateSync();old.view?.sync();old.frame();
  assert.deepEqual(old.counts,{read:0,write:0,height:0});assert.deepEqual(next.counts,{read:0,write:0,height:0});next.close();
});

test('actual renderer Noted write pump retains byte order, generation separation, callbacks and drain independently of viewport',async()=>{
  const a=fixture(),b=fixture({adapter:false}),results=[];try{
    for(const f of[a,b]){f.hide();const writes=[],flushed=[];
      const pump=createXtermWritePump((data,cb)=>{writes.push(data);f.term.write(data,cb);},{onFlushed:m=>flushed.push(m)});
      const parts=['\x1b[31','mHELLO\x1b[0m\r\n','worker\r\n'.repeat(12),'\x1b]7777;prompt:7\x07\x1b[6n'];
      for(let i=0;i<parts.length;i++)pump.push(parts[i],{generation:i<2?'g1':'g2',generationOrdinal:i<2?1:2,writeSeq:i+1});
      const status=await pump.drain();await new Promise(r=>setImmediate(r));f.frame();
      assert.equal(status.failed,null);assert.equal(status.inFlight,false);assert.ok(f.parsed>0);
      results.push({snapshot:f.snapshot(),writes,flushed:JSON.parse(JSON.stringify(flushed))});pump.dispose();}
    assert.deepEqual(results[0],results[1]);assert.equal(a.counts.read,0,'proof/drain did not require hidden pixel updates');
  }finally{a.close();b.close();}
});

test('unsupported viewport shape leaves original term behavior available',()=>{
  if(!candidate.retainXtermViewportPresentation)return;
  const write=()=>{},term={write,_core:{viewport:{syncScrollArea(){}}}};
  assert.equal(bind(term,()=>false),null);assert.equal(term.write,write);
});

const terminalSource=fs.readFileSync(process.env.NOTED_TERMINAL_SOURCE || new URL('../components/Workspace/Terminal.tsx',import.meta.url),'utf8');
const terminalTree=ts.createSourceFile('Terminal.tsx',terminalSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const effects=[];walk(terminalTree,n=>{if(ts.isCallExpression(n)&&n.expression.getText(terminalTree)==='useLayoutEffect')effects.push(n.arguments[0]);});
const compile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;

test('actual committed raw-presentation predicate includes warmup, closed side, workspace and exact pane ref; not keyboard focus',()=>{
  const effect=effects.find(e=>e.getText(terminalTree).includes('viewportPresentedRef.current ='));
  assert.ok(effect,'actual production effect, not a duplicate test predicate');
  for(const ready of[false,true])for(const actual of[false,true])for(const main of[false,true])for(const side of[false,true])for(const pair of[false,true])for(const inWorkspace of[false,true])for(const inTerminal of[false,true]){
    const ctx={isReadyRef:{current:ready},actualPresentationRef:{current:actual},projectCurrentView:inTerminal?'terminal':'home',workspaceView:inWorkspace?'workspace':'home',
      promptQueueInputSurface:pair?'history':'terminal',isTerminalCentre:main,sideTerminalOpen:side,
      viewportPresentedRef:{current:null},viewportPresentationRef:{current:null}};
    vm.runInNewContext(compile('('+effect.getText(terminalTree)+')()'),ctx);
    assert.equal(ctx.viewportPresentedRef.current(),!ready||(actual&&inWorkspace&&inTerminal&&(!pair||main||side)));
    ctx.actualPresentationRef.current=false;assert.equal(ctx.viewportPresentedRef.current(),!ready,'imperative hide does not require React rerender');
  }
});

test('actual pane listener handles child-before-parent ordering and captures exact old projection for its microtask',()=>{
  const effect=effects.find(e=>e.getText(terminalTree).includes('const onPresentation ='));
  assert.ok(effect,'actual presentation subscriber');const microtasks=[],handlers=new Map();let calls=0,visible=false;
  const old={sync:()=>{if(visible)calls++;}},ref={current:old};
  const ctx={actualPresentationRefProp:{current:false},tabId:'owner',viewportPresentationRef:ref,PANE_LAYER_PRESENTATION_EVENT:'pane',
    queueMicrotask:fn=>microtasks.push(fn),window:{addEventListener:(k,fn)=>handlers.set(k,fn),removeEventListener:k=>handlers.delete(k)}};
  const dispose=vm.runInNewContext(compile('('+effect.getText(terminalTree)+')()'),ctx);
  handlers.get('pane')({detail:{tabId:'other',presented:true}});assert.equal(microtasks.length,0);
  handlers.get('pane')({detail:{tabId:'owner',presented:true}});assert.equal(calls,0);visible=true;microtasks.shift()();assert.equal(calls,1);
  handlers.get('pane')({detail:{tabId:'owner',presented:true}});visible=false;ref.current={sync:()=>{throw Error('foreign replacement')}};
  microtasks.shift()();assert.equal(calls,1);dispose();assert.equal(handlers.size,0);
});

test('both actual xterm creation paths bind only after open and before unchanged hydration',()=>{
  const matches=[...terminalSource.matchAll(/term\.open\((?:containerRef|terminalRef\.current)\);\s*viewportPresentationRef\.current = retainXtermViewportPresentation\(/g)];
  assert.equal(matches.length,2);
  assert.equal((terminalSource.match(/new XTerminal\(/g)||[]).length,2,'no additional terminal');
});


test('first real raw-terminal wheel after reveal survives coalescing with programmatic scroll ACK',async()=>{
  const a=fixture(),b=fixture({adapter:false});try{
    for(const f of[a,b]){f.hide();await f.write('rows\r\n'.repeat(20));f.frame();f.show();
      // No intermediate scroll delivery: Chromium can coalesce both changes.
      f.viewport.handleWheel({deltaY:-18,deltaMode:0,shiftKey:false,cancelable:true,preventDefault(){}});
      f.drainEvents();f.frame();}
    assert.deepEqual(a.snapshot(),b.snapshot());assert.equal(a.top,b.top);
    assert.equal(a.term.buffer.active.viewportY,a.term.buffer.active.baseY-1);
  }finally{a.close();b.close();}
});

test('shared Main pump and renderer pump both retain generation boundaries while hidden',async()=>{
  const outputs=[];
  for(const make of[createSharedWritePump,createXtermWritePump]){
    const f=fixture();try{f.hide();const calls=[],flushed=[];
      const pump=make((data,cb)=>{calls.push(data);f.term.write(data,cb);},{onFlushed:meta=>flushed.push(meta)});
      for(let i=1;i<=5;i++)pump.push('part-'+i+'\r\n',{generation:i<3?'before':'after',generationOrdinal:i<3?1:2,writeSeq:i});
      await pump.drain();f.frame();outputs.push({snapshot:f.snapshot(),calls,flushed:JSON.parse(JSON.stringify(flushed))});pump.dispose();
    }finally{f.close();}
  }
  assert.deepEqual(outputs[0],outputs[1]);
});


test('scrollback-cap trimming retains real buffer/cursor and defers inner viewport work, not upstream sync probes',async()=>{
  const a=fixture(),b=fixture({adapter:false});try{
    for(const f of[a,b]){await f.write('seed\r\n'.repeat(110));f.frame();f.hide();f.clearCounts();f.resize(20);f.frame();}
    for(let i=0;i<12;i++)for(const f of[a,b]){await f.write(`capped-${i}\r\n`);f.frame();}
    assert.deepEqual(a.snapshot(),b.snapshot());
    assert.deepEqual(a.counts,{read:0,write:0,height:0},'hidden changed cell geometry waits for reveal even at buffer capacity');
    assert.ok(b.counts.read>0,'original projects changed geometry while hidden');
    for(const f of[a,b]){f.show();f.frame();}
    assert.deepEqual(a.snapshot(),b.snapshot());assert.equal(a.top,b.top);assert.equal(a.areaHeight,b.areaHeight);
  }finally{a.close();b.close();}
});
