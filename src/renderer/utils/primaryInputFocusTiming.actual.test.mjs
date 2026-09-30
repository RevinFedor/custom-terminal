import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { uiPerformancePhase } from './uiPerformanceDiagnostics.mjs';

const history=fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('HistoryPanel.tsx',history,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let effect;
function visit(node){
 if(ts.isCallExpression(node)&&node.expression.getText(ast)==='useEffect'
   &&node.arguments[0]?.getText(ast).includes("window.addEventListener('history-panel:focus-composer', focusComposer)"))effect=node.getText(ast);
 ts.forEachChild(node,visit);
}
visit(ast);assert.ok(effect);
const focus=fs.readFileSync(new URL('./tabPrimaryInputFocus.ts',import.meta.url),'utf8');
const js=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;

function harness(){
 let clock=10,valueReads=0;const calls=[],logs=[],raf=[],listeners=new Map();
 const body={tagName:'BODY',className:'',closest:()=>null};const caret={current:null};
 const state={view:'workspace',activeProjectId:'P',splitPanes:[],openProjects:new Map([['P',{activeTabId:'tab-a',tabs:new Map([['tab-a',{id:'tab-a',tabType:'terminal',commandType:'codex'}]])}]])};
 const editor={focus(){calls.push('focus');clock+=100;},get value(){valueReads++;return 'private draft';},
   setSelectionRange(start,end){calls.push(['selection',start,end]);clock+=30;}};
 const context=vm.createContext({
   console:{log:s=>logs.push(s),warn:s=>logs.push(s)},performance:{timeOrigin:100000,now:()=>clock},
   tabId:'tab-a',promptTextareaRef:{current:editor},promptCaretRef:caret,
   uiPerformancePhase,
   requestAnimationFrame:callback=>raf.push(callback),useEffect:callback=>callback(),
   document:{body,activeElement:body,querySelectorAll:()=>[{dataset:{terminalPaneWrapper:'tab-a',terminalSurfacePresented:'1',paneFocusIsolated:'0'},getAttribute:()=>null}]},
   window:{addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener(){},dispatchEvent:event=>listeners.get(event.type)?.(event)},
   CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail;}},exports:{},
   require:name=>name.includes('useUIStore')?{useUIStore:{getState:()=>({activeArea:'workspace',historyPanelOpenTabs:{}})},resolveTabTerminalPrimary:()=>false}
     :name.includes('useWorkspaceStore')?{useWorkspaceStore:{getState:()=>state}}
     :name.includes('uiPerformanceDiagnostics')?{uiPerformancePhase}:{resolvePtyAgentOwner:()=> 'codex'},
 });
 vm.runInContext(js(effect),context);vm.runInContext(js(focus),context);
 return{context,calls,logs,caret,state,raf,get valueReads(){return valueReads;}};
}

test('actual request logs dispatch entry before synchronous editor focus and separates focus/selection cost',()=>{
 const h=harness();h.context.exports.requestTabPrimaryInputFocus('tab-a','workflow-strip-click');
 assert.deepEqual(h.calls,['focus',['selection',13,13]]);
 const start=h.logs.findIndex(line=>line.includes('phase=dispatch-start'));
 const inner=h.logs.findIndex(line=>line.includes('[HistoryComposerFocus]'));
 const end=h.logs.findIndex(line=>line.includes('dispatchMs='));
 assert.ok(start>=0&&inner>start&&end>inner);
 assert.match(h.logs[start],/startAbs=100010\.0/);
 assert.match(h.logs[inner],/focusMs=100\.0 selectionMs=30\.0 immediate=1/);
 assert.match(h.logs[end],/dispatchMs=130\.0/);
 assert.equal(h.valueReads,2,'no additional editor value/geometry reads');
 assert.ok(h.logs.every(line=>!line.includes('private draft')));
});

test('deferred focus and focus without a caret request retain their existing behavior',()=>{
 const h=harness();h.context.window.dispatchEvent(new h.context.CustomEvent('history-panel:focus-composer',{detail:{tabId:'tab-a'}}));
 assert.equal(h.calls.length,0);assert.equal(h.raf.length,1);h.raf[0]();
 assert.deepEqual(h.calls,['focus']);assert.equal(h.valueReads,0);assert.equal(h.caret.current,null);
 assert.match(h.logs[0],/focusMs=100\.0 selectionMs=0\.0 immediate=0/);
});

test('stale pane and foreign event never acquire focus or log successful focus work',()=>{
 const h=harness();h.state.openProjects.get('P').activeTabId='another-tab';
 h.context.exports.requestTabPrimaryInputFocus('tab-a','workflow-strip-click');
 h.context.window.dispatchEvent(new h.context.CustomEvent('history-panel:focus-composer',{detail:{tabId:'another-tab',immediate:true}}));
 assert.equal(h.calls.length,0);assert.ok(h.logs.some(line=>line.includes('stale-centre-target')));
 assert.ok(h.logs.every(line=>!line.includes('[HistoryComposerFocus]')&&!line.includes('dispatchMs=')));
});
