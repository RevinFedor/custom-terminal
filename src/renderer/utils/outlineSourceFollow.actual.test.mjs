import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';

// node --experimental-vm-modules --test src/renderer/utils/outlineSourceFollow.actual.test.mjs
// Complete production hook + core modules, with only the React/DOM/RAF boundary
// controlled. This is not a browser, native input, compositor or pixel test.
// Run the SAME assertions against CURRENT with OUTLINE_SOURCE_ROOT=/.../preimages.
const root=process.env.OUTLINE_SOURCE_ROOT || fileURLToPath(new URL('../../../',import.meta.url));
const hookPath=path.join(root,'vendor/noted-shared/packages/structured-dnd/src/react/useOutlineDnd.js');
const plain=value=>JSON.parse(JSON.stringify(value));
const key=id=>`${typeof id}:${id}`;
const near=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<1e-7,`${message}: ${actual} != ${expected}`);

function actualTs(relative,dependencies,globals={}) {
  const require=createRequire(import.meta.url);
  const compiler=process.env.OUTLINE_TS_COMPILER ? require(process.env.OUTLINE_TS_COMPILER):require('esbuild');
  const code=compiler.transformSync(readFileSync(path.join(root,relative),'utf8'),
    {loader:relative.endsWith('.tsx')?'tsx':relative.endsWith('.ts')?'ts':'js',format:'cjs',target:'node18'}).code;
  const module={exports:{}};
  new Function('module','exports','require',...Object.keys(globals),code)(module,module.exports,
    name=>{assert.ok(Object.hasOwn(dependencies,name),'explicit boundary dependency '+name);return dependencies[name];},...Object.values(globals));
  return module.exports;
}

