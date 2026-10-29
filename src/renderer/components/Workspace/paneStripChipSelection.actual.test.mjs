import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import {paneTabs} from '../../utils/splitPanesModel.mjs';
import {CHIP_HOVER_STYLE,CHIP_HOVER_MS} from '../../utils/chipHoverIntent.mjs';
import {createPaneStripBadgeHover,PANE_STRIP_BADGE_HOVER_ANIMATION} from '../../utils/paneStripBadgeHover.mjs';

// Actual PaneTabChip handlers with controlled React/store/navigation ports.
// Pending group lifecycle itself is tested in paneStripInterfaceModes.actual.
const code=transformSync(fs.readFileSync(new URL('./PaneTabChip.tsx',import.meta.url),'utf8'),{loader:'tsx',format:'cjs'}).code;
const event=extra=>({preventDefault(){},stopPropagation(){},button:0,detail:1,...extra});
function fixture(grouped=true,{open=true,instant=false}={}){
  const slots=[],calls=[],captured=[],effects=[],timers=new Map(),diagnostics=[],hoverIds=[];let cursor=0,timerId=0,clock=0,currentAction='other-action';
  const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),
    useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},
    useRef:initial=>{const i=cursor++;return slots[i]??={current:initial};},
    useEffect:callback=>{cursor++;effects.push(callback);}};
  let activationResult=Promise.resolve(true);
  const state={activeSpaceId:'W',splitPanes:[{windowId:'win',projectId:'P',tabId:'a',tabs:[{projectId:'P',tabId:'a'}]}],
    openProjects:new Map([['P',{tabs:new Map([['a',{name:'A',tabType:'terminal'}]])}]]),
    activateCenterTab:(...args)=>calls.push(['legacy-activate',...args]),
    openTabById:(...args)=>{calls.push(['open',...args]);return activationResult;},
    focusSplitPane:(...args)=>calls.push(['focus-pane',...args])};
  const store=selector=>selector(state);store.getState=()=>state;
  const ui={filePreview:null,paneStripInstantHover:instant,paneStripCloseOnClick:false,paneStripSelectedFirst:false,closeFilePreview:()=>calls.push(['close-preview'])};
  const controller={selected:()=>false,click:(id,e)=>!!(e.metaKey||e.shiftKey),menu:()=>null};
  const groupControl=grouped?{groupId:'g',revision:1,count:2,open,busy:false,unread:false,color:'#abcdef',
    toggle(){},hover(id){hoverIds.push(id);calls.push(['hover']);},selected:(...args)=>{captured.push(args);calls.push(['selected',args[0]]);}}:undefined;
  const module={exports:{}};
  vm.runInNewContext(code,{module,exports:module.exports,window:{addEventListener(){},removeEventListener(){},
    setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id)},
    require:name=>{
      if(name==='react')return React;if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:store};
      if(name.endsWith('splitPanesModel.mjs'))return {paneTabs};
      if(name==='./TabBar')return {TAB_RENAME_REQUEST_EVENT:'rename',openTabContextMenuAt(){}};
      if(name==='./TabCard')return {__esModule:true,default:'TabCard'};
      if(name.endsWith('PaneStripSelection'))return {usePaneStripSelection:()=>controller};
      if(name.endsWith('paneTabDragBridge'))return {paneStripKey:()=> 'pane:0'};
      if(name.endsWith('paneTabPointerGesture'))return {bindPaneTabPointerDrag:()=>()=>{}};
      if(name.endsWith('paneTabDropPresentation.mjs'))return {canonicalPaneDragAddress:()=>({})};
      if(name.endsWith('useInlineRenameInput'))return {useInlineRenameInputRef:()=>({current:null})};
      if(name.endsWith('tabPrimaryInputFocus'))return {requestTabPrimaryInputFocus:(...args)=>calls.push(['input-focus',...args])};
      if(name.endsWith('useUIStore'))return {useUIStore:{getState:()=>ui}};
      if(name.endsWith('taskPlanNavigation'))return {requestTaskPlanNavigation:(...args)=>calls.push(['task',...args])};
      if(name.endsWith('tabLinkedFilePreview'))return {openTabLinkedFile(){}};
      if(name.endsWith('chipHoverIntent.mjs'))return {CHIP_HOVER_STYLE};
      if(name.endsWith('paneStripBadgeHover.mjs'))return {createPaneStripBadgeHover:options=>createPaneStripBadgeHover({...options,now:()=>clock})};
      if(name.endsWith('uiPerformanceDiagnostics.mjs'))return {captureUIHoverAction:()=>({id:'own-badge-hover'}),currentUIActionId:()=>currentAction,
        uiPerformancePhaseForAction:(id,name,fields)=>diagnostics.push({id,name,fields})};
      throw Error('Uncontrolled dependency: '+name);
    }});
  const render=()=>{cursor=0;return module.exports.default({projectId:'P',tabId:'a',shown:true,paneFocused:true,paneIndex:0,inSplit:true,inStrip:true,groupControl});};
  return {render,calls,captured,state,ui,timers,diagnostics,hoverIds,setCurrentAction:id=>{currentAction=id;},advance:()=>{clock+=CHIP_HOVER_MS;},setActivation:promise=>{activationResult=promise;}};
}
test('actual grouped plain click passes tabId and deferred activation/focus to the group owner',async()=>{
  const f=fixture();f.render().props.onClick(event());
  assert.deepEqual(f.calls,[['selected','a']]);
  const [id,activate,after]=f.captured[0];assert.equal(id,'a');
  assert.equal(await activate(),true);assert.equal(f.calls.filter(call=>call[0]==='open').length,1);
  assert.equal(f.calls.some(call=>call[0]==='input-focus'),false);after();
  assert.equal(f.calls.filter(call=>call[0]==='input-focus').length,1);
  assert.equal(f.calls.some(call=>call[0]==='legacy-activate'),false);
});
test('actual grouped task-square selection uses the same wrapper before task reveal',async()=>{
  const f=fixture();f.render().props.onTaskClick('task-7',event());assert.deepEqual(f.calls,[['selected','a']]);
  const [,activate,after]=f.captured[0];await activate();assert.equal(f.calls.some(call=>call[0]==='task'),false);
  after();assert.equal(f.calls.find(call=>call[0]==='task')[1].taskId,'task-7');
});
test('actual Cmd/Shift chip selection never invokes group selection or activation',()=>{
  const f=fixture();f.render().props.onClick(event({metaKey:true}));f.render().props.onClick(event({shiftKey:true}));
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.captured,[]);
});
test('actual ordinary noncollapsed chip retains its existing activation path without group order work',()=>{
  const f=fixture(false);f.render().props.onClick(event());
  assert.ok(f.calls.some(call=>call[0]==='legacy-activate'));assert.ok(f.calls.some(call=>call[0]==='input-focus'));
  assert.equal(f.calls.some(call=>call[0]==='open'||call[0]==='selected'),false);
});
test('actual badge uses animationend instead of a ring/timer; leave cancels and only its full scale opens',()=>{
  const attributes=new Map(),f=fixture(true,{open:false}),node={isConnected:true,matches:()=>true,
    setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key)};
  let badge=f.render().props.cornerAdornment;badge.props.onMouseEnter({buttons:0,currentTarget:node});
  const endpoint={target:node,currentTarget:node,animationName:PANE_STRIP_BADGE_HOVER_ANIMATION};
  assert.equal(attributes.get('data-group-badge-opening'),'1');assert.equal(f.timers.size,0);assert.deepEqual(f.calls,[]);
  badge.props.onAnimationEnd(endpoint);assert.deepEqual(f.calls,[]);
  badge.props.onMouseLeave();f.advance();badge.props.onAnimationEnd(endpoint);assert.deepEqual(f.calls,[]);assert.equal(attributes.size,0);
  badge=f.render().props.cornerAdornment;badge.props.onMouseEnter({buttons:0,currentTarget:node});
  f.advance();badge.props.onAnimationEnd(endpoint);assert.deepEqual(f.calls,[['hover']]);assert.equal(attributes.size,0);
  assert.equal(badge.props.children.some(child=>child?.type==='svg'),false);
});
test('actual third toggle bypasses badge progress without changing the other interface modes',()=>{
  const f=fixture(true,{open:false,instant:true}),badge=f.render().props.cornerAdornment;
  badge.props.onMouseEnter({buttons:0,currentTarget:{isConnected:true,matches:()=>true}});
  assert.deepEqual(f.calls,[['hover']]);assert.equal(f.timers.size,0);
  assert.equal(f.ui.paneStripCloseOnClick,false);assert.equal(f.ui.paneStripSelectedFirst,false);
});
test('badge dwell/endpoints retain their original hover action after an unrelated key action',()=>{
  const f=fixture(true,{open:false}),badge=f.render().props.cornerAdornment;
  const node={isConnected:true,matches:()=>true,setAttribute(){},removeAttribute(){}};
  badge.props.onMouseEnter({buttons:0,currentTarget:node});f.setCurrentAction('unrelated-key');f.advance();
  badge.props.onAnimationEnd({target:node,currentTarget:node,animationName:PANE_STRIP_BADGE_HOVER_ANIMATION});
  assert.deepEqual(f.hoverIds,['own-badge-hover']);
  assert.ok(f.diagnostics.some(p=>p.name==='strip-group:dwell-started'));
  assert.ok(f.diagnostics.some(p=>p.name==='strip-group:dwell-completed'));
  assert.ok(f.diagnostics.every(p=>p.id==='own-badge-hover'));
});
