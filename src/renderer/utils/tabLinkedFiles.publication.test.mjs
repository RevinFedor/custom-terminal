import test from 'node:test';import assert from 'node:assert/strict';import {createStore} from 'zustand/vanilla';
import * as linked from './tabLinkedFiles.mjs';
// The fallback is the exact pre-repair hook selector: it establishes RED on
// the existing implementation, while the new selector is exercised after.
const select=linked.publishedTabLinkedFilesSnapshot || ((s,id)=>linked.tabLinkedFilesSnapshot(s.openProjects,id,
  s.spaces.find(space=>space.id===s.tabWorkflowMembership?.[id]?.workflowId)?.reserveOrder||[]));
test('90 retained subscribers at 658 tabs share one catalog scan per real Zustand publication',()=>{
 let visited=0;const tabs=new Map();
 for(let i=0;i<90;i++)tabs.set('owner'+i,{id:'owner'+i});
 for(let i=90;i<658;i++)tabs.set('file'+i,{id:'file'+i,tabType:'file',filePath:'/fixture/'+i,visualParentTabId:'owner'+i%90});
 const values=tabs.values.bind(tabs);tabs.values=function*(){for(const row of values()){visited++;yield row}};
 const projects=new Map([['p',{tabs}]]),state={openProjects:projects,spaces:[{id:'s',reserveOrder:['file180','file90']}],tabWorkflowMembership:Object.fromEntries(Array.from({length:90},(_,i)=>['owner'+i,{workflowId:'s'}]))};
 const store=createStore(()=>state),results=new Map(),unsub=[];
 for(let i=0;i<90;i++){const id='owner'+i;unsub.push(store.subscribe(s=>results.set(id,select(s,id))));}
 store.setState({selected:'owner1'});
 assert.equal(visited,658,'one full metadata traversal, not one traversal per retained panel');
 for(let i=0;i<90;i++)assert.equal(results.get('owner'+i),linked.tabLinkedFilesSnapshot(projects,'owner'+i,state.spaces[0].reserveOrder));
 visited=0;store.setState({selected:'owner2'});assert.equal(visited,658);
 // Producers may mutate a tab in place before publishing a new state object.
 // Keying by openProjects would miss it; the publication identity must not.
 tabs.get('file90').visualParentTabId='owner1';tabs.get('file180').deleted=true;
 visited=0;store.setState({selected:'owner3'});assert.equal(visited,658);
 assert.equal(results.get('owner1'),linked.tabLinkedFilesSnapshot(projects,'owner1',state.spaces[0].reserveOrder));
 assert.equal(JSON.parse(results.get('owner0')).some(x=>x.id==='file90'||x.id==='file180'),false);
 for(const stop of unsub)stop();
});
test('published file projection updates after reordered and disconnected file relations',()=>{
 const tabs=new Map([['A',{id:'A'}],['B',{id:'B'}],['x',{id:'x',tabType:'file',filePath:'/x',visualParentTabId:'A'}],
  ['y',{id:'y',tabType:'file',filePath:'/y',visualParentTabId:'A'}],['z',{id:'z',tabType:'file',filePath:'/z',visualParentTabId:'y'}]]);
 const s={openProjects:new Map([['p',{tabs}]]),spaces:[{id:'one',reserveOrder:['y','x','z']}],tabWorkflowMembership:{A:{workflowId:'one'},B:{workflowId:'one'}}};
 assert.equal(select(s,'A'),linked.tabLinkedFilesSnapshot(s.openProjects,'A',['y','x','z']));
 const store=createStore(()=>s);let newer;
 store.subscribe(()=>{if(!newer){newer={...store.getState(),spaces:[{id:'one',reserveOrder:['x','y','z']}]};store.setState(newer);}});
 store.setState({tick:1});assert.equal(select(store.getState(),'A'),linked.tabLinkedFilesSnapshot(s.openProjects,'A',['x','y','z']));
 assert.equal(select(s,'A'),linked.tabLinkedFilesSnapshot(s.openProjects,'A',['y','x','z']));
 tabs.get('y').visualParentTabId='z';store.setState({tick:2});
 assert.equal(select(store.getState(),'A'),linked.tabLinkedFilesSnapshot(s.openProjects,'A',['x','y','z']));
 assert.deepEqual(JSON.parse(select(store.getState(),'missing')),[]);
});

test('selectors on both sides of a nested publication observe the current file relations',()=>{
 const tabs=new Map([
  ['A',{id:'A'}],['B',{id:'B'}],
  ['P',{id:'P',tabType:'file',filePath:'/P',visualParentTabId:'A'}],
  ['x',{id:'x',tabType:'file',filePath:'/x',visualParentTabId:'A'}],
  ['y',{id:'y',tabType:'file',filePath:'/y',visualParentTabId:'P'}],
  ['z',{id:'z',tabType:'file',filePath:'/z',visualParentTabId:'P'}],
 ]);
 const store=createStore(()=>({
  phase:0,openProjects:new Map([['p',{tabs}]]),
  spaces:[{id:'one',reserveOrder:['P','z','y','x']},{id:'two',reserveOrder:['y','z']}],
  tabWorkflowMembership:{A:{workflowId:'one'},B:{workflowId:'one'},P:{workflowId:'two'}},
 }));
 const row=(owner,id,parent,depth,path='/'+id)=>({
  projectId:'p',id,ownerTabId:owner,path,name:path.slice(path.lastIndexOf('/')+1),parentTabId:parent,depth,
 });
 const expected={
  1:{A:[row('A','P','A',0),row('A','z','P',1),row('A','y','P',1),row('A','x','A',0)],
     B:[],P:[row('P','y','P',0),row('P','z','P',0)]},
  2:{A:[row('A','P','A',0),row('A','x','P',1,'/renamed-x'),row('A','z','P',1)],
     B:[row('B','y','B',0)],P:[row('P','z','P',0),row('P','x','P',0,'/renamed-x')]},
 };
 const seen=[];
 const observe=side=>state=>{
  assert.strictEqual(state,store.getState(),'subscription reads the currently published state');
  const snapshots={};
  for(const owner of ['A','B','P']){
   snapshots[owner]=select(state,owner);
   assert.equal(snapshots[owner],JSON.stringify(expected[state.phase][owner]),`${side} phase ${state.phase} owner ${owner}`);
  }
  seen.push({side,phase:state.phase,state,snapshots});
 };
 const unsub=[store.subscribe(observe('before'))];
 unsub.push(store.subscribe(state=>{
  if(state.phase!==1)return;
  // The first selector has already cached S1. Existing producers may mutate
  // nested metadata, then set() publishes S2 while S1 listeners are still running.
  tabs.get('y').visualParentTabId='B';
  Object.assign(tabs.get('x'),{visualParentTabId:'P',filePath:'/renamed-x'});
  store.setState({phase:2,spaces:[
   {id:'one',reserveOrder:['x','z','P','y']},{id:'two',reserveOrder:['z','x']},
  ]});
 }));
 unsub.push(store.subscribe(observe('after')));
 try{
  store.setState({phase:1});
  assert.deepEqual(seen.map(({side,phase})=>[side,phase]),[
   ['before',1],['before',2],['after',2],['after',2],
  ]);
  assert.notStrictEqual(seen[0].state,store.getState());
  for(const read of seen.slice(1))assert.strictEqual(read.state,store.getState());
  for(const owner of ['A','B','P']){
   assert.equal(select(store.getState(),owner),JSON.stringify(expected[2][owner]));
   assert.equal(seen[0].snapshots[owner],JSON.stringify(expected[1][owner]));
  }
 }finally{for(const stop of unsub)stop();}
});
