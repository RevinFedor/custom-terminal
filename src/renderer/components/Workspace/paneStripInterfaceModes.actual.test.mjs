import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {transformSync} from 'esbuild';
import {createOrganizationCommitter,organizationSnapshot} from '../../utils/workflowOrganizationClient.mjs';
import {commitPaneStripGroupPresentation} from '../../utils/paneStripGroupPresentationCommit.mjs';
import {emptySpaceLayout} from '../../utils/workspaceSpacesModel.mjs';
import {applyPaneStripGatherPublication,readPaneStripActiveGroups} from '../../utils/paneStripGroupsModel.mjs';
import {adoptPaneStripColorGroups} from '../../../shared/pane-strip-color-groups.cjs';
import {ownPaneStripGroupMetaHover} from '../../utils/paneStripGroupMetaHover.mjs';

// Actual TSX, existing presentation committer/serial lane and publication helpers.
// React, DOM, navigation/runtime admission, IPC and SQL are finite controls.
// These controls do not claim mounted DOM/pixels/DnD/native/SQL acceptance.
const componentURL=new URL('./PaneStripCollapsedGroup.tsx',import.meta.url);
const source=fs.readFileSync(componentURL,'utf8');
const dependencies=new Map();
for(const match of source.matchAll(/\bfrom\s+['"]([^'"]+\.(?:mjs|cjs))['"]/g)) {
  const name=match[1];dependencies.set(name,await import(new URL(name,componentURL)));
}
const code=transformSync(source,{loader:'tsx',format:'cjs'}).code;
const all=node=>Array.isArray(node)?node.flatMap(all):!node||typeof node!=='object'?[]:[node,...all(node.props?.children)];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const test=(name,run)=>nodeTest(name,{timeout:3000},run);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

