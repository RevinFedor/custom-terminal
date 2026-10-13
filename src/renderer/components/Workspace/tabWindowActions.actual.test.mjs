import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import React from 'react';
import ts from 'typescript';
import {transformSync} from 'esbuild';
import * as metrics from '../UI/contextMenuMetrics.mjs';
const require=createRequire(import.meta.url);
const code=transformSync(fs.readFileSync(new URL('./TabWindowActionButton.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code;
function fixture() {
  const calls=[],state={tabCatalog:{},openProjects:new Map([['p',{tabs:new Map([['target',{id:'target'}]])}]]),
    openTabById:async(...args)=>{calls.push(args);return true;}};
  const module={exports:{}};
  vm.runInNewContext(code,{module,exports:module.exports,require:name=>name==='react'?React:name==='lucide-react'?require(name)
    :name.includes('useWorkspaceStore')?{useWorkspaceStore:{getState:()=>state}}
    :name.includes('useUIStore')?{useUIStore:{getState:()=>({showToast:(...args)=>calls.push(['toast',...args])})}}:metrics});
  return {calls,state,render:module.exports.default};
}
for(const action of ['beside','replace-shown'])test(`actual menu ${action} opens exact existing tab without creating a session`,async()=>{
  const f=fixture();let closed=0;
  const button=f.render({projectId:'p',tabId:'target',action,onClose:()=>closed++});
  await button.props.onClick({stopPropagation(){}});
  assert.equal(closed,1);assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'target');
  assert.equal(f.calls[0][1].windowAction,action);assert.equal(button.props.style.height,26);
});
test('stale opener or vanished target cannot place another tab through old menu',async()=>{
  const f=fixture();let closed=0;
  for(const current of [false,true]) {
    if(current)f.state.openProjects.get('p').tabs.delete('target');
    const b=f.render({projectId:'p',tabId:'target',action:'beside',onClose:()=>closed++,isCurrent:()=>current});
    await b.props.onClick({stopPropagation(){}});
  }
  assert.equal(closed,0);assert.equal(f.calls.length,0);
});
function jsxCallback(file,attribute) {
  const source=fs.readFileSync(new URL(file,import.meta.url),'utf8');
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let expression;
  const visit=node=>{if(!expression && ts.isJsxAttribute(node) && node.name.getText(ast)===attribute)expression=node.initializer.expression;
    if(!expression)ts.forEachChild(node,visit);};visit(ast);assert.ok(expression);return expression.getText(ast);
}
test('actual reserve callback keeps ordinary session navigation after linked-file dispatch',async()=>{
  const f=fixture(),context={useWorkspaceStore:{getState:()=>f.state},openSidebarLinkedFile:()=>null};
  const source=jsxCallback('./ConnectedWorkflowSidebar.tsx','onOpenTab');
  const callback=vm.runInNewContext(transformSync('const callback='+source+';callback',{loader:'ts'}).code,context);
  await callback('p','target');assert.equal(f.calls[0][1].unplacedMode,undefined);
  assert.equal(f.calls[0][1].projectId,'p');assert.equal(f.calls[0][0],'target');
});
test('actual linked-file row click uses the owner preview callback; aux-click remains separate',()=>{
  const calls=[],file={id:'file',ownerTabId:'owner',projectId:'p',path:'/synthetic.md'};
  const source=jsxCallback('./TabLinkedFileTree.tsx','onClick');
  const callback=vm.runInNewContext(transformSync('const callback='+source+';callback',{loader:'ts'}).code,
    {file,onOpen:f=>calls.push(f),openLinkedFileTab:()=>assert.fail('ordinary click must not navigate to file placement')});
  callback({stopPropagation(){}});assert.equal(calls[0],file);
});
test('actual reserve linked-file success or rejection never falls through to independent navigation',async()=>{
  const source=jsxCallback('./ConnectedWorkflowSidebar.tsx','onOpenTab');
  for(const result of [true,false]) {
    const f=fixture();let previewed;
    const callback=vm.runInNewContext(transformSync('const callback='+source+';callback',{loader:'ts'}).code,{
      useWorkspaceStore:{getState:()=>f.state},openSidebarLinkedFile:(namespace,id)=>{previewed=[namespace,id];return Promise.resolve(result);},
    });
    assert.equal(await callback('p','target'),result);assert.deepEqual(previewed,['p','target']);assert.equal(f.calls.length,0);
  }
});
