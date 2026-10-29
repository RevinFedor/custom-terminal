// Actual controller, chip, external TabBar opener, menu and execution adapter.
// React hooks, DOM events, store and IPC are finite controlled ports; no mounted UI.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';import {webcrypto} from 'node:crypto';
import {transformSync} from 'esbuild';
import * as selection from '../../utils/paneStripSelectionModel.mjs';
import * as groups from '../../utils/paneStripGroupsModel.mjs';
import * as actions from '../../utils/paneStripSelectionActions.mjs';
import {paneTabs} from '../../utils/splitPanesModel.mjs';
import {createPaneSelectionRuntimePort} from '../../utils/paneSelectionRuntime.mjs';
import * as pairs from '../../utils/paneStripReleasePair.mjs';
import {organizationProjection,reconcileWorkflowOrder} from '../../utils/workflowOrganizationClient.mjs';
import {newerWorkflowGroups} from '../../utils/workflowGroupClient.mjs';
import {captureSpaceLayout,emptySpaceLayout} from '../../utils/workspaceSpacesModel.mjs';
import {preparePaneStripGroupRelease} from '../../../shared/pane-strip-group-admission.cjs';
import {adoptPaneStripColorGroups} from '../../../shared/pane-strip-color-groups.cjs';
import {dragPlacement} from '../../../shared/workflow-drag.cjs';
import {CHIP_HOVER_STYLE} from '../../utils/chipHoverIntent.mjs';
import {createPaneStripBadgeHover} from '../../utils/paneStripBadgeHover.mjs';
import {resolvePtyAgentOwner} from '../../utils/ptyAgentOwner.mjs';
import * as metrics from '../UI/contextMenuMetrics.mjs';
const event=extra=>({preventDefault(){},stopPropagation(){},button:0,detail:1,...extra});
const all=node=>Array.isArray(node)?node.flatMap(all):!node||typeof node!=='object'?[]:[node,...all(node.props?.children)];
const button=(tree,name)=>all(tree).find(node=>node.props?.['data-tab-context-action']===name);
const words=node=>Array.isArray(node)?node.map(words).join(''):node==null||typeof node==='boolean'?''
  :typeof node==='object'?words(node.props?.children):String(node);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const copy=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const between=(source,start,end)=>{
  const at=source.indexOf(start);assert.ok(at>=0);assert.equal(source.indexOf(start,at+start.length),-1,'unique actual-source anchor');
  const stop=source.indexOf(end,at+start.length);assert.ok(stop>at);return source.slice(at+start.length,stop);
};
function hooks(){
  const slots=[],effects=[],listeners=new Map();let cursor=0,changed=false;
  const memo=(fn,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((v,k)=>v!==old.deps[k]))slots[i]={value:fn(),deps};return slots[i].value;};
  const React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:{...props,children}}),
    createContext:value=>({value}),useContext:context=>context.value,
    useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;
      return[slots[i],next=>{const value=typeof next==='function'?next(slots[i]):next;if(value!==slots[i]){slots[i]=value;changed=true;}}];},
    useRef:initial=>{const i=cursor++;return slots[i]??={current:initial};},
    useMemo:memo,useCallback:(fn,deps)=>memo(()=>fn,deps),
    useEffect:(cb,deps)=>{const i=cursor++,old=slots[i];if(!old||deps.some((v,k)=>v!==old.deps[k])){
      slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=cb();});}}};
  const window={innerWidth:1200,innerHeight:900,clearTimeout(){},setTimeout:()=>1,
    addEventListener:(name,fn)=>{const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set);},
    removeEventListener:(name,fn)=>listeners.get(name)?.delete(fn)};
  return {React,window,render:fn=>{let result,count=0;do{assert.ok(count++<10);cursor=0;changed=false;result=fn();
    while(effects.length)effects.shift()();}while(changed);return result;},dispose:()=>slots.forEach(slot=>slot?.cleanup?.())};
}
function moduleFrom(path,h,require){
  const module={exports:{}};
  vm.runInNewContext(transformSync(fs.readFileSync(new URL(path,import.meta.url),'utf8'),
    {loader:'tsx',format:'cjs'}).code,{module,exports:module.exports,crypto:webcrypto,window:h.window,document:{body:{}},require});
  return module.exports;
}
function fixture(){
  const entries=['1','2','3','4','outside'].map((tabId,index)=>({tabId,projectId:index%2?'Q':'P'}));
  const calls=[],toasts=[],listeners=new Set(),h=hooks(),chipHooks=[];
  const state={organizationReady:true,isRestoring:false,organizationRevision:7,activeSpaceId:'W',navigationRevision:3,
    activeProjectId:'P',focusedProjectId:'P',activeSpaceTab:{projectId:'P',tabId:'1'},focusedPaneIndex:0,
    splitPanes:[{windowId:'win',projectId:'P',tabId:'1',tabs:entries}],centerStrips:{},tabTitleNamingIds:new Set(),
    spaces:[{id:'W',stripColorGroups:{version:1,revision:4,extension:{kept:true},
      groups:[{id:'g',revision:2,color:'#123456',tabIds:['1'],extension:{keep:true}}]}}],
    tabWorkflowMembership:Object.fromEntries(entries.map(entry=>[entry.tabId,{tabId:entry.tabId,workflowId:'W',revision:1}])),
    pendingTabWorkflowMembership:{},paneStripReleasedPairs:{version:1,workflows:{},commands:{}},
    tabCatalog:Object.fromEntries(entries.map(entry=>[entry.tabId,{active:true,namespace:entry.projectId}])),
    openProjects:new Map(['P','Q'].map(projectId=>[projectId,{projectPath:'/'+projectId,
      tabs:new Map(entries.filter(entry=>entry.projectId===projectId).map(entry=>[entry.tabId,
        {id:entry.tabId,name:entry.tabId,tabType:'terminal',commandType:'claude',cwd:'/cwd/'+entry.tabId}]))}])),
    activateCenterTab:(...args)=>calls.push(['activate',...args]),focusSplitPane:()=>calls.push(['focus']),
    clearTabFromSplitPane:id=>{calls.push(['remove',id]);return true;},
    commitPaneStripGroupAdd:async(lease,id)=>{calls.push(['add',lease,id]);return {revision:8};},
    commitPaneStripGroupColor:async(lease,color)=>{calls.push(['color',lease,color]);return {revision:8};},
    commitPaneStripGroupPresentation:async(lease,id,options)=>{calls.push(['presentation',lease,id,options]);return {revision:8};},
    refreshOrganizationCatalog:async()=>calls.push(['refresh']),saveSession:()=>calls.push(['save'])};
  const store=selector=>selector(state);store.getState=()=>state;store.subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
  const controllerModule=moduleFrom('./PaneStripSelection.tsx',h,name=>{
    if(name==='react')return h.React;if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:store};
    if(name.endsWith('paneStripSelectionModel.mjs'))return selection;if(name.endsWith('paneStripGroupsModel.mjs'))return groups;
    if(name.endsWith('paneStripOutsideSelection.mjs'))return {registerPaneStripOutsideSelection:()=>()=>{}};
    if(name.endsWith('paneTabDragBridge'))return {getPaneTabDragSnapshot:()=>({active:false}),subscribePaneTabDrag:()=>()=>{}};
    if(name.endsWith('paneTabPointerBridge'))return {getPaneTabPointerSnapshot:()=>({active:false}),subscribePaneTabPointer:()=>()=>{}};
    throw Error('unexpected controller dependency '+name);
  });
  const controller=()=>h.render(()=>controllerModule.usePaneStripSelectionController({
    workflowId:'W',windowId:'win',paneIndex:0,entries,presented:true,rootRef:{current:null}}));
  const chip=tabId=>{
    const ch=hooks();chipHooks.push(ch);const entry=entries.find(entry=>entry.tabId===tabId);
    const code=moduleFrom('./PaneTabChip.tsx',ch,name=>{
      if(name==='react')return ch.React;if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:store};
      if(name.endsWith('splitPanesModel.mjs'))return {paneTabs};
      if(name==='./TabBar')return {TAB_RENAME_REQUEST_EVENT:'rename',openTabContextMenuAt:(...args)=>calls.push(['menu',...args])};
      if(name==='./TabCard')return {__esModule:true,default:'TabCard'};
      if(name.endsWith('PaneStripSelection'))return {usePaneStripSelection:()=>controller()};
      if(name.endsWith('paneTabDragBridge'))return {paneStripKey:()=> 'pane:0'};
      if(name.endsWith('paneTabPointerGesture'))return {bindPaneTabPointerDrag:()=>()=>{}};
      if(name.endsWith('paneTabDropPresentation.mjs'))return {canonicalPaneDragAddress:()=>({})};
      if(name.endsWith('useInlineRenameInput'))return {useInlineRenameInputRef:()=>({current:null})};
      if(name.endsWith('tabPrimaryInputFocus'))return {requestTabPrimaryInputFocus:(...args)=>calls.push(['input-focus',...args])};
      if(name.endsWith('useUIStore'))return {useUIStore:{getState:()=>({filePreview:null})}};
      if(name.endsWith('chipHoverIntent.mjs'))return {CHIP_HOVER_STYLE};
      if(name.endsWith('paneStripBadgeHover.mjs'))return {createPaneStripBadgeHover};
      if(name.endsWith('uiPerformanceDiagnostics.mjs'))return {captureUIHoverAction:()=>null,currentUIActionId:()=>null,uiPerformancePhaseForAction(){}};
      if(name.endsWith('taskPlanNavigation')||name.endsWith('tabLinkedFilePreview'))return {};
      throw Error('unexpected chip dependency '+name);
    });
    return ch.render(()=>code.default({...entry,shown:tabId==='1',paneFocused:true,paneIndex:0,inSplit:true,inStrip:true}));
  };
  const capture=tabId=>{chip(tabId).props.onContextMenu(event({clientX:20,clientY:30}));return calls.at(-1).at(-1);};
  const select=ids=>{controller().click(ids[0],{});controller();
    for(const id of ids.slice(1)){controller().click(id,{metaKey:true});controller();}};
  const menu=(lease,runtimePort)=>{
    const mh=hooks(),mock={SideFlyout:()=>null,TabNotificationControls:()=>null,TabIdActions:()=>null,PaneStripGroupColorPicker:()=>null};
    const code=moduleFrom('./PaneStripSelectionMenu.tsx',mh,name=>{
      if(name==='react')return mh.React;if(name==='react-dom')return {createPortal:element=>element};
      if(name==='lucide-react')return Object.fromEntries(['ChevronRight','Copy','Palette','RotateCw','Square','PanelLeftClose','PanelLeftOpen','Ungroup','LoaderCircle'].map(name=>[name,name]));
      if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:store};
      if(name.endsWith('useUIStore'))return {useUIStore:{getState:()=>({showToast:(...args)=>toasts.push(args)})}};
      if(name.endsWith('codexWriterIdentity'))return {requireCodexSurfaceSessionId:async()=>{throw Error('unexpected provider lookup');}};
      if(name.endsWith('ptyAgentOwner.mjs'))return {resolvePtyAgentOwner};
      if(name.endsWith('generateTabTitle'))return {refreshGeneratedTabTitle:async()=>{throw Error('unexpected title generation');}};
      if(name.endsWith('paneStripSelectionModel.mjs'))return selection;if(name.endsWith('paneStripGroupsModel.mjs'))return groups;
      if(name.endsWith('paneStripSelectionActions.mjs'))return actions;if(name.endsWith('contextMenuMetrics.mjs'))return metrics;
      const key=name.split('/').at(-1);if(key==='TabIdActions')return {TabIdActions:mock.TabIdActions};
      if(mock[key])return {__esModule:true,default:mock[key]};throw Error('unexpected menu dependency '+name);
    });
    return {render:()=>mh.render(()=>code.default({lease,runtimePort,onClose:()=>calls.push(['close'])})),mock,dispose:mh.dispose};
  };
  return {entries,state,calls,toasts,store,controller,chip,capture,select,menu,
    notify:()=>{for(const listener of listeners)listener();},
    dispose:()=>{h.dispose();for(const ch of chipHooks)ch.dispose();}};
}
function outerMenuOpen(f,tabId,options){
  // Execute the actual parent listener, including its pre-menu admission gate.
  const source=fs.readFileSync(new URL('./TabBar.tsx',import.meta.url),'utf8');
  const callback=between(source,'const onOpenRequest = ','    window.addEventListener(TAB_CONTEXT_MENU_EVENT, onOpenRequest);');
  const opened=[],entry=f.entries.find(entry=>entry.tabId===tabId),module={exports:{}};
  vm.runInNewContext(transformSync('module.exports='+callback,{loader:'tsx',format:'cjs'}).code,{module,exports:module.exports,
    projectId:entry.projectId,workspace:f.state.openProjects.get(entry.projectId),menuOnlyForProject:true,sharedProcessStatus:{},
    renameHostRef:{current:null},externalContextMenuRef:{current:null},handleContextMenu:(...args)=>opened.push(args),
    ipcRenderer:{invoke:()=>{throw Error('multi-selection must not probe shell/process state');}}});
  module.exports({detail:{projectId:entry.projectId,tabId,x:20,y:30,...options}});return opened;
}
test('A23 menu actual plain1→Shift4→right-click1/right-click4 gives the same Add3 with singleton g',async()=>{
  for(const rightId of ['1','4']){
    const f=fixture();f.chip('1').props.onClick(event());f.controller();
    f.chip('4').props.onClick(event({shiftKey:true}));f.controller();
    const before=f.calls.filter(call=>call[0]==='activate'||call[0]==='input-focus').length;
    const options=f.capture(rightId),lease=options.paneSelection;
    assert.deepEqual(copy(lease.entries),f.entries.slice(0,4));assert.equal(options.singleTarget,false);
    assert.equal(outerMenuOpen(f,rightId,options).length,1);
    const menu=f.menu(lease),tree=menu.render();
    assert.equal(words(button(tree,'group-add')),'Добавить в группу · 3');
    assert.equal(button(tree,'group-color'),undefined);assert.equal(button(tree,'group-collapse').props.disabled,true);
    assert.equal(f.calls.some(call=>call[0]==='add'),false,'render/hover is not an Add');
    assert.equal(button(tree,'group-add').props.onMouseEnter,undefined);
    button(tree,'group-add').props.onClick();await tick();
    const call=f.calls.find(call=>call[0]==='add');assert.equal(call[2],'g');assert.deepEqual(copy(call[1].entries),f.entries.slice(0,4));
    assert.equal(f.calls.filter(call=>call[0]==='activate'||call[0]==='input-focus').length,before,'Add and right-click never focus');
    assert.equal(f.calls.filter(call=>call[0]==='save').length,1);menu.dispose();f.dispose();
  }
});
test('A23 classifier keeps color-only guard and identifies partial old group without dropping unselected members',()=>{
  const groups=[{id:'g',tabIds:['1','old','closed'],extension:{preserve:true}}],before=copy(groups);
  assert.equal(selection.classifyPaneStripColorSelection(groups,['1','2','3']).kind,'disabled');
  const add=selection.classifyPaneStripGroupAddSelection(groups,['1','3','2']);
  assert.equal(add.kind,'add');assert.equal(add.group,groups[0]);assert.deepEqual(add.tabIds,['3','2']);assert.deepEqual(groups,before);
  assert.equal(selection.classifyPaneStripGroupAddSelection([...groups,{id:'h',tabIds:['3']}],['1','2','3']).kind,'disabled');
  assert.equal(selection.classifyPaneStripGroupAddSelection(groups,['1']).kind,'disabled');
});
test('A23 menu partial old+free is Add1; whole group keeps recolor/Ungroup/collapse; free-only keeps CREATE; two groups never merge',()=>{
  for(const mode of ['partial-free','partial-only','whole','free-only','two-groups']){
    const f=fixture();f.state.spaces[0].stripColorGroups.groups[0].tabIds=['1','2'];
    const ids=mode==='partial-free'?['1','3']:mode==='partial-only'?['1']:mode==='free-only'?['3','4']:mode==='two-groups'?['1','3','4']:['1','2'];
    if(mode==='two-groups')f.state.spaces[0].stripColorGroups.groups.push({id:'h',revision:1,color:'#654321',tabIds:['3']});
    f.select(ids);const menu=f.menu(f.capture(ids[0]).paneSelection),tree=menu.render();
    if(mode==='partial-free'){
      assert.equal(words(button(tree,'group-add')),'Добавить в группу · 1');assert.equal(button(tree,'group-color'),undefined);
      assert.deepEqual(f.state.spaces[0].stripColorGroups.groups[0].tabIds,['1','2']);
    }else{
      assert.equal(button(tree,'group-add'),undefined);
      assert.equal(button(tree,'group-color').props.disabled,mode==='partial-only'||mode==='two-groups');
      assert.equal(!!button(tree,'group-ungroup'),mode==='whole');
      assert.equal(button(tree,'group-collapse').props.disabled,mode!=='whole');
    }
    menu.dispose();f.dispose();
  }
});
test('A23 actual unselected right-click is still single; Cmd toggles; middle-click removes only named chip',()=>{
  const f=fixture();f.select(['1','2','3','4']);const options=f.capture('outside');
  assert.equal(options.singleTarget,true);assert.equal(options.paneSelection,undefined);
  f.chip('4').props.onClick(event({metaKey:true}));f.controller();assert.equal(f.controller().selected('4'),false);
  f.chip('2').props.onAuxClick(event({button:1}));assert.deepEqual(f.calls.filter(call=>call[0]==='remove'),[['remove','2']]);
  assert.equal(f.calls.some(call=>call[0]==='add'||call[0]==='activate'),false);f.dispose();
});
test('A23 Add explicit pending feedback is single-flight and saved only after confirmed revision',async()=>{
  const f=fixture(),gate=deferred();f.select(['1','2','3','4']);f.state.commitPaneStripGroupAdd=(lease,id)=>{f.calls.push(['add',lease,id]);return gate.promise;};
  const menu=f.menu(f.capture('4').paneSelection);let tree=menu.render();const add=button(tree,'group-add');
  add.props.onClick();add.props.onClick();tree=menu.render();
  assert.equal(f.calls.filter(call=>call[0]==='add').length,1);assert.equal(button(tree,'group-add').props['aria-busy'],true);
  assert.equal(button(tree,'group-add').props.disabled,true);assert.equal(button(tree,'close').props.disabled,true);
  assert.ok(all(button(tree,'group-add')).some(node=>node.type==='LoaderCircle'));
  assert.equal(f.calls.some(call=>call[0]==='save'||call[0]==='close'),false);
  gate.resolve({revision:8});await tick();assert.equal(f.calls.filter(call=>call[0]==='save').length,1);
  assert.equal(f.calls.filter(call=>call[0]==='close').length,1);menu.dispose();f.dispose();
});
test('A23 rejected/unconfirmed Add has honest feedback and no session save; stale captured click sends nothing',async()=>{
  for(const failure of ['unconfirmed','foreign-field','stale']){
    const f=fixture();f.select(['1','2']);const menu=f.menu(f.capture('2').paneSelection),tree=menu.render();
    f.state.commitPaneStripGroupAdd=async()=>{f.calls.push(['add']);if(failure==='foreign-field')throw Error('workflow_strip_groups_revision_changed');return {};};
    if(failure==='stale')f.state.navigationRevision++;
    button(tree,'group-add').props.onClick();await tick();
    assert.equal(f.calls.some(call=>call[0]==='save'),false);
    assert.equal(f.calls.filter(call=>call[0]==='add').length,failure==='stale'?0:1);
    if(failure!=='stale'){assert.equal(f.toasts.length,1);assert.equal(button(menu.render(),'group-add').props['aria-busy'],undefined);}
    if(failure==='foreign-field'){assert.equal(f.calls.filter(call=>call[0]==='refresh').length,1);assert.doesNotMatch(f.toasts[0][0],/Выберите цвет/);}
    menu.dispose();f.dispose();
  }
});
test('A23 outer multi menu uses settings lease, original execution lease stays canonical; single keeps legacy guard',()=>{
  const f=fixture();f.select(['1','2']);
  // Controlled predicate discriminator for the actual chip→parent opener;
  // real B5 proof construction/retirement is exercised in helper/SQL controls.
  const canonical=f.controller().menu('1');canonical.isCurrent=()=>false;canonical.isGroupCurrent=()=>true;
  const real=f.controller;f.controller=()=>({...real(),menu:()=>canonical});
  // Source extraction invokes the actual onContextMenu closure with this lease.
  const source=fs.readFileSync(new URL('./PaneTabChip.tsx',import.meta.url),'utf8');
  const expression=between(source,'      onContextMenu={','      onAuxClick=').trim();
  assert.equal(expression.at(-1),'}');const handler=expression.slice(0,-1);
  const open=lease=>{const calls=[],module={exports:{}};vm.runInNewContext(transformSync('module.exports=('+handler+')',{loader:'tsx',format:'cjs'}).code,
    {module,exports:module.exports,stripSelection:{menu:()=>lease},projectId:'P',tabId:'1',renameHostId:'host',openTabContextMenuAt:(...args)=>calls.push(args)});
    module.exports(event());return calls[0].at(-1);};
  let options=open(canonical);assert.equal(options.paneSelection,canonical);assert.equal(options.isCurrent(),true);
  assert.equal(options.paneSelection.isCurrent(),false);assert.equal(outerMenuOpen(f,'1',options).length,1);
  canonical.isGroupCurrent=()=>false;assert.equal(outerMenuOpen(f,'1',open(canonical)).length,0);
  canonical.entries=canonical.entries.slice(0,1);canonical.isGroupCurrent=()=>true;
  options=open(canonical);assert.equal(options.isCurrent(),false);assert.equal(outerMenuOpen(f,'1',options).length,0);f.dispose();
});
test('A23 pending Add menu cannot poison runtime WeakMap; after canonical ACK original exact Full/Stop still work',async()=>{
  for(const action of ['close','stop']){
    const f=fixture();f.select(['1','2']);const lease=f.capture('1').paneSelection,ipc=[],closed=[];
    let canonical=false;lease.isCurrent=()=>canonical;lease.isGroupCurrent=()=>true;
    f.state.tabWorkflowMembership['2']={tabId:'2',workflowId:'S',revision:1};
    const results=lease.entries.map(entry=>({tabId:entry.tabId,namespace:entry.projectId}));let mutationId;
    f.state.closeTab=async(projectId,tabId,options)=>{closed.push([projectId,tabId,options]);return true;};
    const runtime=createPaneSelectionRuntimePort({getState:()=>f.state,makeId:()=> 'runtime-original-'+action,invoke:async(channel,request)=>{
      ipc.push([channel,copy(request)]);mutationId=request.mutationId;
      if(channel==='workflow:selection-begin')return {success:true,mutationId,action,results};
      if(channel==='workflow:selection-step')return action==='close'?{success:true,closeGuard:{mutationId,tabId:request.tabId,guardToken:'guard'}}
        :{success:true,completed:true,mutationId,tabId:request.tabId};
      if(channel==='workflow:selection-ack')return {success:true,completed:true,mutationId,tabId:request.tabId};
      if(channel==='workflow:selection-receipt')return {success:true,completed:true,mutationId,action,results};
      throw Error(channel);
    }});
    const menu=f.menu(lease,runtime);let tree=menu.render();
    assert.equal(button(tree,'group-add').props.disabled,false);assert.equal(button(tree,action).props.disabled,true);
    button(tree,action).props.onClick();await tick();assert.deepEqual(ipc,[]);
    canonical=true;f.state.tabWorkflowMembership['2']={tabId:'2',workflowId:'W',revision:2};
    tree=menu.render();assert.equal(button(tree,action).props.disabled,false);
    button(tree,action).props.onClick();await tick();
    assert.equal(ipc.filter(([channel])=>channel==='workflow:selection-begin').length,1);
    assert.deepEqual(ipc[0][1].members,copy(lease.entries));assert.equal(f.toasts.length,0);
    assert.equal(closed.length,action==='close'?2:0);menu.dispose();f.dispose();
  }
});
test('A23 actual free-null B5 pair reaches outer menu, then canonical Store publication retires it without losing captured Add selection',async()=>{
  const f=fixture(),state=f.state,owner={windowId:'win',paneIndex:0,centerKey:null},moved=f.entries[1];
  state.tabWorkflowMembership['2']={tabId:'2',workflowId:'S',revision:1};
  const before=captureSpaceLayout(state);before.splitPanes=copy(before.splitPanes);
  before.splitPanes[0].tabs=before.splitPanes[0].tabs.filter(slot=>slot.tabId!=='2');
  const after=copy(captureSpaceLayout(state)),source={...emptySpaceLayout(),
    splitPanes:[{windowId:'source',projectId:'Q',tabId:'2',tabs:[moved]}]};
  const sourceAfter={...copy(source),splitPanes:[{windowId:'source',projectId:'Q',tabId:'',tabs:[]}]};
  state.splitPanes=copy(before.splitPanes);state.spaces[0].layout=copy(before);state.spaces.push({id:'S',layout:source});
  const prepared=preparePaneStripGroupRelease({workflowId:'W',field:state.spaces[0].stripColorGroups,
    beforeLayout:before,layout:after,rootTabIds:['2'],placementTabIds:['2'],targetOwner:owner,isActive:()=>true});
  assert.deepEqual(prepared.intent.plan.assignments,[{tabId:'2',groupId:null}]);
  const request={version:1,mutationId:'b5-menu-free',targetWorkflowId:'W',
    tabs:[{tabId:'2',workflowId:'W',expected:{workflowId:'S',membershipRevision:1}}],
    workflows:[{workflowId:'W',beforeLayout:before,expectedPlacement:dragPlacement(before),layout:after},
      {workflowId:'S',beforeLayout:source,expectedPlacement:dragPlacement(source),layout:sourceAfter}],
    stripGroupReleases:[prepared.intent]};
  Object.assign(state,pairs.publishPaneStripDragRelease(state,request));
  f.select(['1','2']);const options=f.capture('2'),lease=options.paneSelection;
  assert.equal(lease.isCurrent(),false);assert.equal(lease.isGroupCurrent(),true);
  assert.equal(outerMenuOpen(f,'2',options).length,1);assert.equal(state.pendingTabWorkflowMembership['2'].localReleaseMutationId,'b5-menu-free');
  const menu=f.menu(lease,{run:async()=>{throw Error('no execution in this settings control');}});
  let tree=menu.render();assert.equal(button(tree,'group-add').props.disabled,false);
  assert.equal(button(tree,'stop').props.disabled,true);
  const snapshot={publication:{version:1,migrationVersion:1,revision:8,generation:8,metadata:{workflowOrder:['W','S']}},
    workflows:state.spaces.map(space=>({id:space.id,kind:'user',revision:8,metadata:{stripColorGroups:space.stripColorGroups},layout:space.layout})),
    tabs:f.entries.map(entry=>({tabId:entry.tabId,subjectVersion:1,executionSubject:{projectId:entry.projectId},
      legacyRow:{id:'row-'+entry.tabId},membership:{tabId:entry.tabId,workflowId:'W',revision:entry.tabId==='2'?2:1}}))};
  const full=fs.readFileSync(new URL('../../store/useWorkspaceStore.ts',import.meta.url),'utf8');
  const callback=between(full,'  applyPublication:','\n  onError:').trim().replace(/,$/,'');
  const module={exports:{}};f.store.setState=patch=>{Object.assign(state,patch);f.notify();};
  vm.runInNewContext(transformSync('module.exports=('+callback+');',{loader:'ts',format:'cjs'}).code,{module,exports:module.exports,
    useWorkspaceStore:f.store,ipcRenderer:{invoke:async channel=>{assert.equal(channel,'workflow:read');return snapshot;}},
    organizationProjection,reconcileWorkflowOrder,newerWorkflowGroups,adoptPaneStripColorGroups,
    applyPaneStripGatherPublication:groups.applyPaneStripGatherPublication,applyPaneStripReleasePublication:pairs.applyPaneStripReleasePublication,
    uiDiagnosticAbsNow:()=>0,uiDragActionId:id=>id,uiDragDiagnostic(){}});
  await module.exports({revision:8},request);
  f.controller();tree=menu.render();
  assert.equal(state.pendingTabWorkflowMembership['2'],undefined);
  assert.equal(state.paneStripReleasedPairs.workflows.W,undefined);assert.equal(state.paneStripReleasedPairs.commands['b5-menu-free'],undefined);
  assert.equal(lease.isGroupCurrent(),true);assert.equal(lease.isCurrent(),true);
  assert.equal(button(tree,'group-add').props.disabled,false);assert.equal(button(tree,'stop').props.disabled,false);
  assert.equal(f.calls.some(call=>call[0]==='close'),false);
  button(tree,'group-add').props.onClick();await tick();assert.equal(f.calls.filter(call=>call[0]==='add').length,1);
  menu.dispose();f.dispose();
});
