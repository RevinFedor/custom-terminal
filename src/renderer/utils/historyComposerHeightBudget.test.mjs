import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import ts from 'typescript';
import {resolveHistoryComposerHeightBudget as budget,observeHistoryComposerHeight} from './historyComposerHeightBudget.mjs';
const configured={minHeight:36,maxHeight:320,transcriptLineHeight:25.2};
test('small pane preserves reading space without dropping preferred rows in a tall pane',()=>{
 assert.deepEqual(budget({...configured,surfaceHeight:367,chromeHeight:47}),{minHeight:36,maxHeight:269});
 assert.deepEqual(budget({...configured,surfaceHeight:800,chromeHeight:47}),{minHeight:36,maxHeight:320});
 assert.deepEqual(budget({...configured,minHeight:280,surfaceHeight:220,chromeHeight:47}),{minHeight:122,maxHeight:122});
 assert.equal(budget({...configured,surfaceHeight:0,chromeHeight:47}),null);
});
test('actual Workspace ancestry gives the sibling docked composer an independent shared boundary',()=>{
 const path=process.env.NOTED_LAYOUT_WORKSPACE_SOURCE || new URL('../components/Workspace/Workspace.tsx',import.meta.url);
 const source=ts.createSourceFile('Workspace.tsx',fs.readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const has=(node,name)=>node.attributes.properties.some(a=>ts.isJsxAttribute(a)&&a.name.getText(source)===name);
 let ancestors;
 function visit(node,parents=[]){
  if(ts.isJsxElement(node)){
   const next=[...parents,node.openingElement];
   if(has(node.openingElement,'data-workspace-docked-composer-host'))ancestors=next;
   ts.forEachChild(node,child=>visit(child,next));
  }else if(ts.isJsxSelfClosingElement(node)){
   if(has(node,'data-workspace-docked-composer-host'))ancestors=[...parents,node];
  }else ts.forEachChild(node,child=>visit(child,parents));
 }
 visit(source);assert.ok(ancestors,'actual portal host must be present');
 const boundary=[...ancestors].reverse().find(n=>has(n,'data-history-owner')||has(n,'data-history-composer-boundary'));
 assert.ok(boundary,'portal host must have a boundary ancestor');
 assert.ok(has(boundary,'data-single-center-resize-content'),'boundary is the independent shared row, not composer host itself');
 let height=367,callback;const measurements=[];
 const nodes=ancestors.map((node,i)=>({node,index:i,getBoundingClientRect:()=>({height})}));
 const surface=nodes.find(x=>x.node===boundary);
 const dom={isConnected:true,getBoundingClientRect:()=>({width:440,height:320})};
 const controls={isConnected:true,closest:()=>[...nodes].reverse().find(x=>has(x.node,'data-history-owner')||has(x.node,'data-history-composer-boundary'))||null,getBoundingClientRect:()=>({height:368})};
 const cleanup=observeHistoryComposerHeight({...configured,editor:{dom},controls,onMeasure:x=>measurements.push(x),ResizeObserver:class{constructor(fn){callback=fn}observe(){}disconnect(){}}});
 assert.equal(measurements.at(-1).maxHeight,268);height=220;callback();assert.equal(measurements.at(-1).maxHeight,121);cleanup();
 assert.ok(surface.index<ancestors.length-1);
});
test('local resize observer ignores editor-only height changes; width, chrome and pane changes update; cleanup fences callbacks',()=>{
 let callback,disconnected=false;const seen=[],nodes=[];let width=440,editorHeight=320,chrome=47,height=367;
 const dom={isConnected:true,getBoundingClientRect:()=>({width,height:editorHeight})};
 const surface={getBoundingClientRect:()=>({height})};
 const controls={isConnected:true,closest:()=>surface,getBoundingClientRect:()=>({height:editorHeight+chrome})};
 const cleanup=observeHistoryComposerHeight({...configured,editor:{dom},controls,onMeasure:x=>seen.push(x),
  ResizeObserver:class{constructor(fn){callback=fn}observe(x){nodes.push(x)}disconnect(){disconnected=true}}});
 assert.equal(nodes.length,3);assert.equal(seen.length,1);
 editorHeight=200;callback();assert.equal(seen.length,1);
 width=300;callback();assert.equal(seen.length,2);
 chrome=75;callback();assert.equal(seen.at(-1).maxHeight,241);
 height=800;callback();assert.equal(seen.at(-1).maxHeight,320);
 height=0;callback();assert.equal(seen.at(-1).maxHeight,320);
 cleanup();height=220;callback();assert.equal(disconnected,true);assert.equal(seen.length,4);
});
