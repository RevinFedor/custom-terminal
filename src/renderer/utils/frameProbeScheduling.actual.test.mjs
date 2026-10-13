import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const evidence=[];
import { EventEmitter } from 'node:events';
import { transformSync } from 'esbuild';

// Compile the actual three modules. Only browser/Electron/socket participants
// are substituted: no UI dispatch, real timers, IPC, profiling or network.
const compiled = new Map(['uiPerformanceDiagnostics.mjs', 'perfIncidentChannel.ts', 'perfFreezeProbe.ts'].map(name => [name,
  transformSync(readFileSync(process.env.FRAME_PROBE_BASELINE_DIR && name !== 'perfIncidentChannel.ts' ? process.env.FRAME_PROBE_BASELINE_DIR+'/'+name+'.before' : new URL(name, import.meta.url), 'utf8'), { loader: name.endsWith('.ts') ? 'ts' : 'js',
    format: 'cjs', target: 'node18', define: { 'import.meta.env.DEV': 'true' } }).code]));

function harness({deferWatchdogInfo=false}={}) {
  let at = 1000, timerSeq = 0, rafSeq = 0; const rafs=new Map(), delivered=[];
  const intervals = new Map(), timeouts = new Map(), listeners = new Map(), logs = [], native = [], sockets = [], observers = [];
  const performance = { timeOrigin: 100000, now: () => at };
  class Socket extends EventEmitter {
    writable = true; writableLength = 0; destroyed = false; lines = []; acceptsMore = true;
    write(line) { this.lines.push(JSON.parse(line)); return this.acceptsMore; }
    destroy() { this.destroyed = true; this.emit('close'); }
  }
  class Element {
    tagName = 'BUTTON'; id = ''; classList = []; isConnected = true;
    closest(selector) {
      assert.equal(this.isConnected, true, 'reports may not revisit the removed target');
      const attrs = { '[data-insp-path]': ['data-insp-path', 'Control.tsx'],
        '[data-tab-id]': ['data-tab-id', 'test-tab'], '[data-history-owner]': ['data-history-owner', 'test-owner'] };
      const attr = attrs[selector];
      return attr ? { getAttribute: name => name === attr[0] ? attr[1] : '25' } : null;
    }
    get textContent() { throw Error('no target text'); }
    get value() { throw Error('no target value'); }
    get href() { throw Error('no URLs'); }
    getBoundingClientRect() { throw Error('no layout'); }
  }
  class PerformanceObserver {
    static supportedEntryTypes = ['event','longtask'];
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(options) { this.type = options.type; }
  }
  const document = { visibilityState: 'visible', hasFocus: () => true, styleSheets: [],
    activeElement: null, body: { style: {} }, documentElement: { style: {} } };
  let resolveWatchdogInfo;
  const watchdogInfo=deferWatchdogInfo ? new Promise(resolve=>{resolveWatchdogInfo=resolve;}) : Promise.resolve({socketPath:'/fake/watchdog'});
  const ipcRenderer = {
    invoke: channel => { assert.equal(channel, 'perf:watchdog-info'); return watchdogInfo; },
    send: (channel, payload) => native.push({ channel, payload }),
  };
  const window = {
    require: name => {
      if (name === 'electron') return { ipcRenderer };
      if (name === 'process') return { pid: 42 };
      if (name === 'net') return { createConnection: () => { const socket = new Socket(); sockets.push(socket); return socket; } };
      throw Error('unexpected dependency ' + name);
    },
    setInterval: (fn, ms) => { intervals.set(++timerSeq, { fn, ms }); return timerSeq; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (fn, ms) => { timeouts.set(++timerSeq, { fn, ms }); return timerSeq; },
    clearTimeout: id => timeouts.delete(id),
    requestAnimationFrame: fn => {rafs.set(++rafSeq,fn);return rafSeq;}, cancelAnimationFrame:id=>rafs.delete(id),
    addEventListener: (type, callback, options) => { const previous=listeners.get(type)?.callback;listeners.set(type, { callback:previous ? (...args)=>{previous(...args);callback(...args)} : callback, options }); },
  };
  const globals = { window, document, performance, Element, PerformanceObserver,
    MessageChannel: class {port1={close(){}};port2={postMessage(){},close(){}};},
    MutationObserver: class { observe() {} }, console: { warn: message => logs.push(message) } };
  function load(name, deps) {
    const module = { exports: {} };
    new Function('module', 'exports', 'require', ...Object.keys(globals), compiled.get(name))(
      module, module.exports, name => { assert.ok(Object.hasOwn(deps, name), name); return deps[name]; }, ...Object.values(globals));
    return module.exports;
  }
  const ui = load('uiPerformanceDiagnostics.mjs', {});
  const channel = load('perfIncidentChannel.ts', { './uiPerformanceDiagnostics.mjs': ui });
  const probe = load('perfFreezeProbe.ts', {
    './uiPerformanceDiagnostics.mjs': ui, './perfIncidentChannel': channel,
    '../store/useWorkspaceStore': { useWorkspaceStore: { getState: () => ({ view: 'workspace', openProjects: new Map() }) } },
    './rendererActivityTrail': { attributeFreeze: () => '', recentRendererActivities: () => '', markRendererActivity: () => {} },
    './interactionCursor': { getInteractionCursor: () => '' },
  });
  return { resolveWatchdogInfo, rafs, delivered, document, fire(stamp=at){const [id,fn]=rafs.entries().next().value;rafs.delete(id);delivered.push(fn);fn(stamp);}, pagehide(persisted=false){listeners.get('pagehide')?.callback({persisted});}, unload(){listeners.get('beforeunload')?.callback();listeners.get('pagehide')?.callback({persisted:false});if(process.env.FRAME_PROBE_EVIDENCE){evidence.push({logs,native,socketPackets:sockets.flatMap(s=>s.lines),pendingFrames:rafs.size});writeFileSync(process.env.FRAME_PROBE_EVIDENCE,JSON.stringify(evidence,null,2));}}, probe, channel, ui, Element, intervals, timeouts, listeners, logs, native, sockets, observers, time: value => { at = value; } };
}


const input=(h,type='pointerdown',extra={})=>h.listeners.get(type).callback({type,timeStamp:1000,target:new h.Element(),...extra});
const actionLogs=h=>h.logs.filter(s=>s.startsWith('[Perf:UIAction]')).map(s=>JSON.parse(s.slice(16).split(' appView=')[0])).filter(a=>a.kind==='second-frame');

test('original baseline RED: actual probe has no idle RAF and stops after the last second frame',()=>{
 const h=harness();h.probe.installPerfFreezeProbe();assert.equal(h.rafs.size,0,'idle must not request RAF');
 input(h);assert.equal(h.rafs.size,1);h.time(1016);h.fire();assert.equal(h.rafs.size,1);h.time(1032);h.fire();assert.equal(h.rafs.size,0);assert.equal(actionLogs(h).length,1);h.unload();
});

test('actual probe coalesces pointer key wheel copy/paste and records delayed handler delivery plus original RAF timestamp',()=>{
 const h=harness();h.probe.installPerfFreezeProbe();
 for(const type of ['pointerdown','keydown','wheel','copy','paste'])input(h,type,{key:'Meta',metaKey:true});
 assert.equal(h.rafs.size,1);h.document.styleSheets.push({ownerNode:null,get cssRules(){throw Error('no CSS text')}});h.time(3500);h.fire(1008);assert.equal(h.rafs.size,1);h.time(3516);h.fire(3510);
 const actions=actionLogs(h);assert.equal(actions.length,5);assert.equal(new Set(actions.map(a=>a.id)).size,5);
 for(const a of actions){assert.equal(a.frames,2);assert.equal(a.frame1Abs,103500);assert.equal(a.frame1RafTimestampAbs,101008);assert.equal(a.frame2Abs,103516);assert.equal(a.frame2RafTimestampAbs,103510);assert.equal(a.target.source,'Control.tsx:25');assert.equal(a.styles.added.length,1);}
 assert.equal(h.rafs.size,0);assert.doesNotMatch(h.logs.join('\n'),/source=raf|kind=rafGap/);h.unload();
});

test('actual InputDelayContext after idle declares unknown baseline, no false idle gap; active second-frame stall still reported',()=>{
 const h=harness();h.probe.installPerfFreezeProbe();input(h);h.time(1016);h.fire();h.time(1032);h.fire();
 h.time(90000);input(h,'pointerdown',{timeStamp:89500});
 const ctx=h.logs.findLast(s=>s.startsWith('[Perf:InputDelayContext]'));
 assert.match(ctx,/rafSampling=ui-action-frames/);assert.match(ctx,/rafBaseline=unknown/);assert.match(ctx,/lastRafAbs=unknown/);
 h.time(90016);h.fire();assert.doesNotMatch(h.logs.join('\n'),/source=raf|kind=rafGap/);
 h.time(91016);h.fire();assert.match(h.logs.join('\n'),/kind=rafGap/);assert.equal(h.rafs.size,0);h.unload();
});

test('actual disposed probe rejects late callbacks and later capture wakes',()=>{
 const h=harness();h.probe.installPerfFreezeProbe();input(h);const late=[...h.rafs.values()][0];h.unload();assert.equal(h.rafs.size,0);
 h.time(2000);late(2000);input(h);assert.equal(h.rafs.size,0);assert.equal(actionLogs(h).length,0);
});

test('cancelled beforeunload preserves wheel frame evidence in the continuing document',()=>{
 const h=harness();h.probe.installPerfFreezeProbe();
 const event=new Event('beforeunload',{cancelable:true});
 h.listeners.get('beforeunload')?.callback(event);
 event.preventDefault(); // A later close-veto listener cancels the departure.
 assert.equal(event.defaultPrevented,true);
 input(h,'wheel');assert.equal(h.rafs.size,1);
 h.time(1016);h.fire();h.time(1032);h.fire();
 const records=actionLogs(h);assert.equal(records.length,1);
 assert.equal(records[0].event,'wheel');assert.equal(records[0].frames,2);
 assert.equal(h.rafs.size,0);h.unload();
});

test('persisted pagehide does not permanently dispose a resumable document',()=>{
 const h=harness();h.probe.installPerfFreezeProbe();h.pagehide(true);
 input(h);h.time(1016);h.fire();h.time(1032);h.fire();
 assert.equal(actionLogs(h).length,1);assert.equal(h.rafs.size,0);h.unload();
});

test('cancelled departure also keeps the existing watchdog transport alive',async()=>{
 const h=harness();h.probe.installPerfFreezeProbe();await Promise.resolve();h.sockets[0].emit('connect');
 const event=new Event('beforeunload',{cancelable:true});h.listeners.get('beforeunload')?.callback(event);event.preventDefault();
 assert.equal(h.sockets[0].destroyed,false);
 h.time(1250);for(const {fn} of h.intervals.values())fn();
 assert.ok(h.sockets[0].lines.some(p=>p.t==='hb'));
 h.unload();assert.equal(h.sockets[0].destroyed,true);
});

test('actual EventTiming observer and frame callbacks retain the same action ID',()=>{
 const h=harness();h.probe.installPerfFreezeProbe();input(h);
 const observer=h.observers.find(o=>o.type==='event');assert.ok(observer);
 observer.callback({getEntries:()=>[{name:'pointerdown',startTime:1000,
   processingStart:1010,processingEnd:1050,duration:128,interactionId:7}]});
 h.time(1080);h.fire(1064);h.time(1096);h.fire(1080);
 const records=h.logs.filter(s=>s.startsWith('[Perf:UIAction]')).map(s=>JSON.parse(s.slice(16).split(' appView=')[0]));
 const timing=records.find(r=>r.kind==='event-timing'),frame=records.find(r=>r.kind==='second-frame');
 assert.ok(timing&&frame);assert.equal(timing.id,frame.id);
 assert.equal(timing.inputDelayMs,10);assert.equal(timing.handlerMs,40);assert.equal(timing.presentationMs,78);
 assert.equal(frame.frame1Abs,101080);assert.equal(frame.frame1RafTimestampAbs,101064);
 assert.ok(h.native.some(r=>r.payload.id===timing.id));assert.equal(h.rafs.size,0);h.unload();
});

test('scheduler handles reentrant request/frame wakes, duplicate late delivery and disposal during callback',()=>{
 const h=harness();const q=new Map();let seq=0,pending=2,calls=0,s;
 s=h.ui.createUIFrameScheduler({request:fn=>{q.set(++seq,fn);s.wake();return seq},cancel:id=>q.delete(id),hasPending:()=>pending>0,onFrame(){calls++;pending--;s.wake();}});
 s.wake();s.wake();assert.equal(q.size,1);const run=()=>{const[id,fn]=q.entries().next().value;q.delete(id);fn(1);return fn};const late=run();assert.equal(q.size,1);late(2);assert.equal(calls,1);run();assert.equal(q.size,0);
 pending=1;s.wake();const stale=[...q.values()][0];s.dispose();stale(3);assert.equal(calls,2);assert.equal(q.size,0);
 let other;other=h.ui.createUIFrameScheduler({request:fn=>{q.set(++seq,fn);return seq},cancel:id=>q.delete(id),hasPending:()=>true,onFrame(){other.dispose();other.wake();}});other.wake();run();assert.equal(q.size,0);
});

test('actual helper drains old bounded ring in two callbacks; invalid/future capture cannot spin; reentrant action waits next callback',()=>{
 const h=harness();let at=100, inserted=false,d;
 d=h.ui.createUIActionDiagnostics({now:()=>at,emit(){if(!inserted){inserted=true;d.capture('paste',at)}}});
 for(let i=0;i<200;i++)d.capture('pointerdown',at);at=100000;d.frame(at);d.frame(at+1);
 assert.equal(d.health().actionRingEvicted,105);assert.equal(d.pending(),true);d.frame(at+2);assert.equal(d.pending(),true);d.frame(at+3);assert.equal(d.pending(),false);
 at=NaN;d.capture('copy',0);assert.equal(d.pending(),false);at=200000;d.capture('click',at);at=150000;assert.equal(d.pending(),false);
});

test('250ms watchdog heartbeat, drift and LongTask still recognize known renderer pause without idle RAF',async()=>{
 const h=harness();h.probe.installPerfFreezeProbe();await Promise.resolve();h.sockets[0].emit('connect');assert.equal(h.rafs.size,0);
 assert.ok([...h.intervals.values()].every(x=>x.ms===250));h.time(2250);for(const{fn}of h.intervals.values())fn();
 assert.match(h.logs.join('\n'),/kind=timerDrift/);assert.equal(h.sockets[0].lines.find(x=>x.t==='hb').abs,102250);
 h.observers.find(o=>o.type==='longtask').callback({getEntries:()=>[{startTime:1250,duration:1000,name:'self',attribution:[]}]});assert.match(h.logs.join('\n'),/kind=longTask/);assert.equal(h.rafs.size,0);h.unload();
});

for(const lifecycle of ['final','cancelled','persisted']) {
 test(`watchdog pending info then ${lifecycle} departure then ACK respects lifecycle`,async()=>{
  const h=harness({deferWatchdogInfo:true});h.probe.installWatchdogHeartbeat();
  if(lifecycle==='cancelled'){const e=new Event('beforeunload',{cancelable:true});h.listeners.get('beforeunload')?.callback(e);e.preventDefault();}
  else h.pagehide(lifecycle==='persisted');
  h.resolveWatchdogInfo({socketPath:'/fake/watchdog'});await Promise.resolve();
  if(lifecycle==='final'){
   assert.equal(h.sockets.length,0,'late ACK must not create a socket after final pagehide');
   assert.equal(h.intervals.size,0);assert.equal(h.timeouts.size,0);
  }else{
   assert.equal(h.sockets.length,1);h.sockets[0].emit('connect');
   assert.equal(h.intervals.size,1);h.time(1250);for(const {fn} of h.intervals.values())fn();
   assert.ok(h.sockets[0].lines.some(p=>p.t==='hb'));
   h.pagehide(false);assert.equal(h.sockets[0].destroyed,true);assert.equal(h.intervals.size,0);assert.equal(h.timeouts.size,0);
  }
 });
}
