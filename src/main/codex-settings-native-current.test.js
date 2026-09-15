'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),Module=require('node:module');
// Independent Pro NS-race retained as an executable local regression. Only terminal,
// config and transport leaves are fixtures; main selector/publication and renderer
// consumers below are actual source, extracted through TypeScript.
const ts=require('typescript');
const root=path.resolve(__dirname,'../..');
const sources=new Map();
function source(name){if(!sources.has(name)){const text=fs.readFileSync(path.join(root,name),'utf8');sources.set(name,{text,ast:ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true,name.endsWith('tsx')?ts.ScriptKind.TSX:undefined)});}return sources.get(name);}
function fn(name,id){const {ast}=source(name);const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===id);assert.ok(node,id);return node.getText(ast);}
function variable(name,id){const {ast}=source(name);let found;function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(ast)===id)found=n.initializer;ts.forEachChild(n,visit);}visit(ast);assert.ok(found,id);return found.getText(ast);}
function span(name,start,end){const {text}=source(name);const a=text.indexOf(start),b=text.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,start);return text.slice(a,b);}
const compile=code=>ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const file=path.join(root,'src/main/codex-settings-send.integration.test.js');const text=fs.readFileSync(file,'utf8'),end=text.indexOf("test('actual picker measures");assert.ok(end>0);
const fixture=new Module(file,module);fixture.filename=file;fixture.paths=Module._nodeModulePaths(path.dirname(file));fixture._compile(text.slice(0,end)+'\nmodule.exports=harness;',file);
const {createCodexLiveSettingsObserver}=require(root+'/src/main/codex-live-settings');
async function run(movement){
 const h=await fixture.exports();const main='src/main/main.js';
 const effective=await import(root+'/src/renderer/utils/codexEffectiveSettings.mjs');
 let state,saves=0;
 const rendererTab={codexSessionId:'writer',codexModel:'gpt-6-astra',codexEffort:'medium'};
 const ui=vm.createContext({...effective,console:{log(){},warn(){}},get:()=>state,set(){},saveTabs(){saves++;},useUIStore:{},recoverAgentDraftTransferToHistory:async()=>({adopted:false}),useWorkspaceStore:{getState:()=>state}});
 vm.runInContext(compile('globalThis.mutators={'+span('src/renderer/store/useWorkspaceStore.ts','  updateCodexState: (tabId, state','\n  setViewingSubAgent:')+'};'),ui);
 state={openProjects:new Map([['P',{projectId:'P',tabs:new Map([['tab',rendererTab]])}]]),...ui.mutators};
 for(const id of ['handleCodexModelEffortIntentDeferred','handleCodexModelEffortIntentApplied','handleCodexLiveSettings'])vm.runInContext(compile('globalThis.'+id+'='+variable('src/renderer/App.tsx',id)),ui);
 const observationSequence=[];
 const observer=createCodexLiveSettingsObserver({capture:()=>({terminal:h.terminals.get('tab'),runSeq:2,lifecycleGeneration:'generation',inputRevision:1,live:true,ownerId:'writer',sessionId:'writer'}),publish:(tabId,liveSettings)=>{observationSequence.push(liveSettings.model);ui.handleCodexLiveSettings({}, {tabId,liveSettings});}});
 h.context.codexLiveSettingsObserver=observer;
 let frameSeq=0;const observe=(model,effort)=>observer.observe('tab',{valid:true,seq:++frameSeq,text:'› Ask Codex to do anything\n'+model+' '+effort+' · Context 42% used'});
 h.set({model:'gpt-6-astra',effort:'medium'});observe('gpt-6-astra','medium');
 const publish=h.context.mainWindow.webContents.send;
 h.context.mainWindow.webContents.send=(channel,data)=>{publish(channel,data);if(channel==='codex:model-effort-intent-applied')ui.handleCodexModelEffortIntentApplied({},data);};
 let configWaits=0,liveAtConfigReturn;
 Object.assign(h.context,{
   // Fake native UI/capture and on-disk config leaves; real orchestration function below.
   codexEffortApplicationMode:()=> 'persistent-default',CODEX_EFFORT_APPLICATION_CONVERSATION:'conversation-only',CODEX_ALL_MODELS_VALUE:'all-models',
   captureCodexFrame:async()=>({clean:'model-menu',raw:'',timedOut:false}),sendCodexSlashCommand:async()=>({success:true}),
   parseCodexTopModelPicker:()=>({items:[{value:'gpt-6-astra'}]}),parseCodexAllModelPicker:()=>({items:[]}),
   planCodexModelSelection:()=>({available:true,complete:true,route:'top-model-direct'}),
   currentCodexPickerFrameText:clean=>clean,parseCodexPlanReasoningScopePicker:()=>({items:[]}),codexModelEffortConfirmationObservedInFrame:()=>true,
   selectCodexPickerItem:async(_term,request)=>{assert.equal(request.writeGuard('native-fixture-model-confirm').allowed,true);h.set({model:request.target,effort:'high'});observe(request.target,'high');h.events.push({kind:'native-selection-ack',model:request.target,effort:'high'});return {success:true,selected:request.target,frame:{clean:'confirmed-A/high',raw:''}};},
   waitForCodexModelEffortConfig:async(expected)=>{configWaits++;assert.equal(expected.model,'gpt-6-astra');await new Promise(r=>setImmediate(r));if(movement){h.set({model:'gpt-reserve',effort:'high'});observe('gpt-reserve','high');}liveAtConfigReturn=observer.read('tab');return {success:true,source:'fixture-root-config'};},
 });
 vm.runInContext(fn(main,'selectCodexModelEffort'),h.context);
 const result=await h.direct({model:'gpt-6-astra',effort:'high'});
 return {result,observationSequence,liveAtConfigReturn,liveAfter:observer.read('tab'),effectiveAfter:effective.resolveCodexEffectiveSettings(rendererTab),rendererTab,saves,configWaits,events:h.events};
}
test('NS-control: actual native selection orchestration and combined caller keep stable pair',async()=>{
 const e=await run(false);assert.equal(e.result.submitted,true);assert.equal(e.configWaits,1);assert.equal(e.events.find(x=>x.kind==='prompt').model,'gpt-6-astra');assert.equal(e.effectiveAfter.model,'gpt-6-astra');
});
test('NS-race: newer B during actual config-proof await is not overwritten or used to send an explicit A prompt',async()=>{
 const e=await run(true);assert.equal(e.configWaits,1);assert.equal(e.liveAtConfigReturn.model,'gpt-reserve');assert.equal(e.liveAfter.model,'gpt-reserve');
 if(process.env.CODEX_SETTINGS_EXPECT_OLD_RACE==='1'){assert.equal(e.result.submitted,true);assert.equal(e.events.find(x=>x.kind==='prompt').model,'gpt-reserve');assert.equal(e.effectiveAfter.model,'gpt-6-astra');return;}
 assert.equal(e.result.submitted,false);assert.equal(e.result.settingsResult.code,'codex_settings_observation_changed');assert.equal(e.events.filter(x=>x.kind==='prompt').length,0);assert.equal(e.events.filter(x=>x.channel==='codex:model-effort-intent-applied').length,0);assert.equal(e.effectiveAfter.model,'gpt-reserve');
});

