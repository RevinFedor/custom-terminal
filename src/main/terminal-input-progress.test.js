'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'), product=root;
const {createTerminalInputProgress,writeTerminalInputObserved,beginTerminalInputProgress,noteTerminalInputProgress}=require(path.join(product,'src/main/terminal-input-progress.js'));
const key=Symbol.for('noted.pty.writeTrace.v1');
let patched;
const preparation=import('../../scripts/node-pty-write-trace.mjs').then(m=>{patched=m.patchNodePtyWriteTrace(fs.readFileSync(require.resolve('node-pty/lib/unixTerminal'),'utf8'));assert.equal(crypto.createHash('sha256').update(patched).digest('hex'),m.PTY_WRITE_TRACE_SHA);});
function fixture(options={}){
 let time=1000, id=0;const calls=[],immediates=new Map(),errors=[],logs=[];
 const source=patched.slice(patched.indexOf('// Noted scalar-only observer.'));
 const ctx={Buffer,Symbol,Number,fs:{write(fd,buffer,offset,callback){calls.push({fd,buffer,offset,callback});}},setImmediate:cb=>{const n=++id;immediates.set(n,cb);return n;},clearImmediate:n=>immediates.delete(n),console:{error:(...x)=>errors.push(x)}};
 vm.runInNewContext(source+'\nthis.Stream=CustomWriteStream;',ctx);
 const stream=new ctx.Stream(10,'utf8'), term={_writeStream:stream,write(data){stream.write(data);return 77;}};
 const trace=createTerminalInputProgress({now:()=>time,log:x=>{if(options.throwLog)throw Error('private');logs.push(x);}});
 return {trace,stream,term,calls,immediates,errors,logs,at:t=>time=t, begin:data=>trace.begin(data,{tabId:'T',mirrorGeneration:'M',runSeq:1,syncOpen:true}),
  complete(written,error=null){const c=calls.shift();assert.ok(c);c.callback(error,written??c.buffer.byteLength-c.offset);},
  immediate(){const [n,cb]=immediates.entries().next().value;immediates.delete(n);cb();},snap:()=>trace.snapshot()};
}
test.before(()=>preparation);

