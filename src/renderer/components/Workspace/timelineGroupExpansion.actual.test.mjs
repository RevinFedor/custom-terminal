import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
import {getTerminalMcpTag} from '../../../shared/prompt-origin.mjs';
import {isSystemPromptEntry,isServicePromptEntry} from '../../../shared/prompt-origin.mjs';
import * as presentation from '../../utils/timelineMarkerPresentation.mjs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ChevronDown,ChevronRight} from 'lucide-react';
const source=fs.readFileSync(new URL('./Timeline.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('Timeline.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function handler(name){let expression;const visit=node=>{if(ts.isBinaryExpression(node)&&node.left.getText(ast)==='rowApi.'+name)expression=node.right;ts.forEachChild(node,visit)};visit(ast);assert.ok(expression);return expression.getText(ast);}
test('actual collapsed group click updates only its expansion state, never Timeline layout width',()=>{
  let groups=new Set();const calls=[];
  const ambient={setExpandedGroups:fn=>{groups=fn(groups)},setTimelineTreeMode:()=>calls.push('width'),tabId:'T',isExpandedLayout:false};
  const compile=name=>ts.transpileModule('var fn = '+handler(name),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+'\nfn';
  const expand=vm.runInNewContext(compile('expandGroup'),ambient);
  const collapse=vm.runInNewContext(compile('collapseGroup'),ambient);
  expand('exact-group','orchestration');assert.equal(groups.has('exact-group'),true);assert.deepEqual(calls,[]);
  collapse('exact-group');assert.equal(groups.has('exact-group'),false);assert.deepEqual(calls,[]);
});

test('actual mixed MCP/SC grouping counts entries once, independently of model label',()=>{
 const declaration=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='computeGroups');assert.ok(declaration);
 const compute=vm.runInNewContext(ts.transpileModule(declaration.getText(ast)+'\ncomputeGroups;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{getOrchestrationTag:getTerminalMcpTag});
 for(const n of [9,10,100,1000]){
  const entries=Array.from({length:n},(_,i)=>({uuid:'entry-'+i,semanticTags:[{kind:'orchestration',runId:'run-'+i,
   runKind:i===1?'external-research':'agent',targetTabName:i===1?'Another model':'Worker'}]}));
  const map=compute(entries);assert.equal(map.size,n);assert.equal(map.get(0).groupSize,n);
  assert.equal(Array.from(map.values()).filter(value=>value.isGroupHeader).length,1);
  assert.equal(map.get(1).groupId,map.get(0).groupId);
 }
});

test('actual collapsed group preserves first-entry note strips and dot-note colour',()=>{
 const variable=ast.statements.find(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(ast)==='TimelineSegmentRow'));
 const callback=variable.declarationList.declarations[0].initializer.arguments[0];assert.ok(callback);
 const Row=vm.runInNewContext(ts.transpileModule('const Row='+callback.getText(ast)+';\nRow;',{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText,
  {...presentation,React,ChevronDown,ChevronRight,isSystemPromptEntry,isServicePromptEntry,getOrchestrationTag:getTerminalMcpTag,
   getLoopPromptOriginTag:()=>null,TimelineCornerBadges:()=>null});
 const props={entry:{uuid:'exact-entry',type:'user',semanticTags:[{kind:'orchestration',runId:'r'}]},index:0,api:{},
  groupInfo:{isGroupHeader:true,isGroupChild:true,groupId:'g',groupSize:3,groupKind:'orchestration',agentName:'MCP'},
  isGroupExpanded:false,isExpandedLayout:false,hasNote:true};
 for(const notePos of ['before','after']){
  const html=renderToStaticMarkup(React.createElement(Row,{...props,notePos}));
  assert.match(html,/height:6px/);assert.match(html,/data-timeline-group-toggle="g"/);
  assert.equal((html.match(/data-timeline-entry-uuid="exact-entry"/g)||[]).length,1);
 }
 assert.match(renderToStaticMarkup(React.createElement(Row,{...props,notePos:'dot'})),/color:#0891b2/);
});
