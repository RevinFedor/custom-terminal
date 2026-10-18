import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import {transformSync} from 'esbuild';
import * as model from '../Workspace/promptTabSourcesModel.mjs';
import * as directoryDraft from '../../utils/workflowDirectoryDraft.mjs';

function renderSource(file, exportName, states, props, state={}) {
  const source=fs.readFileSync(new URL(file,import.meta.url),'utf8');
  const capture=file.endsWith('WorkflowDirectorySettings.tsx')?'\nmodule.exports.TestComponent=module.exports.default;':`\nmodule.exports.TestComponent=${exportName};`;
  const compiled=transformSync(source+capture,{loader:'tsx',format:'cjs'}).code;
  let cursor=0;
  const hooks={...React,useState:initial=>[states[cursor++]??initial,()=>{}],useEffect:()=>{},
    useCallback:callback=>callback,useRef:value=>({current:value}),useImperativeHandle:()=>{}};
  const context={module:{exports:{}},exports:{},window:{require:()=>({ipcRenderer:{invoke:()=>{throw Error('render must not read or mutate Main');}}})},
    require:name=>{
      if(name==='react')return hooks;
      if(name==='lucide-react')return new Proxy({}, {get:()=>()=>null});
      if(name.includes('promptTabSourcesModel'))return model;
      if(name.includes('useWorkspaceStore'))return{useWorkspaceStore:Object.assign(selector=>selector(state),{getState:()=>state})};
      if(name.includes('workflowDirectoryDraft'))return directoryDraft;
      if(name.includes('DirectoryRootsSettings'))return{default:()=>null};
      throw Error('unexpected dependency '+name);
    }};
  vm.runInNewContext(compiled,context);
  const component=context.module.exports.TestComponent;
  return typeof component==='function'?component(props):component.render(props,null);
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

test('actual workflow directory editor shows common paths without selecting a tab or Save',()=>{
  const state={spaces:[{id:'W',defaultCwd:'/source with spaces',promptDirectories:['/extra']}],organizationReady:true};
  const tree=renderSource('./WorkflowDirectorySettings.tsx','WorkflowDirectorySettings',[],{workflowId:'W'},state);
  const nodes=elements(tree);
  assert.deepEqual(nodes.filter(n=>n.type==='input').map(n=>n.props.value),['/source with spaces','/extra']);
  assert.equal(nodes.filter(n=>n.type==='select').length,0);
  assert.doesNotMatch(content(tree),/Sources|Save|Выбранная вкладка/);
  assert.match(content(tree),/всем вкладкам рабочего пространства/);
});

test('editing a dormant workflow reads that workflow directories, independent of active tab',()=>{
  const state={spaces:[{id:'W',defaultCwd:'/chosen',promptDirectories:[]},{id:'foreign',defaultCwd:'/foreign'}],activeSpaceId:'foreign'};
  const tree=renderSource('./WorkflowDirectorySettings.tsx','WorkflowDirectorySettings',[],{workflowId:'W'},state);
  assert.equal(elements(tree).find(n=>n.type==='input').props.value,'/chosen');
  assert.equal(state.spaces[1].defaultCwd,'/foreign');
});

test('compact registry previews the effective search path before saving without changing the registry root',()=>{
  const registry={version:1,revision:9,roots:[{id:'a',path:'/registered',revision:1,name:'Root'}]};
  const tree=renderSource('./DirectoryRootsSettings.tsx','DirectoryRootsSettings',[
    registry,false,false,'',{path:'/chosen/docs',name:'Chosen',enabled:true},null,null],{compact:true});
  assert.deepEqual(elements(tree).filter(n=>n.props['data-prompt-source-search-path']!==undefined).map(content),['Search: /registered/docs','Search: /chosen/docs/docs']);
  assert.equal(registry.roots[0].path,'/registered');
});
