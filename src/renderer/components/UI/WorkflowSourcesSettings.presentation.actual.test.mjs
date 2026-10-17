import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import {transformSync} from 'esbuild';
import * as model from '../Workspace/promptTabSourcesModel.mjs';

function renderSource(file, exportName, states, props, state={}) {
  const source=fs.readFileSync(new URL(file,import.meta.url),'utf8');
  const compiled=transformSync(source+`\nmodule.exports.TestComponent=${exportName};`,{loader:'tsx',format:'cjs'}).code;
  let cursor=0;
  const hooks={...React,useState:initial=>[states[cursor++]??initial,()=>{}],useEffect:()=>{},
    useCallback:callback=>callback,useRef:value=>({current:value})};
  const context={module:{exports:{}},exports:{},window:{require:()=>({ipcRenderer:{invoke:()=>{throw Error('render must not read or mutate Main');}}})},
    require:name=>{
      if(name==='react')return hooks;
      if(name==='lucide-react')return new Proxy({}, {get:()=>()=>null});
      if(name.includes('promptTabSourcesModel'))return model;
      if(name.includes('useWorkspaceStore'))return{useWorkspaceStore:selector=>selector(state)};
      if(name.includes('DirectoryRootsSettings'))return{default:()=>null};
      throw Error('unexpected dependency '+name);
    }};
  vm.runInNewContext(compiled,context);
  return context.module.exports.TestComponent(props);
}
function elements(value, out=[]) {
  if(Array.isArray(value))value.forEach(v=>elements(v,out));
  else if(React.isValidElement(value)){out.push(value);elements(value.props.children,out);}
  return out;
}
function content(value) {
  if(Array.isArray(value))return value.map(content).join('');
  return React.isValidElement(value)?content(value.props.children):value==null?'':String(value);
}

test('actual bound Sources render both exact roots and docs search paths, including removed roots and spaces',()=>{
  const snapshot={version:1,revision:9,roots:[{id:'a',path:'/source with spaces',name:'Same'},{id:'b',path:'/other/source',name:'Same',enabled:false}],
    sources:[{rootId:'removed',rootPath:'/old/source',removed:true,enabled:false}]};
  const tree=renderSource('./WorkflowSourcesSettings.tsx','TabSources',[snapshot,['a','removed'],false,'',null],{tabId:'T',workflowId:'W'});
  const nodes=elements(tree);
  assert.deepEqual(nodes.filter(n=>n.props['data-prompt-source-root-path']!==undefined).map(content),['Root: /old/source','Root: /source with spaces','Root: /other/source']);
  assert.deepEqual(nodes.filter(n=>n.props['data-prompt-source-search-path']!==undefined).map(content),['Search: /old/source/docs','Search: /source with spaces/docs','Search: /other/source/docs']);
  const inputs=nodes.filter(n=>n.type==='input');
  assert.deepEqual(inputs.map(n=>[n.props['data-prompt-source-root-id'],n.props.checked]),[['removed',true],['a',true],['b',false]]);
  assert.match(content(tree),/удалена/);
});

test('actual Sources exposes the selected workflow member while excluding file tabs and foreign members',()=>{
  const state={openProjects:new Map([['namespace',{tabs:new Map([['A',{id:'A',name:'A'}],['B',{id:'B',name:'B'}],['F',{id:'F',name:'file',tabType:'file'}],['X',{id:'X',name:'foreign'}]])}]]),
    tabWorkflowMembership:{A:{workflowId:'W'},B:{workflowId:'W'},F:{workflowId:'W'},X:{workflowId:'other'}}};
  const tree=renderSource('./WorkflowSourcesSettings.tsx','WorkflowSourcesSettings',[true,'B',false],{workflowId:'W'},state);
  const nodes=elements(tree),select=nodes.find(n=>n.type==='select');
  assert.equal(select.props.value,'B');
  assert.deepEqual(elements(select).filter(n=>n.type==='option').map(n=>n.props.value),['A','B']);
  assert.match(content(tree),/Промпты выбранной вкладки: docs\/\*\*\/\*\.prompt\.md/);
  assert.equal(nodes.find(n=>n.props.tabId==='B').props.workflowId,'W');
});

test('compact registry previews the effective search path before saving without changing the registry root',()=>{
  const registry={version:1,revision:9,roots:[{id:'a',path:'/registered',revision:1,name:'Root'}]};
  const tree=renderSource('./DirectoryRootsSettings.tsx','DirectoryRootsSettings',[
    registry,false,false,'',{path:'/chosen/docs',name:'Chosen',enabled:true},null,null],{compact:true});
  assert.deepEqual(elements(tree).filter(n=>n.props['data-prompt-source-search-path']!==undefined).map(content),['Search: /registered/docs','Search: /chosen/docs/docs']);
  assert.equal(registry.roots[0].path,'/registered');
});
