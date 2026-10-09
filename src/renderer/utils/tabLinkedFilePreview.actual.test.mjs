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
  return {ws,ui,calls,reads,open,release,close:module.exports.closeTabLinkedFile};
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
