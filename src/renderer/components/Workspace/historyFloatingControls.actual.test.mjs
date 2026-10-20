import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import ts from 'typescript';import {transformSync} from 'esbuild';
import {RIGHT_CLUSTER_INNER_GAP_PX} from '../../utils/controlBarWrap.mjs';
const createElement=(type,props,...children)=>({type,props:{...props,children}});
const descendants=node=>Array.isArray(node)?node.flatMap(descendants):!node||typeof node!=='object'?[]:[node,...descendants(node.props?.children)];
const read=name=>fs.readFileSync(new URL(name,import.meta.url),'utf8');
const parsed=(text,name='source.tsx')=>ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function markedElement(text,marker) {
  const ast=parsed(text);let result;
  const walk=node=>{if((ts.isJsxElement(node)||ts.isJsxSelfClosingElement(node))&&
    (ts.isJsxElement(node)?node.openingElement:node).attributes.properties.some(prop=>prop.name?.getText(ast)===marker))result=node.getText(ast);ts.forEachChild(node,walk);};walk(ast);
  assert.ok(result,marker);return result;
}
function renderExpression(expression,scope={}) {
  const module={exports:{}};vm.runInNewContext(transformSync('module.exports=('+expression+')',{loader:'tsx',format:'cjs'}).code,
    {module,exports:module.exports,React:{createElement},...scope});return module.exports;
}
test('actual stationary toggle stays at input right edge/6px when terminal opens; only pressed/tint/label change, hidden owners have no hit target',()=>{
  const state={view:'workspace',splitPanes:[{projectId:'P',tabId:'T'}],getEffectiveTabId:()=> 'T'};
  const ui={historyHorizontalPadding:16,sideTerminalOpenTabs:{},historyPanelOpenTabs:{},primary:false,setSideTerminalOpen:(id,open)=>{ui.sideTerminalOpenTabs[id]=open;}};
  const store=selector=>selector(state),useUIStore=selector=>selector(ui);useUIStore.getState=()=>ui;
  const module={exports:{}};vm.runInNewContext(transformSync(read('./SideSurfaceToggleButton.tsx'),{loader:'tsx',format:'cjs'}).code,
    {module,exports:module.exports,require:name=>{
      if(name==='react')return {createElement,useCallback:fn=>fn};if(name==='lucide-react')return {Bot:'Bot',SquareTerminal:'SquareTerminal'};
      if(name.endsWith('useUIStore'))return {useUIStore,resolveTabTerminalPrimary:()=>ui.primary};
      if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:store};
      if(name.endsWith('ControlHint'))return {__esModule:true,default:'ControlHint'};
      if(name.endsWith('controlBarWrap.mjs'))return {RIGHT_CLUSTER_INNER_GAP_PX};throw Error(name);
    }});
  const component=module.exports,closed=component.StationaryHistorySurfaceToggle({tabId:'T'}),closedButton=descendants(component.default({tabId:'T'})).find(node=>node.type==='button');
  assert.equal(closed.props.style.bottom,6);assert.equal(closed.props.style.right,16);assert.equal(closedButton.props['aria-pressed'],false);
  closedButton.props.onClick();const opened=component.StationaryHistorySurfaceToggle({tabId:'T'}),openedButton=descendants(component.default({tabId:'T'})).find(node=>node.type==='button');
  assert.deepEqual(opened.props.style,closed.props.style);assert.equal(openedButton.props['aria-pressed'],true);assert.notEqual(openedButton.props.style.backgroundColor,closedButton.props.style.backgroundColor);
  state.splitPanes[0].displayHidden=true;assert.equal(component.StationaryHistorySurfaceToggle({tabId:'T'}),null);
  state.splitPanes=[];assert.ok(component.StationaryHistorySurfaceToggle({tabId:'T'}));state.view='home';assert.equal(component.StationaryHistorySurfaceToggle({tabId:'T'}),null);
});
test('actual stationary hosts share the composer height and sit above side terminal; the arrow keeps its old side-panel inset and click command',()=>{
  for(const [name,marker,extra] of [
    ['./SplitPaneSurface.tsx','data-split-pane-queue-host',{splitPaneQueueHostId:id=>id,historySelected:true,surfacesAwake:true}],
    ['./Workspace.tsx','data-workspace-prompt-queue-host',{promptQueuePortalHostId:'host',historyIsPrimary:true,singleCenterTab:{id:'T'}}],
  ]){
    const expression=markedElement(read(name),marker),node=renderExpression(expression,{historyControlsHeight:120,tabId:'T',StationaryHistorySurfaceToggle:'Toggle',...extra});
    assert.equal(node.props.style.bottom,120);assert.equal(node.props.style.zIndex,140);assert.equal(node.props.style.pointerEvents,'none');
    assert.equal(descendants(node).filter(child=>child.type==='Toggle').length,1);
  }
  const expression=markedElement(read('./HistoryPanel.tsx'),'data-history-scroll-to-bottom'),calls=[];
  const base={scrollArrowRef:{current:null},scrollToBottom:smooth=>calls.push(smooth),historyHorizontalPadding:16,HISTORY_FLOATING_CONTROL_SIZE_PX:28,HISTORY_FLOATING_CONTROL_GAP_PX:2,RIGHT_CLUSTER_INNER_GAP_PX,ChevronDown:'Down'};
  const closed=renderExpression(expression,{...base,mainSurface:true,centerRightInset:0}),opened=renderExpression(expression,{...base,mainSurface:true,centerRightInset:300});
  assert.equal(closed.props.style.bottom,6);assert.equal(opened.props.style.bottom,6);assert.equal(opened.props.style.right-closed.props.style.right,300);
  assert.equal(opened.props.style.display,'none');opened.props.onClick();assert.deepEqual(calls,[false]);
  assert.equal(renderExpression(expression,{...base,mainSurface:false,centerRightInset:300}).props.style.bottom,12);
});
test('actual composer calls the shared ArrowDown router before CodeMirror; hosted paths remove the former duplicate toggle without adding global listeners',()=>{
  const text=read('./HistoryPanel.tsx'),ast=parsed(text);let call;
  const walk=node=>{if(ts.isCallExpression(node)&&node.expression.getText(ast)==='requestFocusedHistoryBottomKey')call=node.getText(ast);ts.forEachChild(node,walk);};walk(ast);assert.ok(call);
  const native={key:'ArrowDown'},events=[],module={exports:{}},workspace={},ui={};
  const expression='module.exports=()=>('+call+')';
  vm.runInNewContext(transformSync(expression,{loader:'tsx',format:'cjs'}).code,{module,exports:module.exports,e:{nativeEvent:native},tabId:'T',
    useWorkspaceStore:{getState:()=>workspace},useUIStore:{getState:()=>ui},requestFocusedHistoryBottomKey:(event,args)=>{
      assert.equal(event,native);assert.equal(args.composerTabId,'T');assert.equal(args.workspace,workspace);assert.equal(args.ui,ui);args.dispatchHistory('T');},
    CustomEvent:class {constructor(type,{detail}){this.type=type;this.detail=detail;}},window:{dispatchEvent:event=>events.push([event.type,event.detail.tabId])}});
  module.exports();assert.deepEqual(events,[['history-panel:scroll-to-bottom','T']]);
  assert.match(text,/mainSurface && !sideSurfaceToggleHosted/);
  assert.match(read('./Workspace.tsx'),/mainSurface=\{historyPlacementForRender\.isPrimary\}\s+sideSurfaceToggleHosted/);
  assert.match(read('./SplitPaneSurface.tsx'),/mainSurface\s+sideSurfaceToggleHosted/);
});
