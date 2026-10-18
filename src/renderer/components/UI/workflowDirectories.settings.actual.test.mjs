import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import {createWorkflowDirectoryDraft,normalizeWorkflowDirectories} from '../../utils/workflowDirectoryDraft.mjs';

test('close flush joins the pending save and drains a newer directory edit',async()=>{
  const writes=[],pending=[];
  const draft=createWorkflowDirectoryDraft({initial:{defaultCwd:'/one',promptDirectories:[]},
    apply:value=>writes.push(value),commit:()=>new Promise(resolve=>pending.push(resolve))});
  draft.edit({defaultCwd:'/two'});const blur=draft.flush();await Promise.resolve();
  draft.edit({promptDirectories:['/extra']});const close=draft.flush();assert.equal(close,blur);
  pending.shift()();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes.length,2);assert.deepEqual(writes[1],{defaultCwd:'/two',promptDirectories:['/extra']});
  pending.shift()();await close;
});

test('a failed save stays dirty and can be retried without discarding the draft',async()=>{
  let fails=true,writes=0;
  const draft=createWorkflowDirectoryDraft({initial:{defaultCwd:'/one',promptDirectories:[]},apply:()=>writes++,
    commit:async()=>{if(fails)throw Error('unknown ACK');}});
  draft.edit({defaultCwd:'/two'});await assert.rejects(draft.flush(),/unknown ACK/);
  assert.equal(draft.get().defaultCwd,'/two');fails=false;await draft.flush();assert.equal(writes,2);
});

test('directory edits are validated before persistence, with stable path deduplication',async()=>{
  assert.deepEqual(normalizeWorkflowDirectories({defaultCwd:'/one/',promptDirectories:['/extra','/extra/','/one','']}),
    {defaultCwd:'/one',promptDirectories:['/extra']});
  const draft=createWorkflowDirectoryDraft({initial:{defaultCwd:'/one',promptDirectories:[]},
    apply:()=>assert.fail('invalid input reached persistence'),commit:async()=>assert.fail()});
  draft.edit({defaultCwd:'relative'});await assert.rejects(draft.flush(),/абсолютный/);
});

test('the workflow modal has directories only, and every close entrypoint saves',()=>{
  const modal=fs.readFileSync(new URL('./WorkflowSettingsModal.tsx',import.meta.url),'utf8');
  const directories=fs.readFileSync(new URL('./WorkflowDirectorySettings.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(modal,/WorkflowSourcesSettings|<select/);
  assert.match(modal,/event\.target===event\.currentTarget\)void close\(\)/);
  assert.match(modal,/event\.key==='Escape'[^\n]+void close\(\)/);
  assert.match(modal,/aria-label="Close workflow settings" onClick=\{\(\)=>void close\(\)\}/);
  assert.match(modal,/await directories\.current\?\.flush\(\)/);
  assert.match(modal,/>Настройки<\/strong>/);
  assert.doesNotMatch(directories,/Save|Sources|<select|tabId/);
  assert.match(directories,/promptDirectories/);
});

function modalClose({flush=async()=>{},commit=async()=>({revision:1})}={}){
  const source=fs.readFileSync(new URL('./WorkflowSettingsModal.tsx',import.meta.url),'utf8');
  const start=source.indexOf('  const close=()=>'),end=source.indexOf('  closeRef.current=close;',start);
  assert.ok(start>0&&end>start);
  const ui={workflowSettingsId:'W'},calls=[],errors=[];
  const store={spaces:[{id:'W'}],organizationReady:true,isRestoring:false,
    commitOrganization:async()=>{calls.push('commit');return commit();},saveSession:()=>calls.push('saveSession')};
  const context={workflowId:'W',closing:{current:null},panel:{current:{contains:()=>true}},
    document:{activeElement:{blur:()=>calls.push('blur')}},directories:{current:{flush}},
    useWorkspaceStore:{getState:()=>store},useUIStore:{getState:()=>ui},
    setWorkflowId:id=>{calls.push('close');ui.workflowSettingsId=id;},setError:message=>errors.push(message)};
  vm.runInNewContext(transformSync(source.slice(start,end)+'\nglobalThis.close=close;',{loader:'ts'}).code,context);
  return {close:context.close,ui,calls,errors};
}

test('actual modal close waits for directory flush and durable acknowledgement',async()=>{
  let release;const pending=new Promise(resolve=>release=resolve);
  const f=modalClose({commit:()=>pending});const close=f.close();
  assert.equal(f.close(),close);await Promise.resolve();assert.equal(f.ui.workflowSettingsId,'W');
  release({revision:2});assert.equal(await close,true);assert.equal(f.ui.workflowSettingsId,null);
  assert.deepEqual(f.calls,['blur','commit','saveSession','close']);
});

test('actual modal close keeps failed edits open and cannot close a replacement modal',async()=>{
  const failed=modalClose({commit:async()=>{throw Error('ACK unknown');}});
  assert.equal(await failed.close(),false);assert.equal(failed.ui.workflowSettingsId,'W');
  assert.deepEqual(failed.errors,['ACK unknown']);assert.ok(!failed.calls.includes('close'));
  let release;const pending=new Promise(resolve=>release=resolve);
  const replaced=modalClose({flush:()=>pending});const close=replaced.close();
  replaced.ui.workflowSettingsId='other';release();await close;
  assert.equal(replaced.ui.workflowSettingsId,'other');assert.ok(!replaced.calls.includes('close'));
});