function fixture({selectedFirst=false,clickOnly=false,anchor=200,viewport=900,ids=['1','2','3','4'],shown='2',widths={}}={}) {
  const slots=[],layoutEffects=[],effects=[],listeners=new Map(),subscribers=new Set(),nodes=new Map(),calls=[],focus=[],diagnostics=[];
  const prefs={paneStripSelectedFirst:selectedFirst,paneStripCloseOnClick:clickOnly,showToast:(...args)=>calls.push({toast:args})};
  let cursor=0,dirty=false,tree,disposed=false,sequence=0,dbRevision=1,hold=null,lost=false;
  const state={...emptySpaceLayout(),view:'workspace',activeSpaceId:'W',activeProjectId:'P',navigationRevision:1,
    activeTabNavigationIntent:null,navigationMutationOwner:null,organizationReady:true,organizationRevision:1,organizationGeneration:1,
    isRestoring:false,pendingTabWorkflowMembership:{},tabCatalog:Object.fromEntries(ids.map(id=>[id,{active:true,namespace:'P'}])),
    tabWorkflowMembership:Object.fromEntries(ids.map(id=>[id,{workflowId:'W',revision:1}])),
    splitPanes:[{windowId:'win',projectId:'P',tabId:shown,tabs:ids.map(tabId=>({projectId:'P',tabId}))}],
    spaces:[{id:'W',kind:'user',stripColorGroups:{version:1,revision:1,groups:[{id:'g',revision:1,color:'#abcdef',tabIds:ids,collapsed:true}]}}],
    openProjects:new Map([['P',{projectId:'P',tabs:new Map(ids.map(id=>[id,{id,name:id}]))}]])};
  let publishedSpaces=structuredClone(organizationSnapshot(state).spaces);
  const receipts=new Map();
  const publish=patch=>{Object.assign(state,patch);for(const listener of [...subscribers])listener(state);};
  const committer=createOrganizationCommitter({getPublication:()=>({revision:state.organizationRevision}),
    invoke:async(channel,payload)=>{
      if(channel==='workflow:mutation')return lost?null:receipts.get(payload)||null;
      assert.equal(channel,'workflow:mutate');const request=payload.request;calls.push({request});
      // This controlled Main receipt preserves the real lane's same-ID rule.
      if(receipts.has(request.mutationId)){if(lost)throw Error('controlled_transport_lost');return receipts.get(request.mutationId);}
      const result={success:true,revision:++dbRevision,generation:1,mutationId:request.mutationId};
      publishedSpaces=structuredClone(request.spaces);receipts.set(request.mutationId,result);
      if(hold&&request.stripColorGroupEdits?.some(edit=>edit.arrange)){
        const gate=hold;hold=null;gate.admitted.resolve(request);await gate.release.promise;
      }
      if(lost)throw Error('controlled_transport_lost');return result;
    },
    applyPublication:async(result,request)=>{
      const patch=applyPaneStripGatherPublication(state,adoptPaneStripColorGroups(state.spaces,publishedSpaces),publishedSpaces,request);
      publish({...patch,organizationRevision:result.revision});
    },onError:error=>calls.push({error:error.code||error.message})});
  state.commitOrganization=()=>committer.commit(()=>organizationSnapshot(state));
  state.settlePaneStripGroupPresentation=()=>committer.settle();
  state.commitPaneStripGroupPresentation=(lease,id,options)=>commitPaneStripGroupPresentation({getState:()=>state,committer,lease,groupId:id,...options});
  const store=selector=>selector(state);store.getState=()=>state;store.subscribe=fn=>{subscribers.add(fn);return()=>subscribers.delete(fn);};
  store.setState=patch=>publish(typeof patch==='function'?patch(state):patch);
  const uiStore=selector=>selector(prefs);uiStore.getState=()=>prefs;
  const effect=(queue,callback,deps)=>{const index=cursor++,old=slots[index];
    if(!old||!deps||deps.length!==old.deps?.length||deps.some((value,i)=>value!==old.deps[i])){
      slots[index]={deps,cleanup:old?.cleanup};queue.push(()=>{slots[index].cleanup?.();slots[index].cleanup=callback();});}};
  const memo=(callback,deps)=>{const index=cursor++,old=slots[index];
    if(!old||deps.some((value,i)=>value!==old.deps[i]))slots[index]={deps,value:callback()};return slots[index].value;};
  const React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:{...props,children}}),
    useState:initial=>{const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;
      return [slots[index],next=>{const value=typeof next==='function'?next(slots[index]):next;if(value!==slots[index]){slots[index]=value;dirty=true;}}];},
    useRef:initial=>{const index=cursor++;return slots[index]??={current:initial};},
    useMemo:memo,useCallback:(callback,deps)=>memo(()=>callback,deps),
    useLayoutEffect:(callback,deps)=>effect(layoutEffects,callback,deps),useEffect:(callback,deps)=>effect(effects,callback,deps)};
  class Element{closest(){return null;}}
  const win={addEventListener:(name,fn)=>{const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set);},
    removeEventListener:(name,fn)=>listeners.get(name)?.delete(fn),
    dispatchEvent:event=>{for(const listener of [...listeners.get(event.type)||[]])listener(event);}};
  const dom=new Element();Object.assign(dom,{isConnected:true,contains:target=>!!target?.inside,querySelector:()=>null});
  dom.querySelectorAll=()=>all(tree).filter(node=>node.props?.['data-strip-item']!==undefined).map(node=>{
    const id=node.props['data-strip-tab-id'];let item=nodes.get(id);if(!item){item={dataset:{stripTabId:id}};nodes.set(id,item);}
    item.getBoundingClientRect=()=>{
      const translate=Number(/translateX\(([-\d.]+)px\)/.exec(node.props.style.transform||'')?.[1]||0);
      const left=anchor+(node.props.style.left||0)+translate,width=widths[id]||80;
      return {left,right:left+width,top:30,bottom:56,width,height:26};};return item;
  });
  const module={exports:{}};
  vm.runInNewContext(code,{module,exports:module.exports,window:win,Element,HTMLElement:Element,console,crypto:webcrypto,queueMicrotask,
    document:{documentElement:{clientWidth:viewport},body:new Element()},
    CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail;}},
    require:name=>{
      if(name==='react')return React;if(name.endsWith('useWorkspaceStore'))return {useWorkspaceStore:store};
      if(name.endsWith('useUIStore'))return {useUIStore:uiStore};
      if(name.endsWith('paneStripGroupMetaHover.mjs'))return {ownPaneStripGroupMetaHover:(owner,toggle,_target,inside)=>ownPaneStripGroupMetaHover(owner,toggle,win,inside)};
      if(name.endsWith('uiPerformanceDiagnostics.mjs'))return {currentUIActionId:()=> 'controlled-action',uiDiagnosticAbsNow:()=>performance.now(),
        uiPerformancePhaseForAction:(id,name,fields)=>diagnostics.push({id,name,fields})};
      if(dependencies.has(name))return dependencies.get(name);
      if(name.endsWith('PaneStripGroupOutline'))return {__esModule:true,default:'Outline'};
      if(name.endsWith('.css'))return {};throw Error('Uncontrolled dependency: '+name);
    }});
  const props={group:state.spaces[0].stripColorGroups.groups[0],entries:state.splitPanes[0].tabs,representative:shown,
    workflowId:'W',windowId:'win',paneIndex:0,rowGap:7,presented:true,dragging:false,sourceHere:false,layoutKey:'stable',
    onPresentation(){},renderChip:(entry,control)=>React.createElement('Card',{id:entry.tabId,control})};
  const sync=()=>{
    props.group=readPaneStripActiveGroups(state,'W').find(group=>group.id==='g')||props.group;
    props.entries=state.splitPanes[0].tabs.filter(entry=>props.group.tabIds.includes(entry.tabId));
    props.representative=state.splitPanes[0].tabId;
  };
  const render=()=>{let count=0;do{
    assert.ok(count++<30,'finite React control settles');cursor=0;dirty=false;tree=module.exports.default(props);
    tree.props.ref.current=dom;dom.querySelectorAll();while(layoutEffects.length)layoutEffects.shift()();while(effects.length)effects.shift()();
  }while(dirty);return tree;};
  const emit=(type,values={})=>{const event={type,target:new Element(),defaultPrevented:false,
    preventDefault(){this.defaultPrevented=true;},stopPropagation(){},stopImmediatePropagation(){},...values};
    win.dispatchEvent(event);return event;};
  const control=(id=props.representative)=>all(tree).find(node=>node.type==='Card'&&node.props.id===id)?.props.control;
  const open=kind=>{render();if(kind==='badge')control().toggle();else if(kind==='hover')control().hover();else{
    tree.props.onMouseEnter({buttons:0});emit('keydown',{key:'Meta'});emit('keyup',{key:'Meta'});}return render();};
  const activate=(id,gate=null)=>()=>{
    const intent={id:'navigation-'+(++sequence),tabId:id};publish({activeTabNavigationIntent:intent});
    const finish=()=>{if(state.activeTabNavigationIntent!==intent)return false;
      publish({splitPanes:[{...state.splitPanes[0],tabId:id}],navigationRevision:state.navigationRevision+1,navigationMutationOwner:intent.id});return true;};
    return gate?gate.promise.then(value=>value===false?false:finish()):Promise.resolve(finish());
  };
  const select=(id,{gate=null}={})=>{render();control(id).selected(id,activate(id,gate),()=>focus.push(id));return render();};
  const settle=async()=>{await tick();sync();render();await tick();sync();return render();};
  return {state,props,prefs,calls,focus,nodes,diagnostics,publish,render,sync,emit,open,select,settle,control,
    get tree(){return tree;},get requests(){return calls.filter(call=>call.request).map(call=>call.request);},
    get arrangements(){return this.requests.flatMap(request=>request.stripColorGroupEdits||[]).filter(edit=>edit.arrange);},
    order:()=>state.splitPanes[0].tabs.map(entry=>entry.tabId),
    holdArrangement:()=>{hold={admitted:deferred(),release:deferred()};return hold;},
    loseTransport:value=>{lost=value;},flush:()=>committer.flush(),
    dispose:()=>{if(disposed)return;disposed=true;dom.isConnected=false;slots.forEach(slot=>slot?.cleanup?.());}};
}

