import fs from 'node:fs';import vm from 'node:vm';import test from 'node:test';import assert from 'node:assert/strict';import {transformSync} from 'esbuild';
import {automationInventory} from '../utils/runAfterInventory.mjs';
import {resolvePtyAgentOwner} from '../utils/ptyAgentOwner.mjs';
import {summarizeRunningAutoCompacts} from '../utils/autoCompactActivityPresentation.mjs';
const source=fs.readFileSync(new URL('./useAutomationInventory.ts',import.meta.url),'utf8');
const code=transformSync(source,{loader:'ts',format:'cjs'}).code;
function hook(state,metadata={}){
 const keys=[],ws=Object.assign(selector=>{const key=selector(state);keys.push(key);return key;},{getState:()=>state});
 const ps=Object.assign(selector=>selector({projects:metadata}),{getState:()=>({projects:metadata})});const module={exports:{}};
 vm.runInNewContext(code,{module,exports:module.exports,require:name=>name==='react'?{useMemo:fn=>fn(),useState(){},useEffect(){}}
  :name.includes('useWorkspaceStore')?{useWorkspaceStore:ws}:name.includes('useProjectsStore')?{useProjectsStore:ps}
  :name.includes('ptyAgentOwner')?{resolvePtyAgentOwner}:name.includes('runAfterInventory')?{automationInventory}:{} });
 return{read:module.exports.useAutomationInventory,keys};
}
function fixture(){const tabs=new Map([['a',{id:'a',name:'A',commandType:'codex',codexSessionId:'sa',cwd:'/a'}],
 ['b',{id:'b',name:'B',commandType:'claude',claudeSessionId:'sb',cwd:'/b'}],
 ['sdk',{id:'sdk',name:'SDK',tabType:'claude-sdk',claudeSessionId:'ss'}],['shell',{id:'shell',name:'Shell'}]]);
 return{organizationReady:true,tabWorkflowMembership:{a:{workflowId:'wa',revision:1},b:{workflowId:'wb',revision:2}},
  spaces:[{id:'wa',name:'WA',projectIds:[]},{id:'wb',name:'WB',projectIds:[]}],openProjects:new Map([['namespace',{projectPath:'/fixture',tabs}]])};}
test('closed empty counter reads no tab catalog, metadata, membership or projects',()=>{
 const poison=()=>{throw Error('closed UI traversed unrelated inventory')};const state={};
 for(const key of ['openProjects','spaces','tabWorkflowMembership'])Object.defineProperty(state,key,{get:poison});
 const h=hook(state,new Proxy({},{ownKeys:poison}));const a=h.read(new Set());const b=h.read(new Set());
 assert.equal(a.tabs.length,0);assert.equal(a.groups.length,0);assert.equal(a,b);assert.deepEqual(h.keys,['','']);
});
test('subset keeps the same eligible queue/compaction counter rows, including stopped and missing IDs',()=>{
 const s=fixture(),ids=new Set(['a','sdk','missing']),h=hook(s),full=h.read();const small=h.read(ids);
 assert.deepEqual(small.tabs,full.tabs.filter(t=>ids.has(t.id)));
 const activities={a:{phase:'compacting'},b:{phase:'compacting'},missing:{phase:'compacting'}};
 const wanted=new Set(['a','b','missing']);assert.deepEqual(summarizeRunningAutoCompacts(activities,h.read(wanted).tabs),summarizeRunningAutoCompacts(activities,full.tabs));
});
test('opening reads the entire fresh inventory; same-object rename/SID/membership changes remain visible',()=>{
 const s=fixture(),h=hook(s),ids=new Set(['a']);h.read(ids);const before=h.keys.at(-1);
 s.openProjects.get('namespace').tabs.get('a').name='renamed';s.openProjects.get('namespace').tabs.get('a').codexSessionId='new';s.tabWorkflowMembership.a={workflowId:'wb',revision:3};
 const small=h.read(ids);assert.notEqual(h.keys.at(-1),before);assert.equal(small.tabs[0].name,'renamed');assert.equal(small.tabs[0].sessionId,'new');assert.equal(small.tabs[0].workflowId,'wb');
 const full=h.read();assert.deepEqual(full,automationInventory(s,{}));assert.equal(full.tabs.some(t=>t.id==='b'),true);
});
