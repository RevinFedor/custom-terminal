import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
import * as spaces from '../utils/workspaceSpacesModel.mjs';
import * as panes from '../utils/splitPanesModel.mjs';
const sourcePath=new URL('./useWorkspaceStore.ts',import.meta.url);
const source=ts.createSourceFile('store.ts',fs.readFileSync(sourcePath,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
let expression;
function walk(n){if(ts.isPropertyAssignment(n)&&n.name.getText(source)==='switchWorkspaceSpace')expression=n.initializer.getText(source);ts.forEachChild(n,walk);}walk(source);assert.ok(expression);
const code=ts.transpileModule('module.exports='+expression,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const ref=id=>({projectId:'namespace',tabId:id});
const outgoing={...spaces.emptySpaceLayout(),activeProjectId:'namespace',activeSpaceTab:ref('foreign'),splitPanes:[{windowId:'foreign-window',...ref('foreign')}]};
const cases=[
 {name:'empty dormant workflow',layout:{activeProjectId:'namespace',splitPanes:[],centerStrips:{},activeSpaceTab:null},expected:[]},
 {name:'parked single chip without selection',layout:{activeProjectId:'namespace',splitPanes:[],centerStrips:{namespace:[ref('own')]},activeSpaceTab:null},expected:['own']},
 {name:'saved own selection',layout:{activeProjectId:'namespace',splitPanes:[],centerStrips:{namespace:[ref('own')]},activeSpaceTab:ref('own')},selected:true},
 {name:'explicit empty window',layout:{activeProjectId:'namespace',splitPanes:[{windowId:'explicit',projectId:'',tabId:''}],centerStrips:{},activeSpaceTab:null},expected:[],window:'explicit'},
];
const results=[];
for(const item of cases){
 const state={...outgoing,organizationReady:true,activeSpaceId:'other',spaces:[{id:'other',projectIds:[],layout:outgoing},{id:'inbox',projectIds:[],layout:{...spaces.emptySpaceLayout(),...item.layout}}],openProjects:new Map([['namespace',{activeTabId:'foreign',tabs:new Map(['foreign','own'].map(id=>[id,{id}]))}]]),tabWorkflowMembership:{foreign:{workflowId:'other'},own:{workflowId:'inbox'}}};
 state.saveSession=()=>{};state.activateCenterTab=(_ns,id)=>{state.activated=id;};state.touchGlobalTabMru=()=>{};
 const bindings={get:()=>state,set:p=>Object.assign(state,p),...spaces,...panes,tabIdsOfPanesInLayout:layout=>spaces.spaceTabIds({layout},panes.allPaneTabIds),switchSpaceInList:spaces.switchSpace,GLOBAL_EXECUTION_NAMESPACE:'__tab_catalog_v2__',ownedTabNavigation:null,performance,console:{log(){},warn(){}},markRendererActivity:()=>()=>{},requestAnimationFrame:fn=>fn()};
 const action=Function(...Object.keys(bindings),'const module={exports:null};'+code+';return module.exports;')(...Object.values(bindings));
 try{action('inbox');assert.equal(state.activeSpaceId,'inbox');if(item.selected){assert.equal(state.activated,'own');assert.equal(state.splitPanes.length,0);}else{assert.equal(state.splitPanes.length,1,'must show an explicit vacant window, not shared namespace active tab');assert.equal(state.splitPanes[0].tabId,'');assert.deepEqual(panes.paneTabs(state.splitPanes[0]).map(x=>x.tabId),item.expected);if(item.window)assert.equal(state.splitPanes[0].windowId,item.window);}assert.equal(state.openProjects.get('namespace').activeTabId,'foreign');results.push({name:item.name,pass:true});}
 catch(e){results.push({name:item.name,pass:false,error:e.message});}
}
console.log(JSON.stringify({sourcePath,results},null,2));if(results.some(x=>!x.pass))process.exitCode=1;