for(const clickOnly of [false,true])for(const kind of ['hover','cmd','badge'])test(`actual close matrix: ${clickOnly?'ON':'OFF'} ${kind} and member selection`,async()=>{
  const f=fixture({clickOnly});try{
    f.open(kind);await f.settle();assert.equal(f.tree.props['data-group-open'],'1');
    f.select('3');await f.settle();assert.equal(f.tree.props['data-group-open'],'1','member selection is not a close event');
    f.emit('mousemove',{clientX:9999,clientY:9999});f.render();
    const sticky=clickOnly||kind==='badge';assert.equal(f.tree.props['data-group-open'],sticky?'1':undefined);
    if(sticky){f.emit('pointerdown',{button:0});f.render();assert.equal(f.tree.props['data-group-open'],undefined);}
  }finally{f.dispose();}
});

test('actual sticky views ignore repeated Cmd, badge, and hover entries until outside click or Escape',async()=>{
  for(const [clickOnly,kind] of [[false,'badge'],[true,'hover'],[true,'cmd'],[true,'badge']]){
    const f=fixture({clickOnly});try{
      f.open(kind);await f.settle();f.tree.props.onMouseEnter({buttons:0});
      for(const repeat of ['cmd','badge','hover','cmd','badge']){
        if(repeat==='cmd'){f.emit('keydown',{key:'Meta'});f.emit('keyup',{key:'Meta'});}
        else if(repeat==='badge')f.control().toggle();
        else f.control().hover();
        f.render();await f.settle();assert.equal(f.tree.props['data-group-open'],'1',`${clickOnly}/${kind}/${repeat}`);
      }
      f.emit('pointerdown',{button:0});f.render();assert.equal(f.tree.props['data-group-open'],undefined);
      f.open(kind);await f.settle();assert.equal(f.tree.props['data-group-open'],'1');
      f.emit('keydown',{key:'Escape'});f.render();assert.equal(f.tree.props['data-group-open'],undefined);
    }finally{f.dispose();}
  }
});