async function harness(options={}) {
  let at=1000,seq=0,session=0,slot=0,dirty=true,rendering=false,disposed=false;
  let output,config,hook,scrollTop=0,selected=null,hold=false;
  const slots=[],layouts=[],effects=[],rafs=new Map(),late=[],listeners=new Map(),elements=new Map();
  const commits=[],diagnostics=[],logs=[],reads=[],writes=[],animations=[],refs=new Map();
  const defaults={outline:[{id:'a'},{id:'b'},{id:'c'}],sourceFollow:'y',scopeKey:'A',hierarchyModifier:'meta',folderDwellInterval:500,
    layoutAnimation:{duration:120,maxAnimatedRows:14,minRetargetInterval:72,animateDuringScroll:false,respectReducedMotion:false},
    outsidePointerPolicy:'horizontal-corridor',onCommit:p=>{commits.push(p);return true;},
    getDragSource:input=>({rootIds:[input.sourceId],context:{gestureId:input.sessionId,familyIds:[input.sourceId]}}),
    createSessionId:()=>`gesture-${++session}`,onDiagnostic:(type,data)=>diagnostics.push({type,data}),
    onLog:event=>logs.push(event)};
  config={...defaults,...options};
  const equal=(a,b)=>a && b && a.length===b.length && a.every((v,i)=>Object.is(v,b[i]));
  function memo(factory,deps) {
    const i=slot++,previous=slots[i];
    if(!previous || !equal(previous.deps,deps))slots[i]={deps,value:factory()};
    return slots[i].value;
  }
  function effect(callback,deps,queue) {
    const i=slot++,previous=slots[i];
    if(!previous || !equal(previous.deps,deps)) {
      const current={deps,cleanup:previous?.cleanup};slots[i]=current;
      queue.push(()=>{current.cleanup?.();current.cleanup=callback();});
    }
  }
  const react={useRef:value=>{const i=slot++;return slots[i] ||= {current:value};},
    useState:initial=>{const i=slot++;if(!slots[i])slots[i]={value:typeof initial==='function'?initial():initial};
      return[slots[i].value,value=>{const next=typeof value==='function'?value(slots[i].value):value;
        if(!Object.is(next,slots[i].value)){slots[i].value=next;dirty=true;}}];},
    useMemo:memo,useCallback:(fn,deps)=>memo(()=>fn,deps),
    useLayoutEffect:(fn,deps)=>effect(fn,deps,layouts),useEffect:(fn,deps)=>effect(fn,deps,effects)};
  class Style {
    values=new Map();priorities=new Map();
    setProperty(name,value,priority=''){writes.push({at,element:this.owner,name,value});this.values.set(name,value);this.priorities.set(name,priority);}
    getPropertyValue(name){return this.values.get(name)||'';}
    getPropertyPriority(name){return this.priorities.get(name)||'';}
    removeProperty(name){const old=this.getPropertyValue(name);writes.push({at,element:this.owner,name,value:null});this.values.delete(name);this.priorities.delete(name);return old;}
  }
  const translate=string=>{
    if(!string || string==='none')return{x:0,y:0};
    const nums=string.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
    return string.startsWith('matrix') ? {x:nums[4],y:nums[5]} : {x:nums[1]||0,y:nums[2]||0};
  };
  class Element {
    constructor(id){this.id=id;this.dataset={outlineDndKey:key(id)};this.style=new Style();this.style.owner=this;
      this.isConnected=true;this.height=options.heights?.[id]||27;this.baseTop=0;this.baseLeft=3;this.capture=null;}
    get offsetHeight(){reads.push('offsetHeight');return this.height;}
    getBoundingClientRect(){reads.push('rect:'+this.id);const delta=this.animation && !this.animation.cancelled
      ? translate(this.animation.frames[0].transform):translate(this.style.transform);
      const fraction=this.animation && !this.animation.cancelled ? Math.max(0,1-this.animation.currentTime/this.animation.duration):1;
      const y=this.style.translate ? Number.parseFloat(this.style.getPropertyValue('--outline-dnd-source-y'))||0:0;
      const left=this.baseLeft+delta.x*fraction,top=this.baseTop-scrollTop+y+delta.y*fraction;
      return{left,right:left+194,top,bottom:top+this.height,width:194,height:this.height};}
    animate(frames,opts){const started=at,animation={frames,duration:opts.duration,cancelled:false,onfinish:null,
      get currentTime(){return at-started;},cancel(){this.cancelled=true;}};
      this.animation=animation;animations.push({element:this,animation});return animation;}
    setPointerCapture(id){this.capture=id;}
    hasPointerCapture(id){return this.capture===id;}
    releasePointerCapture(){this.capture=null;}
    closest(selector){return selector==='[data-outline-dnd-row]'?this:null;}
  }
  const scroller={clientHeight:options.viewportHeight||240,
    get scrollTop(){reads.push('scrollTop');return scrollTop;},
    set scrollTop(value){scrollTop=Math.max(0,Math.min(value,this.scrollHeight-this.clientHeight));},
    get scrollHeight(){reads.push('scrollHeight');return Math.max(this.clientHeight,contentBottom+(output?.scrollReserve||0));},
    getBoundingClientRect(){reads.push('scrollerRect');return{left:0,right:220,top:78,bottom:78+this.clientHeight,width:220,height:this.clientHeight};},
    querySelectorAll(){return [...elements.values()].filter(e=>e.isConnected);},
    contains(element){return elements.get(element.id)===element && element.isConnected;},
    addEventListener:(n,f)=>add('scroll:'+n,f),removeEventListener:(n,f)=>remove('scroll:'+n,f)};
  let contentBottom=0;
  const spacer={isConnected:true,parentElement:{},getBoundingClientRect(){reads.push('spacerRect');return{top:78+contentBottom-scrollTop,bottom:78+contentBottom-scrollTop};}};
  function add(type,callback){let group=listeners.get(type);if(!group)listeners.set(type,group=new Set());group.add(callback);}
  function remove(type,callback){listeners.get(type)?.delete(callback);}
  const requestAnimationFrame=fn=>{rafs.set(++seq,fn);return seq;};
  const cancelAnimationFrame=id=>{const fn=rafs.get(id);if(fn)late.push(fn);rafs.delete(id);};
  const computed=element=>{
    reads.push('style:'+element.id);
    const delta=element.animation && !element.animation.cancelled?translate(element.animation.frames[0].transform):translate(element.style?.transform);
    const fraction=element.animation && !element.animation.cancelled?Math.max(0,1-element.animation.currentTime/element.animation.duration):1;
    return{transform:`matrix(1, 0, 0, 1, ${delta.x*fraction}, ${delta.y*fraction})`,paddingBottom:'0'};
  };
  class DOMMatrixReadOnly {constructor(value){const n=value.match(/-?\d+(?:\.\d+)?/g).map(Number);[this.a,this.b,this.c,this.d,this.e,this.f]=n;}}
  const window={addEventListener:add,removeEventListener:remove,matchMedia:()=>({matches:false}),getComputedStyle:computed,DOMMatrixReadOnly};
  const document={elementFromPoint(x,y){const candidates=[...elements.values()].reverse();
    return candidates.find(element=>{if(!element.isConnected || element.style.pointerEvents==='none')return false;
      const rect=element.getBoundingClientRect();return x>=rect.left&&x<=rect.right&&y>=rect.top&&y<rect.bottom;}) || null;}};
  function render(force=false) {
    if(rendering || disposed || (hold&&!force))return;
    rendering=true;
    try {let turns=0;while(dirty || layouts.length || effects.length){assert.ok(++turns<50,'bounded React effects');
      if(dirty){dirty=false;slot=0;output=hook(config);output.scrollerRef.current=scroller;output.scrollSpacerProps.ref(spacer);
        const present=new Set(output.rows.map(r=>r.id));
        for(const [id,el] of elements)if(!present.has(id)&&el.isConnected){refs.get(id)?.(null);el.isConnected=false;}
        let top=82;
        for(const row of output.rows){let el=elements.get(row.id);if(!el||!el.isConnected){el=new Element(row.id);elements.set(row.id,el);}
          el.baseTop=top;el.baseLeft=3+row.depth*24;top+=el.height+(options.gap??0);
          const props=output.getRowProps(row);el.props=props;
          for(const name of ['translate','pointerEvents','zIndex'])el.style[name]=props.style?.[name];
          if(refs.get(row.id)!==props.ref){refs.get(row.id)?.(null);refs.set(row.id,props.ref);props.ref(el);}
        }
        contentBottom=top-78;
      }
      while(layouts.length)layouts.shift()();
      while(effects.length)effects.shift()();
    }}finally{rendering=false;}
  }
  const context=vm.createContext({console,window,document,Element,getComputedStyle:computed,requestAnimationFrame,cancelAnimationFrame,
    performance:{now:()=>at,timeOrigin:100000},crypto:{randomUUID:()=>`uuid-${++session}`},setTimeout,clearTimeout});
  const modules=new Map();
  const synthetic=(name,values)=>{const m=new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context,identifier:name});modules.set(name,m);return m;};
  synthetic('react',react);synthetic('react-dom',{flushSync:fn=>{fn();render(true);}});
  function load(filename){if(modules.has(filename))return modules.get(filename);
    const m=new vm.SourceTextModule(readFileSync(filename,'utf8'),{context,identifier:filename});modules.set(filename,m);return m;}
  const main=load(hookPath);await main.link((name,ref)=>modules.get(name)||load(path.resolve(path.dirname(ref.identifier),name)));
  await main.evaluate();hook=main.namespace.useOutlineDnd;render();
  function event(type,extra={}){return{type,pointerId:7,pointerType:'mouse',button:0,buttons:type==='pointerup'?0:1,
    clientX:45,clientY:86,metaKey:false,timeStamp:at,isPrimary:true,detail:1,
    preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},...extra};}
  function dispatch(type,extra={}){const e=event(type,extra);for(const fn of [...listeners.get(type)||[]])fn(e);render();return e;}
  function frame(ms=1000/120){at+=ms;const batch=[...rafs];for(const[id,fn]of batch){if(!rafs.has(id))continue;rafs.delete(id);fn(at);render();}}
  return{elements,rafs,late,diagnostics,commits,logs,reads,writes,animations,scroller,refs,
    get dnd(){return output;},get now(){return at;},get selection(){return selected;},
    frame,dispatch,render,update(next){config={...config,...next};dirty=true;render();},
    hold(value){hold=value;if(!hold)render();},
    down(id='a',grab=4){const el=elements.get(id),rect=el.getBoundingClientRect();const e=event('pointerdown',{target:el,currentTarget:el,clientY:rect.top+grab});
      el.props.onPointerDownCapture();el.props.onPointerDown(e);render();return e;},
    move(y,x=45,metaKey=false){return dispatch('pointermove',{clientY:y,clientX:x,metaKey});},
    up(y,x=45){return dispatch('pointerup',{clientY:y,clientX:x});},
    click(id){const el=elements.get(id),e=event('click',{target:el,currentTarget:el});el.props.onClickCapture(e);if(!e.defaultPrevented)selected=id;return e;},
    scroll(value){scroller.scrollTop=value;dispatch('scroll:scroll');},
    rebind(id){const old=elements.get(id);refs.get(id)?.(null);old.isConnected=false;elements.delete(id);refs.delete(id);dirty=true;render();return old;},
    dispose(){disposed=true;for(const s of slots)s?.cleanup?.();},
  };
}

