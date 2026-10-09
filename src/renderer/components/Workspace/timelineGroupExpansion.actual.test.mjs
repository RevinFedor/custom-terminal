import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';
import {getTerminalMcpTag} from '../../../shared/prompt-origin.mjs';
import {isSystemPromptEntry,isServicePromptEntry} from '../../../shared/prompt-origin.mjs';
import * as presentation from '../../utils/timelineMarkerPresentation.mjs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ChevronDown,ChevronRight} from 'lucide-react';
const source=fs.readFileSync(new URL('./Timeline.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('Timeline.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function handler(name){let expression;const visit=node=>{if(ts.isBinaryExpression(node)&&node.left.getText(ast)==='rowApi.'+name)expression=node.right;ts.forEachChild(node,visit)};visit(ast);assert.ok(expression);return expression.getText(ast);}
function actualRow(){
 const variable=ast.statements.find(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(ast)==='TimelineSegmentRow'));
 const callback=variable.declarationList.declarations[0].initializer.arguments[0];assert.ok(callback);
 const previews=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&['expandedPreviewCharLimit','truncateTimelinePreviewText'].includes(node.name?.text)
  ||ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(ast).startsWith('EXPANDED_PREVIEW_'))).map(node=>node.getText(ast)).join('\n');
 return vm.runInNewContext(ts.transpileModule(previews+'\nconst Row='+callback.getText(ast)+';\nRow;',{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText,
  {...presentation,React,ChevronDown,ChevronRight,scDesktopIcon:'sc.png',Tooltip:props=>props.children,isSystemPromptEntry,isServicePromptEntry,getOrchestrationTag:getTerminalMcpTag,
   getLoopPromptOriginTag:()=>null,TimelineCornerBadges:()=>React.createElement('div',{'data-test-corner-badges':''})});
}
const groupedProps={entry:{uuid:'exact-entry',type:'user',semanticTags:[{kind:'orchestration',runId:'r'}]},index:0,api:{},
 groupInfo:{isGroupHeader:true,isGroupChild:true,groupId:'g',groupSize:3,groupKind:'orchestration',agentName:'MCP',startIndex:0},
 isGroupExpanded:false,isExpandedLayout:false,treeMode:false};

test('actual SC glyph follows the rotated MCP diamond bounds rather than a fixed 14px size',()=>{
 const Row=actualRow();
 for(const isExpandedLayout of [false,true])for(const child of [false,true])for(const isHovered of [false,true])for(const isInViewport of [false,true]){
  const html=renderToStaticMarkup(React.createElement(Row,{...groupedProps,groupInfo:child?groupedProps.groupInfo:undefined,
   isGroupExpanded:true,isHovered,isInViewport,isExpandedLayout,
   entry:{...groupedProps.entry,semanticTags:[{kind:'orchestration',runId:'r',runKind:'external-research'}]}}));
  const style=html.match(/<img[^>]*data-timeline-sc-desktop[^>]*style="([^"]+)"/)?.[1];assert.ok(style);
  const side=isExpandedLayout?(child?6:8):Number.parseFloat(presentation.timelineMarkerGeometry({isOrchestration:true,showAsChild:child,isHovered,isInViewport}).width);
  const expected=side*Math.SQRT2;
  assert.ok(Math.abs(Number.parseFloat(style.match(/(?:^|;)width:([^;]+)/)?.[1])-expected)<0.001);
  assert.ok(Math.abs(Number.parseFloat(style.match(/(?:^|;)height:([^;]+)/)?.[1])-expected)<0.001);
 }
});

test('actual compact group header has one row and never aggregates child badges',()=>{
 const Row=actualRow();
 for(const isGroupExpanded of [false,true]){
  const html=renderToStaticMarkup(React.createElement(Row,{...groupedProps,isGroupExpanded,
   groupPresentation:{edited:['sample.md'],searched:['query'],hasPromptChip:true}}));
  const header=html.slice(html.indexOf('data-timeline-group-header'),html.indexOf('</button>'));
  assert.match(header,/display:flex;gap:2px/);
  assert.match(header,/font-size:8px/);
  assert.doesNotMatch(header,/grid-template-rows:14px 10px/);
  assert.doesNotMatch(header,/data-test-corner-badges/);
  assert.equal((html.match(/data-test-corner-badges/g)||[]).length,isGroupExpanded?1:0);
 }
});

