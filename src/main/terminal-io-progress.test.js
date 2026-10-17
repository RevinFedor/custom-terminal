'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const product=root;
const redraw=require(path.join(product,'src/main/terminal-redraw-diagnostics.js'));
const baseline=require('./test-helpers/terminal-redraw-before-giant.cjs');
const replay=require(path.join(product,'src/main/terminal-replay-journal.js'));
const oldReplay=require('./test-helpers/terminal-replay-before-giant.cjs');
const {observeTerminalIo}=require(path.join(product,'src/main/terminal-io-progress.js'));
const {createXtermWritePump}=require('../shared/xterm-write-pump.cjs');
const begin='\x1b[?2026h', end='\x1b[?2026l';
function fixture(){let time=0;const logs=[];const trace=redraw.createTerminalRedrawTrace(8,{now:()=>time,log:x=>logs.push(x)});return {trace,logs,at:t=>time=t,output:(text,seq)=>redraw.recordTerminalOutput(trace,text,{seq,at:time}),snap:()=>redraw.snapshotTerminalRedrawTrace(trace,8)};}
function legacy(s){const keys=['cursorVisible','cursorVisibilitySeq','synchronizedOutputOpen','synchronizedOutputSeq','synchronizedOutputGeneration','alternateScreen','lastInput','lastResize','lastFlush','entries'];return Object.fromEntries(keys.map(k=>[k,s[k]]));}

