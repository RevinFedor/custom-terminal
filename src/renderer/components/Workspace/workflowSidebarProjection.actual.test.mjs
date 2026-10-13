// Actual ConnectedWorkflowSidebar computation + real reserve selectors.
// React scheduling/JSX/IPC are deliberately outside this Node control.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import ts from 'typescript';
import {workflowTabCatalog,workflowPlacedTabIds,createWorkflowSidebarProjection,selectWorkflowReserve} from '../../utils/workflowReserve.mjs';
const source=fs.readFileSync(process.env.NOTED_SIDEBAR_SOURCE || new URL('./ConnectedWorkflowSidebar.tsx',import.meta.url),'utf8');
const start=source.indexOf('export default function ConnectedWorkflowSidebar'),end=source.indexOf('  return <div',start);
assert.ok(start>=0&&end>start);
const tree=ts.createSourceFile('ConnectedWorkflowSidebar.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let orderProp;const visit=node=>{if(ts.isJsxAttribute(node)&&node.name.getText(tree)==='orderedTabIds')orderProp=node.initializer.expression.getText(tree);ts.forEachChild(node,visit);};visit(tree);assert.ok(orderProp);
const prefix=source.slice(start,end).replace('export default ','')+`return {presentation,sourceOwner,creationCwd:typeof creationCwd==='undefined'?undefined:creationCwd,orderProp:${orderProp}};}\nConnectedWorkflowSidebar;`;
const js=ts.transpileModule(prefix,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function harness(){
 let reads=0,state,at=0;const hooks=[];
 class CatalogMap extends Map{[Symbol.iterator](){reads++;return super[Symbol.iterator]();}}
 const tabs=new Map([['grand',{id:'grand',name:'Grand',parentTabId:'child'}],['child',{id:'child',parentTabId:'placed'}],
   ['placed',{id:'placed',name:'Placed'}],['file',{id:'file',tabType:'file',filePath:'/fixture/f.md',visualParentTabId:'grand'}],
   ['visual',{id:'visual',name:'Visual',visualParentTabId:'placed'}],['free',{id:'free',name:'Free'}]]);
 state={openProjects:new CatalogMap([['P',{tabs,activeTabId:'placed'}]]),tabCatalog:{},
   activeSpaceId:'w',activeProjectId:'P',splitFocusedIndex:0,
   splitPanes:[{windowId:'one',projectId:'P',tabId:'placed',tabs:[{projectId:'P',tabId:'placed'}]}],
   spaces:[{id:'w',layout:{}}],centerStrips:{},activeSpaceTab:{projectId:'P',tabId:'placed'},windowDisplayLayouts:{},
   tabWorkflowMembership:Object.fromEntries([...tabs.keys()].map(id=>[id,{workflowId:'w',revision:1}])),
   pendingTabWorkflowMembership:{},workflowSidebarState:{},globalGroups:{groups:[],tabGroups:{}}};
 const render=vm.runInNewContext(js,{workflowTabCatalog,workflowPlacedTabIds,createWorkflowSidebarProjection,
  useShallow:selector=>selector,useWorkspaceStore:selector=>selector(state),
  useState:initial=>{const key=at++;if(!(key in hooks))hooks[key]=typeof initial==='function'?initial():initial;return[hooks[key],()=>{}];},
  useRef:initial=>({current:initial}),paneChooserSlots:()=>[]});
 return{get state(){return state;},set state(value){state=value;},CatalogMap,
  render(){at=0;reads=0;const value=render({activity:{}});return{...value,catalogPasses:reads};}};
}
test('actual sidebar: selection/scroll notification retains catalog and reserve projection',()=>{
 const h=harness(),first=h.render();
 h.state={...h.state,workflowSidebarState:{w:{selectedTabIds:['free'],scrollTop:300}},splitFocusedIndex:0};
 const next=h.render();assert.deepEqual({initial:first.catalogPasses,notification:next.catalogPasses},{initial:1,notification:0});
 assert.equal(next.presentation,first.presentation);
});
test('physical/file closure includes reversed deep children; independent visual AI stays in reserve',()=>{
 const h=harness(),value=h.render(),model=selectWorkflowReserve(value.presentation);
 assert.deepEqual(model.reserve.map(owner=>owner.tabId).sort(),['free','visual']);
 assert.equal(h.state.tabCatalog.child,undefined,'projection does not mutate canonical catalog');
 assert.equal(value.presentation.tabCatalog.grand.active,false);assert.equal(value.presentation.tabCatalog.file.active,false);
});
test('an absent saved order does not recreate the child model dependency on every render',()=>{
 const h=harness(),first=h.render();h.state={...h.state,workflowSidebarState:{w:{scrollTop:100}}};
 assert.equal(h.render().orderProp,first.orderProp);
});
test('empty workflow window does not borrow the previously active project tab or directory',()=>{
 const h=harness();h.state.spaces[0].defaultCwd='/voice-record';
 h.state.openProjects.get('P').tabs.get('placed').cwd='/habit-tracker';
 h.state.splitPanes=[{windowId:'empty',projectId:'P',tabId:''}];
 const value=h.render();assert.equal(value.sourceOwner,null);assert.equal(value.creationCwd,'/voice-record');
 h.state.splitPanes=[];h.state.activeSpaceTab=null;
 assert.equal(h.render().sourceOwner,null,'legacy namespace activeTab is not workflow selection');
});
test('sidebar keeps a real member tab cwd, but new blank-space creation uses workflow default',()=>{
 const h=harness();h.state.spaces[0].defaultCwd='/voice-record';
 h.state.openProjects.get('P').tabs.get('placed').cwd='/worktree';
 const value=h.render();assert.equal(value.sourceOwner.tab.cwd,'/worktree');assert.equal(value.creationCwd,'/voice-record');
 h.state.pendingTabWorkflowMembership={placed:{workflowId:'other'}};
 assert.equal(h.render().sourceOwner,null,'moved tab no longer supplies the old workflow directory');
});
test('fresh title, membership, placement and group data still reach actual sidebar projection',()=>{
 const h=harness(),first=h.render(),old=h.state.openProjects.get('P'),tabs=new Map(old.tabs);
 tabs.set('placed',{...tabs.get('placed'),name:'Fresh while held'});
 h.state={...h.state,openProjects:new h.CatalogMap([['P',{...old,tabs}]])};
 const renamed=h.render();assert.equal(renamed.sourceOwner.tab.name,'Fresh while held');assert.notEqual(renamed.presentation,first.presentation);
 h.state={...h.state,splitPanes:[] ,activeSpaceTab:null};
 const unplaced=h.render();assert.equal(unplaced.catalogPasses,0);assert.equal(unplaced.presentation.tabCatalog.child,undefined);
 h.state={...h.state,pendingTabWorkflowMembership:{free:{workflowId:'other',revision:2}},globalGroups:{groups:[{id:'new',name:'Fresh group'}],tabGroups:{}}};
 const next=h.render();assert.equal(next.presentation.tabWorkflowMembership.free.workflowId,'other');
 assert.equal(next.presentation.globalGroups.groups[0].name,'Fresh group');assert.equal(next.catalogPasses,0);
});