test('actual OFF temporary Cmd still toggles for eight taps without another mouse movement',async()=>{
  const f=fixture();try{
    f.render();f.tree.props.onMouseEnter({buttons:0});
    for(let tap=1;tap<=8;tap++){
      f.emit('keydown',{key:'Meta'});f.emit('keyup',{key:'Meta'});f.render();await f.settle();
      assert.equal(f.tree.props['data-group-open'],tap%2?'1':undefined,`tap ${tap}`);
    }
  }finally{f.dispose();}
});

test('actual badge during pending hover and ON preference promote sticky; OFF never demotes that view',async()=>{
  const f=fixture({selectedFirst:true}),g=fixture();try{
    const hold=f.holdArrangement();f.open('hover');await hold.admitted.promise;
    f.open('badge');hold.release.resolve();await f.settle();
    f.emit('mousemove',{clientX:9999,clientY:9999});f.render();assert.equal(f.tree.props['data-group-open'],'1');
    f.emit('pointerdown',{button:0});f.render();assert.equal(f.tree.props['data-group-open'],undefined);
    g.open('hover');await g.settle();g.prefs.paneStripCloseOnClick=true;g.render();
    g.prefs.paneStripCloseOnClick=false;g.render();g.emit('mousemove',{clientX:9999,clientY:9999});g.render();
    assert.equal(g.tree.props['data-group-open'],'1');
    g.emit('pointerdown',{button:0});g.render();assert.equal(g.tree.props['data-group-open'],undefined);
  }finally{f.dispose();g.dispose();}
});

test('actual selected-first uses admitted existing owner and stable remaining order; selection never creates a second current card',async()=>{
  const f=fixture({selectedFirst:true});try{
    f.render();const original=f.nodes.get('2');f.open('badge');await f.settle();
    f.select('2');await f.settle();assert.deepEqual(f.order(),['2','1','3','4']);
    f.select('4');await f.settle();assert.deepEqual(f.order(),['4','2','1','3']);
    assert.equal(f.nodes.get('2'),original);assert.equal(all(f.tree).filter(node=>node.type==='Card'&&node.props.id==='2').length,1);
    assert.equal(all(f.tree).filter(node=>node.props?.['data-strip-item']!==undefined&&node.props.style.position==='relative').length,1);
    assert.equal(f.state.spaces[0].stripColorGroups.revision,1);assert.equal(f.state.spaces[0].stripColorGroups.groups[0].revision,1);
  }finally{f.dispose();}
});

