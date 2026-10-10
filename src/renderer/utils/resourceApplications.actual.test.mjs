import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root=new URL('../components/Workspace/',import.meta.url);
const source=fs.readFileSync(new URL('ResourceUsageButton.tsx',root),'utf8');
const ast=ts.createSourceFile('ResourceUsageButton.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function callback(name,scope){
  let declaration;
  const walk=n=>{if(ts.isVariableDeclaration(n)&&n.name.getText(ast)===name)declaration=n;ts.forEachChild(n,walk);};
  walk(ast); assert.ok(declaration,name);
  const expression=declaration.initializer.arguments[0].getText(ast);
  const js=ts.transpileModule('globalThis.result='+expression,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(js,scope);return scope.result;
}

const require=createRequire(new URL('ResourceApplicationsView.tsx',root));
const module={exports:{}};
const compiled=transformSync(fs.readFileSync(new URL('ResourceApplicationsView.tsx',root),'utf8'),{loader:'tsx',format:'cjs',jsx:'automatic'}).code;
new Function('require','module','exports',compiled)(name=>name==='../UI/Tooltip'
  ? {default:({children})=>children,__esModule:true}:require(name),module,module.exports);
const View=module.exports.default;
const bytes=n=>n+' B';
const value=(b,c)=>b===null||b===undefined?c===null?'—':c+' %':b+' B';
const data={available:true,totalBytes:30,memory:{totalBytes:32,compressedBytes:10,swapUsedBytes:5,pressureLevel:2},apps:[
  {id:'small',label:'SmallApp',path:'/Small.app',bytes:10,cpu:80,processCount:1,rows:[{label:'Renderer',bytes:10,cpu:80,count:1}]},
  {id:'large',label:'LargeApp',path:'/Large.app',bytes:20,cpu:5,processCount:2,rows:[{label:'Renderer',bytes:20,cpu:5,count:2}]},
]};
const render=props=>renderToStaticMarkup(React.createElement(View,{data,mode:'memory',expanded:new Set(),onToggle(){},bytes,value,...props}));

test('real application view sorts memory, keeps rows collapsed and reports hardware counters',()=>{
  const html=render();
  assert.ok(html.indexOf('LargeApp')<html.indexOf('SmallApp'));
  assert.ok(!html.includes('Renderer'));
  assert.match(html,/ОЗУ.*32 B/);assert.match(html,/сжато.*10 B/);assert.match(html,/swap.*5 B/);
  assert.match(html,/#f59e0b|rgb\(245, 158, 11\)/);
});

test('real CPU view changes sort and expanded process count without changing the snapshot',()=>{
  const before=JSON.stringify(data);
  const html=render({mode:'cpu',expanded:new Set(['large']),value:(_b,c)=>c==null?'—':c+' %'});
  assert.ok(html.indexOf('SmallApp')<html.indexOf('LargeApp'));
  assert.match(html,/Renderer/);assert.match(html,/×2/);assert.match(html,/80 %/);
  assert.equal(JSON.stringify(data),before);
});

test('unknown system values render dashes and failed applications do not show zero usage',()=>{
  assert.match(render({data:{...data,memory:{available:false}}}),/ОЗУ.*—/);
  assert.match(render({data:{available:false}}),/Не удалось измерить приложения/);
});

test('actual scope callback only changes view: no subscribe, stop, new capture or History IPC',async()=>{
  const calls=[],received=[],viewRef={current:'noted'},panelVisit={current:4};
  const change=callback('changeView',{viewRef,panelVisit,setView(){},acceptMetrics:p=>received.push(p),setMetrics(){},
    ipcRenderer:{invoke:(channel,args)=>{calls.push([channel,args]);return Promise.resolve({ok:true,scannedAt:10});}}});
  change('system'); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1);assert.equal(calls[0][0],'system:process-metrics-set-view');
  assert.equal(calls[0][1].view,'system');assert.equal(received.length,1);
  assert.equal(viewRef.current,'system');assert.equal(panelVisit.current,4);
});

test('late view reply after close or another view cannot apply to the current panel',async()=>{
  let resolve;const received=[],viewRef={current:'noted'},panelVisit={current:1};
  const change=callback('changeView',{viewRef,panelVisit,setView(){},acceptMetrics:p=>received.push(p),setMetrics(){},
    ipcRenderer:{invoke:()=>new Promise(r=>{resolve=r;})}});
  change('system');panelVisit.current++;
  resolve({ok:true});await new Promise(r=>setImmediate(r));assert.equal(received.length,0);
  change('system');viewRef.current='noted';resolve({ok:true});
  await new Promise(r=>setImmediate(r));assert.equal(received.length,0);
});

test('actual metrics acceptance cannot overwrite new apps with an older initial subscription reply',()=>{
  let previous={ok:true,scannedAt:20,applications:{available:true}};
  const viewRef={current:'system'};
  const accept=callback('acceptMetrics',{viewRef,setMetrics:update=>{previous=update(previous);}});
  accept({ok:true,scannedAt:10});assert.equal(previous.scannedAt,20);
  accept({ok:true,scannedAt:20});assert.equal(previous.applications.available,true);
  viewRef.current='noted';accept({ok:true,scannedAt:20});assert.equal(previous.applications,undefined);
});

test('Escape owned by the resource popup preserves the underlying History search',()=>{
  const file=fs.readFileSync(new URL('HistoryPanel.tsx',root),'utf8');
  const history=ts.createSourceFile('HistoryPanel.tsx',file,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let body;
  const walk=n=>{
    if(ts.isIfStatement(n)&&n.expression.getText(history)==="e.key === 'Escape' && searchOpen"
      &&n.thenStatement.getText(history).includes('setSearchType'))body=n.thenStatement.getText(history);
    ts.forEachChild(n,walk);
  };
  walk(history);assert.ok(body,'actual History search Escape branch');
  let resourceOpen=true,writes=0;
  const scope={document:{getElementById:id=>id==='noted-resource-usage-panel'&&resourceOpen?{}:null},
    isComposerKeyboardTarget:()=>false,setSearchOpen:()=>writes++,setSearchType(){},setSearchQuery(){},setCurrentMatchIdx(){}};
  vm.runInNewContext(ts.transpileModule('globalThis.handle=(e)=>'+body,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,scope);
  const event={target:{},preventDefault(){},stopPropagation(){}};
  scope.handle(event);assert.equal(writes,0,'resource popup gets Escape without clearing History search');
  resourceOpen=false;scope.handle(event);assert.equal(writes,1,'ordinary History Escape remains available');
});
