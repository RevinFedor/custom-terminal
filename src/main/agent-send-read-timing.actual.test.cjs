'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('typescript'),agentSendReadTiming=require('../shared/agent-send-read-timing.cjs');
const source=fs.readFileSync(path.join(__dirname,'main.js'),'utf8');
const ast=ts.createSourceFile('main.js',source,ts.ScriptTarget.Latest,true);
function handler(channel,ports){const found=[];function visit(n){
  if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.expression.getText(ast)==='ipcMain'
    &&n.expression.name.text==='handle'&&ts.isStringLiteral(n.arguments[0])&&n.arguments[0].text===channel)found.push(n.arguments[1]);
  ts.forEachChild(n,visit);}visit(ast);assert.equal(found.length,1,'one actual IPC handler '+channel);
  return vm.runInNewContext('('+found[0].getText(ast)+')',{agentSendReadTiming,...ports});}
const trace=()=>agentSendReadTiming.createAgentSendReadTiming({tabId:'T',operationKey:'history:T:H',attemptId:'A',handoffId:'H',emit(){},now:()=>100});
function ports(){const rows=[];let clock=120;return {rows,setClock:n=>clock=n,context:{console:{log:line=>rows.push(JSON.parse(line.slice('[AgentSendReadTiming] '.length)))},nodePerformance:{timeOrigin:0,now:()=>clock}}};}
test('actual projection handler stays synchronous, publishes once and labels only its bounded caller metadata',()=>{
  const p=ports(),calls=[],expected={success:true,inputReady:true,content:'not logged'};
  const run=handler('codex:get-runtime-projection',{...p.context,publishCodexRuntimeProjection:(...args)=>{calls.push(args);p.setClock(127);return expected;}});
  assert.equal(run(null,{tabId:'T',projectId:'P',readTiming:trace().start('final-presence')}),expected);
  assert.deepEqual(calls,[['T','renderer-presence-query','P']]);
  assert.deepEqual(p.rows.map(r=>[r.phase,r.abs]),[['main-enter',120],['main-return',127]]);
  assert.ok(p.rows.every(r=>r.operationKey==='history:T:H'&&!Object.hasOwn(r,'content')));
});
test('actual composer handler strips observation data before the command and returns the same pending promise',async()=>{
  const p=ports(),calls=[],expectedTarget={launchId:'launch'},pending=Promise.resolve({success:true,inputWritten:false});
  const run=handler('codex:prepare-main-composer-for-send',{...p.context,prepareCodexMainComposerForSend:(...args)=>{calls.push(args);return pending;}});
  const result=run(null,{tabId:'T',expectedTarget,sendOperationKey:'O',sendAttemptId:'A',readTiming:trace().start('composer-prepare')});
  assert.equal(result,pending);assert.equal(calls.length,1);assert.equal(calls[0][0],'T');
  assert.equal(calls[0][1].expectedTarget,expectedTarget);assert.equal(calls[0][1].sendOperationKey,'O');
  assert.equal(Object.hasOwn(calls[0][1],'readTiming'),false);await pending;
  assert.deepEqual(p.rows.map(r=>r.phase),['main-enter','main-return']);assert.equal(p.rows[1].inputWritten,false);
});
test('wrong-tab timing cannot relabel work and does not change existing business error or legacy handler behavior',()=>{
  const p=ports(),error=Error('same error'),expected={same:true};let calls=0;
  const run=handler('codex:get-runtime-projection',{...p.context,publishCodexRuntimeProjection:()=>{calls++;return expected;}});
  assert.equal(run(null,{tabId:'other',readTiming:trace().start('wait-presence')}),expected);
  assert.equal(run(null,'T'),expected);assert.equal(calls,2);assert.deepEqual(p.rows,[]);
  const fail=handler('codex:prepare-main-composer-for-send',{...p.context,prepareCodexMainComposerForSend:()=>{throw error;}});
  assert.throws(()=>fail(null,{tabId:'T',readTiming:trace().start('composer-prepare')}),value=>value===error);
  assert.equal(p.rows.at(-1).phase,'main-throw');
});
test('throwing observational console cannot change actual composer rejection identity or invoke twice',async()=>{
  const p=ports(),error=Error('business error'),pending=Promise.reject(error);let calls=0;
  p.context.console.log=()=>{throw Error('diagnostic failure');};
  const run=handler('codex:prepare-main-composer-for-send',{...p.context,prepareCodexMainComposerForSend:()=>{calls++;return pending;}});
  assert.equal(run(null,{tabId:'T',readTiming:trace().start('composer-prepare')}),pending);
  await assert.rejects(pending,value=>value===error);assert.equal(calls,1);
});