test('actual chunk and Enter gates retain the settings guard, including refusal after a written paste', () => {
 const {ast}=source('src/main/main.js'); let destination; const checks=[];
 const inner=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='_safePasteAndSubmitInner');
 function visit(n){
  if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='destinationFailure')destination=n.initializer.getText(ast);
  if(ts.isIfStatement(n)&&n.expression.getText(ast).startsWith('knownEmptyDestination || handoffId'))checks.push(n.getText(ast));
  ts.forEachChild(n,visit);
 }
 visit(inner);assert.equal(checks.length,2);assert.ok(destination);
 for(const pasteWritten of [false,true]){
  let allowed=true;
  const env=vm.createContext({options:{settingsWriteGuard:()=>({allowed,reason:'codex_settings_observation_changed'})},
   knownEmptyDestination:false,handoffId:null,pasteWritten,assertKnownEmptySend(){},broadcastTabId:'T',
   expectedDestination:null,expectedTarget:null,sendOperationKey:null,sendAttemptId:null});
  env.destinationFailure=vm.runInContext('('+destination+')',env);
  const gate=vm.runInContext('(()=>{'+checks[pasteWritten?1:0]+';return {written:true};})',env);
  assert.equal(gate().written,true);
  allowed=false;const refused=gate();
  assert.equal(refused.submitted,false);assert.equal(refused.enterWritten,false);
  assert.equal(refused.pasteWritten,pasteWritten);assert.equal(refused.written,undefined);
  assert.equal(refused.code,'codex_settings_observation_changed');
 }
});
