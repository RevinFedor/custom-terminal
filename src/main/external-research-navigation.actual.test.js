const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const source=fs.readFileSync(require.resolve('./web-server'),'utf8');
const ast=ts.createSourceFile('web.js',source,ts.ScriptTarget.Latest,true);
const declaration=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='openExternalResearchJob');
test('actual Noted navigation pins persisted external job ID, not a label or derived run prefix',async()=>{
  const calls=[];
  const open=vm.runInNewContext(declaration.getText(ast)+'\nopenExternalResearchJob',{
    crypto:{randomUUID:()=> 'nav-id'},getOrchestrationRunStore:()=>({get:async id=>{assert.equal(id,'run');return {runKind:'external-research',externalResearchJobId:'exact-old-id'};}}),
    getScExternalResearchClient:()=>({openJob:async(id,options)=>{calls.push([id,options]);return {jobId:id};}}),
  });
  const result=await open('run');assert.equal(result.success,true);assert.equal(result.jobId,'exact-old-id');
  assert.equal(calls[0][0],'exact-old-id');assert.equal(calls[0][1].requestId,'nav-id');
});
test('native runs, missing external identity and old SC refuse with no provider/browser fallback',async()=>{
  for(const run of [null,{runKind:'agent',externalResearchJobId:'job'},{runKind:'external-research'}]){
    const open=vm.runInNewContext(declaration.getText(ast)+'\nopenExternalResearchJob',{
      getOrchestrationRunStore:()=>({get:async()=>run}),getScExternalResearchClient:()=>assert.fail('not a research job'),
    });assert.equal((await open('run')).success,false);
  }
  const open=vm.runInNewContext(declaration.getText(ast)+'\nopenExternalResearchJob',{
    crypto:{randomUUID:()=> 'nav-id'},getOrchestrationRunStore:()=>({get:async()=>({runKind:'external-research',externalResearchJobId:'job'})}),
    getScExternalResearchClient:()=>({openJob:async()=>{throw Object.assign(Error('update SC'),{code:'sc_research_navigation_unavailable'});}}),
  });const result=await open('run');assert.equal(result.success,false);assert.equal(result.code,'sc_research_navigation_unavailable');
});
