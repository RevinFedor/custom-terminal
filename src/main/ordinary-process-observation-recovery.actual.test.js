'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const liveness=require('./ai-process-liveness');
const text=fs.readFileSync(process.env.OWN_MAIN_SOURCE||require.resolve('./main'),'utf8');
const tree=ts.createSourceFile('main.js',text,ts.ScriptTarget.Latest,true);
const names=['captureAiProcessLookupScope','aiProcessLookupScopeCurrent','findAiDescendantProcessesByTab','inspectAiDescendantProcessesByTab','readAiLifecycleIdentityForTab'];
const code=names.map(name=>{const n=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert(n,name);return n.getText(tree);}).join('\n');
function fixture(change,{second='absent',tool=null,error=null}={}){
 const tab='own-ordinary',terminal={pid:100},logs=[],state={generation:'G1',calls:0};
 const c=vm.createContext({...liveness,console:{log:(...a)=>logs.push(a.join(' ')),warn:(...a)=>logs.push(a.join(' '))},
  nodePerformance:{timeOrigin:0,now:()=>0},beginPerfOp(){},endPerfOp(){},
  terminals:new Map([[tab,terminal]]),terminalCommandState:new Map([[tab,{runSeq:1,isRunning:true}]]),
  claudeLaunchGenerationByTab:new Map(),codexLastRunCommandPayload:new Map(),
  terminalProjectIds:new Map([[tab,'P']]),terminalProjects:new Map([[tab,'/own/fixture']]),
  getTerminalLifecycleGeneration:()=>state.generation,
  commandLooksLikeAiProcess:cmd=>cmd==='codex',getAiProcessNameFromCommand:()=> 'codex',
  selectAiProcessForStop:matches=>matches[0]||null,
  currentAiLifecycleIdentity:(_tab,proof)=>proof,
  getProcessTreeSnapshot:async options=>{
   assert.equal(options.forceFresh,true);state.calls++;
   if(state.calls===1){if(error)throw error;change?.(c,state,tab);}
   if(state.calls===2&&second==='unknown')throw Error('second snapshot UNKNOWN');
   return {children:second==='found'&&state.calls===2?new Map([[100,[{pid:101,cmd:'codex'}]]]):new Map(),psMs:0,createdAt:0};
  }});
 vm.runInContext(code,c);return{c,state,logs,read:()=>c.readAiLifecycleIdentityForTab(tab,tool)};
}
const finish=(c,_s,tab)=>c.terminalCommandState.set(tab,{runSeq:1,isRunning:false});
test('actual ordinary lookup re-observes only a same-owner natural completion',async()=>{
 const f=fixture(finish),v=await f.read();assert.equal(v.processStatus,'absent');assert.equal(f.state.calls,2);assert(f.logs.some(x=>x.includes('reobserve-shell-completion')));
});
test('a fresh positive provider result is kept, never changed into absence',async()=>{
 const f=fixture(finish,{second:'found'}),v=await f.read();assert.equal(v.processStatus,'found');assert.equal(v.processPid,101);assert.equal(f.state.calls,2);
});
test('second UNKNOWN remains UNKNOWN with no third attempt',async()=>{
 const f=fixture(finish,{second:'unknown'});assert.equal((await f.read()).processStatus,'unknown');assert.equal(f.state.calls,2);
});
for(const [label,change]of [
 ['terminal',(c,_s,t)=>c.terminals.set(t,{pid:200})],
 ['generation',(_c,s)=>s.generation='G2'],
 ['command sequence',(c,_s,t)=>c.terminalCommandState.set(t,{runSeq:2,isRunning:false})],
 ['cwd',(c,_s,t)=>c.terminalProjects.set(t,'/other')],
 ['namespace',(c,_s,t)=>c.terminalProjectIds.set(t,'Q')],
 ['Claude launch',(c,_s,t)=>c.claudeLaunchGenerationByTab.set(t,{generation:'L2'})],
 ['Codex launch',(c,_s,t)=>c.codexLastRunCommandPayload.set(t,{launchId:'L2'})],
 ])test('replacement '+label+' keeps original UNKNOWN and cannot re-observe',async()=>{
  const f=fixture((c,s,t)=>{finish(c,s,t);change(c,s,t);});assert.equal((await f.read()).processStatus,'unknown');assert.equal(f.state.calls,1);
 });
test('provider-specific lifecycle read keeps its original unknown fence',async()=>{
 const f=fixture(finish,{tool:'codex'});assert.equal((await f.read()).processStatus,'unknown');assert.equal(f.state.calls,1);
});
test('timeout does not become an observation retry or absence',async()=>{
 const f=fixture(null,{error:Object.assign(Error('ps timeout'),{code:'ETIMEDOUT'})});assert.equal((await f.read()).processStatus,'unknown');assert.equal(f.state.calls,1);
});
test('already stable ordinary command uses one snapshot',async()=>{
 const f=fixture();assert.equal((await f.read()).processStatus,'absent');assert.equal(f.state.calls,1);
});