test('actual default remains minimal OPEN-fit and does not reorder on member click',async()=>{
  const f=fixture({anchor:200,viewport:900}),edge=fixture({anchor:760,viewport:900});try{
    f.open('badge');await f.settle();assert.deepEqual(f.order(),['1','2','3','4']);assert.equal(f.arrangements.length,0);
    f.select('4');await f.settle();assert.deepEqual(f.order(),['1','2','3','4']);assert.equal(f.arrangements.length,0);
    edge.open('badge');await edge.settle();assert.deepEqual(edge.order(),['1','3','4','2']);
  }finally{f.dispose();edge.dispose();}
});

test('actual delayed activation cannot arrange/focus after a newer navigation or closed member',async()=>{
  for(const revoke of ['navigation','closed','recolor','unjoin']){
    const f=fixture({selectedFirst:true});try{
      f.open('badge');await f.settle();const before=f.arrangements.length,gate=deferred();f.select('3',{gate});
      assert.equal(f.arrangements.length,before,'activation must ACK before arranging');
      if(revoke==='navigation')f.publish({activeTabNavigationIntent:{id:'newer',tabId:'1'},navigationRevision:f.state.navigationRevision+1,navigationMutationOwner:null});
      if(revoke==='closed'){f.state.openProjects.get('P').tabs.delete('3');f.publish({tabCatalog:{...f.state.tabCatalog,'3':{active:false}}});}
      if(revoke==='recolor'){const raw=f.state.spaces[0].stripColorGroups;f.publish({spaces:[{...f.state.spaces[0],stripColorGroups:{...raw,revision:2,groups:raw.groups.map(g=>({...g,revision:2,color:'#112233'}))}}]});}
      if(revoke==='unjoin'){const raw=f.state.spaces[0].stripColorGroups;f.publish({spaces:[{...f.state.spaces[0],stripColorGroups:{...raw,revision:2,groups:raw.groups.map(g=>({...g,revision:2,tabIds:g.tabIds.filter(id=>id!=='3')}))}}]});}
      gate.resolve(true);await f.settle();assert.equal(f.arrangements.length,before,revoke);assert.deepEqual(f.focus,[],revoke);
    }finally{f.dispose();}
  }
});

test('actual newer selected member replaces pending pre-admission intent without replaying the older selection',async()=>{
  const f=fixture({selectedFirst:true});try{
    f.open('badge');await f.settle();const gate=deferred();f.select('3',{gate});f.select('4');await f.settle();
    gate.resolve(true);await f.settle();assert.deepEqual(f.order(),['4','2','1','3']);assert.deepEqual(f.focus,['4']);
    assert.equal(f.tree.props['data-group-open'],'1','superseding a pending member preserves the sticky view');
  }finally{f.dispose();}
});

test('actual collapsed selection without OPEN revokes pending activation on Escape, blur, and other-group ownership',async()=>{
  for(const event of ['escape','blur','ownership']){
    const f=fixture({selectedFirst:true});try{
      const gate=deferred();f.select('2',{gate});
      assert.equal(f.tree.props['data-group-open'],undefined);
      if(event==='escape')f.emit('keydown',{key:'Escape'});
      if(event==='blur')f.emit('blur');
      if(event==='ownership')f.emit('pane-strip-group:open',{detail:{owner:{}}});
      f.render();gate.resolve(true);await f.settle();
      assert.deepEqual(f.focus,[],event);assert.equal(f.arrangements.length,0,event);
      assert.deepEqual(f.order(),['1','2','3','4'],event);
    }finally{f.dispose();}
  }
});

test('actual pending collapsed navigation without OPEN is not cancelled by pointer departure or swallowed by outside click',async()=>{
  for(const event of ['move','outside']){
    const f=fixture({selectedFirst:true,clickOnly:event==='outside'});try{
      const gate=deferred();f.select('2',{gate});
      const signal=event==='move'?f.emit('mousemove',{clientX:9999,clientY:9999}):f.emit('pointerdown',{button:0});
      f.render();assert.equal(signal.defaultPrevented,false,event);
      gate.resolve(true);await f.settle();assert.deepEqual(f.focus,['2'],event);
      assert.deepEqual(f.order(),['2','1','3','4'],event);assert.equal(f.tree.props['data-group-open'],undefined);
    }finally{f.dispose();}
  }
});

