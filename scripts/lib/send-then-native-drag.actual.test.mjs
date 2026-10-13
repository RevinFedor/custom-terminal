// Actual Electron MCP steps/evaluate functions. Page and CGEvent adapters are
// fakes: this verifies the response/order boundary, not physical/native input.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import ts from 'typescript';import {sendThenNativeDrag} from './send-then-native-drag.mjs';
const file=new URL('../../../electron-mcp/src/tools.mjs',import.meta.url);
const source=fs.readFileSync(file,'utf8'),tree=ts.createSourceFile('tools.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const names=['tool_steps','tool_evaluate','requireSelector','requirePoint'];
const functions=tree.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.includes(node.name?.text));
assert.equal(functions.length,names.length);
const code=functions.map(node=>node.getText(tree).replace(/^export /,'')).join('\n')+'\n({tool_steps,tool_evaluate})';
for(const failClick of [false,true])test('actual MCP timing envelope and cleanup, click failure='+failClick,async()=>{
 let wall=1000,clicks=0,nativeCalls=0;const listeners=new Map();
 class Element{constructor(selector){this.selector=selector;}closest(selector){return selector===this.selector?this:null;}}
 const send=new Element('#send'),chip=new Element('#source'),window={};
 const document={querySelectorAll:selector=>['#send','#source'].includes(selector)?[{}]:[],
  addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 const context=vm.createContext({window,document,Element,location:{href:'file:///private/index.html'},Date:{now:()=>wall}});
 const event=(name,target)=>listeners.get(name)?.({target,button:0,pointerId:1,isTrusted:true,timeStamp:wall});
 const page={evaluate:expression=>vm.runInContext(expression,context),click:async()=>{
  clicks++;event('click',send);if(failClick)throw Error('channel lost after click');},waitForTimeout:async ms=>{wall+=ms;}};
 const actual=vm.runInNewContext(code,{withPage:fn=>fn(page),ok:data=>({ok:true,...data}),Date:{now:()=>wall},Number,JSON});
 const result=await sendThenNativeDrag({guard:async()=>({ok:true}),callTool:async(name,args)=>{
  if(name==='electron_steps')return actual.tool_steps(args);
  if(name==='electron_evaluate')return actual.tool_evaluate(args);
  if(name==='electron_native_input_status')return{ok:true,postEventAccess:true,
   nativeAdmission:{version:1,state:'available',available:true,planValidated:true}};
  if(name==='electron_native_drag_path'){
   nativeCalls++;wall+=50;const down=wall;event('pointerdown',chip);wall+=500;event('pointerup',chip);
   return{ok:true,receiptVersion:1,operationId:'offline-actual-1',op:'drag',outcome:'posted',
    target:{expectedMainPid:4410,requireFrontmost:true},events:{attempted:30,posted:30},
    cleanup:{state:'not-needed',remainingMouseDown:false,remainingModifiers:[],attempts:[]},
    timing:{mouseDownWallMs:down,mouseUpAfterWallMs:wall,runEndWallMs:wall}};
  }assert.fail(name);
 }},{runId:'actual-one',targetUrl:'file:///private/index.html',sendSelector:'#send',
  drag:{from:'#source',points:[{x:10,y:20}],expectedMainPid:4410,requireFrontmost:true}});
 assert.equal(clicks,1);assert.equal(nativeCalls,failClick?0:1);assert.equal(listeners.size,0);assert.deepEqual(Object.keys(window),[]);
 assert.equal(result.events.click.trusted,true);assert.equal(result.observationError,undefined);
 if(failClick){assert.equal(result.send,'attempted-outcome-unknown');assert.equal(result.release,'not-held');}
 else{assert.equal(result.sendToReceivedPointerMs,1050);assert.equal(result.sendToPostedPointerMs,1050);assert.equal(result.release,'backend-posted');}
});
