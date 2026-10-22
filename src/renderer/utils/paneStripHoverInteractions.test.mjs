import test from 'node:test';
import assert from 'node:assert/strict';
import {beginNavigationDwell,TAB_DRAG_NAVIGATION_DWELL_MS} from './navigationDwell.mjs';
import {createPaneStripBadgeHover} from './paneStripBadgeHover.mjs';
import {paneStripHoverInside,paneStripHoverMenu} from './paneStripHoverScope.mjs';
import {ownPaneStripGroupMetaHover} from './paneStripGroupMetaHover.mjs';
import {registerPaneStripOutsideSelection} from './paneStripOutsideSelection.mjs';

function windowPort() {
  const listeners=new Map(),timers=new Map();let sequence=0;
  return {listeners,timers,addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},
    removeEventListener(name,fn){listeners.get(name)?.delete(fn);},
    emit(name,event={}){for(const fn of [...listeners.get(name)||[]])fn(event);},
    setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},
    deadline(){const pending=[...timers];timers.clear();for(const [,timer]of pending)timer.fn();}};
}
test('workflow and badge share one finite500ms deadline; cancelled and superseded work cannot fire',()=>{
  const target=windowPort();let calls=0,current=true;
  const start=()=>beginNavigationDwell({schedule:target.setTimeout,cancel:target.clearTimeout,isCurrent:()=>current,onComplete:()=>calls++});
  const cancel=start(),old=[...target.timers.values()][0];assert.equal(old.ms,TAB_DRAG_NAVIGATION_DWELL_MS);assert.equal(old.ms,500);
  cancel();start();old.fn();assert.equal(calls,0);target.deadline();assert.equal(calls,1);
  start();current=false;target.deadline();assert.equal(calls,1);assert.equal(target.timers.size,0);
});
function badgeFixture(instant=false) {
  const target=windowPort(),progress=[],node={isConnected:true,hovered:true,matches(){return this.hovered;}};
  const control={groupId:'g',revision:1,count:3,open:false,busy:false,hover(){calls++;}};let calls=0;
  const hover=createPaneStripBadgeHover({target,getControl:()=>control,isInstant:()=>instant,publish:value=>progress.push(value)});
  return {target,control,node,hover,progress,get calls(){return calls;}};
}
test('ordinary badge hover fills once then opens; quick crossing, stale generation and invisible target cancel it',()=>{
  const f=badgeFixture();f.hover.enter(f.node);assert.deepEqual(f.progress,[true]);assert.equal(f.calls,0);
  const old=[...f.target.timers.values()][0];f.hover.cancel();old.fn();assert.equal(f.calls,0);
  f.hover.enter(f.node);f.target.deadline();assert.equal(f.calls,1);assert.equal(f.progress.at(-1),false);
  for(const cancel of ['revision','availability','hover','connection','blur','Escape','pointerdown']) {
    const f=badgeFixture();f.hover.enter(f.node);
    if(cancel==='revision')f.control.revision++;
    else if(cancel==='availability')f.control.available=false;
    else if(cancel==='hover')f.node.hovered=false;
    else if(cancel==='connection')f.node.isConnected=false;
    else if(cancel==='Escape')f.target.emit('keydown',{key:'Escape'});
    else f.target.emit(cancel);
    f.target.deadline();assert.equal(f.calls,0,cancel);assert.equal(f.progress.at(-1),false,cancel);
    assert.equal([...f.target.listeners.values()].reduce((sum,set)=>sum+set.size,0),0,cancel);
  }
});
test('third instant-hover mode opens immediately with no timer/progress and does not change close/order controls',()=>{
  const f=badgeFixture(true);f.hover.enter(f.node);assert.equal(f.calls,1);assert.equal(f.target.timers.size,0);assert.deepEqual(f.progress,[]);
  f.control.busy=true;f.hover.enter(f.node);assert.equal(f.calls,1);
});
function menu(owner) {
  const node={dataset:{tabMenuOwnerId:owner},closest(){return this;}};
  return {closest(selector){return selector.includes('data-tab-context-menu')?node:null;}};
}
test('only own actual menu is hover; foreign menu cannot borrow the group rectangle; same-row gaps stay inside',()=>{
  const boxes=[{left:10,right:30,top:10,bottom:30},{left:36,right:56,top:10,bottom:30}],root={contains:target=>!!target?.inside};
  assert.equal(paneStripHoverMenu(menu('a'),['a','b']).owned,true);
  assert.equal(paneStripHoverInside({root,target:menu('foreign'),memberIds:['a','b'],boxes,open:true,x:20,y:20}),false);
  assert.equal(paneStripHoverInside({root,target:{},memberIds:['a'],boxes,open:true,x:33,y:20}),true);
  assert.equal(paneStripHoverInside({root,target:{},memberIds:['a'],boxes,open:false,x:33,y:20}),false);
  assert.equal(paneStripHoverInside({root:{contains(){throw TypeError('not a Node');}},target:{},memberIds:['a'],boxes,open:true,x:33,y:20}),true);
});
test('Meta owner survives repeated toggles in its own menu, leaves on foreign menu/blur, and stale release cannot steal a new owner',()=>{
  const target=windowPort(),owner={};let calls=0;
  const inside=event=>paneStripHoverMenu(event.target,['a']).owned;
  const release=ownPaneStripGroupMetaHover(owner,()=>calls++,target,inside);
  for(let i=0;i<8;i++){target.emit('mousemove',{target:menu('a')});target.emit('keydown',{key:'Meta'});target.emit('keyup',{key:'Meta'});}
  assert.equal(calls,8);target.emit('mousemove',{target:menu('foreign')});target.emit('keydown',{key:'Meta'});target.emit('keyup',{key:'Meta'});assert.equal(calls,8);
  const newer=ownPaneStripGroupMetaHover(owner,()=>calls++,target,inside);release();
  ownPaneStripGroupMetaHover(owner,()=>assert.fail('stale release lost the real owner'),target,inside);
  target.emit('keydown',{key:'Meta'});target.emit('keyup',{key:'Meta'});assert.equal(calls,9);
  target.emit('blur');target.emit('keydown',{key:'Meta'});target.emit('keyup',{key:'Meta'});assert.equal(calls,9);newer();
});
test('outside left clears local selections across surfaces, keeps exact captured menus/modifiers/drag, and releases the shared listener',()=>{
  const target=windowPort(),subscribers=new Set();let dragging=false,subscriptions=0,a=0,b=0;
  const register=(owner,clear)=>registerPaneStripOutsideSelection({target,ownerKey:owner,clear,containsChip:chip=>chip.owner===owner,
    isDragging:()=>dragging,subscribeDrag:fn=>{subscriptions++;subscribers.add(fn);return()=>subscribers.delete(fn);}});
  const first=register('one',()=>a++),second=register('two',()=>b++);assert.equal(subscriptions,1);
  const emit=(node={},extra={})=>target.emit('click',{button:0,target:{closest:selector=>selector.includes('selection-owner')?node.menu:node.chip},...extra});
  emit({menu:{dataset:{paneStripSelectionOwner:'one'}}});assert.equal(a,0);assert.equal(b,1);
  emit({chip:{owner:'one'}});assert.equal(a,0);assert.equal(b,2);
  for(const key of ['metaKey','shiftKey','ctrlKey','altKey'])emit({}, {[key]:true});
  emit({}, {button:1});emit({}, {button:2});assert.equal(a,0);
  dragging=true;for(const fn of subscribers)fn();dragging=false;emit();assert.equal(a,0,'release click cannot clear a drag selection');
  target.emit('pointerdown');emit();assert.equal(a,1);assert.equal(b,3);
  first();second();assert.equal(subscribers.size,0);assert.equal([...target.listeners.values()].reduce((sum,set)=>sum+set.size,0),0);
});
