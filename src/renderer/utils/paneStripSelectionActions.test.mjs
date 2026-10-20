import test from 'node:test';import assert from 'node:assert/strict';
import {paneStripSelectionTargets,removePaneStripSelection,openPaneStripSelectionBeside,notifyPaneStripSelection,tabUuidPathText} from './paneStripSelectionActions.mjs';
function fixture() {
  const entries=[{projectId:'P',tabId:'a'},{projectId:'Q',tabId:'b'},{projectId:'P',tabId:'c'}],calls=[];
  const state={activeSpaceId:'W',splitPanes:[{windowId:'win',tabId:'a',tabs:entries}],centerStrips:{},
    openProjects:new Map([['P',{tabs:new Map([['a',{}],['c',{tabType:'file'}]])}],['Q',{tabs:new Map([['b',{}]])}]]),tabCatalog:{},
    clearTabFromSplitPane:id=>{calls.push(['remove',id]);state.splitPanes[0].tabs=state.splitPanes[0].tabs.filter(entry=>entry.tabId!==id);return true;},
    detachTabFromWindow:(project,id,index)=>{calls.push(['detach',project,id,index]);return true;},
    commitWorkspaceWindowAction:request=>{calls.push(['place',request]);return {ok:true};},
    setTabCompletionNotificationArmed:(...args)=>calls.push(['once',...args]),
    setTabCompletionNotificationPersistent:(...args)=>calls.push(['persistent',...args])};
  const lease={workflowId:'W',windowId:'win',paneIndex:0,entries:entries.slice(0,2),isCurrent:()=>true};
  return {state,lease,calls,entries,get:()=>state};
}
test('same existing window writer places cross-namespace selection in ONE beside window, without full/stop/session writes',()=>{
  const f=fixture();openPaneStripSelectionBeside(f.get,f.lease);assert.equal(f.calls.length,1);
  const request=f.calls[0][1];assert.equal(request.target.mode,'new-window');assert.deepEqual(request.entries,f.lease.entries);
  assert.equal(request.target.windowIndex,0);assert.equal(request.sourceTabId,'a');
  f.state.splitPanes.push({windowId:'empty',tabId:'',tabs:[]});openPaneStripSelectionBeside(f.get,f.lease);
  assert.equal(f.calls[1][1].target.mode,'same-window');assert.equal(f.calls[1][1].target.windowIndex,1);
});
test('remove uses only source placement executors; notifications reach each exact namespace and both bells',()=>{
  const f=fixture();notifyPaneStripSelection(f.get,f.lease,'once',true);notifyPaneStripSelection(f.get,f.lease,'persistent',false);
  assert.deepEqual(f.calls,[['once','P','a',true],['once','Q','b',true],['persistent','P','a',false],['persistent','Q','b',false]]);
  f.calls.length=0;removePaneStripSelection(f.get,f.lease);assert.deepEqual(f.calls,[['remove','a'],['remove','b']]);
  assert.deepEqual(f.state.splitPanes[0].tabs.map(entry=>entry.tabId),['c']);
  assert.ok(f.state.openProjects.get('P').tabs.has('a'));assert.ok(f.state.openProjects.get('Q').tabs.has('b'));
});
test('single-center fallback removes its only shown tab through existing vacant-window executor',()=>{
  const f=fixture();f.state.splitPanes=[];f.state.activeProjectId='P';f.state.activeSpaceTab=f.entries[0];
  const lease={...f.lease,windowId:null,paneIndex:null,entries:[f.entries[0]]};removePaneStripSelection(f.get,lease);
  assert.deepEqual(f.calls,[['detach','P','a',null]]);
});
test('stale/closed/replaced/missing namespace selection cannot partially act; visible unfocused source does not depend on focused project',()=>{
  for(const kind of ['closed','missing','window']) {
    const f=fixture();f.state.activeProjectId='OTHER';
    if(kind==='closed')f.lease.isCurrent=()=>false;
    if(kind==='missing')f.state.openProjects.get('Q').tabs.delete('b');
    if(kind==='window')f.state.splitPanes[0].windowId='replacement';
    assert.throws(()=>removePaneStripSelection(f.get,f.lease));assert.deepEqual(f.calls,[]);
  }
  const f=fixture();f.state.activeProjectId='OTHER';assert.equal(paneStripSelectionTargets(f.state,f.lease).length,2);
});
test('UUID/Path format remains identical across namespace paths, including fallback',()=>{
  assert.equal(tabUuidPathText([{uuid:'sid-a',cwd:'/P'},{uuid:'sid-b',cwd:'/Q'},{uuid:'sid-c'}]),'sid-a\ncwd: /P\n\nsid-b\ncwd: /Q\n\nsid-c\ncwd: /');
});