test('actual stale-group fallback preserves navigation but grants no late focus after close safety',async()=>{
  for(const event of ['none','escape','blur','ownership']){
    const f=fixture({selectedFirst:true});try{
      f.render();const raw=f.state.spaces[0].stripColorGroups;
      // Retained React props can describe an old group while the existing
      // owner already contains the recolor. This must keep ordinary activation.
      f.publish({spaces:[{...f.state.spaces[0],stripColorGroups:{...raw,revision:2,
        groups:raw.groups.map(group=>({...group,revision:2,color:'#112233'}))}}]});
      const gate=deferred();f.select('2',{gate});
      if(event==='escape')f.emit('keydown',{key:'Escape'});
      if(event==='blur')f.emit('blur');
      if(event==='ownership')f.emit('pane-strip-group:open',{detail:{owner:{}}});
      f.render();gate.resolve(true);await f.settle();
      assert.deepEqual(f.focus,event==='none'?['2']:[],event);
      assert.equal(f.arrangements.length,0,'stale group never becomes a durable arrange proof');
    }finally{f.dispose();}
  }
});

test('actual delayed activation rejection is observed even when arrange admission already refused',async()=>{
  for(const admission of ['not-ready','stale-group']){
    const f=fixture({selectedFirst:true});try{
      f.render();
      if(admission==='not-ready')f.state.organizationReady=false;
      else {const raw=f.state.spaces[0].stripColorGroups;
        f.publish({spaces:[{...f.state.spaces[0],stripColorGroups:{...raw,revision:2,
          groups:raw.groups.map(group=>({...group,revision:2,color:'#112233'}))}}]});}
      const gate=deferred();f.select('2',{gate});await tick();
      gate.reject(Error('controlled_activation_rejected'));await f.settle();
      assert.deepEqual(f.focus,[],admission);assert.equal(f.arrangements.length,0,admission);
    }finally{f.dispose();}
  }
});

test('actual admitted order survives Escape without late reveal or second focus; reopen owns its own view',async()=>{
  const f=fixture({selectedFirst:true});try{
    f.open('badge');await f.settle();const hold=f.holdArrangement();f.select('3');await hold.admitted.promise;
    f.emit('keydown',{key:'Escape'});f.render();assert.equal(f.tree.props['data-group-open'],undefined);
    const focusBefore=f.focus.length;hold.release.resolve();await f.settle();
    assert.deepEqual(f.order(),['3','2','1','4']);assert.equal(f.tree.props['data-group-open'],undefined);assert.equal(f.focus.length,focusBefore);
    f.open('badge');await f.settle();assert.equal(f.tree.props['data-group-open'],'1');
  }finally{f.dispose();}
});

test('actual selected-first preserves representative physical X/Y and durable logical order in both directions',async()=>{
  for(const options of [
    {anchor:100,viewport:900,ids:['1','2','3','4'],shown:'2'},
    {anchor:760,viewport:900,ids:['1','2','3','4'],shown:'2',widths:{'1':70,'2':130,'3':190,'4':95}},
    {anchor:200,viewport:300,ids:['1','2','3'],shown:'1'},
  ]){
    const f=fixture({selectedFirst:true,...options});try{
      f.render();const representative=f.nodes.get(options.shown),before=representative.getBoundingClientRect();
      f.open('badge');await f.settle();const order=[options.shown,...options.ids.filter(id=>id!==options.shown)];
      assert.deepEqual(f.order(),order);assert.equal(f.nodes.get(options.shown),representative);
      const after=representative.getBoundingClientRect();assert.equal(after.left,before.left);assert.equal(after.top,before.top);
      const chips=order.map(id=>f.nodes.get(id).getBoundingClientRect()),direction=f.tree.props['data-group-direction'];
      assert.ok(chips.every((chip,index)=>!index||(direction==='left'?chip.right<chips[index-1].left:chip.left>chips[index-1].right)));
      assert.equal(all(f.tree).filter(node=>node.props?.['data-strip-item']!==undefined&&node.props.style.position==='relative').length,1);
    }finally{f.dispose();}
  }
});