test('same-slot source follows +5.5, +7, pause and reversal from original off-centre grab',async()=>{
  const h=await harness();const source=h.elements.get('a');h.down();h.move(91.5);
  assert.equal(h.dnd.dragState.phase,'dragging');assert.equal(h.dnd.dragState.boundary,0);
  near(source.getBoundingClientRect().top,87.5,'threshold must move the real source');
  assert.equal(h.elements.get('a'),source);assert.equal(h.elements.size,3);
  h.move(93);h.frame();near(source.getBoundingClientRect().top,89,'same-slot +7');
  const writes=h.writes.length;for(let i=0;i<18;i++)h.frame();
  assert.equal(h.writes.length,writes,'pause adds no positional writes');near(source.getBoundingClientRect().top,89,'intentional pause');
  h.move(91.5);h.frame();near(source.getBoundingClientRect().top,87.5,'reversal must not stick');
  assert.equal(h.dnd.dragState.boundary,0);h.dispose();
});

test('ordinary click and prethreshold motion retain the 4px threshold with no Y writes',async()=>{
  const h=await harness();h.down();h.move(89.9);h.up(89.9);assert.equal(h.writes.length,0);
  assert.equal(h.dnd.dragState,null);assert.equal(h.click('a').defaultPrevented,undefined);h.dispose();
});