test('existing hook SHA, not a new fd writer, is executed with controlled callbacks',()=>{assert.match(patched,/notedWriteTraceVersion = 1/);assert.match(patched,/fs.write\(this._fd, task.buffer, task.offset/);});
test('manual input return is not fd completion; exact predecessor delay remains attributed',()=>{
 const h=fixture();h.term.write('ahead');const token=h.begin('Ж😀');assert.equal(writeTerminalInputObserved(token,h.term,'Ж😀'),77);
 let r=h.snap().records[0];assert.equal(r.writesReturned,1);assert.equal(r.tasks.length,1);assert.equal(r.tasks[0].stages.enqueue.aheadCount,1);assert.equal(r.tasks[0].stages['fd-call'],undefined);
 h.at(4000);h.complete();r=h.snap().records[0];assert.equal(r.tasks[0].stages['fd-call'].firstAt,4000);assert.equal(r.tasks[0].stages.enqueue.aheadBytes,5);
 h.at(4050);h.complete();r=h.snap().records[0];assert.equal(r.tasks[0].completedAt,4050);assert.equal(r.chars,3);assert.equal(r.utf8Bytes,6);assert.equal(r.tasks[0].stages.enqueue.aheadCount,1);
 assert.equal(Object.hasOwn(h.stream,key),false);assert.equal(JSON.stringify(h.logs).includes('Ж'),false);
});
test('partial callback, EAGAIN and next attempt preserve original queue algorithm and exact offset',()=>{
 const h=fixture(),token=h.begin('abcde');writeTerminalInputObserved(token,h.term,'abcde');h.at(1010);h.complete(2);assert.equal(h.calls[0].offset,2);
 h.at(1020);h.complete(0,{code:'EAGAIN'});assert.equal(h.calls.length,0);assert.equal(h.immediates.size,1);h.at(1100);h.immediate();assert.equal(h.calls[0].offset,2);h.at(1150);h.complete(3);
 const task=h.snap().records[0].tasks[0];assert.equal(task.stages['fd-call'].count,3);assert.equal(task.stages['fd-callback'].count,3);assert.equal(task.stages['fd-callback'].errors.EAGAIN,1);assert.equal(task.offsetAfter,5);assert.equal(task.completedAt,1150);assert.equal(h.stream._writeQueue.length,0);
});
test('fatal async error differs from returned API; abandoned successor is not completed',()=>{
 const h=fixture();writeTerminalInputObserved(h.begin('one'),h.term,'one');writeTerminalInputObserved(h.begin('two'),h.term,'two');h.at(1200);h.complete(0,{code:'EIO',message:'PRIVATE ERROR'});
 const s=h.snap();assert.equal(s.records[0].writesReturned,1);assert.equal(s.records[0].tasks[0].completedAt,undefined);assert.equal(s.records[1].tasks[0].abandonedAt,1200);assert.equal(h.errors.length,1);assert.equal(JSON.stringify(h.logs).includes('PRIVATE ERROR'),false);
});
test('dispose and a later already-started completion are separate facts, never success from dispose',()=>{
 const h=fixture();writeTerminalInputObserved(h.begin('one'),h.term,'one');h.at(1200);h.stream.dispose();let r=h.snap().records[0];assert.equal(r.tasks[0].disposeAt,1200);assert.equal(r.tasks[0].completedAt,undefined);
 h.at(1300);h.complete();r=h.snap().records[0];assert.equal(r.tasks[0].completedAt,1300);assert.equal(r.tasks[0].disposeAt,1200);
});
test('unavailable hook still performs one unchanged call; no fabricated callback',()=>{
 const trace=createTerminalInputProgress();const data='\x1b[200~test\x1b[201~', token=trace.begin(data);let calls=0;const term={write(s){assert.equal(s,data);calls++;return 9;}};
 assert.equal(writeTerminalInputObserved(token,term,data),9);assert.equal(calls,1);const r=trace.snapshot().records[0];assert.equal(r.hook,'unavailable');assert.equal(r.tasks.length,0);assert.equal(r.bracketedPaste,true);
});
test('throws keep original exception, no retry, restore existing trace descriptor',()=>{
 const trace=createTerminalInputProgress(),token=trace.begin('x'),failure=Error('same'),old={observe(){}};const stream={notedWriteTraceVersion:1};Object.defineProperty(stream,key,{value:old,writable:false,configurable:true,enumerable:true});const desc=Object.getOwnPropertyDescriptor(stream,key);let calls=0;
 assert.throws(()=>writeTerminalInputObserved(token,{_writeStream:stream,write(){calls++;throw failure;}},'x'),e=>e===failure);
 assert.equal(calls,1);assert.deepEqual(Object.getOwnPropertyDescriptor(stream,key),desc);assert.equal(trace.snapshot().records[0].writesThrew,1);assert.equal(trace.snapshot().records[0].tasks.length,0);
});
test('failed hook binding cannot swallow, duplicate or change native write',()=>{
 const trace=createTerminalInputProgress(),token=trace.begin('x'),stream={notedWriteTraceVersion:1};Object.defineProperty(stream,key,{value:null,configurable:false});let n=0;
 assert.equal(writeTerminalInputObserved(token,{_writeStream:stream,write(){n++;return 10;}},'x'),10);assert.equal(n,1);assert.equal(trace.snapshot().records[0].hook,'binding-failed');assert.ok(trace.snapshot().diagnosticErrors>0);
});
test('throwing sink does not affect partial/error queue processing',()=>{
 const h=fixture({throwLog:true});writeTerminalInputObserved(h.begin('abc'),h.term,'abc');h.complete(1);h.complete(2);assert.equal(h.stream._writeQueue.length,0);assert.ok(h.snap().diagnosticErrors>=2);
});
test('owner loss note is metadata, never permission to write or a forced retry',()=>{
 const h=fixture(),t=h.begin('text');noteTerminalInputProgress(t,'queued');h.at(5000);noteTerminalInputProgress(t,'terminal-replaced');const r=h.snap().records[0];assert.equal(r.writesAttempted,0);assert.equal(r.notes[1].kind,'terminal-replaced');assert.equal(h.calls.length,0);
});
test('more than sixteen unfinished inputs evict diagnostic records only; byte queue unchanged',()=>{
 const h=fixture();for(let i=0;i<40;i++)writeTerminalInputObserved(h.begin('p'+i),h.term,'p'+i);assert.equal(h.stream._writeQueue.length,40);assert.equal(h.snap().records.length,16);assert.equal(h.snap().omittedInputs,24);assert.equal(h.snap().omittedUnfinishedInputs,24);
 while(h.calls.length)h.complete();assert.equal(h.stream._writeQueue.length,0);assert.ok(h.snap().omittedCallbacks>=24);assert.ok(h.logs.length<=8);assert.ok(h.snap().suppressedReports>0);
});
test('single input task fanout and note floods have bounded omission counters',()=>{
 const h=fixture(),t=h.begin('x');const original=h.term.write;h.term.write=function(data){for(let i=0;i<12;i++)original.call(this,data);};writeTerminalInputObserved(t,h.term,'x');for(let i=0;i<100;i++)noteTerminalInputProgress(t,'queued');while(h.calls.length)h.complete();const r=h.snap().records[0];assert.equal(r.tasks.length,4);assert.ok(r.omittedTaskEvents>0);assert.equal(r.notes.length,8);assert.equal(r.omittedNotes,92);
});
test('broken begin or clock is diagnostic-only; terminal call keeps its receiver and data',()=>{
 const trace={inputProgress:{begin(){throw Error('fault');}}};assert.equal(beginTerminalInputProgress(trace,'x',{}),null);assert.equal(trace.inputProgressHookErrors,1);
 let broken=false;const collector=createTerminalInputProgress({now:()=>{if(broken)throw Error('time');return 10;}});const t=collector.begin('x');broken=true;let calls=0;const term={write(s){assert.equal(this,term);assert.equal(s,'x');calls++;return 4;}};assert.equal(writeTerminalInputObserved(t,term,'x'),4);assert.equal(calls,1);
});
test('two inputs correlate with their own task even when callbacks are out of JS write scope',()=>{
 const h=fixture(),a=h.begin('aaa'),b=h.begin('bbb');writeTerminalInputObserved(a,h.term,'aaa');writeTerminalInputObserved(b,h.term,'bbb');h.at(1100);h.complete();h.at(1200);h.complete();const r=h.snap().records;assert.notEqual(r[0].tasks[0].taskId,r[1].tasks[0].taskId);assert.equal(r[0].tasks[0].completedAt,1100);assert.equal(r[1].tasks[0].completedAt,1200);
});
test('receive owner and actual write-boundary owner are distinct; reader failure is not a write refusal',()=>{
 const trace=createTerminalInputProgress(),token=trace.begin('x',{runSeq:1,inputRevision:5});const term={write(){return 1;}};
 writeTerminalInputObserved(token,term,'x',()=>({runSeq:2,inputRevision:6,body:'PRIVATE'}));let r=trace.snapshot().records[0];assert.equal(r.owner.runSeq,1);assert.equal(r.writeOwner.runSeq,2);assert.equal(r.writeOwner.body,undefined);
 const other=trace.begin('y');assert.equal(writeTerminalInputObserved(other,term,'y',()=>{throw Error('private');}),1);assert.equal(trace.snapshot().records[1].writeOwner,null);
});
test('existing bounded queue-ahead probe explicitly marks partial byte accounting',()=>{
 const h=fixture();for(let i=0;i<150;i++)h.term.write('abc');writeTerminalInputObserved(h.begin('x'),h.term,'x');const t=h.snap().records[0].tasks[0];assert.equal(t.stages.enqueue.aheadCount,150);assert.equal(t.stages.enqueue.aheadBytes,384);assert.equal(t.stages.enqueue.aheadBytesComplete,false);while(h.calls.length)h.complete();assert.equal(h.stream._writeQueue.length,0);
});
