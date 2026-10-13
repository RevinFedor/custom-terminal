import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {createStore} from 'zustand/vanilla';
const projection=await import(process.env.NOTED_SIDEBAR_FINGERPRINT_SOURCE
  ?pathToFileURL(process.env.NOTED_SIDEBAR_FINGERPRINT_SOURCE).href
  :new URL('./tabSidebarProjectFingerprint.mjs',import.meta.url).href);
const {openProjectIdsFingerprint,tabSidebarProjectFingerprint}=projection;
const select=projection.publishedTabSidebarProjectFingerprint
  ||((state,projectId)=>tabSidebarProjectFingerprint(state.openProjects.get(projectId)));

const workspace = () => ({
  projectId: 'project-a',
  activeTabId: 'tab-a',
  activeGroupId: null,
  currentView: 'terminal',
  viewingSubAgentTabId: null,
  selectedTabIds: [],
  tabGroups: [{ id: 'group-a', name: 'Group', collapsed: false }],
  tabs: new Map([
    ['tab-a', { id: 'tab-a', name: 'A', cwd: '/a', taskPlan: { id: 'p', items: [] } }],
    ['tab-b', { id: 'tab-b', name: 'B', cwd: '/b', groupId: 'group-a' }],
  ]),
});

test('in-place row changes wake only the owning project projection', () => {
  const value = workspace();
  const before = tabSidebarProjectFingerprint(value);
  value.tabs.get('tab-b').name = 'Renamed';
  const after = tabSidebarProjectFingerprint(value);
  assert.notEqual(after, before);
});

test('selection, hierarchy and task markers participate in the projection', () => {
  const value = workspace();
  const base = tabSidebarProjectFingerprint(value);
  value.selectedTabIds.push('tab-b');
  const selected = tabSidebarProjectFingerprint(value);
  assert.notEqual(selected, base);
  value.tabs.get('tab-b').visualParentTabId = 'tab-a';
  const nested = tabSidebarProjectFingerprint(value);
  assert.notEqual(nested, selected);
  value.tabs.get('tab-a').taskPlan.items.push({ id: 'i', title: 'Work', status: 'in_progress' });
  assert.notEqual(tabSidebarProjectFingerprint(value), nested);
});

test('large non-visual payload does not invalidate the sidebar', () => {
  const value = workspace();
  const before = tabSidebarProjectFingerprint(value);
  value.tabs.get('tab-a').notes = 'x'.repeat(100_000);
  value.tabs.get('tab-a').sdkMessages = [{ role: 'assistant', content: 'large transcript' }];
  assert.equal(tabSidebarProjectFingerprint(value), before);
});

test('open project identity is order-stable and independent from workspace mutation', () => {
  const projects = new Map([['a', {}], ['b', {}]]);
  const before = openProjectIdsFingerprint(projects);
  projects.get('a').changed = true;
  assert.equal(openProjectIdsFingerprint(projects), before);
  projects.set('c', {});
  assert.notEqual(openProjectIdsFingerprint(projects), before);
});

test('repeated retained selectors share each project projection within one publication',()=>{
 const projects=new Map(),visits=new Map();
 for(const id of ['a','b','c']){
  const value=workspace();value.projectId=id;
  const values=value.tabs.values.bind(value.tabs);
  value.tabs.values=function*(){for(const tab of values()){visits.set(id,(visits.get(id)||0)+1);yield tab}};
  projects.set(id,value);
 }
 const store=createStore(()=>({openProjects:projects})),observed=new Map(),unsub=[];
 // Sidebar and menu owners, plus repeated React getSnapshot-style reads.
 for(const id of projects.keys())for(let surface=0;surface<2;surface++){
  unsub.push(store.subscribe(state=>{
   observed.set(id,select(state,id));assert.equal(select(state,id),observed.get(id));
  }));
 }
 try{
  store.setState({focus:'a'});
  assert.deepEqual(Object.fromEntries(visits),{a:2,b:2,c:2},'one traversal per project, not per subscriber/read');
  const previousB=observed.get('b');visits.clear();
  projects.get('a').tabs.get('tab-b').name='Changed in place';
  store.setState({focus:'b'});
  assert.deepEqual(Object.fromEntries(visits),{a:2,b:2,c:2});
  for(const [id,value] of projects)assert.equal(observed.get(id),tabSidebarProjectFingerprint(value));
  assert.equal(observed.get('b'),previousB,'unrelated project keeps identical primitive output');
  assert.equal(select(store.getState(),'missing'),'missing');
 }finally{for(const stop of unsub)stop();}
});

test('nested publication after an earlier selector leaves later selectors on current metadata',()=>{
 const value=workspace(),projects=new Map([['a',value]]);
 const store=createStore(()=>({phase:0,openProjects:projects})),seen=[];
 const observe=side=>state=>{
  assert.strictEqual(state,store.getState());
  const result=select(state,'a');assert.equal(result,tabSidebarProjectFingerprint(value));
  seen.push({side,phase:state.phase,result});
 };
 const unsub=[store.subscribe(observe('before')),store.subscribe(state=>{
  if(state.phase!==1)return;
  value.tabs.get('tab-b').name='New nested title';
  value.tabs.get('tab-b').visualParentTabId='tab-a';
  value.tabs.get('tab-a').taskPlan.items.push({id:'nested',title:'Useful work',status:'in_progress'});
  store.setState({phase:2});
 }),store.subscribe(observe('after'))];
 try{
  store.setState({phase:1});
  assert.deepEqual(seen.map(x=>[x.side,x.phase]),[['before',1],['before',2],['after',2],['after',2]]);
  assert.notEqual(seen[0].result,seen[1].result);
  assert.equal(select(store.getState(),'a'),seen[1].result);
  assert.equal(seen.at(-1).result,seen[1].result);
 }finally{for(const stop of unsub)stop();}
});