test('actual narrow group children sit left of the axis with room for their passive guide',()=>{
 const Row=actualRow();
 for(const runKind of ['agent','external-research']){
  const html=renderToStaticMarkup(React.createElement(Row,{...groupedProps,isGroupExpanded:true,hasNote:true,notePos:'after',
   entry:{...groupedProps.entry,semanticTags:[{kind:'orchestration',runId:'r',runKind}]}}));
  assert.match(html,/data-timeline-group-child="g"/);
  const rowStyle=html.match(/data-timeline-group-child="g"[^>]*style="([^"]+)"/)?.[1];
  assert.ok(rowStyle);
  assert.match(rowStyle,/padding-right:4px/);
  assert.doesNotMatch(rowStyle,/padding-left:/);
  assert.match(html,/data-timeline-group-guide="g"[^>]*style="[^"]*left:4px/);
  assert.equal((html.match(/data-timeline-group-guide="g"/g)||[]).length,2);
  assert.match(html,/pointer-events:none/);
 }
 for(const props of [{...groupedProps},{...groupedProps,groupInfo:undefined,isGroupExpanded:true}]){
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(Row,props)),/data-timeline-group-guide/);
 }
});
test('group child loading and failed overlays stay on the shifted marker column',()=>{
 const Row=actualRow();
 for(const dotClickState of ['loading','failed']){
  const html=renderToStaticMarkup(React.createElement(Row,{...groupedProps,isGroupExpanded:true,dotClickState}));
  assert.match(html,/class="absolute inset-0 flex items-center justify-center pointer-events-none" style="padding-right:4px"/);
 }
 const wide=renderToStaticMarkup(React.createElement(Row,{...groupedProps,isGroupExpanded:true,isExpandedLayout:true,dotClickState:'loading'}));
 assert.match(wide,/padding-left:6px/);
 assert.doesNotMatch(wide,/padding-right:4px/);
});
test('left-of-axis group placement fits both hovered glyphs without crossing its guide',()=>{
 const Row=actualRow();
 for(const runKind of ['agent','external-research'])for(const isHovered of [false,true]){
  const html=renderToStaticMarkup(React.createElement(Row,{...groupedProps,isGroupExpanded:true,isHovered,
   entry:{...groupedProps.entry,semanticTags:[{kind:'orchestration',runId:'r',runKind}]}}));
  const rowStyle=html.match(/data-timeline-group-child="g"[^>]*style="([^"]+)"/)?.[1];
  assert.match(rowStyle,/padding-right:4px/);
  const center=(32-4)/2;
  const side=Number.parseFloat(presentation.timelineMarkerGeometry({isOrchestration:true,showAsChild:true,isHovered}).width);
  const left=center-side*Math.SQRT2/2;
  assert.equal(center,14);
  assert.ok(left-(4+1)>1.9,'hover bounds keep a visible gap after the passive guide');
 }
 const plain=renderToStaticMarkup(React.createElement(Row,{...groupedProps,groupInfo:undefined,isGroupExpanded:true}));
 assert.doesNotMatch(plain,/padding-right:4px|translateX\(-2px\)|data-timeline-group-guide/);
});
test('actual group guide also covers structural strips without adding another header',()=>{
 const html=renderToStaticMarkup(React.createElement(actualRow(),{...groupedProps,isGroupExpanded:true,
  isLastBoundary:true,forkMarkerVisible:true,isPlanModeBoundary:true}));
 assert.equal((html.match(/data-timeline-group-guide="g"/g)||[]).length,4);
 assert.equal((html.match(/data-timeline-group-toggle="g"/g)||[]).length,1);
});
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