test('differentiating: long plain output is visible although legacy snapshots are identical to silence',()=>{
 const a=fixture(),b=fixture();a.at(100);b.at(100);a.output(begin,1);b.output(begin,1);
 a.at(4100);b.at(4100);a.output('Секрет 😀',2);
 assert.deepEqual(legacy(a.snap()),legacy(b.snap()));
 assert.equal(a.snap().ioProgress.mirror.chunks,2);
 assert.equal(b.snap().ioProgress.mirror.chunks,1);
 assert.equal(a.snap().ioProgress.open.ageMs,4000);
 assert.equal(a.snap().ioProgress.open.silenceMs,0);
 assert.equal(b.snap().ioProgress.open.silenceMs,4000);
 assert.equal(JSON.stringify(a.logs).includes('Секрет'),false);
});
test('differentiating: begin lifetime and maximum gap survive ring eviction',()=>{
 const h=fixture();h.at(100);h.output(begin,3004);
 for(let i=0;i<500;i++){h.at(3000+i);h.output('diff\n',3005+i);}
 h.at(6000);const s=h.snap();assert.equal(s.entries.length,8);assert.equal(s.entriesDropped,493);
 assert.equal(s.ioProgress.open.beginSeq,3004);assert.equal(s.ioProgress.open.beginAt,100);
 assert.equal(s.ioProgress.open.ageMs,5900);assert.equal(s.ioProgress.open.maxGapMs,2900);
 assert.equal(s.ioProgress.open.chunks,501);
});
test('existing split-control grammar unchanged; repeated begin does not renew diagnostic lifetime',()=>{
 const h=fixture();h.at(100);h.output('\x1b[?20',1);h.at(200);h.output('26hFIRST',2);
 h.at(500);h.output(begin+'NEXT',3);h.at(700);h.output('\x1b[?202',4);h.at(900);h.output('6l',5);
 const s=h.snap();assert.equal(s.synchronizedOutputOpen,false);assert.equal(s.synchronizedOutputGeneration,3);
 assert.equal(s.ioProgress.lastClosed.beginAt,200);assert.equal(s.ioProgress.lastClosed.ageMs,700);
 assert.equal(s.ioProgress.lastClosed.repeatedBegins,1);assert.equal(s.ioProgress.open,null);
 // First split prefix wasn't counted as a whole touching chunk: onset is recognition, not original kernel time.
 assert.match(s.ioProgress.lastClosed.onset,/grammar/);
});
test('same-chunk close/open/close spans are explicitly overlapping observations',()=>{
 const h=fixture();h.at(50);h.output(begin+'A'+end+begin+'B'+end,1);const s=h.snap();
 assert.equal(s.synchronizedOutputOpen,false);assert.equal(s.ioProgress.lastClosed.id,2);
 assert.equal(s.ioProgress.lastClosed.chunks,1);assert.match(s.ioProgress.lastClosed.counting,/overlap/);
});
test('UTF16 and UTF8 reencoded chunk counters intentionally differ; split surrogate accounting explicit',()=>{
 const h=fixture();h.output(begin,1);h.output('Ж😀',2);h.output('\ud83d',3);h.output('\ude00',4);
 const s=h.snap().ioProgress;assert.equal(s.mirror.chars,begin.length+5);
 assert.equal(s.mirror.utf8Bytes,Buffer.byteLength(begin)+6+3+3);
 assert.match(s.units,/per-chunk/);assert.equal(s.mirror.missingSeqs,0);
});
test('sequence holes, non-increasing seqs and unknown seqs remain visible',()=>{
 const h=fixture();h.output(begin,1);h.output('a',4);h.output('b',4);h.output('c',NaN);
 const s=h.snap().ioProgress.mirror;assert.equal(s.missingSeqs,2);assert.equal(s.nonIncreasingSeqs,1);assert.equal(s.unknownSeqs,1);
});
test('raw arrival, mirror delivery and flush/commit are independent observations',()=>{
 const h=fixture();h.at(10);observeTerminalIo(h.trace,'raw','x');h.at(30);h.output(begin+'x',11);
 h.at(70);redraw.recordTerminalFlush(h.trace,{seq:11});h.at(100);
 let s=h.snap().ioProgress;assert.equal(s.raw.firstAt,10);assert.equal(s.mirror.firstAt,30);assert.equal(s.lastFlush.at,70);assert.equal(s.lastCommit,null);
 h.output(end,12);h.at(130);redraw.recordTerminalFlush(h.trace,{seq:12});observeTerminalIo(h.trace,'commit',12);
 assert.equal(h.snap().ioProgress.lastCommit.at,130);
});
test('actual unchanged pump preserves all data/order; closed-but-unflushed remains distinct',()=>{
 const h=fixture(),callbacks=[],writes=[];let written=0,flushed=0;
 const pump=createXtermWritePump((s,cb)=>{writes.push(s);callbacks.push(cb);},{onFlushed:m=>{flushed=m.seq;redraw.recordTerminalFlush(h.trace,{seq:flushed});if(!h.trace.synchronizedOutputOpen&&flushed===written)observeTerminalIo(h.trace,'commit',flushed);}});
 const put=s=>{written++;h.output(s,written);pump.push(s,{seq:written,generation:'G'});};
 put(begin+'a');callbacks.shift()();assert.equal(flushed,written);assert.equal(h.snap().ioProgress.lastCommit,null);
 put('b');put(end);assert.equal(h.trace.synchronizedOutputOpen,false);assert.notEqual(written,flushed);
 callbacks.shift()();assert.equal(h.snap().ioProgress.lastCommit,null);callbacks.shift()();
 assert.equal(writes.join(''),begin+'ab'+end);assert.equal(h.snap().ioProgress.lastCommit.seq,3);
});
test('diagnostics broken methods and sinks cannot fail the output/input record path',()=>{
 const h=fixture();h.trace.ioProgress.output=()=>{throw Error('broken');};assert.doesNotThrow(()=>h.output(begin,1));assert.equal(h.trace.synchronizedOutputOpen,true);assert.equal(h.trace.progressHookErrors,1);
 const trace=redraw.createTerminalRedrawTrace(8,{now:()=>{throw Error('clock');},log:()=>{throw Error('sink');}});
 assert.doesNotThrow(()=>redraw.recordTerminalOutput(trace,begin,{seq:1}));assert.equal(trace.synchronizedOutputOpen,true);
 assert.doesNotThrow(()=>redraw.snapshotTerminalRedrawTrace(trace));
});
test('observer end never invents DEC close or commit; later events cannot mutate ended span',()=>{
 const h=fixture();h.output(begin,1);h.at(5000);observeTerminalIo(h.trace,'end','mirror-disposed');
 const a=h.snap().ioProgress;h.at(8000);observeTerminalIo(h.trace,'raw','late');
 const b=h.snap().ioProgress;assert.equal(b.open.ageMs,5000);assert.equal(h.trace.synchronizedOutputOpen,true);assert.equal(b.lastCommit,null);assert.equal(b.raw.chunks,a.raw.chunks);assert.equal(b.ended.reason,'mirror-disposed');
});
test('short frames produce no console traffic; long storm is rate-limited with omissions',()=>{
 const h=fixture();for(let i=0;i<3000;i++){h.at(i);h.output(begin+'x'+end,i+1);}assert.equal(h.logs.length,0);
 for(let i=0;i<20;i++){h.at(4000+i*2600);h.output(begin,4000+i*2);h.at(6600+i*2600);h.output('x'+end,4001+i*2);}
 const s=h.snap().ioProgress;assert.ok(h.logs.length<=8);assert.ok(s.reportsDropped>0);assert.equal(s.open,null);
 assert.ok(JSON.stringify(s).length<5000);
});
test('diagnostic new fields do not change legacy parser, controls, cursor and flush output',()=>{
 const a=baseline.createTerminalRedrawTrace(8),b=redraw.createTerminalRedrawTrace(8);const samples=[begin,'PRIVATE\n','\x1b[2J','\x1b[?20','26l', '\x1b[?25l', '\x1b[?1049h','\x1b[?1049l', 'Ж😀','\x1b[4;2H'];
 for(let i=0;i<600;i++){const text=samples[i%samples.length],meta={seq:i+1,at:i+1};assert.deepEqual(redraw.recordTerminalOutput(b,text,meta),baseline.recordTerminalOutput(a,text,meta));}
 assert.deepEqual(legacy(redraw.snapshotTerminalRedrawTrace(b)),baseline.snapshotTerminalRedrawTrace(a));
});
test('differentiating replay loss counts every evicted character; baseline policy and remaining text unchanged',()=>{
 const a=oldReplay.createTerminalReplayJournal({maxChars:16,maxEvents:8}),b=replay.createTerminalReplayJournal({maxChars:16,maxEvents:8});
 for(const j of[a,b]){j.checkpoint(()=>({screen:'base',writeSeq:0}));j.output('Ж'.repeat(20),1);j.output('😀'.repeat(20),2);j.resize(80,24,true);}
 const old=a.snapshot(),v=b.snapshot();const c=v.current;assert.equal(c.complete,false);assert.equal(c.loss.chars,60);assert.equal(c.loss.utf8ReencodedBytes,120);assert.equal(c.loss.outputEvents,2);
 assert.deepEqual(c.events.map(e=>({...e,at:0})),old.current.events.map(e=>({...e,at:0})));
 assert.equal(c.gapReason,old.current.gapReason);assert.deepEqual(c.gaps,['output-exceeded-retention-before-flush','resize-overlapped-pending-xterm-write']);
});
test('resize eviction counts losses and checkpoint keeps incomplete previous instead of repairing it',()=>{
 const j=replay.createTerminalReplayJournal({maxChars:100,maxEvents:2});j.checkpoint(()=>({screen:'old',writeSeq:0}));j.output('prefix',1);for(let i=0;i<5;i++)j.resize(80+i,24,false);
 const lost=j.snapshot().current.loss;assert.equal(lost.outputEvents,1);assert.ok(lost.resizeEvents>0);j.checkpoint(()=>({screen:'new',writeSeq:9}));
 const s=j.snapshot();assert.equal(s.current.complete,true);assert.equal(s.previous.complete,false);assert.equal(s.previous.loss.chars,6);assert.equal(s.current.loss.chars,0);
});
test('diagnostic UTF8 loss-counter failure cannot change replay eviction or propagate to mirror',()=>{
 const fs=require('node:fs'),vm=require('node:vm');const ctx={module:{exports:{}},Buffer:{byteLength(){throw Error('broken counter');}},Date};vm.runInNewContext(fs.readFileSync(path.join(product,'src/main/terminal-replay-journal.js'),'utf8'),ctx);const j=ctx.module.exports.createTerminalReplayJournal({maxChars:16});j.checkpoint(()=>({screen:'base'}));assert.doesNotThrow(()=>j.output('x'.repeat(80),1));const v=j.snapshot().current;assert.equal(v.complete,false);assert.equal(v.chars,0);assert.equal(v.loss.chars,80);assert.equal(v.loss.utf8Complete,false);assert.equal(v.loss.utf8UnavailableEvents,1);
});
