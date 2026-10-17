import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
import {createStore} from 'zustand/vanilla';import {resolveAgentBusyPresentation} from './agentBusyPresentation.mjs';
const file=process.env.NOTED_ACTIVITY_SOURCE||new URL('../components/Workspace/TabBar.tsx',import.meta.url),text=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile('TabBar.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const declarations=new Map();function walk(n){if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name))declarations.set(n.name.text,n);ts.forEachChild(n,walk);}walk(ast);
function fixture(projectId,store){const ref={current:projectId},maps={},renders={};const names=['ClaudeBusyMap','GeminiBusyMap','CodexBusyMap','PasteBusyMap','AwaitingMap'];const context={Map,console:{warn(){}},resolveAgentBusyPresentation,useWorkspaceStore:{getState:store.getState},activityProjectIdRef:ref};for(const name of names){maps[name]=new Map();renders[name]=0;context['set'+name]=fn=>{const next=fn(maps[name]);if(next!==maps[name])renders[name]++;maps[name]=next;};}
 const methods=['ownsActivityTab','discardForeignActivity','applyClaudeVisualBusy','handleClaudeBusy','handleGeminiBusy','handleCodexBusy','handlePasteBusy','handleAwaitingInput'];
 const source=methods.filter(name=>declarations.has(name)).map(name=>'const '+declarations.get(name).getText(ast)+';').join('\n')+'\nmodule.exports={'+methods.filter(name=>name.startsWith('handle')).join(',')+'};';
 context.module={exports:{}};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);return{ref,maps,renders,handlers:context.module.exports};}
const setup=()=>createStore(()=>({activeProjectId:'foreign',openProjects:new Map(['a','b','c'].map(id=>[id,{tabs:new Map([[id+'-tab',{}]])}]))}));

test('actual busy/paste/awaiting callbacks leave unrelated retained rosters unchanged',()=>{
 const store=setup(),owners=['a','b','c'].map(id=>fixture(id,store));
 for(const [handler,field,payload] of [['handleClaudeBusy','ClaudeBusyMap',{busy:true}],['handleGeminiBusy','GeminiBusyMap',{busy:true}],['handleCodexBusy','CodexBusyMap',{busy:true}],['handlePasteBusy','PasteBusyMap',{busy:true}],['handleAwaitingInput','AwaitingMap',{awaiting:true}]]){
  owners.forEach(o=>o.handlers[handler](null,{tabId:'a-tab',...payload}));assert.deepEqual(owners.map(o=>o.renders[field]),[1,0,0],handler);assert.equal(owners[0].maps[field].get('a-tab'),true);
 }
});
test('hidden owner still receives activity, independent of the active project',()=>{
 const store=setup(),a=fixture('a',store);a.handlers.handleCodexBusy(null,{tabId:'a-tab',busy:true});assert.equal(a.maps.CodexBusyMap.get('a-tab'),true);a.handlers.handleCodexBusy(null,{tabId:'a-tab',busy:true});assert.equal(a.renders.CodexBusyMap,1);
});
test('in-place membership moves clear the prior owner and update the new one',()=>{
 const store=setup(),a=fixture('a',store),b=fixture('b',store);a.handlers.handleCodexBusy(null,{tabId:'a-tab',busy:true});const projects=store.getState().openProjects,tab=projects.get('a').tabs.get('a-tab');projects.get('a').tabs.delete('a-tab');projects.get('b').tabs.set('a-tab',tab);
 a.handlers.handleCodexBusy(null,{tabId:'a-tab',busy:true});b.handlers.handleCodexBusy(null,{tabId:'a-tab',busy:true});assert.equal(a.maps.CodexBusyMap.has('a-tab'),false);assert.equal(b.maps.CodexBusyMap.get('a-tab'),true);
});
test('committed prop ownership can change without recreating listeners',()=>{
 const store=setup(),a=fixture('a',store);a.handlers.handleCodexBusy(null,{tabId:'a-tab',busy:true});a.ref.current='b';a.handlers.handleCodexBusy(null,{tabId:'a-tab',busy:false});a.handlers.handleCodexBusy(null,{tabId:'b-tab',busy:true});assert.equal(a.maps.CodexBusyMap.has('a-tab'),false);assert.equal(a.maps.CodexBusyMap.get('b-tab'),true);
});
test('Claude spinner remains excluded and activityBusy retains its own semantics',()=>{
 const store=setup(),a=fixture('a',store);a.handlers.handleClaudeBusy(null,{tabId:'a-tab',busy:true,reason:'spinner'});assert.equal(a.renders.ClaudeBusyMap,0);a.handlers.handleClaudeBusy(null,{tabId:'a-tab',busy:false,activityBusy:true});assert.equal(a.maps.ClaudeBusyMap.get('a-tab'),true);
});
test('removed workspace cannot acquire a new visual busy flag',()=>{
 const store=setup(),a=fixture('a',store);store.getState().openProjects.delete('a');a.handlers.handlePasteBusy(null,{tabId:'a-tab',busy:true});assert.equal(a.renders.PasteBusyMap,0);
});
