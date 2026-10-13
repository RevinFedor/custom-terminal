import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import {createStore} from 'zustand/vanilla';
import * as linked from './tabLinkedFiles.mjs';
import {tabNavigationLocation} from './tabNavigationLocation.mjs';

// Actual preview helper; only UI/workspace state and read/navigation transport
// are controlled here. No Electron application, disk delete, or provider.
const code=transformSync(fs.readFileSync(new URL('./tabLinkedFilePreview.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function fixture(){
  const calls=[],reads=new Map(['a','b'].map(id=>[id,{arrived:deferred(),reply:deferred()}]));
  const tabs=new Map(['a','b'].flatMap(id=>[[id,{id,tabType:'terminal'}],['file-'+id,{id:'file-'+id,tabType:'file',visualParentTabId:id,filePath:'/fixture/'+id+'.md'}]]));
  const ws=createStore(()=>({view:'workspace',activeSpaceId:'one',activeProjectId:'p',splitPanes:[],splitFocusedIndex:0,
    navigationRevision:0,openProjects:new Map([['p',{projectId:'p',activeTabId:'a',currentView:'terminal',tabs}]]),
    openTabById:async id=>{calls.push(['navigate',id]);const current=ws.getState();
      ws.setState({openProjects:new Map([['p',{...current.openProjects.get('p'),activeTabId:id}]])});return true;},
    closeTab:()=>assert.fail('preview close must not unlink a tab')}));
  const ui=createStore(()=>({filePreview:null,filePreviewRevision:0,
    openFilePreview:preview=>ui.setState(s=>({filePreview:preview,filePreviewRevision:s.filePreviewRevision+1})),
    closeFilePreview:()=>ui.setState(s=>({filePreview:null,filePreviewRevision:s.filePreviewRevision+1})),showToast(){}}));
  const module={exports:{}};
  vm.runInNewContext(code,{module,exports:module.exports,console,
    require:name=>name.includes('useWorkspaceStore')?{useWorkspaceStore:ws}:name.includes('useUIStore')?{useUIStore:ui}
      :name.includes('tabLinkedFiles.mjs')?linked:{tabNavigationLocation},
    window:{require:()=>({ipcRenderer:{invoke:(channel,path)=>{assert.equal(channel,'file:read');calls.push([channel,path]);
      const id=path.includes('/a.md')?'a':'b',read=reads.get(id);read.arrived.resolve();return read.reply.promise;}}})}});
  const open=id=>module.exports.openTabLinkedFile('p',linked.collectTabLinkedFileTree(ws.getState().openProjects,id)[0],()=>ws.getState().openTabById(id));
  const release=id=>reads.get(id).reply.resolve({success:true,content:'# Synthetic '+id});
  return {ws,ui,calls,reads,open,release,close:module.exports.closeTabLinkedFile,openSidebar:module.exports.openSidebarLinkedFile};
}

test('middle close returns the exact owner while retaining its file link',async()=>{
  const f=fixture(),opened=f.open('a');await f.reads.get('a').arrived.promise;f.release('a');assert.equal(await opened,true);
  assert.equal(await f.close('a'),true);assert.equal(f.ui.getState().filePreview,null);
  assert.equal(f.ws.getState().openProjects.get('p').tabs.get('file-a').visualParentTabId,'a');
  assert.deepEqual(f.calls.at(-1),['navigate','a']);
});
test('middle close during an outstanding read cannot resurrect the reader',async()=>{
  const f=fixture(),opened=f.open('a');await f.reads.get('a').arrived.promise;
  assert.equal(await f.close('a'),true);f.release('a');assert.equal(await opened,false);
  assert.equal(f.ui.getState().filePreview,null);assert.ok(f.ws.getState().openProjects.get('p').tabs.has('file-a'));
});
test('an unrelated chip does not dismiss another owner or sidebar reader',async()=>{
  const f=fixture(),opened=f.open('b');await f.reads.get('b').arrived.promise;f.release('b');await opened;
  const preview=f.ui.getState().filePreview,count=f.calls.length;
  assert.equal(await f.close('a'),false);assert.equal(f.ui.getState().filePreview,preview);assert.equal(f.calls.length,count);
  const sidebar={source:'sidebar',path:'/fixture/a.md',content:'# Sidebar'};f.ui.getState().openFilePreview(sidebar);
  assert.equal(await f.close('a'),false);assert.equal(f.ui.getState().filePreview,sidebar);
});
test('old read cleanup cannot clear the newer owner cancellation guard',async()=>{
  const f=fixture(),a=f.open('a');await f.reads.get('a').arrived.promise;
  const b=f.open('b');await f.reads.get('b').arrived.promise;f.release('a');assert.equal(await a,false);
  assert.equal(await f.close('b'),true);f.release('b');assert.equal(await b,false);assert.equal(f.ui.getState().filePreview,null);
});
test('linked file placed in Inbox still previews in its owner window without moving either placement',async()=>{
  const f=fixture(),layout=[{windowId:'main-window',projectId:'p',tabId:'a',tabs:[{projectId:'p',tabId:'a'},{projectId:'p',tabId:'b'}]}];
  const spaces=[{id:'one',layout:{splitPanes:layout}},
    {id:'inbox',layout:{splitPanes:[{windowId:'inbox-window',projectId:'p',tabId:'file-a',tabs:[{projectId:'p',tabId:'file-a'}]}]}}];
  const members={a:{workflowId:'one',revision:1},'file-a':{workflowId:'inbox',revision:2}};
  f.ws.setState({splitPanes:layout,spaces,tabWorkflowMembership:members});
  const before=structuredClone({spaces,layout,members});
  const opened=f.openSidebar('p','file-a');await f.reads.get('a').arrived.promise;f.release('a');
  assert.equal(await opened,true);assert.equal(f.ws.getState().activeSpaceId,'one');
  assert.deepEqual(f.calls.filter(c=>c[0]==='navigate'),[['navigate','a']]);
  assert.equal(f.ui.getState().filePreview.ownerTabId,'a');assert.equal(f.ui.getState().filePreview.sourceTabId,'file-a');
  assert.deepEqual({spaces:f.ws.getState().spaces,layout:f.ws.getState().splitPanes,members:f.ws.getState().tabWorkflowMembership},before);
  const count=f.calls.length;assert.equal(await f.openSidebar('p','file-a'),true);
  assert.equal(f.ui.getState().filePreview,null);assert.equal(f.calls.length,count);
});
test('nested linked file resolves its AI owner; a vanished owner cannot become standalone navigation',async()=>{
  const f=fixture(),tabs=f.ws.getState().openProjects.get('p').tabs;
  tabs.set('nested',{id:'nested',tabType:'file',visualParentTabId:'file-a',filePath:'/fixture/a.md'});
  const opened=f.openSidebar('p','nested');await f.reads.get('a').arrived.promise;f.release('a');assert.equal(await opened,true);
  assert.equal(f.ui.getState().filePreview.ownerTabId,'a');assert.equal(f.ui.getState().filePreview.sourceTabId,'nested');
  tabs.delete('a');const count=f.calls.length;assert.equal(await f.openSidebar('p','nested'),false);assert.equal(f.calls.length,count);
  assert.equal(f.openSidebar('p','b'),null);
});
test('owner unlink or navigation during file read cannot publish a late preview',async()=>{
  for(const change of ['unlink','navigate']) {
    const f=fixture(),opened=f.openSidebar('p','file-a');await f.reads.get('a').arrived.promise;
    if(change==='unlink')f.ws.getState().openProjects.get('p').tabs.get('file-a').visualParentTabId='b';
    else f.ws.setState({activeSpaceId:'elsewhere'});
    f.release('a');assert.equal(await opened,false);assert.equal(f.ui.getState().filePreview,null);
  }
});