test('latest event coalesces once per frame and geometry compensation prevents a second slot move',async()=>{
  const h=await harness();h.down();h.move(91.5);h.reads.length=0;h.writes.length=0;
  h.move(92);h.move(92.5);h.move(93);assert.equal(h.writes.length,0);h.frame();
  near(h.elements.get('a').getBoundingClientRect().top,89,'latest delivered Y');
  assert.equal(h.writes.filter(w=>w.name==='--outline-dnd-source-y').length,1);
  // No separate per-move full measurement by the writer; resolver owns one rect/style per row.
  assert.equal(h.reads.filter(r=>r==='style:a').length,1);
  for(let i=0;i<5;i++){h.move(93);h.frame();assert.equal(h.dnd.dragState.boundary,0);}
  h.dispose();
});

test('reorder keeps source Y under the cursor while neighbours retain vertical FLIP',async()=>{
  const h=await harness();h.down();h.move(91.5);h.move(120);h.frame(100);
  assert.deepEqual(Array.from(h.dnd.rows,r=>String(r.id)),['b','a','c']);
  near(h.elements.get('a').getBoundingClientRect().top,116,'reorder source Y');
  const neighbour=h.animations.find(({element,animation})=>element.id==='b'&&!animation.cancelled);
  assert.ok(neighbour,'neighbour FLIP is retained');
  assert.ok(!h.animations.some(({element,animation})=>element.id==='a'&&!animation.cancelled&&translateY(animation.frames[0].transform)!==0),'source has no competing vertical FLIP');
  h.move(118);h.frame(8);near(h.elements.get('a').getBoundingClientRect().top,114,'motion during neighbour FLIP');
  h.move(91.5);h.frame(100);near(h.elements.get('a').getBoundingClientRect().top,87.5,'reverse over a slot');h.dispose();
});
const translateY=value=>Number(value.match(/translate3d\([^,]+,\s*([^p]+)/)?.[1]||0);

test('frozen disjoint roots and nested descendants move as one compact block anchored at the grabbed child',async()=>{
  const outline=[{id:'g',children:[{id:'a'},{id:'hidden',collapsible:true,expanded:false,children:[{id:'h'}]}]},
    {id:'unselected'},{id:'c',children:[{id:'d'}]},{id:'z'}];
  const context={gestureId:'frozen',familyIds:['g','a','hidden','h','c','d']};
  const h=await harness({outline,gap:3,heights:{g:21,a:27,hidden:24,c:30,d:27},
    getDragSource:()=>({rootIds:['g','c'],context})});
  const before=h.elements.get('d').getBoundingClientRect().top;
  h.down('d',4);h.move(before+9.5);
  const ids=Array.from(h.dnd.dragState.sourceIds);assert.ok(ids.includes('h'),'collapsed child remains admitted');
  assert.equal(h.dnd.dragState.sourceContext,context,'frozen authority is retained');
  const visible=['g','a','hidden','c','d'];let top=before+5.5-(24+30+27+33);
  for(const id of visible){near(h.elements.get(id).getBoundingClientRect().top,top,'block row '+id);top+=h.elements.get(id).height+3;}
  assert.equal(h.elements.has('h'),false);h.dnd.cancel();h.render();
  near(h.elements.get('d').getBoundingClientRect().top,before,'cancel restores disjoint source layout');h.dispose();
});

test('scroll while paused and edge scroll preserve cursor-relative Y without reading every row twice',async()=>{
  const h=await harness({outline:Array.from({length:20},(_,i)=>({id:'r'+i})),viewportHeight:120});
  h.down('r2',4);h.move(145.5);const source=h.elements.get('r2');
  h.scroll(30);near(source.getBoundingClientRect().top,141.5,'manual scroll compensation');
  h.move(190);h.frame();h.move(196);h.frame();const before=h.scroller.scrollTop;h.frame();
  assert.ok(h.scroller.scrollTop>before,'existing edge activation still scrolls');
  near(source.getBoundingClientRect().top,192,'edge scroll compensation');h.dispose();
});

test('source row rebind updates the actual new element; removed element no longer receives writes',async()=>{
  const h=await harness();h.down();h.move(91.5);const old=h.rebind('a'),fresh=h.elements.get('a');
  assert.notEqual(old,fresh);near(fresh.getBoundingClientRect().top,87.5,'same owner rebind');
  assert.equal(old.style.getPropertyValue('--outline-dnd-source-y'),'');
  const before=h.writes.filter(w=>w.element===old).length;h.move(93);h.frame();
  near(fresh.getBoundingClientRect().top,89,'new row follows');assert.equal(h.writes.filter(w=>w.element===old).length,before);h.dispose();
});

test('drop consumes painted slot once, restores offsets and permits the next physical click',async()=>{
  const h=await harness();h.down();h.move(91.5);h.move(120);h.frame(100);
  const accepted=plain(h.dnd.previewOutline);h.move(160); // queued but never shown
  h.up(160);await Promise.resolve();h.render();
  assert.equal(h.commits.length,1);assert.deepEqual(plain(h.commits[0].previewOutline),accepted);
  assert.equal(h.dnd.dragState,null);assert.equal(h.elements.get('a').style.getPropertyValue('--outline-dnd-source-y'),'');
  assert.equal(h.elements.get('a').capture,null);
  assert.equal(h.click('a').defaultPrevented,true,'trailing click of drag is suppressed');
  h.down('b');h.up(h.elements.get('b').getBoundingClientRect().top+4);h.click('b');
  assert.equal(h.selection,'b','new down clears only the trailing drag suppression');h.dispose();
});

test('cancel restores exact prior inline variable/priority, selection and original order',async()=>{
  const h=await harness();const el=h.elements.get('a');el.style.setProperty('--outline-dnd-source-y','2px','important');
  h.click('b');h.down();h.move(91.5);h.move(120);h.frame(100);h.dispatch('keydown',{key:'Escape'});
  assert.deepEqual(Array.from(h.dnd.rows,r=>String(r.id)),['a','b','c']);assert.equal(h.selection,'b');
  assert.equal(el.style.getPropertyValue('--outline-dnd-source-y'),'2px');assert.equal(el.style.getPropertyPriority('--outline-dnd-source-y'),'important');
  assert.equal(el.style.translate,undefined);assert.equal(el.capture,null);h.dispose();
});

test('adopted sidebar origin retains a 4px grab, frozen context, owner epoch and no second pickup',async()=>{
  let pickups=0;const context={gestureId:'physical-one',familyIds:['a']};
  const h=await harness({getDragSource:input=>{pickups++;return{rootIds:['a'],context};}});
  h.down();h.move(91.5);const oldCallback=h.refs.get('a'),oldFrames=[...h.rafs.values()];
  h.update({scopeKey:'B',outline:[{id:'z'},{id:'a'}],externalDrag:{active:true,ownerKey:'reserve:B:physical-one',sourceId:'a',
    sourceRootIds:['a'],sourceContext:context,gestureId:'physical-one',pointerId:7,clientX:45,clientY:140,grabOffsetY:4}});
  h.frame();assert.equal(pickups,1);assert.equal(h.dnd.dragState.sourceContext,context);
  near(h.elements.get('a').getBoundingClientRect().top,136,'adoption original grab');
  const before=h.writes.length;oldCallback(null);for(const fn of oldFrames)fn(h.now+8);h.render();
  assert.equal(h.writes.length,before,'old owner callbacks do not write');
  h.move(142);h.frame();near(h.elements.get('a').getBoundingClientRect().top,138,'new owner follow');
  assert.equal(h.dnd.getDragSnapshot().current.ownerEpoch,1);h.dispose();
});

test('late cancelled pointer RAF cannot consume the next gesture with the same pointer ID',async()=>{
  const h=await harness();h.down();h.move(91.5);h.move(93);const old=[...h.rafs.values()];
  h.dnd.cancel();h.render();h.down('b');h.move(120.5);h.move(121.5);
  const before=h.writes.length;for(const fn of old)fn(h.now+8);
  assert.equal(h.writes.length,before);h.frame();near(h.elements.get('b').getBoundingClientRect().top,117.5,'new gesture retains own queued packet');h.dispose();
});

test('external release stops Y writes and commits only its acknowledged candidate',async()=>{
  const h=await harness({externalDrag:{active:true,ownerKey:'reserve:B:g',sourceId:'a',sourceRootIds:['a'],
    sourceContext:{gestureId:'g'},gestureId:'g',pointerId:7,clientX:45,clientY:92,grabOffsetY:4,releaseOwner:'bridge'}});
  h.frame();near(h.elements.get('a').getBoundingClientRect().top,88,'adopt before release');
  assert.equal(h.dnd.commitExternalDrag('test',{ownerKey:'foreign',pointerId:7}),false);
  assert.equal(h.dnd.commitExternalDrag('test',{ownerKey:'reserve:B:g',pointerId:7}),true);
  const writes=h.writes.length;h.move(190);h.frame();await Promise.resolve();h.render();
  assert.equal(h.commits.length,1);assert.equal(h.writes.length,writes);h.dispose();
});

test('pane-origin host feedback remains opt-out and adopted centre grab keeps its original semantic boundary',async()=>{
  const h=await harness({sourceFollow:null,externalDrag:{active:true,ownerKey:'pane-origin',sourceId:'a',pointerId:7,clientX:45,clientY:92}});
  h.frame();assert.equal(h.writes.length,0);assert.equal(h.elements.get('a').style.translate,undefined);
  const geometry=h.diagnostics.findLast(d=>d.type==='geometry');assert.equal(geometry.data.grabY,13.5);h.dispose();
});

test('Cmd semantic X FLIP remains independent from continuous Y',async()=>{
  const h=await harness();h.down('b');h.move(118.5);h.dispatch('keydown',{key:'Meta',metaKey:true});
  h.move(118.5,105,true);h.frame(100);
  assert.equal(h.dnd.dragState.resolvedDepth,1,'existing Cmd indent');
  near(h.elements.get('b').getBoundingClientRect().top,114.5,'Y stays grabbed through horizontal anchor');
  const x=h.animations.find(({element,animation})=>element.id==='b'&&!animation.cancelled);
  assert.ok(x,'source X FLIP retained');assert.equal(translateY(x.animation.frames[0].transform),0);
  h.move(120,106,true);h.frame(8);near(h.elements.get('b').getBoundingClientRect().top,116,'Y during X animation');h.dispose();
});

test('real-source hit transparency preserves exactly the existing 500ms folder dwell',async()=>{
  const expansions=[];const h=await harness({outline:[{id:'a'},
    {id:'folder',collapsible:true,expanded:false,children:[{id:'child'}]},{id:'z'}],
    onExpansionRequest:p=>{expansions.push({...p,at:h.now});return true;}});
  h.down();h.move(91.5);h.move(125);h.frame(0);h.frame(0);const started=h.now;
  near(h.elements.get('a').getBoundingClientRect().top,121,'source overlays target header');
  h.frame(499);assert.equal(expansions.length,0);h.frame(1);
  assert.equal(expansions.length,1);assert.equal(expansions[0].nodeId,'folder');
  assert.equal(expansions[0].reason,'hover-dwell');assert.equal(expansions[0].at-started,500);
  await Promise.resolve();h.render();near(h.elements.get('a').getBoundingClientRect().top,121,'dwell expansion preserves Y');h.dispose();
});

test('release between external publication and first layout latches one candidate and blocks stale activation work',async()=>{
  let h,released=false;h=await harness({externalDrag:{active:true,ownerKey:'reserve:B:g',sourceId:'a',sourceRootIds:['a'],
    sourceContext:{gestureId:'g'},gestureId:'g',pointerId:7,clientX:45,clientY:150,grabOffsetY:4,releaseOwner:'bridge'},
    onDiagnostic:(phase)=>{if(phase==='published'&&!released){released=true;
      assert.equal(h.dnd.commitExternalDrag('early',{ownerKey:'reserve:B:g',pointerId:7}),true);
      assert.equal(h.dnd.getDragSnapshot().current.releasePending,true);}}});
  h.frame();const candidate=plain(h.dnd.previewOutline);
  assert.equal(h.writes.length,0,'released adoption must not author Y');
  h.move(200);h.frame();await Promise.resolve();h.render();
  assert.equal(h.commits.length,1);assert.deepEqual(plain(h.commits[0].previewOutline),candidate);assert.equal(h.writes.length,0);h.dispose();
});

test('diagnostics OFF does not disable functional movement; authored receipt follows the write',async()=>{
  for(const enabled of [false,true]){let h;const records=[];h=await harness({onDiagnostic:enabled?(phase,data)=>{
    if(phase==='authored')records.push({data,value:h.elements.get('a').style.getPropertyValue('--outline-dnd-source-y')});}:undefined});
    h.down();h.move(91.5);near(h.elements.get('a').getBoundingClientRect().top,87.5,'same result with recorder '+enabled);
    if(enabled){assert.ok(records.length);assert.equal(records.at(-1).value,'5.5px');assert.equal(records.at(-1).data.top,87.5);}
    h.dispose();}
});

test('layout receipt for a reordered source is emitted after the source Y rebase in the same React commit',async()=>{
  let h;const receipts=[];h=await harness({onDiagnostic:(phase,data)=>{
    if(phase==='layout-receipt'&&data.boundary===1)receipts.push(h.elements.get('a').getBoundingClientRect().top);
  }});
  h.down();h.move(91.5);h.move(120);h.frame(100);
  assert.ok(receipts.length);near(receipts.at(-1),116,'receipt follows actual style rebase');h.dispose();
});

test('actual reserve transport carries original sidebar grab on the same frozen source across pointer publications',()=>{
  const callbacks=new Map();let frame=0;const document={elementFromPoint:()=>null};
  const window={addEventListener:(name,fn)=>{const group=callbacks.get(name)||new Set();group.add(fn);callbacks.set(name,group);},
    removeEventListener:(name,fn)=>callbacks.get(name)?.delete(fn)};
  const globals={window,document,requestAnimationFrame:()=>++frame,cancelAnimationFrame:()=>{},console:{log(){}}};
  const pointer=actualTs('src/renderer/utils/paneTabPointerBridge.ts',{});
  const geometry=actualTs('src/renderer/utils/horizontalDragGeometry.mjs',{'./horizontalReorder.mjs':{}});
  const bridge=actualTs('src/renderer/utils/paneTabDragBridge.ts',{
    react:{useSyncExternalStore:()=>{}},'./horizontalDragGeometry.mjs':geometry,
    './uiPerformanceDiagnostics.mjs':{uiDragDiagnostic(){},uiDragAdmission(){}}},globals);
  const admission=Object.freeze({gestureId:'g',sourceWorkflowId:'A',sourceId:'reserve-tab:a',
    familyIds:Object.freeze(['a','child']),paneEntries:Object.freeze([{projectId:'p',tabId:'a'}])});
  const api=actualTs('src/renderer/utils/reserveDragTransport.ts',{
    './uiPerformanceDiagnostics.mjs':{uiDragDiagnostic(){}},'./paneTabDragBridge':bridge,
    './paneTabPointerBridge':pointer,'./sidebarTabDragBridge.mjs':{beginSidebarTabDrag(){},endSidebarTabDrag(){}},
    './tabDragNavigationBridge':{setTabDragNavigationTarget(){},clearTabDragNavigationTarget(){}},
    '../store/useWorkspaceStore':{useWorkspaceStore:{getState:()=>({activeSpaceId:'A'}),subscribe:()=>()=>{}}},
    './workflowDragModel.mjs':{workflowDragSourceValid:()=>true}},globals);
  const source=api.beginReserveDragTransport(admission,{pointerId:7,clientX:45,clientY:91.5,metaKey:false,grabOffsetY:4},
    {projectId:'p',entityType:'tab'});
  assert.equal(source.sourceGrabOffsetY,4);assert.equal(pointer.getPaneTabPointerSnapshot().source,source);
  for(const fn of callbacks.get('pointermove'))fn({pointerId:7,buttons:1,clientX:46,clientY:130,metaKey:false});
  assert.equal(pointer.getPaneTabPointerSnapshot().source,source);assert.equal(source.workflowDrag,admission);
  assert.equal(source.sourceGrabOffsetY,4);assert.equal(Object.hasOwn(admission,'sourceGrabOffsetY'),false);
  for(const fn of [...callbacks.get('pointercancel')])fn({pointerId:7});
  assert.equal(pointer.getPaneTabPointerSnapshot().active,false);
});

test('actual Workflow host merges row style, contains source overflow and forwards grab only for sidebar adoption',()=>{
  const node={id:'a',projectId:'p',tabId:'a',children:[]},outline=[node];
  const model={catalog:new Map([['a',{projectId:'p',tabId:'a',tab:{}}]]),visibleGroups:new Map()};
  const state={activeSpaceId:'B',spaces:[{id:'B',name:'B'}],openProjects:new Map(),globalGroups:{},tabWorkflowMembership:{}};
  const style={translate:'0 var(--outline-dnd-source-y, 0px)',pointerEvents:'none',zIndex:1};
  const row={id:'a',depth:1,path:['a'],ancestorContinuationDepths:[]};
  const fakeDnd={rows:[row],previewOutline:outline,dragState:{phase:'dragging',sourceId:'a'},
    getRowProps:()=>({style}),scrollerRef:{current:{getBoundingClientRect:()=>({left:0,right:200,top:0,bottom:200})}},scrollSpacerProps:{}};
  let captured,slot=0,pendingEffects=[],pointer=null;const states=[],ranEffects=new Set();
  const react={useRef:value=>{const i=slot++;return states[i] ||= {current:value};},useMemo:fn=>fn(),
    useState:initial=>{const i=slot++;if(!states[i])states[i]={value:typeof initial==='function'?initial():initial};
      return[states[i].value,value=>{states[i].value=typeof value==='function'?value(states[i].value):value;}];},
    useEffect:fn=>{const i=slot++;if(!ranEffects.has(i)){ranEffects.add(i);pendingEffects.push(fn);}},useLayoutEffect:()=>{}};
  const jsx=(type,props)=>({type,props});const noop=()=>{};
  react.createElement=(type,props,...children)=>({type,props:{...props,children}});
  const deps={react:{...react,default:react},'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'Fragment'},'react-dom':{createPortal:jsx},
    'lucide-react':{},'@noted/structured-dnd/react':{useOutlineDnd:options=>{captured=options;return fakeDnd;}},
    '../../utils/uiPerformanceDiagnostics.mjs':{uiDragDiagnostic:noop},
    '../../utils/workflowOutlineRetention.mjs':{retainWorkflowOutline:(_previous,_key,outline)=>({outline,immutable:true})},
    '../../../shared/workflow-groups-projection.cjs':{},'../../hooks/useCommandHierarchyHint':{useCommandHierarchyHint:noop},
    './TabCard':{},'./TabBar':{},'../../store/useWorkspaceStore':{useWorkspaceStore:{getState:()=>state}},
    '../../store/useUIStore':{useUIStore:selector=>selector({tabSidebarWidth:200,tabGeometry:{gap:3,paddingX:3,paddingY:3,borderRadius:4},tabsFontSize:14})},
    '../../utils/openFileTabBeside':{},'../../utils/tabSidebarResize':{},'../../utils/paneTabDragBridge':{},
    '../../utils/paneTabPointerBridge':{getPaneTabPointerSnapshot:()=>pointer,subscribePaneTabPointer:()=>noop,subscribePaneTabPointerDrop:()=>noop},
    '../../utils/workflowReserve.mjs':{selectWorkflowReserve:()=>model,workflowReserveOutline:()=>outline,
      projectReservePaneSource:()=>({sourceId:'a',sourceRootIds:['a'],outline})},
    './tabChrome':{},'./tabOutlineModel.mjs':{},'../../utils/workflowDragModel.mjs':{},
    '../../utils/reserveDragTransport':{reserveReleaseOwner:(workflow,source)=>`reserve:${workflow}:${source.gestureId}`},
    '../../hooks/useOutlineDragCursor':{useOutlineDragCursor:noop},'./SidebarTabDragCursorChip':{},
    '../../utils/tabCardVisual.mjs':{TAB_CARD_LINE_HEIGHT:1.2},
    '../../utils/workflowGroupExpansion.mjs':{createWorkflowGroupExpansionQueue:()=>noop},
    '../../utils/workflowActionError':{},'../../hooks/useInlineRenameInput':{},'../../utils/splitPanesModel.mjs':{},
    '../../utils/workflowCreationVisibility.mjs':{},'./NewTabMenuRows':{},'../../utils/menuViewportClamp.mjs':{},
    '../UI/contextMenuMetrics.mjs':{},'../../hooks/useWorkspaceOverlayTarget':{useWorkspaceOverlayTarget:()=>null},'./WorkflowTabSidebar.css':{}};
  const host=actualTs('src/renderer/components/Workspace/WorkflowTabSidebar.tsx',deps).default;
  const props={state,selectedTabIds:[]};
  const walk=(value,predicate)=>{if(!value)return null;if(Array.isArray(value)){for(const v of value){const found=walk(v,predicate);if(found)return found;}return null;}
    if(predicate(value))return value;return walk(value.props?.children,predicate);};
  for(const owner of ['sidebar','pane']){
    states.length=0;ranEffects.clear();pendingEffects=[];slot=0;
    const source={owner,gestureId:'g',sourceGrabOffsetY:4,workflowDrag:{gestureId:'g'}};
    pointer={active:true,source,pointerId:7,clientX:45,clientY:140,metaKey:false};
    host(props);for(const effect of pendingEffects)effect();slot=0;const tree=host(props);
    assert.equal(captured.sourceFollow,owner==='sidebar'?'y':null);
    assert.equal(captured.externalDrag.grabOffsetY,owner==='sidebar'?4:undefined);
    assert.equal(captured.externalDrag.sourceContext,source.workflowDrag);
    const sourceRow=walk(tree,e=>e.props?.className==='workflow-reserve-row');
    assert.equal(sourceRow.props.style.translate,style.translate);assert.equal(sourceRow.props.style.marginLeft,12);
    const container=walk(tree,e=>e.props?.className==='workflow-reserve-outline');
    assert.equal(container.props['data-outline-dnd-source-follow'],owner==='sidebar'?'y':null);
  }
  // Static CSS contract check only; the DOM harness above does not implement Blink overflow.
  const css=readFileSync(path.join(root,'src/renderer/components/Workspace/WorkflowTabSidebar.css'),'utf8');
  assert.match(css,/\[data-outline-dnd-source-follow="y"\]\{min-height:100%;box-sizing:border-box;overflow-y:clip\}/);
});

test('actual recorder measures only Y for sidebar writer, still catches stopped Y and keeps pane XY defaults',()=>{
  const {createUIActionDiagnostics}=actualTs('src/renderer/utils/uiPerformanceDiagnostics.mjs',{});
  for(const axis of ['y',undefined]){
    let at=performance.timeOrigin+1000;const logs=[];
    const d=createUIActionDiagnostics({now:()=>at,emit:line=>logs.push(line)});
    d.capture('pointerdown',at,{tab:'a'});d.drag.configure({mode:'frames',hz:120,slowMs:16});
    d.drag.event('pending',{gestureId:'g',pointerId:7,eventAbs:at});d.drag.event('threshold',{gestureId:'g'});
    const input=(x,y)=>d.drag.input({type:'pointermove',pointerId:7,timeStamp:at-performance.timeOrigin,clientX:x,clientY:y,buttons:1,getCoalescedEvents:()=>[]});
    input(45,91.5);d.drag.event('authored',{gestureId:'g',axis,x:45,y:91.5,top:87.5});
    at+=8;input(105,91.5);d.drag.frame(at);at+=32;d.drag.frame(at);
    if(axis==='y'){at+=8;input(105,94.5);d.drag.frame(at);at+=32;d.drag.frame(at);}
    d.drag.event('physical-end',{gestureId:'g',reason:'cancel:test'});
    const summary=JSON.parse(logs.find(line=>line.startsWith('[Perf:DragSummary]')).slice(19));
    const detail=JSON.parse(logs.find(line=>line.startsWith('[Perf:DragWindow]')).slice(18));
    if(axis==='y'){
      assert.equal(summary.maxAuthoredErrorX,null);assert.equal(summary.maxAuthoredErrorY,3);
      assert.equal(detail.first[0].needsAuthor,false,'semantic X does not request Y author');
      assert.equal(detail.first[1].authorLagMs,0);assert.ok(summary.maxAuthoredLagMs>=32,'stopped Y is still detected');
      assert.equal(detail.first[0].author.axis,'y','compact-at-release retains the axis');
    }else{assert.equal(summary.maxAuthoredErrorX,60);assert.equal(summary.maxAuthoredErrorY,0);assert.ok(detail.first[0].needsAuthor);}
  }
});
