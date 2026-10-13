import test from 'node:test';import assert from 'node:assert/strict';
import {sendThenNativeDrag} from './send-then-native-drag.mjs';
const plan=()=>({runId:'D1-one',targetUrl:'file:///private-frozen/index.html',sendSelector:'#send-C',waitMs:1000,
  drag:{from:'[data-tab-id="B"]',points:[{x:120,y:300,steps:24,durationMs:500}],modifiers:[],expectedMainPid:4410,requireFrontmost:true}});
const nativeReceipt=()=>({ok:true,receiptVersion:1,operationId:'offline-drag-1',op:'drag',outcome:'posted',
 target:{expectedMainPid:4410,requireFrontmost:true},events:{attempted:30,posted:30},
 cleanup:{state:'not-needed',remainingMouseDown:false,remainingModifiers:[],attempts:[]},
 timing:{mouseDownWallMs:2050,mouseUpAfterWallMs:2650,runEndWallMs:2651}});
function fixture(extra={}){
 const calls=[];const adapter={guard:async stage=>{calls.push(stage);return{ok:true,privatePid:4410,busyTurnIds:['A1','B1']};},
  callTool:async(name,args)=>{calls.push(name);
   if(name==='electron_native_input_status')return{ok:true,postEventAccess:true,
    nativeAdmission:{version:1,state:'available',available:true,planValidated:true}};
   if(name==='electron_steps'){assert.equal(args.continueOnError,false);assert.deepEqual(args.steps.map(s=>s.action),['evaluate','click','wait']);assert.equal(args.steps[2].ms,1000);return{ok:true};}
   if(name==='electron_native_drag_path'){assert.equal(args.expectedMainPid,4410);assert.equal(args.requireFrontmost,true);return nativeReceipt();}
   if(name==='electron_evaluate')return{value:{click:{receivedWallMs:1000,trusted:true},pointerdown:{receivedWallMs:2070,trusted:true},pointerup:{receivedWallMs:2660,trusted:true}}};
   assert.fail(name);
  },...extra};return{adapter,calls};
}
test('sequential existing tools, measured real delta differs from requested wait, normal release kept',async()=>{
 const f=fixture(),r=await sendThenNativeDrag(f.adapter,plan());
 assert.deepEqual(f.calls,['before-preflight','electron_native_input_status','before-send','electron_native_input_status','electron_steps','before-native','electron_native_drag_path','electron_evaluate']);
 assert.equal(r.sendToReceivedPointerMs,1070);assert.equal(r.sendToPostedPointerMs,1050);
 assert.equal(r.send,'click-returned');assert.equal(r.release,'backend-posted');
});
test('cancel during intentional wait leaves one Send attempt and never starts drag',async()=>{
 const controller=new AbortController(),f=fixture(),base=f.adapter.callTool;
 f.adapter.callTool=async(name,args)=>{const r=await base(name,args);if(name==='electron_steps')controller.abort();return r;};
 const r=await sendThenNativeDrag(f.adapter,plan(),{signal:controller.signal});
 assert.equal(r.status,'cancelled-before-native');assert.equal(r.send,'click-returned');assert.equal(r.native,'not-started');
 assert.equal(f.calls.filter(n=>n==='electron_steps').length,1);assert.equal(f.calls.includes('electron_native_drag_path'),false);
});
test('lost native reply remains release UNKNOWN; no CDP-up substitute or retry',async()=>{
 const f=fixture(),base=f.adapter.callTool;f.adapter.callTool=async(name,args)=>{
   if(name==='electron_native_drag_path'){f.calls.push(name);throw Error('transport disconnected');}return base(name,args);};
 const r=await sendThenNativeDrag(f.adapter,plan());assert.equal(r.release,'unknown');assert.equal(r.native,'attempted-outcome-unknown');
 assert.equal(f.calls.filter(n=>n==='electron_native_drag_path').length,1);assert.equal(f.calls.at(-1),'electron_evaluate');
 await assert.rejects(sendThenNativeDrag(f.adapter,plan()),/previous native release UNKNOWN/);
 assert.equal(f.calls.filter(n=>n==='electron_steps').length,1);
});
test('in-flight cancellation awaits existing backend release; it cannot claim no drop',async()=>{
 const controller=new AbortController(),f=fixture(),base=f.adapter.callTool;
 f.adapter.callTool=async(name,args)=>{if(name==='electron_native_drag_path')controller.abort();return base(name,args);};
 const r=await sendThenNativeDrag(f.adapter,plan(),{signal:controller.signal});
 assert.equal(r.status,'cancel-requested-after-native-release');assert.equal(r.release,'backend-posted');
});
test('failed click, stale BUSY/target guard and malformed path never produce another input',async()=>{
 const f=fixture(),base=f.adapter.callTool;f.adapter.callTool=async(name,args)=>name==='electron_steps'?{ok:false,error:'click outcome unknown'}:base(name,args);
 const failed=await sendThenNativeDrag(f.adapter,plan());assert.equal(failed.native,'not-started');assert.equal(failed.send,'attempted-outcome-unknown');
 const stale=fixture({guard:async()=>({ok:false,reason:'turn A settled'})});assert.equal((await sendThenNativeDrag(stale.adapter,plan())).send,'not-attempted');
 const bad=plan();bad.drag.points[0].x=NaN;await assert.rejects(sendThenNativeDrag(fixture().adapter,bad),/finite path/);
});
test('missing native terminal timestamp is not accepted as a release receipt',async()=>{
 const f=fixture(),base=f.adapter.callTool;f.adapter.callTool=async(name,args)=>{
  const result=await base(name,args);if(name==='electron_native_drag_path')delete result.timing.runEndWallMs;return result;};
 const result=await sendThenNativeDrag(f.adapter,plan());assert.equal(result.release,'unknown');assert.equal(result.status,'stopped');
});
test('missing PID or frontmost guard is rejected before preflight or Send',async()=>{
 for(const patch of [{expectedMainPid:undefined},{expectedMainPid:1.5},{requireFrontmost:false}]){
  const f=fixture(),p=plan();Object.assign(p.drag,patch);
  await assert.rejects(sendThenNativeDrag(f.adapter,p),/exact Main PID/);assert.deepEqual(f.calls,[]);
 }
});
for(const channel of ['text','structured','thrown'])test('failed native cleanup receipt survives '+channel+' delivery',async()=>{
 const f=fixture(),base=f.adapter.callTool,receipt={...nativeReceipt(),ok:false,outcome:'failed',error:'focus changed',
  cleanup:{state:'released',remainingMouseDown:false,remainingModifiers:[],attempts:[{kind:'mouseUp',ok:true}]}};
 f.adapter.callTool=async(name,args)=>{
  if(name!=='electron_native_drag_path')return base(name,args);
  f.calls.push(name);
  if(channel==='thrown')throw Object.assign(Error(receipt.error),{nativeInputReceipt:receipt});
  return channel==='text'?{isError:true,content:[{type:'text',text:JSON.stringify(receipt)}]}:{isError:true,structuredContent:receipt};
 };
 const r=await sendThenNativeDrag(f.adapter,plan());
 assert.deepEqual(r.nativeReceipt,receipt);assert.equal(r.status,'stopped');assert.equal(r.native,'failure-returned');
 assert.equal(r.release,'backend-posted');assert.equal(f.calls.filter(n=>n==='electron_native_drag_path').length,1);
});
test('UNKNOWN release is preserved even when timestamps exist',async()=>{
 const f=fixture(),base=f.adapter.callTool,receipt={...nativeReceipt(),ok:false,outcome:'unknown',error:'permission lost',
  cleanup:{state:'unknown',remainingMouseDown:true,remainingModifiers:[],attempts:[{kind:'mouseUp',ok:false}]}};
 f.adapter.callTool=async(name,args)=>name==='electron_native_drag_path'?{isError:true,content:[{type:'text',text:JSON.stringify(receipt)}]}:base(name,args);
 const r=await sendThenNativeDrag(f.adapter,plan());assert.deepEqual(r.nativeReceipt,receipt);assert.equal(r.release,'unknown');
 await assert.rejects(sendThenNativeDrag(f.adapter,plan()),/UNKNOWN/);
});
test('unbound, held-input and legacy success receipts cannot claim release',async()=>{
 for(const mutate of [r=>delete r.receiptVersion,r=>{r.target.expectedMainPid=555;},r=>{r.cleanup.remainingMouseDown=true;}]){
  const f=fixture(),base=f.adapter.callTool;f.adapter.callTool=async(name,args)=>{
   const r=await base(name,args);if(name==='electron_native_drag_path')mutate(r);return r;};
  const r=await sendThenNativeDrag(f.adapter,plan());assert.equal(r.status,'stopped');assert.equal(r.release,'unknown');
 }
});
test('unknown blocking owner after Send preserves not-posted for this call and latches future Send',async()=>{
 const f=fixture(),base=f.adapter.callTool,receipt={...nativeReceipt(),ok:false,outcome:'not-posted',error:'prior owner unknown',
  events:{attempted:0,posted:0},transport:{blockingState:'unknown',blockingOperationId:'prior-owner-7'}};
 f.adapter.callTool=async(name,args)=>name==='electron_native_drag_path'?{isError:true,structuredContent:receipt}:base(name,args);
 const result=await sendThenNativeDrag(f.adapter,plan());assert.equal(result.release,'not-held');
 assert.equal(result.blockingNativeInput.blockingOperationId,'prior-owner-7');assert.deepEqual(result.nativeReceipt,receipt);
 await assert.rejects(sendThenNativeDrag(f.adapter,plan()),error=>error.nativeInputReceipt.blockingOperationId==='prior-owner-7');
 assert.equal(f.calls.filter(n=>n==='electron_steps').length,1);
});
test('permission without explicit owner and full-plan proof is not admission for Send',async()=>{
 for(const admission of [undefined,{version:1,state:'busy',available:false,blockingOperationId:'active'},
  {version:1,state:'available',available:true,planValidated:false}]){
  const f=fixture(),base=f.adapter.callTool;f.adapter.callTool=async(name,args)=>name==='electron_native_input_status'
   ?{ok:true,postEventAccess:true,nativeAdmission:admission}:base(name,args);
  const result=await sendThenNativeDrag(f.adapter,plan());assert.equal(result.send,'not-attempted');
  assert.equal(f.calls.includes('electron_steps'),false);
 }
});
