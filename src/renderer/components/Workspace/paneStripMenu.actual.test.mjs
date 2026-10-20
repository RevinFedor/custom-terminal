import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';import {webcrypto} from 'node:crypto';import ts from 'typescript';import {transformSync} from 'esbuild';
import * as actions from '../../utils/paneStripSelectionActions.mjs';
import * as groups from '../../utils/paneStripGroupsModel.mjs';
import * as selection from '../../utils/paneStripSelectionModel.mjs';
import * as metrics from '../UI/contextMenuMetrics.mjs';
import {resolvePtyAgentOwner} from '../../utils/ptyAgentOwner.mjs';
import {paneTabs} from '../../utils/splitPanesModel.mjs';
import {stripHexToHsv,stripHsvToHex} from '../../utils/paneStripColor.mjs';
const event=extra=>({preventDefault(){},stopPropagation(){},button:0,detail:1,...extra});
const all=node=>Array.isArray(node)?node.flatMap(all):!node||typeof node!=='object'?[]:[node,...all(node.props?.children)];
const button=(tree,name)=>all(tree).find(node=>node.props?.['data-tab-context-action']===name);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function hooks(){
  const slots=[],effects=[],listeners=new Map();let cursor=0,changed=false;
  const React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:{...props,children}}),
    useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;
      return[slots[i],next=>{const value=typeof next==='function'?next(slots[i]):next;if(value!==slots[i]){slots[i]=value;changed=true;}}];},
    useRef:initial=>{const i=cursor++;return slots[i]??={current:initial};},
    useCallback:(fn,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((v,k)=>v!==old.deps[k]))slots[i]={value:fn,deps};return slots[i].value;},
    useEffect:(cb,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((v,k)=>v!==old.deps[k])){
      slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=cb();});}}};
  const window={innerWidth:1200,innerHeight:900,
    addEventListener:(name,fn)=>{const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set);},
    removeEventListener:(name,fn)=>listeners.get(name)?.delete(fn),clearTimeout(){},setTimeout:()=>1};
  return {React,window,listeners,render:fn=>{let result,count=0;do{assert.ok(count++<8);cursor=0;changed=false;result=fn();while(effects.length)effects.shift()();}while(changed);return result;},
    dispose:()=>slots.forEach(slot=>slot?.cleanup?.())};
}
function menuFixture({runtimePort,colorOnly=false}={}) {
  const h=hooks(),entries=[{projectId:'P',tabId:'a'},{projectId:'Q',tabId:'b'}],calls=[],toasts=[],listeners=new Set();let current=true;
  const state={organizationReady:true,isRestoring:false,activeSpaceId:'W',splitPanes:[{windowId:'win',tabs:entries,tabId:'a'}],
    spaces:[{id:'W'}],centerStrips:{},tabCatalog:{},tabTitleNamingIds:new Set(),
    openProjects:new Map([['P',{projectPath:'/P',tabs:new Map([['a',{commandType:'claude',claudeSessionId:'SIDa'}]])}],
      ['Q',{projectPath:'/Q',tabs:new Map([['b',{commandType:'claude',claudeSessionId:'SIDb'}]])}]]),
    clearTabFromSplitPane:id=>{calls.push(['remove',id]);return true;},
    commitWorkspaceWindowAction:request=>{calls.push(['beside',request]);return {ok:true};},
    setTabCompletionNotificationArmed:(...args)=>calls.push(['once',...args]),setTabCompletionNotificationPersistent:(...args)=>calls.push(['persistent',...args]),
    setTabTitleNaming:(id,on)=>{calls.push(['naming',id,on]);on?state.tabTitleNamingIds.add(id):state.tabTitleNamingIds.delete(id);},
    commitPaneStripGroupColor:async(lease,color)=>{calls.push(['color',lease.entries.map(entry=>entry.tabId),color]);return {revision:2};},
    refreshOrganizationCatalog:async()=>calls.push(['refresh']),saveSession:()=>calls.push(['save'])};
  const store=selector=>selector(state);store.getState=()=>state;store.subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
  const lease={version:1,workflowId:'W',windowId:'win',paneIndex:0,entries,isCurrent:()=>current};
  const mock={SideFlyout:()=>null,TabNotificationControls:()=>null,TabIdActions:()=>null,PaneStripGroupColorPicker:()=>null};
  const module={exports:{}};const source=fs.readFileSync(new URL('./PaneStripSelectionMenu.tsx',import.meta.url),'utf8');
  vm.runInNewContext(transformSync(source,{loader:'tsx',format:'cjs'}).code,{module,exports:module.exports,crypto:webcrypto,window:h.window,document:{body:{}},
    require:name=>{
      if(name==='react')return h.React;if(name==='react-dom')return {createPortal:element=>element};
      if(name==='lucide-react')return Object.fromEntries(['ChevronRight','Copy','Palette','RotateCw','Square'].map(name=>[name,name]));
      if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:store};
      if(name.endsWith('useUIStore'))return {useUIStore:{getState:()=>({showToast:(...args)=>toasts.push(args)})}};
      if(name.endsWith('codexWriterIdentity'))return {requireCodexSurfaceSessionId:async()=>{throw Error('unexpected codex lookup');}};
      if(name.endsWith('ptyAgentOwner.mjs'))return {resolvePtyAgentOwner};
      if(name.endsWith('generateTabTitle'))return {refreshGeneratedTabTitle:async(id,options)=>{calls.push(['title',id,options]);return {ok:true};}};
      if(name.endsWith('paneStripSelectionModel.mjs'))return selection;if(name.endsWith('paneStripGroupsModel.mjs'))return groups;
      if(name.endsWith('paneStripSelectionActions.mjs'))return actions;if(name.endsWith('contextMenuMetrics.mjs'))return metrics;
      const key=name.split('/').at(-1);if(key==='TabIdActions')return {TabIdActions:mock.TabIdActions};
      if(mock[key])return {__esModule:true,default:mock[key]};throw Error(name);
    }});
  h.window.require=()=>({clipboard:{writeText:text=>calls.push(['copy',text])}});
  const render=()=>h.render(()=>module.exports.default({lease,onClose:()=>calls.push(['close']),runtimePort,colorOnly}));
  return {h,render,lease,state,calls,toasts,mock,invalidate:()=>{current=false;for(const listener of listeners)listener();}};
}
test('actual menu has the requested rows, both bell ports and color hover; no Status/Fork/Resume/auto-stop; multi destructive adapter stays explicit',()=>{
  const f=menuFixture(),tree=f.render(),rows=all(tree).filter(node=>node.type==='button').map(node=>node.props['data-tab-context-action']);
  assert.deepEqual(rows,['beside','remove-from-window','close','stop','group-color','copy-session-id-path','refresh-title']);
  assert.equal(button(tree,'close').props.disabled,true);assert.equal(button(tree,'stop').props.disabled,true);
  assert.ok(all(tree).some(node=>node.type===f.mock.TabNotificationControls));
  assert.ok(all(tree).some(node=>node.type===f.mock.TabIdActions));f.h.dispose();
});
test('actual button handlers use captured cross-namespace targets for window/notification/UUID/title actions; stale lease cannot act',async()=>{
  for(const action of ['beside','remove-from-window','copy-session-id-path','refresh-title']){
    const f=menuFixture(),tree=f.render();button(tree,action).props.onClick(event());await tick();
    if(action==='beside')assert.deepEqual(f.calls[0][1].entries.map(entry=>entry.tabId),['a','b']);
    if(action==='remove-from-window')assert.deepEqual(f.calls.slice(0,2),[['remove','a'],['remove','b']]);
    if(action==='copy-session-id-path')assert.deepEqual(f.calls[0],['copy','SIDa\ncwd: /P\n\nSIDb\ncwd: /Q']);
    if(action==='refresh-title')assert.deepEqual(f.calls.filter(call=>call[0]==='title').map(call=>call[1]),['a','b']);
    const before=f.calls.length;f.invalidate();button(tree,action).props.onClick(event());await tick();
    assert.equal(f.calls.length,before+1);f.h.dispose();
  }
  const f=menuFixture(),controls=all(f.render()).find(node=>node.type===f.mock.TabNotificationControls);
  controls.props.onOnce(true);await tick();assert.deepEqual(f.calls.slice(0,2),[['once','P','a',true],['once','Q','b',true]]);f.h.dispose();
});
test('actual color submenu disables mixed membership; exact selection commits only through the old organization owner',async()=>{
  const f=menuFixture();let tree=f.render();button(tree,'group-color').props.onMouseEnter();tree=f.render();
  const picker=all(tree).find(node=>node.type===f.mock.PaneStripGroupColorPicker);assert.ok(picker);
  assert.equal(f.calls.length,0);picker.props.onCommit('#abcdef');await tick();
  assert.deepEqual(f.calls.slice(0,2),[['color',['a','b'],'#abcdef'],['save']]);
  f.state.spaces[0].stripColorGroups={version:1,revision:1,groups:[{id:'g',revision:1,color:'#123456',tabIds:['a']}]};
  assert.equal(button(f.render(),'group-color').props.disabled,true);f.h.dispose();
});
test('actual new runtime command invokes one injected captured-set adapter, with no renderer foreach/whole-workflow fallback',async()=>{
  const calls=[],f=menuFixture({runtimePort:{run:async(action,lease)=>calls.push([action,lease.entries.map(entry=>entry.tabId)])}});
  const tree=f.render();assert.equal(button(tree,'close').props.disabled,false);
  button(tree,'close').props.onClick(event());await tick();assert.deepEqual(calls,[['close',['a','b']]]);f.h.dispose();
});
test('actual TabBar routes only MULTI selection to the new menu; a single keeps the legacy Full/Stop/Status/Fork flow plus a color-only row',()=>{
  const source=fs.readFileSync(new URL('./TabBar.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('TabBar.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let branch,close;const visit=node=>{
    if(ts.isConditionalExpression(node)&&node.condition.getText(ast).includes('paneSelection.entries.length>1'))branch=node;
    if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='handleContextClose')close=node.initializer.getText(ast);
    ts.forEachChild(node,visit);};visit(ast);assert.ok(branch);assert.ok(close);
  for(const count of [0,1,2]){const ref={current:count?{paneSelection:{entries:new Array(count).fill({})}}:null};
    const value=vm.runInNewContext('Boolean('+branch.condition.getText(ast)+')',{externalContextMenuRef:ref});assert.equal(value,count>1);}
  assert.match(branch.whenFalse.getText(ast),/handleStopAI/);assert.match(branch.whenFalse.getText(ast),/colorOnly/);
  const calls=[],module={exports:{}},context={module,exports:module.exports,projectId:'P',contextMenu:{tabId:'a'},
    workspace:{tabs:new Map([['a',{tabType:'terminal'}]])},closeTab:(...args)=>calls.push(args),setContextMenu:()=>{},isTabTurnBusy:()=>false};
  vm.runInNewContext(transformSync('module.exports=('+close+')',{loader:'tsx',format:'cjs'}).code,context);module.exports();
  assert.equal(calls[0][0],'P');assert.equal(calls[0][1],'a');assert.equal('forceCleanup' in calls[0][2],false);
  const f=menuFixture({colorOnly:true}),rows=all(f.render()).filter(node=>node.type==='button').map(node=>node.props['data-tab-context-action']);
  assert.deepEqual(rows,['group-color']);f.h.dispose();
});
test('actual picker drafts locally until one release; cancel/disabled/unmount cannot publish a late color',()=>{
  const source=fs.readFileSync(new URL('./PaneStripGroupColorPicker.tsx',import.meta.url),'utf8'),code=transformSync(source,{loader:'tsx',format:'cjs'}).code;
  for(const finish of ['release','cancel','disabled','unmount']){
    const h=hooks(),calls=[],module={exports:{}},SquarePicker=()=>null,props={color:'#123456',onCommit:color=>calls.push(color),disabled:false};
    vm.runInNewContext(code,{module,exports:module.exports,window:h.window,require:name=>{
      if(name==='react')return h.React;if(name==='react-colorful')return {HsvColorPicker:SquarePicker};
      if(name.endsWith('paneStripColor.mjs'))return {stripHexToHsv,stripHsvToHex};if(name.endsWith('.css'))return {};throw Error(name);
    }});
    const render=()=>h.render(()=>module.exports.default(props));let tree=render();tree.props.onPointerDownCapture();
    let square=all(tree).find(node=>node.type===SquarePicker);square.props.onChange({h:30,s:50,v:90});tree=render();
    square=all(tree).find(node=>node.type===SquarePicker);square.props.onChange({h:60,s:80,v:70});tree=render();assert.deepEqual(calls,[]);
    const hue=all(tree).find(node=>node.type==='input');assert.equal(hue.props['aria-orientation'],'vertical');
    if(finish==='disabled'){props.disabled=true;render();}
    if(finish==='unmount')h.dispose();
    const type=finish==='cancel'?'pointercancel':'pointerup';for(const listener of [...h.listeners.get(type)||[]])listener(event());
    assert.equal(calls.length,finish==='release'?1:0,finish);h.dispose();
    assert.equal(h.listeners.get('pointerup')?.size||0,0);assert.equal(h.listeners.get('pointercancel')?.size||0,0);
  }
});
test('actual chip Cmd/Shift select without activation/removal; selected right-click carries its exact lease and unselected remains single',()=>{
  const source=fs.readFileSync(new URL('./PaneTabChip.tsx',import.meta.url),'utf8'),code=transformSync(source,{loader:'tsx',format:'cjs'}).code;
  const h=hooks(),calls=[],entries=[{projectId:'P',tabId:'a'},{projectId:'Q',tabId:'b'}],lease={entries,isCurrent:()=>true};
  const controller={selected:()=>true,click:(id,event)=>{calls.push(['select',id,!!event.metaKey,!!event.shiftKey]);return !!(event.metaKey||event.shiftKey);},
    menu:()=>lease,dragEntries:()=>entries};
  const state={activeSpaceId:'W',splitPanes:[{windowId:'win',projectId:'P',tabId:'a',tabs:entries}],
    openProjects:new Map([['P',{tabs:new Map([['a',{name:'A',tabType:'terminal'}]])}]]),
    activateCenterTab:(...args)=>calls.push(['activate',...args]),clearTabFromSplitPane:id=>{calls.push(['remove',id]);return true;},focusSplitPane:()=>calls.push(['focus'])};
  const store=selector=>selector(state);store.getState=()=>state;const module={exports:{}};
  vm.runInNewContext(code,{module,exports:module.exports,window:h.window,require:name=>{
    if(name==='react')return h.React;if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:store};
    if(name.endsWith('splitPanesModel.mjs'))return {paneTabs};if(name==='./TabBar')return {TAB_RENAME_REQUEST_EVENT:'rename',openTabContextMenuAt:(...args)=>calls.push(['menu',...args])};
    if(name==='./TabCard')return {__esModule:true,default:'TabCard'};if(name.endsWith('PaneStripSelection'))return {usePaneStripSelection:()=>controller};
    if(name.endsWith('paneTabDragBridge'))return {paneStripKey:()=> 'pane:0'};
    if(name.endsWith('paneTabPointerGesture'))return {bindPaneTabPointerDrag:()=>()=>{}};
    if(name.endsWith('paneTabDropPresentation.mjs'))return {canonicalPaneDragAddress:()=>({})};
    if(name.endsWith('useInlineRenameInput'))return {useInlineRenameInputRef:()=>({current:null})};
    if(name.endsWith('tabPrimaryInputFocus'))return {requestTabPrimaryInputFocus:(...args)=>calls.push(['input-focus',...args])};
    if(name.endsWith('useUIStore'))return {useUIStore:{getState:()=>({filePreview:null})}};
    if(name.endsWith('taskPlanNavigation')||name.endsWith('tabLinkedFilePreview'))return {};throw Error(name);
  }});
  const props={projectId:'P',tabId:'a',shown:true,paneFocused:false,paneIndex:0,inSplit:true,inStrip:true};
  const render=()=>h.render(()=>module.exports.default(props));let tree=render();
  tree.props.onClick(event({metaKey:true}));render();tree.props.onClick(event({shiftKey:true}));render();
  assert.ok(calls.every(call=>call[0]==='select'));calls.length=0;
  tree=render();tree.props.onClick(event());assert.ok(calls.some(call=>call[0]==='activate'));calls.length=0;
  tree.props.onContextMenu(event({clientX:10,clientY:20}));let options=calls[0].at(-1);assert.equal(options.paneSelection,lease);assert.equal(options.singleTarget,false);
  lease.entries=[entries[0]];calls.length=0;tree=render();tree.props.onContextMenu(event());assert.equal(calls[0].at(-1).singleTarget,true);
  controller.menu=()=>null;calls.length=0;tree=render();tree.props.onContextMenu(event());options=calls[0].at(-1);assert.equal(options.singleTarget,true);assert.equal(options.paneSelection,undefined);
  calls.length=0;tree.props.onAuxClick(event({button:1}));assert.deepEqual(calls,[['remove','a']]);h.dispose();
});