test('actual same-ID width change flips direction with fixed representative and a layout receipt, without another persistence write',async()=>{
  const widths={'1':80,'2':80,'3':80},f=fixture({selectedFirst:true,anchor:600,viewport:1000,ids:['1','2','3'],shown:'1',widths});
  let receipts=0;f.props.onPresentation=()=>{receipts++;};
  try{
    f.open('badge');await f.settle();assert.equal(f.tree.props['data-group-direction'],'right');
    const before=f.nodes.get('1').getBoundingClientRect(),writes=f.requests.length,priorReceipts=receipts;
    widths['2']=190;widths['3']=190;
    const outline=all(f.tree).find(node=>node.type==='Outline');assert.ok(outline?.props.onMeasured);
    outline.props.onMeasured(['1','2','3'].map(id=>({id,left:0,right:widths[id]})));f.render();
    assert.equal(f.tree.props['data-group-direction'],'left');assert.deepEqual(f.order(),['1','2','3']);
    const after=f.nodes.get('1').getBoundingClientRect();assert.equal(after.left,before.left);assert.equal(after.top,before.top);
    assert.equal(f.requests.length,writes);assert.ok(receipts>priorReceipts,'same-ID direction change publishes the existing layout receipt');
  }finally{f.dispose();}
});

test('actual member-origin peek and released order-only preview never submit a collapse arrange',async()=>{
  for(const origin of ['member-drag','released-preview']){
    const f=fixture({selectedFirst:true,anchor:760,viewport:900});try{
      if(origin==='member-drag'){f.props.dragging=true;f.props.sourceHere=true;f.render();}
      else {
        const byId=new Map(f.props.entries.map(entry=>[entry.tabId,entry]));
        f.props.entries=['3','1','2','4'].map(id=>byId.get(id));f.open('badge');
      }
      await f.settle();assert.equal(f.tree.props['data-group-open'],'1',origin);
      assert.deepEqual(f.order(),['1','2','3','4'],origin);assert.equal(f.arrangements.length,0,origin);
      assert.deepEqual(f.state.spaces[0].stripColorGroups.groups[0].tabIds,['1','2','3','4']);
    }finally{f.dispose();}
  }
});

test('actual newer canonical order wins over late admitted arrange publication without repeating selection',async()=>{
  const f=fixture({selectedFirst:true});try{
    f.open('badge');await f.settle();const hold=f.holdArrangement();f.select('3');await hold.admitted.promise;
    const byId=new Map(f.state.splitPanes[0].tabs.map(entry=>[entry.tabId,entry]));
    const newer=['4','2','1','3'];f.publish({splitPanes:[{...f.state.splitPanes[0],tabs:newer.map(id=>byId.get(id))}]});
    const admitted=f.arrangements.length;hold.release.resolve();await f.settle();
    assert.deepEqual(f.order(),newer);assert.equal(f.arrangements.length,admitted,'late ACK cannot invent another selected-first intent');
  }finally{f.dispose();}
});

test('actual unknown ACK plus Escape/reopen recovers the same mutation before selected-first reveal',async()=>{
  const f=fixture({selectedFirst:true});try{
    f.open('badge');await f.settle();const hold=f.holdArrangement();f.select('3');const request=await hold.admitted.promise;
    f.loseTransport(true);hold.release.resolve();await f.settle();
    assert.deepEqual(f.order(),['2','1','3','4'],'unknown ACK does not fabricate accepted local order');
    f.emit('keydown',{key:'Escape'});f.render();f.loseTransport(false);f.open('badge');await f.settle();
    const retries=f.requests.filter(value=>value.mutationId===request.mutationId);
    assert.equal(retries.length,2);assert.deepEqual(retries[0],retries[1]);
    assert.deepEqual(f.order(),['3','2','1','4']);assert.equal(f.tree.props['data-group-open'],'1');
  }finally{f.dispose();}
});
